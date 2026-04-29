import type { InputState } from './Input';

export interface WalkChecker {
  isRectWalkable(cx: number, cy: number, halfW: number, halfH: number): boolean;
}

export type Direction = 'left' | 'right' | 'up' | 'down';
const DIR_ROW: Record<Direction, number> = { down: 0, right: 1, left: 2, up: 3 };

export class Player {
  x: number;
  y: number;
  /** Hitbox half-width / half-height for collision (small rect at the salamander's body). */
  readonly halfW = 18;
  readonly halfH = 12;
  /** Drawn sprite size in world pixels (smaller than the 256px source frame). */
  readonly drawSize = 96;
  speed = 140; // pixels per second
  direction: Direction = 'down';
  /** Set by Game each frame after the position update — drives sprite-sheet
   * selection (swim vs walk) in render. */
  isSwimming = false;
  private animTime = 0;
  private moving = false;

  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }

  update(dt: number, input: InputState, walk: WalkChecker) {
    let dx = 0;
    let dy = 0;
    if (input.left) dx -= 1;
    if (input.right) dx += 1;
    if (input.up) dy -= 1;
    if (input.down) dy += 1;

    this.moving = dx !== 0 || dy !== 0;

    if (this.moving) {
      // Pick a facing direction. Prefer the latest pressed axis: if both axes
      // are active, prefer horizontal because the side-view sprites read more
      // clearly than the up/down ones.
      if (dx !== 0) this.direction = dx < 0 ? 'left' : 'right';
      else this.direction = dy < 0 ? 'up' : 'down';

      // Normalize so diagonals aren't faster
      const len = Math.hypot(dx, dy);
      const vx = (dx / len) * this.speed * dt;
      const vy = (dy / len) * this.speed * dt;

      // Try moving on each axis separately so the player can slide along walls.
      const newX = this.x + vx;
      if (walk.isRectWalkable(newX, this.y, this.halfW, this.halfH)) {
        this.x = newX;
      }
      const newY = this.y + vy;
      if (walk.isRectWalkable(this.x, newY, this.halfW, this.halfH)) {
        this.y = newY;
      }

      this.animTime += dt;
    } else {
      this.animTime = 0;
    }
  }

  /** Returns the current animation frame (0-3). Idle = frame 0. */
  get frame(): number {
    if (!this.moving) return 0;
    const fps = 8;
    return Math.floor(this.animTime * fps) % 4;
  }

  get row(): number {
    return DIR_ROW[this.direction];
  }
}
