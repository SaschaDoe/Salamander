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
    luminance = 0.299 * r + 0.587 * g + 0.114 * b

    # Three terrain types that the player can walk on, all sampled empirically
    # from the background art:
    #
    #   grass         R 120-150  G 150-170  B 40-55   lum ~130
    #   pond / swamp  R  30- 75  G 115-130  B 50-75   lum  85-105   (cooler greens)
    #   path stones   R 100-135  G 105-135  B 70-100  lum 100-140   (neutral grey)
    #
    # The key discriminator between trees and ponds is the green channel: tree
    # canopy and shadow tops out around G=113, ponds start around G=120. So
    # `g >= 115` cleanly separates them. Houses (warm reds/purples) have
    # `r >= g`, so requiring `g > r` excludes them from the green-dominant
    # detectors.
    is_grass = (
        (g >= 130) & (r >= 90) & (b <= 70) & (g > r) & (g > b + 60)
    )
    is_pond = (
        (g >= 115) & (g > r) & (luminance >= 70) & (luminance <= 145)
    )
    is_stone = (
        (luminance >= 95) & (luminance <= 165)
        & (np.abs(r - g) <= 25)
        & (b >= 60)
        & (g >= 100)
    )

    walkable = is_grass | is_pond | is_stone

    from scipy.ndimage import binary_closing, binary_opening, binary_erosion, label

    # Drop tiny isolated walkable specks inside obstacles (occasional bright
    # pixels in tree canopy).
    walkable = binary_opening(walkable, iterations=2)
    # Close small holes inside walkable areas (flowers, pebble shadows).
    walkable = binary_closing(walkable, iterations=4)
    # Close gaps between trees / inside structures so the obstacle ring is
    # solid (otherwise the player can squeeze between trees).
    blocked = ~walkable
    blocked = binary_closing(blocked, iterations=8)
    walkable = ~blocked

    # Keep only the main connected walkable region. This drops walkable
    # pockets that ended up outside the forest border (e.g. behind trees).
    labels, n_components = label(walkable)
    if n_components > 0:
        sizes = np.bincount(labels.ravel())
        sizes[0] = 0
        main = int(np.argmax(sizes))
        walkable = (labels == main)

    # Safety margin so the player's hitbox doesn't clip into walls.
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
