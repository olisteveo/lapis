export class Input {
  private keys = new Set<string>();
  yaw = 0;
  pitch = -0.18;
  zoom = 1;
  locked = false;
  onFirstGesture: (() => void) | null = null;

  constructor(el: HTMLElement) {
    addEventListener('keydown', (e) => {
      this.keys.add(e.code);
      if (e.code === 'Space') e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    el.addEventListener('click', () => {
      this.onFirstGesture?.();
      this.onFirstGesture = null;
      // Embedded previews can refuse pointer lock; ignore that rather than throwing.
      Promise.resolve(el.requestPointerLock?.()).catch(() => {});
    });
    document.addEventListener('pointerlockchange', () => (this.locked = document.pointerLockElement === el));
    addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.yaw -= e.movementX * 0.0022;
      this.pitch = Math.max(-1.25, Math.min(0.9, this.pitch - e.movementY * 0.0022));
    });
    el.addEventListener('wheel', (e) => (this.zoom = Math.max(0.45, Math.min(2.2, this.zoom * Math.exp(e.deltaY * 0.001)))), {
      passive: true,
    });
  }

  down(...codes: string[]) {
    return codes.some((c) => this.keys.has(c));
  }

  get moveX() {
    return (this.down('KeyD', 'ArrowRight') ? 1 : 0) - (this.down('KeyA', 'ArrowLeft') ? 1 : 0);
  }

  get moveY() {
    return (this.down('KeyW', 'ArrowUp') ? 1 : 0) - (this.down('KeyS', 'ArrowDown') ? 1 : 0);
  }
}
