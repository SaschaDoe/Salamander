export class Camera {
  x = 0;
  y = 0;
  constructor(
    public viewW: number,
    public viewH: number,
    public worldW: number,
    public worldH: number
  ) {}

  follow(targetX: number, targetY: number) {
    this.x = clamp(targetX - this.viewW / 2, 0, Math.max(0, this.worldW - this.viewW));
    this.y = clamp(targetY - this.viewH / 2, 0, Math.max(0, this.worldH - this.viewH));
  }
}

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}
