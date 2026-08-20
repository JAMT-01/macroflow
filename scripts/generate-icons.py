"""
Generates every PWA icon size from one source, into public/.

    python scripts/generate-icons.py                 # draws the default mark
    python scripts/generate-icons.py my-logo.png     # uses your own artwork

Python rather than the project's usual TypeScript because Pillow is the only
image library on this machine; there is no sharp/canvas in node_modules. It is
a build-time tool run by hand, so it never ships.

The default mark is an open ring in the app's green on its dark surface — the
same shape as the calorie ring the Today screen is built around. No letter,
because a glyph at 32px is mud, and the ring reads at any size.

Your own artwork: pass a square PNG or JPEG. It is fitted onto the brand
background with the safe-area padding maskable icons require, so Android will
not crop into it when it applies a circle or squircle mask.
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public"

INK = (23, 32, 25, 255)        # #172019, the app's dark surface
GREEN = (201, 243, 106, 255)   # #c9f36a, the accent everything else uses
MASTER = 1024


def rounded_background(size: int, radius_ratio: float = 0.22) -> Image.Image:
    """iOS applies its own mask, but Android and the browser tab do not."""
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle([(0, 0), (size - 1, size - 1)], radius=int(size * radius_ratio), fill=INK)
    return image


def draw_default_mark(size: int) -> Image.Image:
    image = rounded_background(size)
    draw = ImageDraw.Draw(image)

    # An open ring: the gap keeps it from reading as a plain circle, and echoes
    # a progress arc that is not yet complete.
    inset = size * 0.26
    stroke = max(2, int(size * 0.105))
    box = [inset, inset, size - inset, size - inset]
    draw.arc(box, start=-95, end=205, fill=GREEN, width=stroke)

    # The dot sits in the gap, not on the arc: placed anywhere the stroke already
    # covers it merges into a blob at small sizes. 235 degrees is the middle of
    # the opening left between the arc's end (205) and its start (265).
    import math
    radius = (size - 2 * inset) / 2
    angle = math.radians(235)
    dot = size * 0.052
    cx = size / 2 + radius * math.cos(angle)
    cy = size / 2 + radius * math.sin(angle)
    draw.ellipse([cx - dot, cy - dot, cx + dot, cy + dot], fill=GREEN)
    return image


def from_source(path: Path, size: int) -> Image.Image:
    source = Image.open(path).convert("RGBA")
    # 76% leaves the 12% margin each side that a maskable icon needs.
    inner = int(size * 0.76)
    source.thumbnail((inner, inner), Image.LANCZOS)
    canvas = rounded_background(size)
    canvas.paste(source, ((size - source.width) // 2, (size - source.height) // 2), source)
    return canvas


def main() -> int:
    source = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else None
    if source and not source.exists():
        print(f"No such file: {source}")
        return 1

    master = from_source(source, MASTER) if source else draw_default_mark(MASTER)
    PUBLIC.mkdir(exist_ok=True)

    outputs = {
        "icon-512.png": 512,
        "icon-192.png": 192,
        "apple-touch-icon.png": 180,   # iOS home screen; must be PNG, no alpha needed
        "favicon-32.png": 32,
        "favicon-16.png": 16,
    }
    for name, size in outputs.items():
        master.resize((size, size), Image.LANCZOS).save(PUBLIC / name, optimize=True)
        print(f"public/{name}  {size}x{size}")

    # Maskable: same art, more breathing room, because Android crops to a circle.
    maskable = Image.new("RGBA", (MASTER, MASTER), INK)
    scaled = master.resize((int(MASTER * 0.78),) * 2, Image.LANCZOS)
    maskable.paste(scaled, ((MASTER - scaled.width) // 2,) * 2, scaled)
    maskable.resize((512, 512), Image.LANCZOS).save(PUBLIC / "icon-maskable-512.png", optimize=True)
    print("public/icon-maskable-512.png  512x512")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
