/**
 * Loads the pre-generated collision mask PNG and exposes a fast pixel query.
 * White (>=128) = walkable, black = blocked.
 */
export class CollisionMask {
  width = 0;
  height = 0;
  /** 1 byte per pixel: 1 = walkable, 0 = blocked. */
  private data: Uint8Array = new Uint8Array(0);

  static async load(url: string): Promise<CollisionMask> {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = url;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0);
    const pixels = ctx.getImageData(0, 0, c.width, c.height).data;
    const mask = new CollisionMask();
    mask.width = c.width;
    mask.height = c.height;
    mask.data = new Uint8Array(c.width * c.height);
    for (let i = 0, j = 0; i < pixels.length; i += 4, j++) {
      // mask is grayscale, but we read the red channel — same value in all channels.
      mask.data[j] = pixels[i] >= 128 ? 1 : 0;
    }
    return mask;
  }

  /** True if the pixel at (x, y) is walkable. Out-of-bounds = blocked. */
  isWalkable(x: number, y: number): boolean {
    const ix = x | 0;
    const iy = y | 0;
    if (ix < 0 || iy < 0 || ix >= this.width || iy >= this.height) return false;
    return this.data[iy * this.width + ix] === 1;
  }

  /**
   * Test an axis-aligned rectangle against the mask. Returns true if every
   * pixel in the rectangle is walkable. We sample on a coarse grid for speed,
   * which is fine because the player's hitbox is small and the mask was
   * generated with an erosion safety margin.
   */
  isRectWalkable(cx: number, cy: number, halfW: number, halfH: number): boolean {
    const step = 4;
    const x0 = Math.floor(cx - halfW);
    const x1 = Math.ceil(cx + halfW);
    const y0 = Math.floor(cy - halfH);
    const y1 = Math.ceil(cy + halfH);
    // Always test the four corners (and center) so that small obstacles can't slip
    // between sample points.
    if (
      !this.isWalkable(x0, y0) ||
      !this.isWalkable(x1 - 1, y0) ||
      !this.isWalkable(x0, y1 - 1) ||
      !this.isWalkable(x1 - 1, y1 - 1) ||
      !this.isWalkable((x0 + x1) >> 1, (y0 + y1) >> 1)
    ) {
      return false;
    }
    for (let y = y0; y < y1; y += step) {
      for (let x = x0; x < x1; x += step) {
        if (!this.isWalkable(x, y)) return false;
      }
    }
    return true;
  }
}
