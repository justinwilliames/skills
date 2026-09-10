#!/usr/bin/env python3
"""build-cover.py — brand-injectable LinkedIn cover photo (1584x396).

One command, one JSON brand kit, one verified PNG/JPG pair. The layout is fixed;
everything brand-specific comes from the kit, so the same cover can be rebuilt for a
different employer by swapping one file.

    python3 build-cover.py brand-kits/example.json --out ~/Desktop/cover

Writes <out>-1584x396.jpg and <out>-3168x792@2x.jpg, and exits non-zero if any gate
fails. Every gate below exists because the corresponding defect shipped at least once.

THE LAYOUT (fixed — this is the thing being kept consistent across brands)

    +----------------------------------------------------------------+
    |            [logo]                              .-'''''-.       |
    |            Headline line one                  (  photo   )     |
    |            Headline line two                   '.       .'     |
    |  (avatar)   Subline                              fades left    |
    +----------------------------------------------------------------+
         ^ dead zone                                    ^ bleeds off the right edge

  · A smooth aura wash as the field — analytic light layers, never a flat gradient
    and never a noise pass. Grounded on the brand's surface colour, feathering to
    the brand's canvas colour at every edge so nothing bands at the boundary.
  · The portrait bleeds off the RIGHT edge and dissolves leftward through an alpha
    ramp. No card, no border, no drop shadow — the photo becomes part of the field.
  · Text sits left-of-centre but CLEAR OF THE AVATAR CIRCLE (see SAFE_ZONE).
  · Film grain, if any, lives ONLY on the photograph. Drawn surfaces stay smooth.

WHY GRAIN GOES ON THE PHOTO ONLY
Grain is a property of film emulsion, i.e. of photography. Sprayed over a drawn
gradient it reads as JPEG artefacting or a cheap "texture" filter, and it destroys the
clean glassy quality an aura wash exists to produce. Gate G4 enforces this: the drawn
field must measure as analytically smooth.

THE CHROME-HEADLESS HEIGHT TRAP (G1)
`--window-size=W,H` does NOT give you an H-pixel viewport: Chrome subtracts roughly 89px
of browser chrome, so the document ends early and the BODY background leaks a flat bar
across the bottom of the screenshot. `--force-device-scale-factor=2` produces the same
bar by fractionally mismatching the screenshot canvas against the document. The fix used
here is both halves: render at H + CHROME_PAD and crop, and scale with a CSS
`transform:scale(2)` wrapper rather than the device-scale flag.
"""
from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageEnhance, ImageFilter

# ---------------------------------------------------------------- constants
W, H = 1584, 396          # LinkedIn's cover spec. Do not change; LinkedIn crops to 4:1.
SCALE = 2                 # supersample factor for crisp type
CHROME_PAD = 90           # see "THE CHROME-HEADLESS HEIGHT TRAP" above

# The desktop profile picture overlaps the cover's lower left. Measured off a
# rendered LinkedIn profile page, expressed in cover pixels. Anything inked inside
# this rectangle is hidden or clipped in the real product.
SAFE_ZONE = {"x0": 44, "y0": 212, "x1": 368, "y1": H}
SAFE_GAP = 40             # minimum clearance between the circle and the text block

CHROME_CANDIDATES = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "google-chrome",
    "chromium",
]


def die(msg: str) -> None:
    sys.exit(f"FAIL: {msg}")


def find_chrome() -> str:
    for c in CHROME_CANDIDATES:
        if Path(c).exists() or shutil.which(c):
            return c
    die("no Chrome/Chromium binary found — install one or add its path to CHROME_CANDIDATES")


def b64_file(path: Path) -> tuple[str, str]:
    mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return mime, base64.b64encode(path.read_bytes()).decode()


def hex_rgb(value: str) -> np.ndarray:
    v = value.lstrip("#")
    return np.array([int(v[i:i + 2], 16) for i in (0, 2, 4)], dtype=np.float32)


# ---------------------------------------------------------------- brand kit
REQUIRED = ["font", "colors", "copy"]
REQUIRED_COLORS = ["headline", "subline", "surface", "canvas", "aura"]


def load_kit(path: Path) -> dict:
    kit = json.loads(path.read_text())
    for key in REQUIRED:
        if key not in kit:
            die(f"brand kit is missing required key '{key}'")
    for key in REQUIRED_COLORS:
        if key not in kit["colors"]:
            die(f"brand kit colors is missing required key '{key}'")
    if len(kit["colors"]["aura"]) != 3:
        die("colors.aura must be exactly three hexes: [sky, lit, deep]")

    base = path.parent
    for key in ("font", "photo", "logo"):
        if kit.get(key):
            p = Path(kit[key]).expanduser()
            if not p.is_absolute():
                p = base / p
            if not p.exists():
                die(f"{key} not found: {p}")
            kit[key] = p
    if not kit.get("logo") and not kit.get("wordmark_text"):
        die("brand kit needs either 'logo' (svg/png) or 'wordmark_text'")
    if not kit.get("photo"):
        die("brand kit needs 'photo' — a portrait to bleed off the right edge")
    return kit


# ---------------------------------------------------------------- the aura field
def build_aura(kit: dict) -> Image.Image:
    """Analytic light wash. Four soft elliptical layers over the brand surface colour,
    every edge feathered to the brand canvas colour so the field never bands where it
    meets a flat background. No noise is ever added here — see gate G4."""
    w, h = W * SCALE, H * SCALE
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    surface = hex_rgb(kit["colors"]["surface"])
    canvas_c = hex_rgb(kit["colors"]["canvas"])
    sky, lit, deep = (hex_rgb(c) for c in kit["colors"]["aura"])
    field = np.tile(surface, (h, w, 1)).astype(np.float32)

    def layer(cx, cy, rx, ry, color, alpha, power):
        r = np.sqrt(((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2)
        a = (np.clip(1 - r, 0, 1) ** power * alpha)[..., None]
        return a, color[None, None, :]

    # Weighted toward the right so the wash meets the portrait rather than fighting
    # the headline. Powers >1 keep the falloff soft enough to avoid a visible rim.
    layers = [
        (w * 0.66, h * 0.70, w * 0.46, h * 1.15, sky, 0.40, 1.8),
        (w * 0.60, h * 0.62, w * 0.26, h * 0.80, lit, 0.48, 1.4),
        (w * 0.74, h * 0.86, w * 0.30, h * 0.70, deep, 0.09, 2.2),
    ]
    if kit["colors"].get("kiss"):
        layers.append((w * 0.13, h * 0.88, w * 0.24, h * 0.62, hex_rgb(kit["colors"]["kiss"]), 0.30, 1.8))

    for cx, cy, rx, ry, col, al, pw in layers:
        a, c = layer(cx, cy, rx, ry, col, al, pw)
        field = field * (1 - a) + c * a

    dist = np.minimum.reduce([xx, yy, w - 1 - xx, h - 1 - yy])
    fe = np.clip(dist / (110.0 * SCALE / 2), 0, 1)[..., None]
    field = canvas_c * (1 - fe) + field * fe
    return Image.fromarray(np.clip(field, 0, 255).astype(np.uint8))


# ---------------------------------------------------------------- the portrait
def prepare_photo(kit: dict, grade: str, grain: float) -> Image.Image:
    """Crop to the panel ratio, optionally apply a film grade, then add monochrome
    grain — on the photograph only."""
    src = Image.open(kit["photo"]).convert("RGB")
    panel_w = int(kit.get("photo_width", 648))
    target = (panel_w * SCALE, H * SCALE)

    # Cover-crop to the panel aspect, biased by photo_anchor so the subject can be
    # pushed clear of the alpha ramp without hand-cropping the source.
    ratio = target[0] / target[1]
    sw, sh = src.size
    if sw / sh > ratio:
        new_w = int(sh * ratio)
        ax = float(kit.get("photo_anchor_x", 0.5))
        x0 = int(np.clip((sw - new_w) * ax, 0, sw - new_w))
        src = src.crop((x0, 0, x0 + new_w, sh))
    else:
        new_h = int(sw / ratio)
        ay = float(kit.get("photo_anchor_y", 0.25))
        y0 = int(np.clip((sh - new_h) * ay, 0, sh - new_h))
        src = src.crop((0, y0, sw, y0 + new_h))
    im = src.resize(target, Image.LANCZOS)

    x = np.asarray(im, np.float32) / 255.0
    if grade == "film":
        # Colour-negative behaviour: warm the shadows, pull blue in the mids, gentle
        # S-curve for contrast, soft shoulder so nothing clips to paper white.
        lift = np.array([0.022, 0.014, 0.010], np.float32)
        x = x * (1 - lift) + lift
        x = np.clip(x, 0, 1) ** np.array([0.985, 1.000, 1.030], np.float32)
        s = x * x * (3 - 2 * x)
        x = np.clip(x * 0.62 + s * 0.38, 0, 1)
        x = 1 - (1 - x) ** 1.06
        g = Image.fromarray((np.clip(x, 0, 1) * 255).astype(np.uint8))
        # Halation: a warm bloom off the brightest areas, as film scatters in the base.
        lum = np.asarray(g.convert("L"), np.float32) / 255.0
        m = np.clip((lum - 0.78) / 0.22, 0, 1)
        bm = np.asarray(Image.fromarray((m * 255).astype(np.uint8)).filter(
            ImageFilter.GaussianBlur(9 * SCALE // 2)), np.float32)[..., None] / 255.0
        arr = np.clip(np.asarray(g, np.float32) / 255.0
                      + bm * np.array([1.0, 0.86, 0.72], np.float32) * 0.085, 0, 1)
        im = ImageEnhance.Color(Image.fromarray((arr * 255).astype(np.uint8))).enhance(0.94)

    if grain > 0:
        arr = np.asarray(im, np.float32)
        rng = np.random.default_rng(7)
        noise = rng.normal(0, grain, arr.shape[:2])[..., None]
        # Film grain peaks in the midtones and thins in deep shadow and blown highlight.
        lum = arr.mean(axis=2, keepdims=True) / 255.0
        weight = np.clip(1.25 - np.abs(lum - 0.45) * 1.5, 0.35, 1.0)
        im = Image.fromarray(np.clip(arr + noise * weight, 0, 255).astype(np.uint8))
    return im


# ---------------------------------------------------------------- compose + render
HTML = """<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{{font-family:'Display';src:url(data:font/ttf;base64,{font}) format('truetype');font-weight:100 900;}}
*{{margin:0;padding:0;box-sizing:border-box}}
html,body{{width:{sw}px;height:{sh}px;overflow:hidden;background:{canvas}}}
.scale{{transform:scale({scale});transform-origin:0 0;width:{w}px;height:{h}px}}
.cover{{position:relative;width:{w}px;height:{h}px;font-family:'Display',system-ui,sans-serif;
  overflow:hidden;background-image:url(data:image/png;base64,{aura});background-size:100% 100%}}
.photo{{position:absolute;right:0;top:0;width:{pw}px;height:{h}px;object-fit:cover;object-position:50% 50%;
  -webkit-mask-image:linear-gradient(to right,rgba(0,0,0,0) 0%,rgba(0,0,0,.12) 20%,rgba(0,0,0,.55) 38%,rgba(0,0,0,.92) 56%,#000 70%);
          mask-image:linear-gradient(to right,rgba(0,0,0,0) 0%,rgba(0,0,0,.12) 20%,rgba(0,0,0,.55) 38%,rgba(0,0,0,.92) 56%,#000 70%);}}
.content{{position:absolute;left:{cl}px;top:0;height:{h}px;width:{cw}px;
  display:flex;flex-direction:column;justify-content:center}}
.logo{{width:{lw}px;margin-bottom:20px}}
.wordmark{{font-weight:800;font-size:38px;letter-spacing:-.5px;color:{c_headline};margin-bottom:18px}}
h1{{font-weight:{dw};font-size:{hs}px;line-height:1.11;letter-spacing:0;color:{c_headline}}}
p{{margin-top:15px;font-weight:500;font-size:{ss}px;line-height:1.45;color:{c_subline}}}
</style></head><body><div class="scale"><div class="cover">
<img class="photo" src="data:{pmime};base64,{photo}">
<div class="content">{mark}
  <h1>{headline}</h1>
  <p>{sub}</p>
</div>
</div></div></body></html>"""


def render(kit: dict, aura: Image.Image, photo: Image.Image, tmp: Path) -> Image.Image:
    aura_p, photo_p = tmp / "aura.png", tmp / "photo.jpg"
    aura.save(aura_p)
    photo.save(photo_p, quality=95, subsampling=0)

    if kit.get("logo"):
        lmime, ldata = b64_file(kit["logo"])
        mark = f'\n  <img class="logo" src="data:{lmime};base64,{ldata}">'
    else:
        mark = f'\n  <div class="wordmark">{kit["wordmark_text"]}</div>'

    content_left = int(kit.get("content_left", SAFE_ZONE["x1"] + SAFE_GAP))
    html = HTML.format(
        font=b64_file(kit["font"])[1],
        aura=base64.b64encode(aura_p.read_bytes()).decode(),
        photo=base64.b64encode(photo_p.read_bytes()).decode(),
        pmime="image/jpeg",
        sw=W * SCALE, sh=H * SCALE, w=W, h=H, scale=SCALE,
        pw=int(kit.get("photo_width", 648)),
        cl=content_left, cw=int(kit.get("content_width", 600)),
        lw=int(kit.get("logo_width", 206)),
        dw=int(kit.get("font_weight_display", 800)),
        hs=int(kit.get("headline_size", 45)), ss=int(kit.get("subline_size", 18.5)),
        canvas=kit["colors"]["canvas"], c_headline=kit["colors"]["headline"],
        c_subline=kit["colors"]["subline"],
        mark=mark,
        headline="<br>".join(kit["copy"]["headline"]),
        sub=kit["copy"].get("subline", ""),
    )
    page = tmp / "cover.html"
    page.write_text(html)
    shot = tmp / "shot.png"
    subprocess.run(
        [find_chrome(), "--headless", "--disable-gpu", "--hide-scrollbars",
         f"--window-size={W * SCALE},{H * SCALE + CHROME_PAD}",
         f"--screenshot={shot}", f"file://{page}"],
        check=True, capture_output=True,
    )
    return Image.open(shot).convert("RGB").crop((0, 0, W * SCALE, H * SCALE))


# ---------------------------------------------------------------- gates
def verify(img: Image.Image, aura: Image.Image, kit: dict) -> list[str]:
    """Every gate here maps to a defect that shipped. Returns a list of failures."""
    fails: list[str] = []
    a = np.asarray(img, np.float32)
    canvas_c = hex_rgb(kit["colors"]["canvas"])

    # G1 — no dead bar on any edge (the Chrome height trap, and letterboxed photos).
    for name, strip in (("top", a[0]), ("bottom", a[-1]), ("left", a[:, 0]), ("right", a[:, -1])):
        mean = strip.mean(axis=0)
        if mean.max() < 24 or mean.min() > 250:
            fails.append(f"G1 dead {name} bar: mean RGB {mean.round(1).tolist()}")

    # G2 — the profile circle must not cover text. Geometric, so it cannot be fooled
    # by a coincidentally pale background.
    content_left = int(kit.get("content_left", SAFE_ZONE["x1"] + SAFE_GAP))
    if content_left < SAFE_ZONE["x1"] + SAFE_GAP:
        fails.append(f"G2 content_left {content_left}px intrudes on the avatar circle "
                     f"(needs >= {SAFE_ZONE['x1'] + SAFE_GAP})")

    # G3 — and no dark ink of any kind inside the circle, which also catches a photo
    # subject or logo that drifted left.
    z = a[SAFE_ZONE["y0"] * SCALE:SAFE_ZONE["y1"] * SCALE,
          SAFE_ZONE["x0"] * SCALE:SAFE_ZONE["x1"] * SCALE]
    dark = float((z.mean(axis=2) < 120).mean())
    if dark > 0.01:
        fails.append(f"G3 {dark:.1%} of the avatar safe zone is dark ink (limit 1%)")

    # G4 — the drawn field is smooth. Grain on a drawn surface reads as artefacting.
    f = np.asarray(aura.convert("RGB"), np.float32)[:, :, 2]
    hf = f - np.asarray(Image.fromarray(f.astype(np.uint8)).filter(ImageFilter.GaussianBlur(3)), np.float32)
    if float(hf.std()) > 0.5:
        fails.append(f"G4 aura field is not smooth: high-frequency residual {hf.std():.3f} (limit 0.5)")

    # G5 — the field's corners land on the declared canvas token, so the cover meets a
    # flat page background without a visible seam.
    for cy, cx, label in ((0, 0, "top-left"), (0, -1, "top-right"), (-1, 0, "bottom-left"), (-1, -1, "bottom-right")):
        if np.abs(np.asarray(aura, np.float32)[cy, cx] - canvas_c).max() > 2:
            fails.append(f"G5 {label} corner is not the canvas token {kit['colors']['canvas']}")

    # G6 — LinkedIn's mobile app centre-crops the cover. Warn (do not fail) when the
    # headline block reaches outside the reliably visible middle.
    if content_left < W * 0.20:
        fails.append(f"G6 WARN content starts at {content_left}px — mobile may crop it")
    return fails


# ---------------------------------------------------------------- entry point
def main() -> None:
    ap = argparse.ArgumentParser(description="Build a brand-injectable LinkedIn cover photo.")
    ap.add_argument("kit", type=Path, help="path to a brand-kit JSON")
    ap.add_argument("--out", type=Path, required=True, help="output path prefix (no extension)")
    ap.add_argument("--grade", choices=["film", "none"], default="film",
                    help="colour grade applied to the portrait (default: film)")
    ap.add_argument("--grain", type=float, default=6.5,
                    help="film grain sigma, photo only; 0 disables (default: 6.5)")
    args = ap.parse_args()

    kit = load_kit(args.kit)
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        aura = build_aura(kit)
        photo = prepare_photo(kit, args.grade, args.grain)
        full = render(kit, aura, photo, tmp)

        fails = [f for f in verify(full, aura, kit) if not f.startswith("G6 WARN")]
        warns = [f for f in verify(full, aura, kit) if f.startswith("G6 WARN")]

        args.out.parent.mkdir(parents=True, exist_ok=True)
        two_x = args.out.with_name(f"{args.out.name}-{W * SCALE}x{H * SCALE}@2x.jpg")
        one_x = args.out.with_name(f"{args.out.name}-{W}x{H}.jpg")
        full.save(two_x, quality=92, subsampling=0)
        full.resize((W, H), Image.LANCZOS).save(one_x, quality=93, subsampling=0)

    for w in warns:
        print(f"WARN: {w}")
    if fails:
        for f in fails:
            print(f"FAIL: {f}", file=sys.stderr)
        sys.exit(f"{len(fails)} gate(s) failed — cover written but NOT ship-ready.")
    print(f"PASS all gates\n  {one_x}\n  {two_x}")


if __name__ == "__main__":
    main()
