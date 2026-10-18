#!/usr/bin/env python3
"""Generate the whole PWA / home-screen icon set from ONE source artwork.

    python3 scripts/gen-icons.py        (run from PinballGenieWeb/app)

Source of truth: app/assets-src/app-icon-source.png — the turbaned-skull
"PINBALL GENIE" logo (rolo, 2026-07-31). Everything under app/public/icons/ is DERIVED and
regenerable; edit the source and re-run, never hand-edit the outputs.

Rewritten 2026-07-31. It previously generated only the two `maskable` variants
FROM the two `any` icons, which meant the `any` icons themselves were
hand-placed files with no reproducible origin, and there was no
correctly-sized apple-touch-icon at all.

--------------------------------------------------------------------------
THE THREE CONSUMERS WANT DIFFERENT THINGS. That is the whole reason this
script is not a one-liner.

1. `purpose: "any"` (192/512) — used as-is, no cropping. Full bleed.

2. `purpose: "maskable"` (192/512) — Android adaptive icons crop to an
   arbitrary mask (circle, squircle, teardrop, per launcher). The guaranteed
   safe zone is a CIRCLE of 80% of the width, i.e. radius <= 40% — NOT an 80%
   square, which is the usual misreading. A square artwork inscribed in that
   circle can only be 80%/sqrt(2) ~= 56.6% of the canvas:

       scale s  ->  content corner radius = s * sqrt(2) / 2
       s = 0.55 ->  r = 38.9%  < 40%   (with a little margin)

   This is why maskable icons look "small". It is correct: an earlier pass
   composited at 78% (corner radius 55%) and Android masks sliced the frame
   into slivers — caught in the 2026-07-29 review with mask simulations.

   PADDING COLOUR: the artwork's own corner pixel, not the manifest's
   background_color. This source is a black tile; padding it with #16181d
   would draw a visible lighter square around a black icon on every Android
   launcher. Sampling the artwork makes the padding disappear into it.

3. apple-touch-icon (180) — iOS home screen. iOS does NOT read the manifest
   icons and does NOT respect `maskable`; it takes this one PNG and applies
   its own squircle. So it must be the FULL-BLEED art, never the padded
   maskable version — feeding iOS a maskable icon is the classic way to get a
   tiny logo marooned in a big empty tile.

   The source art already has its own rounded corners painted in black. iOS's
   squircle is a slightly different curve, but since every pixel in that
   border region is black anyway, the two roundings cannot disagree visibly.
   No corner slivers, nothing to correct for.
"""
import math
import os
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "assets-src", "app-icon-source.png")
ICONS = os.path.join(HERE, "..", "public", "icons")
PUBLIC = os.path.join(HERE, "..", "public")

ANY_SIZES = (192, 512)
APPLE_SIZE = 180  # exact iOS home-screen size; iOS will scale anything, but
# handing it the right pixels avoids a resample it does badly on fine text.
SCALE = 0.55  # -> content corner radius 38.9% of width, inside the 40% circle

# ---- favicon -------------------------------------------------------------
# The favicon is NOT a shrunken app icon, and that is deliberate.
#
# ARTWORK CHANGED 2026-07-31 (rolo): the source is now the turbaned-skull
# "PINBALL GENIE" logo — skull and turban up top, dripping wordmark through the
# middle, flippers and ball along the bottom. The wordmark and the flippers both
# collapse into mush at 16x16; the SKULL does not. Verified by rendering all
# three candidate crops at 128/48/16 and looking at them side by side, not
# assumed — the previous bottom-of-the-artwork crop, which was correct for the
# OLD neon-text art, renders as an unreadable smear of "GENIE" against this one.
#
# So the favicon crops to the skull. It reads as a distinct object at 16x16 and
# is unmistakable at the 48x48 Google renders beside a search result. Cropping a
# logo down to its most legible element is the normal answer for favicons;
# scaling the whole lockup is the usual mistake.
#
# Box is a fraction of the source so it survives the artwork being re-exported
# at a different resolution.
FAVICON_CROP = (0.32, 0.05, 0.68, 0.45)  # left, top, right, bottom — the skull
# 16/32 are the classic browser-tab sizes; 48 is what Google's search results
# use and its docs ask for a multiple of 48.
FAVICON_SIZES = (16, 32, 48)


def load_source() -> "Image.Image":
    if not os.path.exists(SRC):
        sys.exit(
            f"FATAL: {SRC} is missing. It is the source of truth for every icon; "
            "restore it (or point this script at the new artwork) rather than "
            "hand-editing public/icons/."
        )
    im = Image.open(SRC).convert("RGBA")
    if im.size[0] != im.size[1]:
        sys.exit(f"FATAL: source artwork must be square, got {im.size[0]}x{im.size[1]}")
    return im


def write(img: "Image.Image", name: str, note: str) -> None:
    out = os.path.join(ICONS, name)
    img.convert("RGB").save(out, "PNG", optimize=True)
    kb = os.path.getsize(out) / 1024
    print(f"  {name:<26} {img.size[0]:>3}x{img.size[1]:<3}  {kb:6.1f} KB   {note}")


def main() -> int:
    src = load_source()
    os.makedirs(ICONS, exist_ok=True)
    print(f"source: assets-src/app-icon-source.png  {src.size[0]}x{src.size[1]}")

    # Padding colour sampled from the artwork's own corner — see the header.
    pad = src.getpixel((1, 1))

    for size in ANY_SIZES:
        write(src.resize((size, size), Image.LANCZOS), f"icon-{size}.png", "full bleed (purpose: any)")

    for size in ANY_SIZES:
        canvas = Image.new("RGBA", (size, size), pad)
        inner = round(size * SCALE)
        canvas.alpha_composite(src.resize((inner, inner), Image.LANCZOS), ((size - inner) // 2,) * 2)
        r = SCALE * math.sqrt(2) / 2
        write(canvas, f"icon-{size}-maskable.png", f"safe-zone padded, corner r={r:.1%} < 40%")

    write(
        src.resize((APPLE_SIZE, APPLE_SIZE), Image.LANCZOS),
        f"icon-{APPLE_SIZE}.png",
        "apple-touch-icon — FULL BLEED, never the maskable one",
    )

    # ---- favicon: cropped to the ball-and-flippers mark (see FAVICON_CROP) --
    w, h = src.size
    l, t, r_, b = FAVICON_CROP
    crop = src.crop((int(w * l), int(h * t), int(w * r_), int(h * b)))
    side = max(crop.size)
    square = Image.new("RGBA", (side, side), pad)
    square.alpha_composite(crop, ((side - crop.size[0]) // 2, (side - crop.size[1]) // 2))

    ico_path = os.path.join(PUBLIC, "favicon.ico")
    # A single .ico carrying 16/32/48 lets each consumer pick its own size
    # instead of downscaling one bitmap badly.
    square.convert("RGB").save(
        ico_path, format="ICO", sizes=[(s, s) for s in FAVICON_SIZES]
    )
    print(
        f"  {'favicon.ico':<26} {'/'.join(str(s) for s in FAVICON_SIZES):>11}  "
        f"{os.path.getsize(ico_path) / 1024:6.1f} KB   cropped mark, multi-size"
    )
    # PNG copy at 48 for the explicit <link rel="icon"> — Google's docs ask for
    # a multiple of 48 and prefer a declared icon over sniffing /favicon.ico.
    # Written to public/ (NOT public/icons/) so it sits beside favicon.ico and
    # both resolve at the site root, matching index.html's link tags. Written
    # explicitly rather than via write()'s ICONS-relative path, because a
    # "../" in that argument is exactly the kind of thing that silently puts a
    # file somewhere the HTML isn't looking.
    fav48 = os.path.join(PUBLIC, "favicon-48.png")
    square.resize((48, 48), Image.LANCZOS).convert("RGB").save(fav48, "PNG", optimize=True)
    print(f"  {'favicon-48.png':<26} {'48x48':>11}  {os.path.getsize(fav48) / 1024:6.1f} KB   declared <link rel=icon>")

    print(f"\npadding colour sampled from artwork corner: rgb{pad[:3]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
