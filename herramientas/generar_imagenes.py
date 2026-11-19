#!/usr/bin/env python3
"""Genera los iconos PNG y la imagen de vista previa (og.png) de Léelo con Chrome sin ventana.

Uso:  python3 herramientas/generar_imagenes.py
Escribe en web/iconos/ y web/og.png.
"""
import pathlib
import subprocess
import tempfile

RAIZ = pathlib.Path(__file__).resolve().parent.parent
WEB = RAIZ / "web"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

VERDE = "#117555"
PAPEL = "#faf6ef"
TINTA = "#182029"
TENUE = "#535c65"


def burbuja(escala: float = 1.0) -> str:
    """Bocadillo con tres líneas de texto, centrado en un lienzo de 512×512."""
    return f"""
  <g transform="translate(256 256) scale({escala}) translate(-256 -256)">
    <g fill="{PAPEL}">
      <rect x="84" y="112" width="344" height="256" rx="76"/>
      <path d="M150 334 L124 424 Q120 438 133 431 L252 356 Z"/>
    </g>
    <g fill="{VERDE}">
      <rect x="146" y="176" width="220" height="30" rx="15"/>
      <rect x="146" y="226" width="178" height="30" rx="15"/>
      <rect x="146" y="276" width="110" height="30" rx="15" opacity=".5"/>
    </g>
  </g>"""


def icono_svg(redondeado: bool, escala: float) -> str:
    fondo = f'<rect width="512" height="512" rx="118" fill="{VERDE}"/>' if redondeado else f'<rect width="512" height="512" fill="{VERDE}"/>'
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">{fondo}{burbuja(escala)}\n</svg>\n'


def captura(html: str, salida: pathlib.Path, ancho: int, alto: int, transparente: bool) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        pagina = pathlib.Path(tmp) / "pagina.html"
        pagina.write_text(html, encoding="utf-8")
        orden = [
            CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
            f"--window-size={ancho},{alto}", "--virtual-time-budget=3000", f"--screenshot={salida}",
        ]
        if transparente:
            orden.append("--default-background-color=00000000")
        orden.append(pagina.as_uri())
        subprocess.run(orden, check=True, capture_output=True, timeout=60)


def pagina_icono(svg: str, lado: int) -> str:
    return f"""<!doctype html><html><head><style>
html,body{{margin:0;background:transparent}} svg{{display:block;width:{lado}px;height:{lado}px}}
</style></head><body>{svg}</body></html>"""


def pagina_og() -> str:
    fuentes = (WEB / "fuentes").as_uri()
    lupa = f'<svg viewBox="0 0 24 24" width="26" height="26"><circle cx="11" cy="11" r="6.5" fill="none" stroke="{TENUE}" stroke-width="2"/><path d="M16 16l4.5 4.5" stroke="{TENUE}" stroke-width="2" stroke-linecap="round"/></svg>'
    return f"""<!doctype html><html lang="es"><head><meta charset="utf-8"><style>
@font-face{{font-family:'Instrument Serif';src:url('{fuentes}/instrument-serif.woff2') format('woff2')}}
@font-face{{font-family:'Atkinson';src:url('{fuentes}/atkinson-next.woff2') format('woff2');font-weight:400 700}}
html,body{{margin:0}}
body{{width:1200px;height:630px;box-sizing:border-box;padding:0 76px;background:{PAPEL};color:{TINTA};
  font-family:'Atkinson',sans-serif;display:grid;grid-template-columns:minmax(0,1fr) 500px;gap:56px;align-items:center}}
.logo{{margin:0;font:400 156px/0.9 'Instrument Serif',serif;letter-spacing:-0.025em}}
.lema{{margin:26px 0 14px;font-size:40px;font-weight:700;line-height:1.15}}
.sub{{margin:0;font-size:25px;line-height:1.4;color:{TENUE};text-wrap:pretty}}
.tarjeta{{background:#fffdfa;border:1px solid #e6e0d4;border-radius:24px;padding:26px;display:grid;gap:10px;
  box-shadow:0 24px 48px -28px rgba(20,30,40,.45)}}
.busca{{display:flex;align-items:center;gap:12px;border:2px solid {VERDE};border-radius:16px;padding:12px 16px;font-size:25px;margin-bottom:4px}}
.resumen{{font-size:19px;color:{TENUE};margin:2px 4px 6px}}
.fila{{display:grid;grid-template-columns:64px minmax(0,1fr);gap:10px;font-size:23px;line-height:1.4;padding:8px 4px;border-radius:12px}}
.fila.activa{{background:#dbf4e8}}
.t{{color:{VERDE};font-weight:700}}
mark{{background:#a9dcc4;color:inherit;border-radius:5px;padding:0 3px}}
</style></head><body>
<div>
  <p class="logo">Léelo</p>
  <p class="lema">Tus audios de WhatsApp, en&nbsp;texto.</p>
  <p class="sub">Gratis, sin cuentas y sin subir nada.<br>Busca una palabra y mira en qué minuto se dice.</p>
</div>
<div class="tarjeta">
  <div class="busca">{lupa}<span>precio</span></div>
  <p class="resumen">Aparece 2 veces. Toca una para escucharla.</p>
  <div class="fila activa"><span class="t">0:12</span><span>…están dispuestos a bajar el <mark>precio</mark> a doscientos diez mil euros…</span></div>
  <div class="fila"><span class="t">1:48</span><span>…y que el <mark>precio</mark> incluya la plaza de garaje…</span></div>
</div>
</body></html>"""


def main() -> None:
    iconos = WEB / "iconos"
    iconos.mkdir(parents=True, exist_ok=True)

    svg_redondo = icono_svg(redondeado=True, escala=1.0)
    (iconos / "icono.svg").write_text(svg_redondo, encoding="utf-8")

    captura(pagina_icono(svg_redondo, 192), iconos / "icono-192.png", 192, 192, transparente=True)
    captura(pagina_icono(svg_redondo, 512), iconos / "icono-512.png", 512, 512, transparente=True)
    # Maskable: fondo a sangre y dibujo dentro de la zona segura (círculo del 80 %).
    captura(pagina_icono(icono_svg(False, 0.74), 512), iconos / "icono-maskable-512.png", 512, 512, transparente=False)
    # iOS redondea él solo las esquinas.
    captura(pagina_icono(icono_svg(False, 0.86), 180), iconos / "apple-touch-icon.png", 180, 180, transparente=False)
    captura(pagina_og(), WEB / "og.png", 1200, 630, transparente=False)

    for archivo in sorted([*iconos.glob("*.png"), WEB / "og.png"]):
        print(f"{archivo.relative_to(RAIZ)}  {archivo.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
