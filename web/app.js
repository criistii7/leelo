// Léelo · interfaz principal.
// Decodifica cada audio en el navegador (16 kHz, mono) y se lo pasa a motor.js, un Web Worker que
// ejecuta Whisper. El resultado llega en frases con su minuto: se puede buscar una palabra, ver en
// qué minuto se dice y escuchar ese trozo. Ni el audio ni el texto salen del dispositivo.

const PARAMS = new URLSearchParams(location.search);
const MUESTREO = 16000;
const CLAVE_AJUSTES = 'leelo:ajustes';
const CACHE_MODELOS = 'transformers-cache';
const CACHE_COMPARTIDOS = 'leelo-compartidos';
const DECODIFICADOR_OPUS = 'https://cdn.jsdelivr.net/npm/ogg-opus-decoder@1.7.5/+esm';

const IDIOMAS = [
  ['es', 'Español'], ['en', 'Inglés'], ['pt', 'Portugués'], ['fr', 'Francés'], ['it', 'Italiano'],
  ['de', 'Alemán'], ['ca', 'Catalán'], ['gl', 'Gallego'], ['eu', 'Euskera'], ['ro', 'Rumano'],
  ['ru', 'Ruso'], ['uk', 'Ucraniano'], ['ar', 'Árabe'], ['zh', 'Chino'],
];

// El turbo va en su variante «_timestamped» (exportada con la atención cruzada que da el segundo
// exacto de cada palabra): sus frases son largas y sin ella el minuto saldría poco preciso. Con
// small y base, pedirlo duplica el tiempo; sus frases ya son cortas y el segundo de cada palabra se
// estima dentro de la frase (motor.js).
const MODELOS = {
  base: 'onnx-community/whisper-base',
  small: 'onnx-community/whisper-small',
  turbo: 'onnx-community/whisper-large-v3-turbo_timestamped',
};

const NOTAS = {
  rapida: {
    nueva: (mb) => `La más ligera: descarga ≈ ${mb} MB la primera vez. Para móviles antiguos; se equivoca bastante más.`,
    lista: 'La más ligera; se equivoca bastante más.',
  },
  buena: {
    nueva: (mb) => `Equilibrada: la primera vez descarga ≈ ${mb} MB (mejor con wifi) y después funciona sin internet.`,
    lista: 'Equilibrada.',
  },
  maxima: {
    nueva: (mb) => `La más precisa y, con tarjeta gráfica, la más rápida. La primera vez descarga ≈ ${mb} MB (mejor con wifi).`,
    lista: 'La más precisa y, con tarjeta gráfica, la más rápida.',
  },
};

// Sufijo de archivo que usa transformers.js para cada tipo de cuantización.
const SUFIJOS = { fp32: '', fp16: '_fp16', q8: '_quantized', int8: '_int8', uint8: '_uint8', q4: '_q4', q4f16: '_q4f16', bnb4: '_bnb4' };

const UA = navigator.userAgent;
const ES_IOS = /iPad|iPhone|iPod/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const ES_ANDROID = /Android/i.test(UA);
const ES_TACTIL = matchMedia('(pointer: coarse)').matches;
const ES_MOVIL = navigator.userAgentData?.mobile ?? (ES_IOS || /Android|Mobile/i.test(UA));
const PUEDE_COMPARTIR = typeof navigator.share === 'function';
const MOVIMIENTO_REDUCIDO = matchMedia('(prefers-reduced-motion: reduce)').matches;

const $ = (sel, raiz = document) => raiz.querySelector(sel);

const ui = {
  elegir: $('#elegir'),
  archivo: $('#archivo'),
  entrada: $('#entrada'),
  pistaSoltar: $('#pista-soltar'),
  idioma: $('#idioma'),
  calidades: $('#calidades'),
  opcionMaxima: $('#opcion-maxima'),
  notaCalidad: $('#nota-calidad'),
  resultados: $('#resultados'),
  lista: $('#lista'),
  copiarTodo: $('#copiar-todo'),
  buscador: $('#buscador'),
  busqueda: $('#busqueda'),
  resumenBusqueda: $('#resumen-busqueda'),
  coincidencias: $('#coincidencias'),
  avisoAbierta: $('#aviso-abierta'),
  instalar: $('#instalar'),
  borrarModelos: $('#borrar-modelos'),
  compartirApp: $('#compartir-app'),
  plantilla: $('#tpl-audio'),
};

const estado = {
  ajustes: { idioma: 'es', ...leerJSON(localStorage.getItem(CLAVE_AJUSTES)) }, // calidad: tras mirar la GPU
  gpu: null, // { f16 } si el navegador ofrece WebGPU
  items: [],
  cola: [],
  ocupado: false,
  terminos: [],
};
let siguienteId = 1;

/* ───────────── utilidades ───────────── */

function leerJSON(texto) {
  try { return JSON.parse(texto) || {}; } catch { return {}; }
}

function guardarAjustes() {
  try { localStorage.setItem(CLAVE_AJUSTES, JSON.stringify(estado.ajustes)); } catch { /* modo privado */ }
}

const dos = (n) => String(n).padStart(2, '0');

function fmtTiempo(segundos) {
  const s = Math.max(0, Math.floor(segundos));
  const h = Math.floor(s / 3600);
  const m = Math.floor(s / 60) % 60;
  return h ? `${h}:${dos(m)}:${dos(s % 60)}` : `${m}:${dos(s % 60)}`;
}

function fmtSrt(segundos) {
  const ms = Math.round(segundos * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor(ms / 60000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  return `${dos(h)}:${dos(m)}:${dos(s)},${String(ms % 1000).padStart(3, '0')}`;
}

function fmtDuracion(segundos) {
  const s = Math.max(1, Math.round(segundos));
  if (s < 60) return `${s} s`;
  return s % 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s / 60} min`;
}

const fmtMB = (bytes) => `${Math.round(bytes / 1e6)} MB`;
const nombreBase = (nombre) => nombre.replace(/\.[^.]+$/, '') || 'audio';
const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;

function descargar(nombre, contenido, tipo) {
  const url = URL.createObjectURL(new Blob([contenido], { type: tipo }));
  const a = Object.assign(document.createElement('a'), { href: url, download: nombre });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function copiarTexto(texto) {
  try {
    await navigator.clipboard.writeText(texto);
    return true;
  } catch {
    const area = Object.assign(document.createElement('textarea'), { value: texto });
    area.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

function confirmar(boton, texto) {
  boton.dataset.original ??= boton.textContent;
  boton.textContent = texto;
  boton.classList.add('hecho');
  clearTimeout(boton._temporizador);
  boton._temporizador = setTimeout(() => {
    boton.textContent = boton.dataset.original;
    boton.classList.remove('hecho');
  }, 1800);
}

// Minúsculas y sin tildes, para que «tasacion» encuentre «Tasación».
const normalizar = (texto) => texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

// Igual que normalizar(), pero recordando a qué carácter del original corresponde cada uno.
function normalizarConMapa(texto) {
  let normal = '';
  const mapa = [];
  for (let i = 0; i < texto.length; i += 1) {
    const trozo = normalizar(texto[i]);
    for (let k = 0; k < trozo.length; k += 1) {
      normal += trozo[k];
      mapa.push(i);
    }
  }
  mapa.push(texto.length);
  return { normal, mapa };
}

function buscarEn(texto, terminos) {
  const { normal, mapa } = normalizarConMapa(texto);
  const rangos = [];
  for (const termino of terminos) {
    let desde = 0;
    for (;;) {
      const i = normal.indexOf(termino, desde);
      if (i < 0) break;
      rangos.push([mapa[i], mapa[i + termino.length - 1] + 1]);
      desde = i + termino.length;
    }
  }
  rangos.sort((a, b) => a[0] - b[0]);
  const unidos = [];
  for (const r of rangos) {
    const ultimo = unidos.at(-1);
    if (ultimo && r[0] <= ultimo[1]) ultimo[1] = Math.max(ultimo[1], r[1]);
    else unidos.push([...r]);
  }
  return unidos;
}

function pintarConMarcas(elemento, texto, rangos) {
  if (!rangos?.length) {
    elemento.textContent = texto;
    return;
  }
  const partes = [];
  let pos = 0;
  for (const [a, b] of rangos) {
    if (a > pos) partes.push(texto.slice(pos, a));
    const marca = document.createElement('mark');
    marca.textContent = texto.slice(a, b);
    partes.push(marca);
    pos = b;
  }
  if (pos < texto.length) partes.push(texto.slice(pos));
  elemento.replaceChildren(...partes);
}

/* ───────────── modelo y dispositivo ───────────── */

async function detectarGPU() {
  if (PARAMS.has('sin-gpu') || !('gpu' in navigator)) return null;
  try {
    const adaptador = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    return adaptador ? { f16: adaptador.features.has('shader-f16') } : null;
  } catch {
    return null;
  }
}

function configPara(calidad) {
  const forzado = PARAMS.get('modelo'); // solo para pruebas: ?modelo=…&dispositivo=…&dtype=…
  if (forzado) {
    let dtype = PARAMS.get('dtype') || 'q8';
    try { dtype = JSON.parse(dtype); } catch { /* es un texto como «q8» */ }
    return {
      modelo: forzado,
      dispositivo: PARAMS.get('dispositivo') || 'wasm',
      dtype,
      mb: null,
      hilos: Number(PARAMS.get('hilos')) || undefined,
      palabras: PARAMS.has('palabras'),
    };
  }
  // Medido en un Mac M5 con una nota de voz de 41 s (ver README): «Máxima» 20 s con el segundo
  // exacto de cada palabra y casi sin fallos; «Buena» por GPU 14 s; «Buena» por CPU 42 s; «Rápida» 16 s.
  const gpu = estado.gpu;
  if (calidad === 'maxima' && gpu) {
    return gpu.f16
      ? { modelo: MODELOS.turbo, dispositivo: 'webgpu', dtype: { encoder_model: 'q4f16', decoder_model_merged: 'q4f16' }, mb: 564, palabras: true }
      : { modelo: MODELOS.turbo, dispositivo: 'webgpu', dtype: { encoder_model: 'q4', decoder_model_merged: 'q4' }, mb: 759, palabras: true };
  }
  if (calidad === 'rapida') return { modelo: MODELOS.base, dispositivo: 'wasm', dtype: 'q8', mb: 77 };
  if (gpu) return { modelo: MODELOS.small, dispositivo: 'webgpu', dtype: { encoder_model: 'q4', decoder_model_merged: 'q4' }, mb: 299 };
  return { modelo: MODELOS.small, dispositivo: 'wasm', dtype: 'q8', mb: 249 };
}

// Sin elección previa: «Máxima» si hay GPU con f16 en un ordenador (es la más rápida y la que menos
// falla); en el móvil, «Buena», que descarga la mitad y gasta menos memoria.
const calidadPorDefecto = () => (estado.gpu?.f16 && !ES_MOVIL ? 'maxima' : 'buena');

function archivosDe(cfg) {
  return ['encoder_model', 'decoder_model_merged'].map((parte) => {
    const tipo = typeof cfg.dtype === 'string' ? cfg.dtype : cfg.dtype[parte];
    return `/${cfg.modelo}/resolve/main/onnx/${parte}${SUFIJOS[tipo] ?? ''}.onnx`;
  });
}

async function estaDescargado(cfg) {
  if (!('caches' in self)) return false;
  try {
    const cache = await caches.open(CACHE_MODELOS);
    const urls = (await cache.keys()).map((peticion) => peticion.url);
    return archivosDe(cfg).every((archivo) => urls.some((url) => url.endsWith(archivo)));
  } catch {
    return false;
  }
}

/* ───────────── audio ───────────── */

const esOgg = (datos) => {
  const b = new Uint8Array(datos, 0, Math.min(4, datos.byteLength));
  return b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53; // «OggS»
};

async function decodificar(archivo) {
  const datos = await archivo.arrayBuffer();
  if (!PARAMS.has('opus-wasm')) {
    try {
      return await decodificarNativo(datos.slice(0));
    } catch (err) {
      if (!esOgg(datos)) throw err;
    }
  }
  return decodificarOpus(datos); // Safari antiguos no saben abrir las notas de voz (.opus)
}

async function decodificarNativo(datos) {
  const Contexto = self.OfflineAudioContext || self.webkitOfflineAudioContext;
  const contexto = new Contexto(1, MUESTREO, MUESTREO); // decodeAudioData remuestrea a 16 kHz
  const buffer = await new Promise((ok, mal) => {
    const promesa = contexto.decodeAudioData(datos, ok, mal);
    promesa?.then?.(ok, mal);
  });
  if (buffer.numberOfChannels === 1) return new Float32Array(buffer.getChannelData(0));
  const mono = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c += 1) {
    const canal = buffer.getChannelData(c);
    for (let i = 0; i < mono.length; i += 1) mono[i] += canal[i] / buffer.numberOfChannels;
  }
  return mono;
}

async function decodificarOpus(datos) {
  const { OggOpusDecoder } = await import(DECODIFICADOR_OPUS);
  const decodificador = new OggOpusDecoder({ sampleRate: MUESTREO });
  await decodificador.ready;
  try {
    const { channelData, samplesDecoded } = await decodificador.decodeFile(new Uint8Array(datos));
    if (!samplesDecoded) throw new Error('Audio vacío');
    if (channelData.length === 1) return channelData[0].slice(0, samplesDecoded);
    const mono = new Float32Array(samplesDecoded);
    for (const canal of channelData) {
      for (let i = 0; i < samplesDecoded; i += 1) mono[i] += canal[i] / channelData.length;
    }
    return mono;
  } finally {
    decodificador.free();
  }
}

// WAV de 16 bits para los navegadores que no reproducen el archivo original.
function wavDesdePCM(pcm) {
  const datos = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const texto = (pos, t) => { for (let i = 0; i < t.length; i += 1) datos.setUint8(pos + i, t.charCodeAt(i)); };
  texto(0, 'RIFF');
  datos.setUint32(4, 36 + pcm.length * 2, true);
  texto(8, 'WAVE');
  texto(12, 'fmt ');
  datos.setUint32(16, 16, true);
  datos.setUint16(20, 1, true);
  datos.setUint16(22, 1, true);
  datos.setUint32(24, MUESTREO, true);
  datos.setUint32(28, MUESTREO * 2, true);
  datos.setUint16(32, 2, true);
  datos.setUint16(34, 16, true);
  texto(36, 'data');
  datos.setUint32(40, pcm.length * 2, true);
  for (let i = 0, pos = 44; i < pcm.length; i += 1, pos += 2) {
    const v = Math.max(-1, Math.min(1, pcm[i]));
    datos.setInt16(pos, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new Blob([datos.buffer], { type: 'audio/wav' });
}

/* ───────────── motor (Web Worker) ───────────── */

let motor = null;
let motorDispositivo = null; // un motor sirve para CPU (wasm) o para GPU (webgpu), no para los dos
const esperas = new Map(); // id → { item, ok, mal }

function obtenerMotor(dispositivo) {
  if (motor && motorDispositivo !== dispositivo) {
    motor.terminate();
    motor = null;
  }
  if (motor) return motor;
  motorDispositivo = dispositivo;
  motor = new Worker(new URL('./motor.js', import.meta.url), { type: 'module' });
  motor.addEventListener('message', alMensajeMotor);
  motor.addEventListener('error', (evento) => {
    evento.preventDefault?.();
    romperMotor(new Error(evento.message || 'No se pudo arrancar el motor de transcripción. Revisa la conexión.'));
  });
  return motor;
}

function romperMotor(err) {
  for (const { mal } of esperas.values()) mal(err);
  esperas.clear();
  motor?.terminate();
  motor = null;
}

function enviarAlMotor(item, pcm, cfg) {
  return new Promise((ok, mal) => {
    esperas.set(item.id, { item, ok, mal });
    obtenerMotor(cfg.dispositivo).postMessage(
      { tipo: 'transcribir', id: item.id, audio: pcm, cfg, idioma: estado.ajustes.idioma },
      [pcm.buffer],
    );
  });
}

function alMensajeMotor({ data }) {
  const espera = esperas.get(data.id);
  if (!espera) return;
  const { item } = espera;
  switch (data.tipo) {
    case 'carga':
      if (!item.descargando || !(data.total > 0)) break;
      if (data.progreso >= 100) {
        ponerEstado(item, 'cargando', 'Preparando el modelo…');
        barra(item, null);
      } else {
        ponerEstado(item, 'cargando', `Descargando el modelo de voz (solo la primera vez) · ${Math.floor(data.progreso)} % · ${fmtMB(data.cargado)} de ${fmtMB(data.total)}`);
        barra(item, data.progreso / 100);
      }
      break;
    case 'modelo-listo':
      if (item.descargando) {
        item.descargando = false;
        navigator.storage?.persist?.().catch(() => {});
        pintarNotaCalidad();
      }
      item.inicio = performance.now();
      ponerEstado(item, 'transcribiendo', 'Transcribiendo…');
      barra(item, null);
      arrancarReloj(item);
      break;
    case 'tramo':
      item.tramos = data;
      if (data.total > 1) barra(item, Math.max(0.04, data.hechos / data.total));
      pintarProgreso(item);
      break;
    case 'parcial':
      item.provisional += data.texto;
      item.el.texto.textContent = item.provisional;
      break;
    case 'fin':
      esperas.delete(data.id);
      espera.ok(data);
      break;
    case 'error':
      esperas.delete(data.id);
      espera.mal(Object.assign(new Error(data.mensaje), { gpu: data.gpu }));
      break;
    default:
      break;
  }
}

/* ───────────── cola de audios ───────────── */

function crearItem(archivo) {
  const nodo = ui.plantilla.content.firstElementChild.cloneNode(true);
  const item = {
    id: siguienteId++,
    archivo,
    nombre: archivo.name || 'audio',
    estado: 'cola',
    duracion: null,
    texto: '',
    segmentos: [],
    provisional: '',
    sonando: -1,
    url: null,
    el: {
      nodo,
      barra: $('.barra', nodo),
      relleno: $('.barra span', nodo),
      nombre: $('.audio-nombre', nodo),
      meta: $('.audio-meta', nodo),
      estado: $('.audio-estado', nodo),
      reproductor: $('.reproductor', nodo),
      texto: $('.texto', nodo),
      frases: $('.frases', nodo),
      acciones: $('.acciones', nodo),
    },
  };
  nodo.dataset.id = item.id;
  item.el.nombre.textContent = item.nombre;
  item.el.nombre.title = item.nombre;
  $('.quitar', nodo).addEventListener('click', () => quitarItem(item));
  $('[data-accion="compartir"]', nodo).hidden = !PUEDE_COMPARTIR;
  item.el.acciones.addEventListener('click', (evento) => {
    const boton = evento.target.closest('button[data-accion]');
    if (boton) accion(item, boton.dataset.accion, boton);
  });
  item.el.frases.addEventListener('click', (evento) => {
    const tiempo = evento.target.closest('.frase-tiempo');
    if (tiempo) {
      reproducirDesde(item, item.segmentos[Number(tiempo.dataset.i)]?.ini ?? 0);
      return;
    }
    // Tocar una palabra: el audio suena desde ahí (salvo si se está seleccionando texto para copiarlo).
    const palabra = evento.target.closest('.palabra');
    if (!palabra || String(getSelection?.() ?? '').trim()) return;
    const frase = item.segmentos[Number(palabra.closest('.frase').dataset.i)];
    const p = frase?.palabras[Number(palabra.dataset.k)];
    if (p) reproducirDesde(item, Math.max(0, p.ini - 0.15));
  });
  ponerEstado(item, 'cola', 'En cola');
  return item;
}

function añadirArchivos(lista) {
  const archivos = [...lista].filter((archivo) => archivo && archivo.size > 0);
  if (!archivos.length) return;
  for (const archivo of archivos) {
    const item = crearItem(archivo);
    estado.items.push(item);
    estado.cola.push(item);
    ui.lista.append(item.el.nodo);
  }
  actualizarResultados();
  if (archivos.length && !estado.ocupado) {
    ui.resultados.scrollIntoView?.({ behavior: MOVIMIENTO_REDUCIDO ? 'auto' : 'smooth', block: 'start' });
  }
  siguiente();
}

async function siguiente() {
  if (estado.ocupado) return;
  const item = estado.cola.shift();
  if (!item) {
    ui.avisoAbierta.hidden = true;
    soltarPantalla();
    return;
  }
  estado.ocupado = true;
  ui.avisoAbierta.hidden = false;
  mantenerPantalla();
  try {
    await procesar(item);
  } catch (err) {
    console.error('[Léelo]', err);
    fallar(item, 'Algo ha fallado. Prueba otra vez.');
  } finally {
    estado.ocupado = false;
    siguiente();
  }
}

async function procesar(item) {
  ponerEstado(item, 'leyendo', 'Leyendo el audio…');
  barra(item, null);
  let pcm;
  try {
    pcm = await decodificar(item.archivo);
  } catch (err) {
    console.warn('[Léelo] no se pudo decodificar', err);
    fallar(item, 'No he podido leer este archivo. Prueba con una nota de voz (.opus), .m4a, .mp3, .wav o un vídeo .mp4.');
    return;
  }
  if (item.quitado) return;
  item.duracion = pcm.length / MUESTREO;
  if (item.duracion < 0.3) {
    fallar(item, 'El audio está vacío o es demasiado corto.');
    return;
  }

  let cfg = configPara(estado.ajustes.calidad);
  item.calidad = cfg.modelo === MODELOS.turbo ? 'Máxima' : cfg.modelo === MODELOS.base ? 'Rápida' : 'Buena';
  pintarMeta(item);
  try {
    await transcribirCon(item, pcm, cfg);
  } catch (err) {
    if (err.cancelado || item.quitado) return;
    if (err.gpu) {
      // La tarjeta gráfica ha fallado: se desactiva «Máxima» y se repite con «Buena».
      console.warn('[Léelo] WebGPU ha fallado, paso a WASM', err);
      estado.gpu = null;
      pintarCalidades();
      cfg = configPara('buena');
      item.calidad = 'Buena';
      pintarMeta(item);
      try {
        await transcribirCon(item, await decodificar(item.archivo), cfg);
        return;
      } catch (err2) {
        if (err2.cancelado || item.quitado) return;
        err = err2;
      }
    }
    console.error('[Léelo]', err);
    fallar(item, `No se ha podido transcribir: ${err.message}`);
  }
}

async function transcribirCon(item, pcm, cfg) {
  const descargado = await estaDescargado(cfg);
  item.descargando = !descargado;
  item.provisional = '';
  item.el.texto.textContent = '';
  ponerEstado(item, 'cargando', descargado ? 'Preparando el modelo…' : 'Descargando el modelo de voz (solo la primera vez)…');
  barra(item, descargado ? null : 0);
  const resultado = await enviarAlMotor(item, pcm, cfg);
  terminar(item, resultado);
}

function terminar(item, resultado) {
  pararReloj(item);
  item.segmentos = resultado.segmentos || [];
  item.texto = resultado.texto || '';
  item.motor = resultado.motor;
  item.segundos = resultado.segundos;
  item.provisional = '';
  item.el.texto.textContent = '';
  if (!item.texto) {
    ponerEstado(item, 'listo', 'No he oído palabras en este audio.');
    actualizarResultados();
    return;
  }
  ponerEstado(item, 'listo', `Transcrito en ${fmtDuracion(resultado.segundos)}`);
  pintarFrases(item);
  prepararReproductor(item);
  item.el.acciones.hidden = false;
  actualizarResultados();
  if (estado.terminos.length) buscar();
}

function fallar(item, mensaje) {
  pararReloj(item);
  item.provisional = '';
  item.el.texto.textContent = '';
  ponerEstado(item, 'error', mensaje);
  actualizarResultados();
}

function quitarItem(item) {
  item.quitado = true;
  const enCola = estado.cola.indexOf(item);
  if (enCola >= 0) estado.cola.splice(enCola, 1);
  const espera = esperas.get(item.id);
  if (espera) {
    // No se puede parar Whisper a medias: se reinicia el motor (el modelo sigue en caché).
    esperas.delete(item.id);
    motor?.terminate();
    motor = null;
    espera.mal(Object.assign(new Error('cancelado'), { cancelado: true }));
  }
  pararReloj(item);
  cancelAnimationFrame(item.animacion);
  item.el.reproductor.pause();
  if (item.url) URL.revokeObjectURL(item.url);
  item.el.nodo.remove();
  estado.items = estado.items.filter((otro) => otro !== item);
  actualizarResultados();
  buscar();
}

/* ───────────── pintar cada audio ───────────── */

function ponerEstado(item, nuevo, texto) {
  item.estado = nuevo;
  item.el.nodo.dataset.estado = nuevo;
  item.el.estado.textContent = texto;
}

function barra(item, fraccion) {
  item.el.barra.classList.toggle('indeterminada', fraccion == null);
  item.el.relleno.style.width = fraccion == null ? '' : `${Math.round(Math.min(1, Math.max(0, fraccion)) * 100)}%`;
}

function pintarMeta(item) {
  const partes = [];
  if (item.duracion) partes.push(fmtTiempo(item.duracion));
  if (item.calidad) partes.push(`calidad ${item.calidad}`);
  item.el.meta.textContent = partes.join(' · ');
}

function pintarProgreso(item) {
  if (item.estado !== 'transcribiendo') return;
  const pasado = fmtTiempo((performance.now() - item.inicio) / 1000);
  const tramos = item.tramos?.total > 1 ? ` · parte ${Math.min(item.tramos.hechos + 1, item.tramos.total)} de ${item.tramos.total}` : '';
  item.el.estado.textContent = `Transcribiendo${tramos} · ${pasado}`;
}

function arrancarReloj(item) {
  pararReloj(item);
  item.reloj = setInterval(() => pintarProgreso(item), 1000);
}

function pararReloj(item) {
  clearInterval(item.reloj);
  item.reloj = null;
}

function pintarFrases(item, marcas = null) {
  const lista = document.createDocumentFragment();
  item.segmentos.forEach((frase, i) => {
    const li = document.createElement('li');
    li.className = 'frase';
    li.dataset.i = i;
    const tiempo = document.createElement('button');
    tiempo.type = 'button';
    tiempo.className = 'frase-tiempo';
    tiempo.dataset.i = i;
    tiempo.textContent = fmtTiempo(frase.ini);
    tiempo.setAttribute('aria-label', `Escuchar desde el minuto ${fmtTiempo(frase.ini)}`);
    const texto = document.createElement('p');
    texto.className = 'frase-texto';
    pintarPalabras(texto, frase, marcas?.get(i));
    li.append(tiempo, texto);
    lista.append(li);
  });
  item.el.frases.replaceChildren(lista);
  item.el.frases.classList.toggle('sin-tiempos', item.segmentos.length < 2 && item.duracion < 30);
  item.sonando = -1;
  item.palabraSonando = null;
}

// Cada palabra va en su <span> (para tocarla y para iluminarla al sonar), con las marcas del buscador.
function pintarPalabras(elemento, frase, rangos) {
  const nodos = [];
  let pos = 0;
  frase.palabras.forEach((palabra, k) => {
    const espacio = palabra.texto.length - palabra.texto.trimStart().length;
    if (espacio) nodos.push(frase.texto.slice(pos, pos + espacio));
    const ini = pos + espacio;
    const fin = pos + palabra.texto.length;
    const span = document.createElement('span');
    span.className = 'palabra';
    span.dataset.k = k;
    let cursor = ini;
    for (const [a, b] of rangos || []) {
      if (b <= ini || a >= fin) continue;
      const desde = Math.max(a, ini);
      const hasta = Math.min(b, fin);
      if (desde > cursor) span.append(frase.texto.slice(cursor, desde));
      span.append(Object.assign(document.createElement('mark'), { textContent: frase.texto.slice(desde, hasta) }));
      cursor = hasta;
    }
    if (cursor < fin) span.append(frase.texto.slice(cursor, fin));
    nodos.push(span);
    pos = fin;
  });
  elemento.replaceChildren(...nodos);
}

// Índice de la palabra que contiene el carácter «posicion» del texto de la frase.
function palabraEn(frase, posicion) {
  let fin = 0;
  for (let k = 0; k < frase.palabras.length; k += 1) {
    fin += frase.palabras[k].texto.length;
    if (posicion < fin) return k;
  }
  return frase.palabras.length - 1;
}

function prepararReproductor(item) {
  const reproductor = item.el.reproductor;
  if (item.url) return;
  item.url = URL.createObjectURL(item.archivo);
  reproductor.addEventListener('error', async () => {
    if (item.wav) return; // ya se intentó con el WAV
    item.wav = true;
    try {
      const pcm = await decodificar(item.archivo);
      URL.revokeObjectURL(item.url);
      item.url = URL.createObjectURL(wavDesdePCM(pcm));
      reproductor.src = item.url;
    } catch {
      reproductor.hidden = true;
    }
  });
  // Mientras suena, se sigue cada fotograma para que la palabra iluminada vaya a la par que la voz.
  const seguir = () => {
    marcarSonando(item);
    if (!reproductor.paused && !reproductor.ended) item.animacion = requestAnimationFrame(seguir);
  };
  reproductor.addEventListener('play', () => {
    cancelAnimationFrame(item.animacion);
    seguir();
  });
  reproductor.addEventListener('timeupdate', () => marcarSonando(item));
  reproductor.src = item.url;
  reproductor.hidden = false;
}

function marcarSonando(item) {
  const t = item.el.reproductor.currentTime;
  const i = item.segmentos.findIndex((frase) => t >= frase.ini && t < frase.fin);
  if (i !== item.sonando) {
    item.el.frases.children[item.sonando]?.classList.remove('sonando');
    item.el.frases.children[i]?.classList.add('sonando');
    item.sonando = i;
  }
  const frase = item.segmentos[i];
  const k = frase ? frase.palabras.findIndex((p) => t >= p.ini && t < Math.max(p.fin, p.ini + 0.12)) : -1;
  const clave = k >= 0 ? `${i}:${k}` : null;
  if (clave === item.palabraSonando) return;
  item.el.frases.querySelector('.palabra.actual')?.classList.remove('actual');
  if (clave) item.el.frases.children[i]?.querySelector(`.palabra[data-k="${k}"]`)?.classList.add('actual');
  item.palabraSonando = clave;
}

function reproducirDesde(item, segundos) {
  const reproductor = item.el.reproductor;
  const saltar = () => {
    reproductor.currentTime = Math.max(0, segundos);
    reproductor.play().catch(() => {});
  };
  if (reproductor.readyState >= 1) saltar();
  else reproductor.addEventListener('loadedmetadata', saltar, { once: true });
}

/* ───────────── resultados, búsqueda y exportar ───────────── */

const listos = () => estado.items.filter((item) => item.estado === 'listo' && item.segmentos.length);

function actualizarResultados() {
  ui.resultados.hidden = estado.items.length === 0;
  const hechos = listos();
  ui.buscador.hidden = hechos.length === 0;
  ui.copiarTodo.hidden = hechos.length < 2;
}

function buscar() {
  estado.terminos = ui.busqueda.value
    .split(',')
    .map((t) => normalizar(t.trim().replace(/\s+/g, ' ')))
    .filter((t) => t.length >= 2);
  const filas = []; // una por cada vez que aparece, con el segundo exacto de esa palabra
  const audios = new Set();
  for (const item of listos()) {
    const marcas = new Map();
    if (estado.terminos.length) {
      item.segmentos.forEach((frase, i) => {
        const rangos = buscarEn(frase.texto, estado.terminos);
        if (!rangos.length) return;
        marcas.set(i, rangos);
        audios.add(item);
        for (const rango of rangos) {
          const segundo = frase.palabras[palabraEn(frase, rango[0])]?.ini ?? frase.ini;
          filas.push({ item, i, rango, segundo });
        }
      });
    }
    pintarFrases(item, marcas);
  }
  const veces = filas.length;

  if (!estado.terminos.length) {
    ui.resumenBusqueda.textContent = '';
    ui.coincidencias.replaceChildren();
    return;
  }
  const variosAudios = listos().length > 1;
  ui.resumenBusqueda.textContent = veces
    ? `Aparece ${plural(veces, 'vez', 'veces')}${variosAudios ? ` en ${plural(audios.size, 'audio', 'audios')}` : ''}. Toca una para escucharla.`
    : 'No aparece en ninguna transcripción.';
  ui.coincidencias.replaceChildren(...filas.slice(0, 300).map(({ item, i, rango, segundo }) => {
    const frase = item.segmentos[i];
    const li = document.createElement('li');
    const boton = document.createElement('button');
    boton.type = 'button';
    boton.className = 'coincidencia';
    const tiempo = Object.assign(document.createElement('span'), { className: 'c-tiempo', textContent: fmtTiempo(segundo) });
    const texto = Object.assign(document.createElement('span'), { className: 'c-texto' });
    const trozo = contexto(frase, rango);
    pintarConMarcas(texto, trozo.texto, [trozo.marca]);
    if (trozo.antes) texto.prepend('…');
    if (trozo.despues) texto.append('…');
    boton.append(tiempo);
    if (variosAudios) boton.append(Object.assign(document.createElement('span'), { className: 'c-nombre', textContent: item.nombre }));
    boton.append(texto);
    boton.setAttribute('aria-label', `Minuto ${fmtTiempo(segundo)}${variosAudios ? ` de ${item.nombre}` : ''}: ${trozo.texto}`);
    boton.addEventListener('click', () => irA(item, i, segundo));
    li.append(boton);
    return li;
  }));
}

// Unas palabras alrededor de lo encontrado, para reconocerlo de un vistazo.
function contexto(frase, [a, b], alrededor = 6) {
  const inicios = [];
  let pos = 0;
  for (const p of frase.palabras) {
    inicios.push(pos);
    pos += p.texto.length;
  }
  const n = frase.palabras.length;
  const desde = Math.max(0, palabraEn(frase, a) - alrededor);
  const hasta = Math.min(n - 1, palabraEn(frase, b - 1) + alrededor);
  const crudo = frase.texto.slice(inicios[desde], hasta + 1 < n ? inicios[hasta + 1] : frase.texto.length);
  const desplazamiento = inicios[desde] + (crudo.length - crudo.trimStart().length);
  const texto = crudo.trim();
  return {
    texto,
    marca: [Math.max(0, a - desplazamiento), Math.min(texto.length, b - desplazamiento)],
    antes: desde > 0,
    despues: hasta < n - 1,
  };
}

function irA(item, i, segundo) {
  const fila = item.el.frases.children[i];
  if (!fila) return;
  fila.scrollIntoView({ behavior: MOVIMIENTO_REDUCIDO ? 'auto' : 'smooth', block: 'center' });
  fila.classList.remove('destello');
  void fila.offsetWidth; // reinicia la animación
  fila.classList.add('destello');
  reproducirDesde(item, segundo - 0.6); // un poco antes, para oír la palabra entera
}

function textoConTiempos(item) {
  const lineas = item.segmentos.map((frase) => `[${fmtTiempo(frase.ini)}] ${frase.texto}`);
  return `${item.nombre} · ${fmtTiempo(item.duracion)}\nTranscrito con Léelo\n\n${lineas.join('\n')}\n`;
}

function subtitulos(item) {
  return item.segmentos
    .map((frase, i) => `${i + 1}\n${fmtSrt(frase.ini)} --> ${fmtSrt(frase.fin)}\n${frase.texto}\n`)
    .join('\n');
}

async function accion(item, tipo, boton) {
  if (tipo === 'copiar') {
    if (await copiarTexto(item.texto)) confirmar(boton, 'Copiado');
  } else if (tipo === 'compartir') {
    try { await navigator.share({ text: item.texto }); } catch { /* cancelado */ }
  } else if (tipo === 'txt') {
    descargar(`${nombreBase(item.nombre)}.txt`, textoConTiempos(item), 'text/plain;charset=utf-8');
  } else if (tipo === 'srt') {
    descargar(`${nombreBase(item.nombre)}.srt`, subtitulos(item), 'application/x-subrip;charset=utf-8');
  }
}

/* ───────────── ajustes ───────────── */

function pintarAjustes() {
  ui.idioma.replaceChildren(...IDIOMAS.map(([valor, nombre]) => new Option(nombre, valor, false, valor === estado.ajustes.idioma)));
  pintarCalidades();
}

function pintarCalidades() {
  const sinGPU = !estado.gpu && !PARAMS.get('modelo');
  const maxima = ui.calidades.querySelector('input[value="maxima"]');
  maxima.disabled = sinGPU;
  ui.opcionMaxima.title = sinGPU ? 'Necesita una tarjeta gráfica compatible (WebGPU): prueba en Chrome o Edge en un ordenador.' : '';
  if (sinGPU && estado.ajustes.calidad === 'maxima') estado.ajustes.calidad = 'buena';
  for (const radio of ui.calidades.querySelectorAll('input')) radio.checked = radio.value === estado.ajustes.calidad;
}

async function pintarNotaCalidad() {
  const calidad = estado.ajustes.calidad;
  const cfg = configPara(calidad);
  const descargado = await estaDescargado(cfg);
  if (calidad !== estado.ajustes.calidad) return; // cambió mientras mirábamos la caché
  const nota = NOTAS[calidad];
  const partes = [descargado ? nota.lista : nota.nueva(cfg.mb ?? '?')];
  if (descargado) {
    partes.push(' ', Object.assign(document.createElement('span'), { className: 'ok', textContent: 'Ya descargada: funciona sin internet.' }));
  }
  if (!estado.gpu) {
    partes.push(' Este navegador no deja usar la tarjeta gráfica, así que transcribe con el procesador: puede tardar más de lo que dura el audio. La calidad Máxima necesita WebGPU (Chrome, Edge o Safari recientes).');
  }
  ui.notaCalidad.replaceChildren(...partes);
}

/* ───────────── pantalla encendida mientras transcribe ───────────── */

let bloqueoPantalla = null;

async function mantenerPantalla() {
  try {
    if (bloqueoPantalla || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    bloqueoPantalla = await navigator.wakeLock.request('screen');
    bloqueoPantalla.addEventListener('release', () => { bloqueoPantalla = null; });
  } catch { /* no disponible */ }
}

function soltarPantalla() {
  bloqueoPantalla?.release().catch(() => {});
  bloqueoPantalla = null;
}

/* ───────────── audios compartidos desde WhatsApp (Android) ───────────── */

async function recogerCompartidos() {
  if (!PARAMS.has('compartido') || !('caches' in self)) return;
  history.replaceState(null, '', location.pathname);
  try {
    const cache = await caches.open(CACHE_COMPARTIDOS);
    const archivos = [];
    for (const peticion of await cache.keys()) {
      const respuesta = await cache.match(peticion);
      if (respuesta) {
        const blob = await respuesta.blob();
        const nombre = decodeURIComponent(respuesta.headers.get('X-Nombre') || 'audio');
        archivos.push(new File([blob], nombre, { type: blob.type }));
      }
      await cache.delete(peticion);
    }
    añadirArchivos(archivos);
  } catch (err) {
    console.warn('[Léelo] no se pudieron recoger los audios compartidos', err);
  }
}

/* ───────────── service worker ───────────── */

async function registrarSW() {
  if (!('serviceWorker' in navigator) || PARAMS.has('sin-sw')) return;
  try {
    await navigator.serviceWorker.register('./sw.js');
  } catch (err) {
    console.warn('[Léelo] sin service worker', err);
    return;
  }
  if (self.crossOriginIsolated) return;
  // Si el servidor no manda las cabeceras de aislamiento, las pone el service worker: hace falta
  // recargar una vez para que Whisper pueda usar varios núcleos del procesador.
  const recargar = () => {
    if (self.crossOriginIsolated || estado.items.length || sessionStorage.getItem('leelo:recargado')) return;
    sessionStorage.setItem('leelo:recargado', '1');
    location.reload();
  };
  if (navigator.serviceWorker.controller) recargar();
  else navigator.serviceWorker.addEventListener('controllerchange', recargar, { once: true });
}

/* ───────────── eventos ───────────── */

function conectarEventos() {
  ui.elegir.addEventListener('click', () => ui.archivo.click());
  ui.archivo.addEventListener('change', () => {
    añadirArchivos(ui.archivo.files);
    ui.archivo.value = '';
  });

  // Arrastrar y soltar en toda la página
  let arrastres = 0;
  const llevaArchivos = (evento) => [...(evento.dataTransfer?.types || [])].includes('Files');
  addEventListener('dragenter', (evento) => {
    if (!llevaArchivos(evento)) return;
    arrastres += 1;
    ui.entrada.classList.add('soltando');
  });
  addEventListener('dragleave', (evento) => {
    if (!llevaArchivos(evento)) return;
    arrastres = Math.max(0, arrastres - 1);
    if (!arrastres) ui.entrada.classList.remove('soltando');
  });
  addEventListener('dragover', (evento) => {
    if (llevaArchivos(evento)) evento.preventDefault();
  });
  addEventListener('drop', (evento) => {
    if (!llevaArchivos(evento)) return;
    evento.preventDefault();
    arrastres = 0;
    ui.entrada.classList.remove('soltando');
    añadirArchivos(evento.dataTransfer.files);
  });
  addEventListener('paste', (evento) => {
    const archivos = [...(evento.clipboardData?.files || [])];
    if (archivos.length) añadirArchivos(archivos);
  });

  ui.idioma.addEventListener('change', () => {
    estado.ajustes.idioma = ui.idioma.value;
    guardarAjustes();
  });
  ui.calidades.addEventListener('change', (evento) => {
    estado.ajustes.calidad = evento.target.value;
    guardarAjustes();
    pintarNotaCalidad();
  });

  let pausa;
  ui.busqueda.addEventListener('input', () => {
    clearTimeout(pausa);
    pausa = setTimeout(buscar, 120);
  });

  ui.copiarTodo.addEventListener('click', async () => {
    const todo = listos().map((item) => `${item.nombre} (${fmtTiempo(item.duracion)})\n${item.texto}`).join('\n\n');
    if (await copiarTexto(todo)) confirmar(ui.copiarTodo, 'Copiado');
  });

  ui.borrarModelos.addEventListener('click', async () => {
    if (!confirm('¿Borrar los modelos descargados? Se volverán a descargar la próxima vez que transcribas.')) return;
    try { await caches.delete(CACHE_MODELOS); } catch { /* nada que borrar */ }
    confirmar(ui.borrarModelos, 'Borrados');
    pintarNotaCalidad();
  });

  ui.compartirApp.addEventListener('click', async () => {
    const url = new URL('./', location.href).href;
    if (PUEDE_COMPARTIR) {
      try {
        await navigator.share({ title: 'Léelo', text: 'Pasa tus audios de WhatsApp a texto gratis y sin subir nada:', url });
      } catch { /* cancelado */ }
    } else if (await copiarTexto(url)) {
      confirmar(ui.compartirApp, 'Enlace copiado');
    }
  });

  // Instalar como app (Android/escritorio): así aparece en el menú «Compartir» de WhatsApp.
  let avisoInstalar = null;
  addEventListener('beforeinstallprompt', (evento) => {
    evento.preventDefault();
    avisoInstalar = evento;
    ui.instalar.hidden = false;
  });
  ui.instalar.addEventListener('click', async () => {
    if (!avisoInstalar) return;
    avisoInstalar.prompt();
    await avisoInstalar.userChoice.catch(() => {});
    avisoInstalar = null;
    ui.instalar.hidden = true;
  });
  addEventListener('appinstalled', () => { ui.instalar.hidden = true; });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && estado.ocupado) mantenerPantalla();
  });
}

function adaptarAPlataforma() {
  const plataforma = ES_IOS ? 'ios' : ES_ANDROID ? 'android' : 'escritorio';
  $(`details[data-plataforma="${plataforma}"]`)?.setAttribute('open', '');
  if (ES_TACTIL) ui.pistaSoltar.textContent = 'Notas de voz de WhatsApp (.opus), .m4a, .mp3, .wav o vídeos.';
  // En iPhone, el filtro de tipos deja en gris las notas de voz (.opus): mejor no filtrar.
  if (ES_IOS) ui.archivo.removeAttribute('accept');
}

async function iniciar() {
  adaptarAPlataforma();
  conectarEventos();
  registrarSW();
  // Primero se mira si hay tarjeta gráfica: de eso depende qué calidades se pueden elegir.
  estado.gpu = await detectarGPU();
  if (!NOTAS[estado.ajustes.calidad]) estado.ajustes.calidad = calidadPorDefecto();
  pintarAjustes();
  pintarNotaCalidad();
  recogerCompartidos();
}

// Para pruebas automáticas.
window.leelo = {
  estado: () => estado.items.map((item) => ({
    id: item.id,
    nombre: item.nombre,
    estado: item.estado,
    mensaje: item.el.estado.textContent,
    duracion: item.duracion,
    calidad: item.calidad,
    motor: item.motor,
    segundos: item.segundos,
    texto: item.texto,
    segmentos: item.segmentos,
  })),
  aislado: () => self.crossOriginIsolated,
  gpu: () => estado.gpu,
  exportar: (id, tipo) => {
    const item = estado.items.find((otro) => otro.id === id);
    return item && (tipo === 'srt' ? subtitulos(item) : textoConTiempos(item));
  },
};

iniciar();
