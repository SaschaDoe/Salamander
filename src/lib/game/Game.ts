import { Camera } from './Camera';
import { CollisionMask } from './CollisionMask';
import { Input } from './Input';
import { Player, type Direction, type WalkChecker } from './Player';

const SPRITE_CELL = 256;

export type GameOptions = {
  canvas: HTMLCanvasElement;
  /** When true, renders collision and trigger debug overlays. */
  debug?: boolean;
};

type Trigger = {
  /** Axis-aligned action box in world pixels. */
  cx: number;
  cy: number;
  halfW: number;
  halfH: number;
  /** Hint shown to the player while standing inside the box. */
  prompt: string;
  activate: (game: Game) => void;
};

type Scene = {
  name: 'outdoor' | 'indoor';
  background: HTMLImageElement;
  worldW: number;
  worldH: number;
  walkable: WalkChecker;
  /** Mask of pond/swamp pixels — true here triggers the swim animation. */
  water?: CollisionMask;
  /** Optional pre-rendered collision overlay (outdoor mask). */
  debugOverlay?: HTMLImageElement;
  /** Optional walkable rects to outline in debug mode (indoor floor). */
  debugRects?: Rect[];
  triggers: Trigger[];
};

type Rect = { x0: number; y0: number; x1: number; y1: number };

/** Walkable area defined as the union of axis-aligned rectangles. The
 * player's hitbox must fit entirely inside *at least one* rectangle. */
class MultiRectWalk implements WalkChecker {
  constructor(public rects: Rect[]) {}
  isRectWalkable(cx: number, cy: number, halfW: number, halfH: number): boolean {
    for (const r of this.rects) {
      if (
        cx - halfW >= r.x0 &&
        cx + halfW <= r.x1 &&
        cy - halfH >= r.y0 &&
        cy + halfH <= r.y1
      ) {
        return true;
      }
    }
    return false;
  }
}

export class Game {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private spriteSheet!: HTMLImageElement;
  private spriteSheetSwim!: HTMLImageElement;
  private player!: Player;
  private camera!: Camera;
  private input = new Input();
  private last = 0;
  private rafId = 0;
  private scenes!: Record<'outdoor' | 'indoor', Scene>;
  private currentScene!: Scene;
  /** The trigger the player currently overlaps (for the on-screen prompt). */
  private activeTrigger: Trigger | null = null;
  debug: boolean;

  constructor(opts: GameOptions) {
    this.canvas = opts.canvas;
    this.ctx = opts.canvas.getContext('2d')!;
    this.debug = !!opts.debug;
  }

  async start() {
    const [bgOutdoor, bgIndoor, sprite, spriteSwim, maskImg, mask, water] = await Promise.all([
      loadImage('/background.png'),
      loadImage('/room.png'),
      loadImage('/salamander.png'),
      loadImage('/salamander_swim.png'),
      loadImage('/collision-mask.png'),
      CollisionMask.load('/collision-mask.png'),
      CollisionMask.load('/water-mask.png')
    ]);
    this.spriteSheet = sprite;
    this.spriteSheetSwim = spriteSwim;

    const outdoor: Scene = {
      name: 'outdoor',
      background: bgOutdoor,
      worldW: bgOutdoor.naturalWidth,
      worldH: bgOutdoor.naturalHeight,
      walkable: mask,
      water,
      debugOverlay: maskImg,
      triggers: [
        {
          // Action box in front of the carrot-house door (on grass below the steps).
          cx: 655,
          cy: 465,
          halfW: 24,
          halfH: 18,
          prompt: 'E: Haus betreten',
          activate: (g) => g.switchScene('indoor', 720, 955, 'up')
        }
      ]
    };

    const indoorRects: Rect[] = [
      // Lower floor — the wooden plank floor across the bottom of the room.
      { x0: 150, y0: 880, x1: 1280, y1: 1010 },
      // Staircase — diagonal corridor from the floor up to the loft. Top
      // and bottom intentionally extend ~30 px past the visible step
      // boundary so the player's 24-px-tall hitbox has room to traverse
      // into the floor and loft rectangles below/above.
      { x0: 800, y0: 300, x1: 990, y1: 930 },
      // Loft floor — the upper level where the bed and side table are.
      { x0: 120, y0: 280, x1: 920, y1: 360 },
    ];
    const indoor: Scene = {
      name: 'indoor',
      background: bgIndoor,
      worldW: bgIndoor.naturalWidth,
      worldH: bgIndoor.naturalHeight,
      walkable: new MultiRectWalk(indoorRects),
      debugRects: indoorRects,
      triggers: [
        {
          // Exit zone centered on the rug — implied front door of the house.
          cx: 720,
          cy: 1000,
          halfW: 70,
          halfH: 14,
          prompt: 'E: Haus verlassen',
          activate: (g) => g.switchScene('outdoor', 655, 510, 'down')
        }
      ]
    };

    this.scenes = { outdoor, indoor };
    this.currentScene = outdoor;

    this.player = this.spawnOutdoor(mask);
    this.camera = new Camera(
      this.canvas.width,
      this.canvas.height,
      outdoor.worldW,
      outdoor.worldH
    );
    this.camera.follow(this.player.x, this.player.y);

    this.input.attach();
    this.last = performance.now();
    this.rafId = requestAnimationFrame(this.frame);
  }

  stop() {
    cancelAnimationFrame(this.rafId);
    this.input.detach();
  }

  private spawnOutdoor(mask: CollisionMask): Player {
    // Find a walkable spawn near the center of the map.
    const cx = mask.width / 2;
    const cy = mask.height / 2;
    if (mask.isRectWalkable(cx, cy, 18, 12)) return new Player(cx, cy);
    for (let r = 8; r < Math.max(mask.width, mask.height); r += 8) {
      for (let a = 0; a < Math.PI * 2; a += Math.PI / 16) {
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r;
        if (mask.isRectWalkable(x, y, 18, 12)) return new Player(x, y);
      }
    }
    return new Player(cx, cy);
  }

  private switchScene(name: 'outdoor' | 'indoor', px: number, py: number, facing: Direction) {
    const scene = this.scenes[name];
    this.currentScene = scene;
    this.player.x = px;
    this.player.y = py;
    this.player.direction = facing;
    this.camera = new Camera(
      this.canvas.width,
      this.canvas.height,
      scene.worldW,
      scene.worldH
    );
    this.camera.follow(this.player.x, this.player.y);
    this.activeTrigger = null;
  }

  private findTriggerAtPlayer(): Trigger | null {
    const px = this.player.x;
    const py = this.player.y;
    const phw = this.player.halfW;
    const phh = this.player.halfH;
    for (const t of this.currentScene.triggers) {
      if (
        Math.abs(px - t.cx) <= t.halfW + phw &&
        Math.abs(py - t.cy) <= t.halfH + phh
      ) {
        return t;
      }
    }
    return null;
  }

  private frame = (now: number) => {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.player.update(dt, this.input.state, this.currentScene.walkable);
    this.camera.follow(this.player.x, this.player.y);

    // Swim state: true while any pixel of the player's hitbox overlaps a
    // pond/swamp pixel — stepping a foot into water is enough.
    const w = this.currentScene.water;
    this.player.isSwimming = w
      ? w.intersectsRect(this.player.x, this.player.y, this.player.halfW, this.player.halfH)
      : false;

    this.activeTrigger = this.findTriggerAtPlayer();
    if (this.activeTrigger && this.input.consumeActionPress()) {
      // Capture before activate — switchScene clears activeTrigger.
      const t = this.activeTrigger;
      t.activate(this);
    } else {
      // Drain a press that wasn't on a trigger so it doesn't fire later.
      this.input.consumeActionPress();
    }

    this.render();
    this.rafId = requestAnimationFrame(this.frame);
  };

  private render() {
    const ctx = this.ctx;
    const cam = this.camera;
    const scene = this.currentScene;

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      scene.background,
      cam.x, cam.y, cam.viewW, cam.viewH,
      0, 0, cam.viewW, cam.viewH
    );

    if (this.debug) {
      if (scene.debugOverlay) {
        ctx.globalAlpha = 0.35;
        ctx.drawImage(
          scene.debugOverlay,
          cam.x, cam.y, cam.viewW, cam.viewH,
          0, 0, cam.viewW, cam.viewH
        );
        ctx.globalAlpha = 1;
      }
      if (scene.debugRects) {
        ctx.strokeStyle = '#33ff77';
        ctx.lineWidth = 1;
        for (const r of scene.debugRects) {
          ctx.strokeRect(
            r.x0 - cam.x,
            r.y0 - cam.y,
            r.x1 - r.x0,
            r.y1 - r.y0
          );
        }
      }
      // Trigger boxes (yellow).
      ctx.strokeStyle = '#ffd24a';
      ctx.lineWidth = 1;
      for (const t of scene.triggers) {
        ctx.strokeRect(
          t.cx - t.halfW - cam.x,
          t.cy - t.halfH - cam.y,
          t.halfW * 2,
          t.halfH * 2
        );
      }
    }

    // Interaction markers — a static, semi-transparent halo on the ground.
    // Drawn before the player so the salamander can walk over it.
    for (const t of scene.triggers) {
      this.drawTriggerMarker(t);
    }

    // Player — pick the swim sheet when standing in water.
    const sheet = this.player.isSwimming ? this.spriteSheetSwim : this.spriteSheet;
    const sx = this.player.frame * SPRITE_CELL;
    const sy = this.player.row * SPRITE_CELL;
    const drawSize = this.player.drawSize;
    const dx = Math.round(this.player.x - cam.x - drawSize / 2);
    const dy = Math.round(this.player.y - cam.y - drawSize / 2);
    ctx.drawImage(
      sheet,
      sx, sy, SPRITE_CELL, SPRITE_CELL,
      dx, dy, drawSize, drawSize
    );

    if (this.debug) {
      ctx.strokeStyle = 'red';
      ctx.lineWidth = 1;
      ctx.strokeRect(
        this.player.x - cam.x - this.player.halfW,
        this.player.y - cam.y - this.player.halfH,
        this.player.halfW * 2,
        this.player.halfH * 2
      );
    }

    if (this.activeTrigger) {
      drawPrompt(ctx, this.activeTrigger.prompt, cam.viewW, cam.viewH);
    }
  }

  private drawTriggerMarker(t: Trigger) {
    const ctx = this.ctx;
    const cam = this.camera;
    const x = t.cx - cam.x;
    const y = t.cy - cam.y;

    const margin = 80;
    if (x < -margin || y < -margin || x > cam.viewW + margin || y > cam.viewH + margin) return;

    const baseR = Math.max(t.halfW, t.halfH) + 4;

    ctx.save();
    const grad = ctx.createRadialGradient(x, y, 0, x, y, baseR);
    grad.addColorStop(0, 'rgba(255, 230, 140, 0.22)');
    grad.addColorStop(0.6, 'rgba(255, 230, 140, 0.14)');
    grad.addColorStop(1, 'rgba(255, 230, 140, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, baseR, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function drawPrompt(
  ctx: CanvasRenderingContext2D,
  text: string,
  viewW: number,
  viewH: number
) {
  ctx.save();
  ctx.font = '16px system-ui, sans-serif';
  const metrics = ctx.measureText(text);
  const padX = 10;
  const padY = 6;
  const w = metrics.width + padX * 2;
  const h = 16 + padY * 2;
  const x = Math.round((viewW - w) / 2);
  const y = viewH - h - 16;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  ctx.fillStyle = '#f4f1e6';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + padX, y + h / 2);
  ctx.restore();
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}
