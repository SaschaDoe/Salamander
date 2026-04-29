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
  /** Optional pre-rendered collision overlay (outdoor mask). */
  debugOverlay?: HTMLImageElement;
  /** Optional walkable rect to outline in debug mode (indoor floor). */
  debugRect?: { x0: number; y0: number; x1: number; y1: number };
  triggers: Trigger[];
};

/** Walkable area defined as a single axis-aligned rectangle. */
class RectWalk implements WalkChecker {
  constructor(
    public x0: number,
    public y0: number,
    public x1: number,
    public y1: number
  ) {}
  isRectWalkable(cx: number, cy: number, halfW: number, halfH: number): boolean {
    return (
      cx - halfW >= this.x0 &&
      cx + halfW <= this.x1 &&
      cy - halfH >= this.y0 &&
      cy + halfH <= this.y1
    );
  }
}

export class Game {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private spriteSheet!: HTMLImageElement;
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
    const [bgOutdoor, bgIndoor, sprite, maskImg, mask] = await Promise.all([
      loadImage('/background.png'),
      loadImage('/room.png'),
      loadImage('/salamander.png'),
      loadImage('/collision-mask.png'),
      CollisionMask.load('/collision-mask.png')
    ]);
    this.spriteSheet = sprite;

    const outdoor: Scene = {
      name: 'outdoor',
      background: bgOutdoor,
      worldW: bgOutdoor.naturalWidth,
      worldH: bgOutdoor.naturalHeight,
      walkable: mask,
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

    const indoor: Scene = {
      name: 'indoor',
      background: bgIndoor,
      worldW: bgIndoor.naturalWidth,
      worldH: bgIndoor.naturalHeight,
      // Walkable strip along the wooden floor between the kitchen plant and the cauldron.
      walkable: new RectWalk(200, 920, 1000, 1010),
      debugRect: { x0: 200, y0: 920, x1: 1000, y1: 1010 },
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
      if (scene.debugRect) {
        ctx.strokeStyle = '#33ff77';
        ctx.lineWidth = 1;
        ctx.strokeRect(
          scene.debugRect.x0 - cam.x,
          scene.debugRect.y0 - cam.y,
          scene.debugRect.x1 - scene.debugRect.x0,
          scene.debugRect.y1 - scene.debugRect.y0
        );
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

    // Player
    const sx = this.player.frame * SPRITE_CELL;
    const sy = this.player.row * SPRITE_CELL;
    const drawSize = this.player.drawSize;
    const dx = Math.round(this.player.x - cam.x - drawSize / 2);
    const dy = Math.round(this.player.y - cam.y - drawSize / 2);
    ctx.drawImage(
      this.spriteSheet,
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
