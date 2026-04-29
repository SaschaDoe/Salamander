"""
Build script: normalize the salamander spritesheets into clean 256x256 frames
and generate collision and water masks from the background.

Run:  python scripts/build_assets.py
Outputs:
  static/salamander.png        (normalized walking 4x4 sheet, 1024x1024)
  static/salamander.json       (frame metadata)
  static/salamander_swim.png   (normalized swim 4x4 sheet, 1024x1024)
  static/salamander_swim.json  (frame metadata)
  static/background.png        (copy of the level background)
  static/collision-mask.png    (B/W: white=walkable, black=blocked)
  static/water-mask.png        (B/W: white=pond/swamp area to swim on)
  static/collision-debug.png   (overlay for visual verification)
  static/room.png              (copy of the interior background)
"""

from pathlib import Path
import json
from PIL import Image
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
SRC_SPRITES = ROOT / "salamander spriteSheet.png"
SRC_SWIM = ROOT / "salamander swimming sprite sheet.png"
SRC_BG = ROOT / "Background Level 1.png"
SRC_ROOM = ROOT / "room.png"
OUT_DIR = ROOT / "static"
OUT_DIR.mkdir(exist_ok=True)


# ---------- Spritesheets ----------

CELL = 256
COLS, ROWS = 4, 4
DIRECTIONS = ["down", "right", "left", "up"]

# Approximate row bands found by alpha analysis. We use these to pick the right
# band of pixels for each direction so the sprite isn't clipped by neighboring
# rows during the per-cell tight-bbox extraction.
ROW_BANDS_WALK = [
    (60, 210),
    (290, 440),
    (515, 670),
    (740, 920),
]
ROW_BANDS_SWIM = [
    (60, 230),
    (290, 430),
    (510, 670),
    (730, 920),
]


def normalize_spritesheet(src_path: Path, out_png: Path, out_json: Path, row_bands):
    """Crop each cell to its sprite's tight bbox, then re-place all frames so
    they share a common ground line per row. Both walking and swimming sheets
    use the same 4x4 layout — only their row bands differ."""
    if not src_path.exists():
        print(f"Skipping {src_path} (missing)")
        return
    src = Image.open(src_path).convert("RGBA")
    arr = np.array(src)
    out = Image.new("RGBA", (CELL * COLS, CELL * ROWS), (0, 0, 0, 0))

    # First pass: collect each frame's tight bbox and overall max sizes per row.
    frames = []
    max_h_per_row = [0] * ROWS

    for r, (y1, y2) in enumerate(row_bands):
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
            max_h_per_row[r] = max(max_h_per_row[r], cropped.shape[0])

    # Second pass: place each frame inside its 256x256 cell, centered
    # horizontally, bottom-aligned within the row's max-height band so all
    # frames in the same direction share the same anchor line.
    sprite_meta = {
        "cell": CELL,
        "cols": COLS,
        "rows": ROWS,
        "directions": DIRECTIONS,
        "frames": [],
    }
    for r in range(ROWS):
        row_h = max_h_per_row[r]
        cell_top = r * CELL
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

    out.save(out_png)
    out_json.write_text(json.dumps(sprite_meta, indent=2))
    print(f"Wrote {out_png} ({out.size})")
    print(f"Wrote {out_json}")


# ---------- Background, collision mask, water mask ----------

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
    # Strict pond/swamp colour: cool greens that aren't found in path stones.
    # `g > r + 45` keeps every pond/bush sample (G-R 65-99) and excludes
    # neutral path stones (G-R 11-36).
    is_water_seed = (
        (g >= 115) & (g > r + 45) & (luminance >= 70) & (luminance <= 145)
    )
    is_stone = (
        (luminance >= 95) & (luminance <= 165)
        & (np.abs(r - g) <= 25)
        & (b >= 60)
        & (g >= 100)
    )

    from scipy.ndimage import (
        binary_closing,
        binary_dilation,
        binary_erosion,
        binary_fill_holes,
        binary_opening,
        label,
    )

    # Build a solid swamp/pond blob from the seed pixels: close hairline gaps
    # along the shoreline so the boundary is continuous, then fill every
    # interior hole. Without this step the rocks, dark water and highlight
    # pixels inside a pond fail every walkable detector and the player's
    # hitbox can't fit anywhere inside the swamp.
    swamp = binary_closing(is_water_seed, iterations=5)
    swamp = binary_fill_holes(swamp)
    swamp = binary_opening(swamp, iterations=2)
    # Drop tiny stray fragments far from the real swamps (scattered green
    # specks at the forest edge, etc.).
    swamp_labels, swamp_n = label(swamp)
    if swamp_n > 0:
        ssizes = np.bincount(swamp_labels.ravel())
        ssizes[0] = 0
        keep = ssizes >= 1500
        swamp = keep[swamp_labels]

    # Build the "meadow envelope" — the area fully enclosed by the main
    # grass region (so it covers grass + any interior obstacles + the real
    # swamps, but stops at the forest). Then drop every swamp blob that
    # lies outside the envelope. Without this filter, isolated pine trees
    # in the forest border (whose dark canopies pass the cool-green
    # detector) survive into `swamp` and the later "force walkable" step
    # would carve tree-shaped holes through the forest.
    grass_labels, grass_n = label(is_grass)
    if grass_n > 0:
        gsz = np.bincount(grass_labels.ravel())
        gsz[0] = 0
        main_grass = grass_labels == int(np.argmax(gsz))
    else:
        main_grass = np.zeros_like(is_grass)
    meadow_envelope = binary_fill_holes(main_grass)
    swamp = swamp & meadow_envelope

    walkable = is_grass | swamp | is_stone

    walkable = binary_opening(walkable, iterations=2)
    walkable = binary_closing(walkable, iterations=4)
    blocked = ~walkable
    blocked = binary_closing(blocked, iterations=8)
    walkable = ~blocked

    labels, n_components = label(walkable)
    if n_components > 0:
        sizes = np.bincount(labels.ravel())
        sizes[0] = 0
        main = int(np.argmax(sizes))
        walkable = (labels == main)

    walkable = binary_erosion(walkable, iterations=3)

    # The swamp interior must be completely free of collision. Regardless of
    # what the morphology pipeline did to its boundary, force every pixel
    # inside the closed swamp blob to be walkable.
    walkable = walkable | swamp

    # Fill small enclosed "flower" pockets inside the meadow — clusters of
    # dark grass / flower pixels that fail every walkable detector but are
    # too small to be real obstacles. Anything that touches the image
    # border (the forest) or is bigger than `speck_max` (houses, hut, dead
    # tree, etc.) stays blocked. The real structures are all 2000+ px so
    # 1500 is a comfortable cutoff.
    speck_max = 1500
    hole_labels, n_holes = label(~walkable)
    if n_holes > 0:
        hole_sizes = np.bincount(hole_labels.ravel())
        border_ids: set[int] = set()
        for edge in (
            hole_labels[0],
            hole_labels[-1],
            hole_labels[:, 0],
            hole_labels[:, -1],
        ):
            border_ids.update(int(v) for v in np.unique(edge))
        fill = np.zeros_like(walkable)
        for i in range(1, n_holes + 1):
            if hole_sizes[i] < speck_max and i not in border_ids:
                fill[hole_labels == i] = True
        walkable = walkable | fill

    final = np.where(walkable, 255, 0).astype(np.uint8)
    mask_img = Image.fromarray(final, "L")
    mask_path = OUT_DIR / "collision-mask.png"
    mask_img.save(mask_path)
    print(f"Wrote {mask_path}")

    # ----- Water mask -----
    # Same swamp blob as the collision side, intersected with walkable. No
    # erosion: the runtime checks the player's full hitbox against this mask,
    # so the swim animation already requires the body to overlap water, not
    # just the center pixel.
    water = swamp & walkable
    water_final = np.where(water, 255, 0).astype(np.uint8)
    water_img = Image.fromarray(water_final, "L")
    water_path = OUT_DIR / "water-mask.png"
    water_img.save(water_path)
    print(f"Wrote {water_path}")

    # ----- Debug overlay -----
    overlay = bg.copy()
    overlay_arr = np.array(overlay)
    blocked_dbg = final == 0
    overlay_arr[blocked_dbg, 0] = np.minimum(255, overlay_arr[blocked_dbg, 0].astype(int) + 80)
    overlay_arr[blocked_dbg, 1] = (overlay_arr[blocked_dbg, 1] * 0.7).astype(np.uint8)
    overlay_arr[blocked_dbg, 2] = (overlay_arr[blocked_dbg, 2] * 0.7).astype(np.uint8)
    # Tint water blueish.
    water_dbg = water_final > 0
    overlay_arr[water_dbg, 2] = np.minimum(255, overlay_arr[water_dbg, 2].astype(int) + 90)
    Image.fromarray(overlay_arr).save(OUT_DIR / "collision-debug.png")
    print(f"Wrote {OUT_DIR / 'collision-debug.png'}")

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
    normalize_spritesheet(
        SRC_SPRITES,
        OUT_DIR / "salamander.png",
        OUT_DIR / "salamander.json",
        ROW_BANDS_WALK,
    )
    normalize_spritesheet(
        SRC_SWIM,
        OUT_DIR / "salamander_swim.png",
        OUT_DIR / "salamander_swim.json",
        ROW_BANDS_SWIM,
    )
    build_collision_mask()
    copy_room_interior()
