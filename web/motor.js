// Léelo · motor de transcripción (Web Worker de tipo módulo).
// Ejecuta Whisper en el propio dispositivo con transformers.js. Lo único que viaja por la red es
// la descarga del modelo (una vez, desde Hugging Face) y la de la propia librería (jsDelivr).
// Ni el audio ni el texto salen de aquí.

import {
  pipeline,
  WhisperTextStreamer,
  env,
} from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2/dist/transformers.min.js';

env.allowLocalModels = false;

const MUESTREO = 16000;
const VENTANA_S = 30; // Whisper trabaja en tramos de 30 s
const SOLAPE_S = 5; // solape entre tramos para no cortar palabras

let cargado = { clave: null, asr: null };
let modo = null; // 'wasm' o 'webgpu': lo fija el primer encargo; para cambiarlo, app.js crea otro motor

const avisar = (tipo, datos) => self.postMessage({ tipo, ...datos });

function configurar(cfg) {
  if (modo) return;
  modo = cfg.dispositivo;
  const onnx = env.backends.onnx;
  if (modo !== 'wasm' || !onnx?.wasm) return;
  // Sin tarjeta gráfica: la versión de onnxruntime solo-CPU pesa la mitad (14 MB) y va más rápida
  // que la «asyncify» que la librería usa por defecto (preparada también para WebGPU).
  const version = onnx.versions?.web;
  if (version) {
    const base = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${version}/dist/`;
    onnx.wasm.wasmPaths = { mjs: `${base}ort-wasm-simd-threaded.mjs`, wasm: `${base}ort-wasm-simd-threaded.wasm` };
  }
  // Hilos: el valor de onnxruntime (mitad de los núcleos, máximo 4) fue el más rápido en las pruebas;
  // con 8 hilos un M5 tardaba un 60 % más. Solo se cambia con ?hilos=N para medir.
  if (cfg.hilos) onnx.wasm.numThreads = cfg.hilos;
}

async function preparar(cfg, id) {
  configurar(cfg);
  const clave = JSON.stringify(cfg);
  if (cargado.clave === clave) return cargado.asr;
  if (cargado.asr) {
    try { await cargado.asr.dispose(); } catch { /* da igual */ }
    cargado = { clave: null, asr: null };
  }
  let ultimo = 0;
  const asr = await pipeline('automatic-speech-recognition', cfg.modelo, {
    device: cfg.dispositivo,
    dtype: cfg.dtype,
    progress_callback: (p) => {
      if (p.status !== 'progress_total') return;
      const ahora = Date.now();
      if (ahora - ultimo < 200 && p.progress < 100) return;
      ultimo = ahora;
      avisar('carga', { id, progreso: p.progress, cargado: p.loaded, total: p.total });
    },
  });
  cargado = { clave, asr };
  return asr;
}

// Mismo cálculo que hace el pipeline al trocear, para poder enseñar «tramo 2 de 3».
function contarTramos(muestras) {
  const ventana = MUESTREO * VENTANA_S;
  const salto = ventana - 2 * MUESTREO * SOLAPE_S;
  let tramos = 1;
  for (let inicio = 0; inicio + ventana < muestras; inicio += salto) tramos += 1;
  return tramos;
}

// Frases que Whisper se inventa en silencios (vienen de los subtítulos con los que se entrenó).
const ALUCINACIONES = [
  /subt[ií]tulos (?:realizados )?por la comunidad de amara\.org\.?/gi,
  /subt[ií]tulos (?:en espa[ñn]ol )?(?:de|por) amara\.org\.?/gi,
  /subt[ií]tulos realizados por la comunidad de amara\.org\.?/gi,
];

function limpiar(texto) {
  let t = texto;
  for (const re of ALUCINACIONES) t = t.replace(re, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

const FIN_DE_FRASE = /[.?!…]["»”')]*$/;
const PAUSA_S = 1.5; // una pausa así de larga también corta la frase
const MAX_PALABRAS = 40;

// Whisper devuelve palabras sueltas con su tiempo; aquí se agrupan en frases para leerlas cómodas:
// { ini, fin, texto, palabras: [{ ini, fin, texto }] }. texto = palabras unidas tal cual.
function frasesDesdePalabras(palabras, duracion) {
  const frases = [];
  let actual = null;
  const cerrar = () => {
    if (actual?.palabras.length) {
      actual.texto = actual.palabras.map((p) => p.texto).join('');
      frases.push(actual);
    }
    actual = null;
  };
  for (const c of palabras) {
    const texto = (c.text ?? '').replace(/\s+/g, ' ');
    if (!texto.trim()) continue;
    const previa = actual?.palabras.at(-1);
    let [ini, fin] = c.timestamp ?? [];
    ini = Number.isFinite(ini) ? ini : (previa?.fin ?? 0);
    fin = Number.isFinite(fin) && fin >= ini ? fin : ini;
    ini = Math.min(Math.max(0, ini), duracion);
    fin = Math.min(Math.max(ini, fin), duracion);
    if (actual && (ini - previa.fin > PAUSA_S || actual.palabras.length >= MAX_PALABRAS)) cerrar();
    if (!actual) actual = { ini, fin, palabras: [] };
    actual.palabras.push({ ini, fin, texto: actual.palabras.length ? texto : texto.trimStart() });
    actual.fin = fin;
    const larga = actual.palabras.length >= 20 && /[,;:]$/.test(texto.trim());
    if ((FIN_DE_FRASE.test(texto.trim()) && actual.palabras.length >= 3) || larga) cerrar();
  }
  cerrar();

  // Limpieza: frases inventadas en silencios y bucles en los que Whisper repite lo mismo.
  const limpias = [];
  for (const frase of frases) {
    if (!limpiar(frase.texto)) continue;
    const anterior = limpias.at(-1);
    if (anterior && anterior.texto.trim() === frase.texto.trim() && frase.texto.length > 12) {
      anterior.fin = frase.fin;
      continue;
    }
    limpias.push(frase);
  }
  return limpias;
}

// Modelos sin tiempo por palabra (Buena y Rápida): Whisper da frases cortas (1-5 s) con su tiempo y
// el de cada palabra se reparte según su posición en la frase. Se equivoca menos de un segundo y
// cuesta la mitad que pedir el tiempo exacto (en las pruebas: «precio» a 9,88 s frente a 9,94 s).
function frasesDesdeSegmentos(segmentos, duracion) {
  const frases = [];
  segmentos.forEach((c, n) => {
    const texto = limpiar(c.text ?? '');
    if (!texto) return;
    const anterior = frases.at(-1);
    let [ini, fin] = c.timestamp ?? [];
    ini = Number.isFinite(ini) ? ini : (anterior?.fin ?? 0);
    const siguiente = segmentos[n + 1]?.timestamp?.[0];
    fin = Number.isFinite(fin) && fin > ini ? fin : (Number.isFinite(siguiente) ? siguiente : duracion);
    ini = Math.min(Math.max(0, ini), duracion);
    fin = Math.min(Math.max(ini, fin), duracion);
    if (anterior && anterior.texto === texto && texto.length > 12) { // bucle de Whisper
      anterior.fin = fin;
      return;
    }
    const trozos = texto.match(/\s*\S+/g) ?? [texto];
    const palabras = [];
    let pos = 0;
    for (const trozo of trozos) {
      const t = ini + ((fin - ini) * pos) / texto.length;
      palabras.push({ ini: t, fin: t, texto: trozo });
      pos += trozo.length;
    }
    palabras.forEach((p, k) => { p.fin = palabras[k + 1]?.ini ?? fin; });
    frases.push({ ini, fin, texto, palabras, estimado: true });
  });
  return frases;
}

self.onmessage = async ({ data }) => {
  if (data?.tipo !== 'transcribir') return;
  const { id, audio, cfg, idioma } = data;
  try {
    const t0 = performance.now();
    const asr = await preparar(cfg, id);
    const t1 = performance.now();
    avisar('modelo-listo', { id, segundos: (t1 - t0) / 1000 });

    const total = contarTramos(audio.length);
    let hechos = 0;
    avisar('tramo', { id, hechos, total });

    const streamer = new WhisperTextStreamer(asr.tokenizer, {
      skip_prompt: true,
      callback_function: (texto) => avisar('parcial', { id, texto }),
      on_finalize: () => {
        hechos += 1;
        avisar('tramo', { id, hechos, total });
      },
    });

    const salida = await asr(audio, {
      language: idioma,
      task: 'transcribe',
      chunk_length_s: VENTANA_S,
      stride_length_s: SOLAPE_S,
      // Tiempos para el buscador y para escuchar desde una palabra: exactos por palabra con los
      // modelos que lo traen («_timestamped»), por frase con los demás.
      return_timestamps: cfg.palabras ? 'word' : true,
      streamer,
    });

    const duracion = audio.length / MUESTREO;
    const trozos = salida?.chunks?.length ? salida.chunks : [{ text: salida?.text ?? '', timestamp: [0, duracion] }];
    const segmentos = cfg.palabras ? frasesDesdePalabras(trozos, duracion) : frasesDesdeSegmentos(trozos, duracion);
    avisar('fin', {
      id,
      segmentos,
      texto: segmentos.map((s) => s.texto.trim()).join(' '),
      segundos: (performance.now() - t1) / 1000,
      carga: (t1 - t0) / 1000,
      motor: modo === 'wasm' ? `wasm · ${env.backends.onnx?.wasm?.numThreads} hilos` : modo,
    });
  } catch (err) {
    console.error('[Léelo] fallo en el motor', err);
    avisar('error', { id, mensaje: String(err?.message ?? err), gpu: cfg?.dispositivo === 'webgpu' });
  }
};
