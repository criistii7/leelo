// Léelo · service worker.
// 1. Guarda la app para que funcione sin conexión (los modelos los guarda transformers.js aparte).
// 2. Recibe los audios que se comparten desde WhatsApp en Android (share_target del manifiesto).
// 3. Añade las cabeceras de aislamiento (COOP/COEP) si el alojamiento no las pone: sin ellas,
//    Whisper solo puede usar un núcleo del procesador y va bastante más lento.

const VERSION = 'leelo-v1';
const CACHE_CDN = 'leelo-cdn-v1'; // librerías con versión fija: no cambian nunca
const CACHE_COMPARTIDOS = 'leelo-compartidos';

const APP = [
  './',
  './index.html',
  './estilos.css',
  './app.js',
  './motor.js',
  './manifest.webmanifest',
  './iconos/icono.svg',
  './iconos/icono-192.png',
  './fuentes/atkinson-next.woff2',
  './fuentes/instrument-serif.woff2',
  './fuentes/instrument-serif-italic.woff2',
];

self.addEventListener('install', (evento) => {
  evento.waitUntil(
    caches.open(VERSION)
      .then((cache) => cache.addAll(APP))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (evento) => {
  evento.waitUntil((async () => {
    const nombres = await caches.keys();
    await Promise.all(
      nombres.filter((n) => n.startsWith('leelo-v') && n !== VERSION).map((n) => caches.delete(n)),
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (evento) => {
  const peticion = evento.request;
  const url = new URL(peticion.url);

  if (peticion.method === 'POST' && url.origin === self.location.origin && url.pathname.endsWith('/compartir')) {
    evento.respondWith(recibirCompartido(peticion));
    return;
  }
  if (peticion.method !== 'GET') return;

  if (url.origin === self.location.origin) {
    evento.respondWith(mismoOrigen(peticion));
  } else if (url.hostname === 'cdn.jsdelivr.net' && !url.pathname.endsWith('.wasm')) {
    // El .wasm de onnxruntime ya lo guarda transformers.js: no se duplica.
    evento.respondWith(desdeCDN(peticion));
  }
  // Lo demás (descarga de modelos de Hugging Face) lo gestiona transformers.js con su propia caché.
});

function aislar(respuesta) {
  if (!respuesta || respuesta.status === 0 || respuesta.type === 'opaque' || respuesta.type === 'opaqueredirect') {
    return respuesta;
  }
  const cabeceras = new Headers(respuesta.headers);
  cabeceras.set('Cross-Origin-Opener-Policy', 'same-origin');
  cabeceras.set('Cross-Origin-Embedder-Policy', 'require-corp');
  return new Response(respuesta.body, {
    status: respuesta.status,
    statusText: respuesta.statusText,
    headers: cabeceras,
  });
}

// Primero la red (para recibir las actualizaciones al momento); si no hay conexión, la copia guardada.
async function mismoOrigen(peticion) {
  const cache = await caches.open(VERSION);
  try {
    const respuesta = await fetch(peticion);
    if (respuesta.ok && respuesta.type === 'basic') {
      const clave = peticion.mode === 'navigate' ? './index.html' : peticion;
      cache.put(clave, respuesta.clone()).catch(() => {});
    }
    return aislar(respuesta);
  } catch (err) {
    const guardada = peticion.mode === 'navigate'
      ? await cache.match('./index.html')
      : await cache.match(peticion, { ignoreSearch: true });
    if (guardada) return aislar(guardada);
    throw err;
  }
}

async function desdeCDN(peticion) {
  const cache = await caches.open(CACHE_CDN);
  const guardada = await cache.match(peticion);
  if (guardada) return guardada;
  const respuesta = await fetch(peticion);
  if (respuesta.ok && (respuesta.type === 'cors' || respuesta.type === 'basic')) {
    cache.put(peticion, respuesta.clone()).catch(() => {});
  }
  return respuesta;
}

async function recibirCompartido(peticion) {
  try {
    const datos = await peticion.formData();
    const archivos = datos.getAll('audio').filter((a) => a && typeof a !== 'string' && a.size > 0);
    const cache = await caches.open(CACHE_COMPARTIDOS);
    const marca = Date.now();
    await Promise.all(archivos.map((archivo, i) => cache.put(
      new Request(`./compartidos/${marca}-${i}`),
      new Response(archivo, {
        headers: {
          'Content-Type': archivo.type || 'application/octet-stream',
          'X-Nombre': encodeURIComponent(archivo.name || `audio-${i + 1}`),
        },
      }),
    )));
  } catch (err) {
    console.warn('[Léelo] no se pudo guardar el audio compartido', err);
  }
  return Response.redirect(new URL('./?compartido=1', self.registration.scope).href, 303);
}
