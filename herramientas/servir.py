#!/usr/bin/env python3
"""Servidor local de pruebas para Léelo.

Sirve web/ con las mismas cabeceras que _headers (COOP + COEP), que permiten a Whisper usar
varios núcleos. Con --sin-aislar las quita, para probar el caso de un alojamiento que no deja
poner cabeceras (entonces las añade el service worker).

Uso:  python3 herramientas/servir.py [--puerto 8792] [--sin-aislar]
"""
import argparse
import functools
import http.server
import pathlib

WEB = pathlib.Path(__file__).resolve().parent.parent / "web"


class Manejador(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".webmanifest": "application/manifest+json",
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".wasm": "application/wasm",
        ".woff2": "font/woff2",
    }

    def end_headers(self):
        if not self.server.sin_aislar:
            self.send_header("Cross-Origin-Opener-Policy", "same-origin")
            self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, formato, *args):  # menos ruido en la terminal
        if self.command != "GET" or " 200 " not in (formato % args):
            super().log_message(formato, *args)


def main():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--puerto", type=int, default=8792)
    p.add_argument("--sin-aislar", action="store_true", help="no mandar COOP/COEP")
    args = p.parse_args()
    servidor = http.server.ThreadingHTTPServer(("127.0.0.1", args.puerto), functools.partial(Manejador, directory=str(WEB)))
    servidor.sin_aislar = args.sin_aislar
    print(f"Léelo en http://localhost:{args.puerto}/  ({'sin' if args.sin_aislar else 'con'} aislamiento)")
    servidor.serve_forever()


if __name__ == "__main__":
    main()
