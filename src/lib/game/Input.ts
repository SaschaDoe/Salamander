export type InputState = {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  action: boolean;
};

export class Input {
  state: InputState = { up: false, down: false, left: false, right: false, action: false };
  /** Set on the rising edge of the action key; cleared by `consumeActionPress`. */
  private actionEdge = false;

  private onKey = (e: KeyboardEvent, pressed: boolean) => {
    let handled = true;
    switch (e.code) {
      case 'ArrowUp':
      case 'KeyW':
        this.state.up = pressed;
        break;
      case 'ArrowDown':
      case 'KeyS':
        this.state.down = pressed;
        break;
      case 'ArrowLeft':
      case 'KeyA':
        this.state.left = pressed;
        break;
      case 'ArrowRight':
      case 'KeyD':
        this.state.right = pressed;
        break;
      case 'KeyE':
      case 'Space':
      case 'Enter':
        if (pressed && !this.state.action) this.actionEdge = true;
        this.state.action = pressed;
        break;
      default:
        handled = false;
    }
    if (handled) e.preventDefault();
  };

  /** Returns true exactly once for each press of the action key. */
  consumeActionPress(): boolean {
    const v = this.actionEdge;
    this.actionEdge = false;
    return v;
  }

  private downHandler = (e: KeyboardEvent) => this.onKey(e, true);
  private upHandler = (e: KeyboardEvent) => this.onKey(e, false);
  private blurHandler = () => {
    this.state.up = this.state.down = this.state.left = this.state.right = false;
    this.state.action = false;
    this.actionEdge = false;
  };

  attach() {
    window.addEventListener('keydown', this.downHandler);
    window.addEventListener('keyup', this.upHandler);
    window.addEventListener('blur', this.blurHandler);
  }

  detach() {
    window.removeEventListener('keydown', this.downHandler);
    window.removeEventListener('keyup', this.upHandler);
    window.removeEventListener('blur', this.blurHandler);
  }
}
