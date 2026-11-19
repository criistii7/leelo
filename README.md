# Léelo

**Tus audios de WhatsApp, en texto.** Gratis, sin cuentas y sin subir nada: la transcripción se hace en el propio móvil u ordenador de quien la usa, con [Whisper](https://github.com/openai/whisper) ejecutándose en el navegador mediante [transformers.js](https://huggingface.co/docs/transformers.js).

## Qué hace

- Transcribe notas de voz de WhatsApp (`.opus`), `.m4a`, `.mp3`, `.wav` y el audio de vídeos `.mp4`. Varios a la vez.
- **Buscador**: escribe una o varias palabras (separadas por comas, sin preocuparte de tildes) y te dice **en qué minuto y segundo** se dice cada una. Al tocarla, el audio suena justo desde ahí.
- Toca cualquier palabra del texto para escuchar desde ese punto; mientras suena, se ilumina la palabra que se está diciendo.
- Copiar, compartir, descargar `.txt` (con minutos) y subtítulos `.srt`.
- En Android, una vez instalada, aparece en el menú **Compartir** de WhatsApp.
- Funciona sin conexión después de la primera vez.

## Privacidad

El audio y el texto no salen del dispositivo. Lo único que se descarga de internet es la propia app, la librería (jsDelivr) y el modelo de voz (Hugging Face), una sola vez; después queda en la caché del navegador.

## Calidades

Medido en un Mac M5 con una nota de voz de 41 s:

| Calidad | Modelo | Motor | Tarda | Descarga |
|---|---|---|---|---|
| Máxima (por defecto en ordenador con GPU) | whisper-large-v3-turbo (`_timestamped`, q4f16) | WebGPU | 20 s, segundo exacto de cada palabra | ≈ 564 MB |
| Buena (por defecto en móvil) | whisper-small (q4) | WebGPU | 14 s | ≈ 300 MB |
| Buena sin GPU | whisper-small (q8) | WASM, 4 hilos | 42 s | ≈ 250 MB |
| Rápida | whisper-base (q8) | WASM, 4 hilos | 16 s | ≈ 77 MB |

Con Buena y Rápida, el segundo de cada palabra se estima dentro de su frase (frases de 1-5 s): en las pruebas, «precio» salió a 9,88 s frente a 9,94 s exactos.

## Estructura

```
web/                 la app (estática: se publica tal cual)
  index.html, estilos.css
  app.js             interfaz, cola, decodificación, búsqueda, reproductor
  motor.js           Web Worker con Whisper (transformers.js 4.3.2)
  sw.js              sin conexión, «Compartir» de Android, cabeceras COOP/COEP
  manifest.webmanifest, _headers, iconos/, fuentes/, og.png
herramientas/
  servir.py          servidor local con las cabeceras de aislamiento
  generar_imagenes.py  iconos y og.png con Chrome sin ventana
pruebas/
  audios/            notas de voz sintéticas (voz de macOS) y su texto
  wer.py             tasa de error por palabra frente al texto de referencia
```

## Probar en local

```
python3 herramientas/servir.py          # http://localhost:8792 (cambia con --puerto)
python3 herramientas/servir.py --sin-aislar   # simula un alojamiento sin cabeceras
```

Parámetros de prueba en la URL: `?modelo=onnx-community/whisper-small&dispositivo=webgpu&dtype=q4` (forzar modelo), `&palabras` (tiempo exacto por palabra), `&hilos=4`, `?sin-gpu`, `?opus-wasm` (forzar el decodificador .opus de respaldo), `?sin-sw`.

## Publicar

Es una web estática: vale cualquier alojamiento. Whisper necesita «aislamiento» (COOP + COEP) para usar varios núcleos; `_headers` lo pone en Netlify y Cloudflare Pages, y si el alojamiento no deja (GitHub Pages), lo pone el service worker y la página se recarga una vez.

## Créditos

Whisper (OpenAI, MIT) · transformers.js (Hugging Face, Apache-2.0) · ONNX Runtime Web (MIT) · ogg-opus-decoder (MIT) · Atkinson Hyperlegible Next e Instrument Serif (SIL OFL).
