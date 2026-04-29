"""
Build script: normalize the salamander spritesheet into clean 256x256 frames
and generate a collision mask from the background.

Run:  python scripts/build_assets.py
Outputs:
  static/salamander.png      (normalized 4x4 sheet, 1024x1024)
  static/salamander.json     (frame metadata)
  static/Background Level 1.png  (copy)
  static/collision-mask.png  (B/W: white=walkable, black=blocked)
  static/collision-debug.png (overlay for visual verification)
"""

from pathlib import Path
import json
from PIL import Image
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
SRC_SPRITES = ROOT / "salamander spriteSheet.png"
SRC_BG = ROOT / "Background Level 1.png"
SRC_ROOM = ROOT / "room.png"
OUT_DIR = ROOT / "static"
OUT_DIR.mkdir(exist_ok=True)


# ---------- Spritesheet ----------

CELL = 256
COLS, ROWS = 4, 4

# Approximate row bands found by alpha analysis. We use these to pick the right
# band of pixels for each direction so the sprite isn't clipped by neighboring rows.
ROW_BANDS = [
    (60, 210),    # row 0 (LEFT)
    (290, 440),   # row 1 (RIGHT)
    (515, 670),   # row 2 (UP)
    (740, 920),   # row 3 (DOWN)
]
DIRECTIONS = ["down", "right", "left", "up"]


def normalize_spritesheet():
    src = Image.open(SRC_SPRITES).convert("RGBA")
    arr = np.array(src)
    out = Image.new("RGBA", (CELL * COLS, CELL * ROWS), (0, 0, 0, 0))

    # First pass: collect each frame's tight bbox and overall max sizes per row
    frames = []
    max_w = 0
    max_h_per_row = [0] * ROWS

    for r, (y1, y2) in enumerate(ROW_BANDS):
        for c in range(COLS):
            x1, x2 = c * CELL, (c + 1) * CELL
            sub = arr[y1:y2, x1:x2]
            alpha = sub[:, :, 3]
            ys, xs = np.where(alpha > 0)
            if len(xs) == 0:
                frames.append(None)
                continue
            bx1, bx2 = xs.min(), xs.max() + 1
            by1, by2 = ys.min(), ys.max() + 1
            cropped = sub[by1:by2, bx1:bx2]
            frames.append(cropped)
            max_w = max(max_w, cropped.shape[1])
            max_h_per_row[r] = max(max_h_per_row[r], cropped.shape[0])

    # Second pass: place each frame inside its 256x256 cell, centered horizontally,
    # bottom-aligned within the row's max-height band (so all frames share the same
    # ground-line / anchor — that's what makes the walk cycle look smooth).
    sprite_meta = {"cell": CELL, "cols": COLS, "rows": ROWS, "directions": DIRECTIONS, "frames": []}

    for r in range(ROWS):
        row_h = max_h_per_row[r]
        # vertical center of the row's content within the cell
        cell_top = r * CELL
        # place the bottom of each frame at cell_top + (CELL/2 + row_h/2) so the
        # body roughly sits centered in the cell
        bottom_y = cell_top + (CELL + row_h) // 2

        for c in range(COLS):
            f = frames[r * COLS + c]
            if f is None:
                continue
            fh, fw = f.shape[0], f.shape[1]
            cell_left = c * CELL
            place_x = cell_left + (CELL - fw) // 2
            place_y = bottom_y - fh
            frame_img = Image.fromarray(f, "RGBA")
            out.paste(frame_img, (place_x, place_y), frame_img)
            sprite_meta["frames"].append({
                "direction": DIRECTIONS[r],
                "frame": c,
                "row": r,
                "col": c,
                "sx": cell_left,
                "sy": cell_top,
                "sw": CELL,
                "sh": CELL,
            })

    out_path = OUT_DIR / "salamander.png"
    out.save(out_path)
    meta_path = OUT_DIR / "salamander.json"
    meta_path.write_text(json.dumps(sprite_meta, indent=2))
    print(f"Wrote {out_path} ({out.size})")
    print(f"Wrote {meta_path}")


# ---------- Background + collision mask ----------

def build_collision_mask():
    bg = Image.open(SRC_BG).convert("RGBA")
    arr = np.array(bg)
    r, g, b = arr[:, :, 0].astype(int), arr[:, :, 1].astype(int), arr[:, :, 2].astype(int)

    # Walkable = bright yellow-green grass. Empirical thresholds based on samples:
    #   grass    R 120-150  G 150-170  B 40-55   (luminance ~130)
    #   pond     R  10-140  G  60-165  B 30-75   (blue too high)
    #   trees    R  35-90   G  70-130  B 20-50   (too dark)
    is_grass = (
        (g >= 130)               # bright enough to be grass, not dark tree shadow
        & (r >= 90)              # warm yellow-green, not pure dark green of trees
        & (b <= 70)              # excludes the dark green water of ponds (higher blue)
        & (g > r)                # green dominant
        & (g > b + 60)           # green clearly above blue (extra pond exclusion)
    )

    mask = np.where(is_grass, 255, 0).astype(np.uint8)

    # Morphological cleanup:
    #  - close holes (flowers, pebbles, shadow dots inside grass)
    #  - close gaps between trees so the forest border is a solid wall
    #  - then erode by a few px for a small safety margin around obstacles
    from scipy.ndimage import binary_closing, binary_opening, binary_erosion
    walkable = mask > 0
    # First, OPEN with small kernel: remove tiny isolated walkable specks inside obstacles
    walkable = binary_opening(walkable, iterations=1)
    # Then close holes inside walkable area
    walkable = binary_closing(walkable, iterations=4)
    # Invert and close blocked area too (closes gaps between trees)
    blocked = ~walkable
    blocked = binary_closing(blocked, iterations=6)
    walkable = ~blocked
    # Safety margin so the player doesn't clip into walls
    walkable = binary_erosion(walkable, iterations=3)

    final = np.where(walkable, 255, 0).astype(np.uint8)
    mask_img = Image.fromarray(final, "L")
    mask_path = OUT_DIR / "collision-mask.png"
    mask_img.save(mask_path)
    print(f"Wrote {mask_path}")

    # Debug overlay: tint blocked areas red
    overlay = bg.copy()
    overlay_arr = np.array(overlay)
    blocked = final == 0
    overlay_arr[blocked, 0] = np.minimum(255, overlay_arr[blocked, 0].astype(int) + 80)
    overlay_arr[blocked, 1] = (overlay_arr[blocked, 1] * 0.7).astype(np.uint8)
    overlay_arr[blocked, 2] = (overlay_arr[blocked, 2] * 0.7).astype(np.uint8)
    Image.fromarray(overlay_arr).save(OUT_DIR / "collision-debug.png")
    print(f"Wrote {OUT_DIR / 'collision-debug.png'}")

    # Copy background to static/
    bg.save(OUT_DIR / "background.png")
    print(f"Wrote {OUT_DIR / 'background.png'}")


def copy_room_interior():
    if not SRC_ROOM.exists():
        return
    img = Image.open(SRC_ROOM).convert("RGBA")
    out = OUT_DIR / "room.png"
    img.save(out)
    print(f"Wrote {out}")


if __name__ == "__main__":
    normalize_spritesheet()
    build_collision_mask()
    copy_room_interior()
