<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { Game } from '$lib/game/Game';

  let canvas: HTMLCanvasElement;
  let game: Game | null = null;
  let debug = $state(false);

  onMount(async () => {
    game = new Game({ canvas, debug });
    await game.start();
  });

  onDestroy(() => {
    game?.stop();
  });

  $effect(() => {
    if (game) game.debug = debug;
  });
</script>

<div class="root">
  <h1>Salamander</h1>
  <p class="hint">
    Bewegen mit <kbd>WASD</kbd> oder <kbd>Pfeiltasten</kbd> &nbsp;·&nbsp;
    Aktion <kbd>E</kbd> / <kbd>Space</kbd> &nbsp;·&nbsp;
    <label><input type="checkbox" bind:checked={debug} /> Debug</label>
  </p>
  <canvas bind:this={canvas} width="800" height="600"></canvas>
</div>

<style>
  :global(body) {
    margin: 0;
    background: #1c1f1a;
    color: #e8efe1;
    font-family: system-ui, sans-serif;
  }
  .root {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 16px;
  }
  h1 {
    margin: 0 0 4px;
    font-weight: 600;
    letter-spacing: 0.5px;
  }
  .hint {
    margin: 0 0 12px;
    font-size: 14px;
    opacity: 0.85;
  }
  kbd {
    background: #2a2f27;
    border: 1px solid #3d4538;
    border-bottom-width: 2px;
    border-radius: 4px;
    padding: 1px 6px;
    font-family: ui-monospace, monospace;
    font-size: 12px;
  }
  canvas {
    border: 2px solid #3d4538;
    border-radius: 6px;
    image-rendering: pixelated;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.4);
    max-width: 100%;
    height: auto;
  }
  label {
    margin-left: 14px;
    cursor: pointer;
    user-select: none;
  }
</style>
