#!/usr/bin/env python3
"""Tasa de error por palabra (WER) de una transcripción frente al texto de referencia.

Uso:  python3 pruebas/wer.py referencia.txt "texto transcrito"
Normaliza minúsculas, tildes y puntuación, y escribe los números como en la referencia no hace
falta: las cifras («210.000») cuentan como error si la referencia las tiene en letra.
"""
import re
import sys
import unicodedata


def palabras(texto: str) -> list[str]:
    t = unicodedata.normalize("NFD", texto.lower())
    t = "".join(c for c in t if unicodedata.category(c) != "Mn")
    return re.findall(r"[a-z0-9ñ]+", t)


def wer(ref: list[str], hip: list[str]) -> tuple[float, int]:
    d = list(range(len(hip) + 1))
    for i, r in enumerate(ref, 1):
        anterior, d[0] = d[0], i
        for j, h in enumerate(hip, 1):
            actual = min(d[j] + 1, d[j - 1] + 1, anterior + (r != h))
            anterior, d[j] = d[j], actual
    return d[-1] / max(1, len(ref)), d[-1]


if __name__ == "__main__":
    referencia = open(sys.argv[1], encoding="utf-8").read()
    tasa, errores = wer(palabras(referencia), palabras(sys.argv[2]))
    print(f"WER {tasa:.1%} ({errores} errores en {len(palabras(referencia))} palabras)")
