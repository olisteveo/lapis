import { WORLD_HALF, WORLD_SIZE, type Heightfield } from '../core/heightfield';

const RES = 256;
const FOG = 128;
const REVEAL = 300;
const STORE = 'lapis.map.v1';

export interface MapMarker {
  kind: 'beacon' | 'beaconLit' | 'lagoon' | 'wonder' | 'mystery' | 'star';
  x: number;
  z: number;
  label?: string;
}

const lerp = (a: number[], b: number[], t: number) => a.map((v, i) => v + (b[i] - v) * t);

/** The Keeper's chart: a hand-inked map, revealed only where you have been. */
export class JournalMap {
  private root: HTMLElement;
  private canvas: HTMLCanvasElement;
  private base: HTMLCanvasElement | null = null;
  private fog = new Uint8Array(FOG * FOG);
  private fogCanvas = document.createElement('canvas');
  private dirty = false;
  private saveT = 0;
  open = false;
  markers: () => MapMarker[] = () => [];
  /** Without the compass you have to place yourself on the chart by its landmarks. */
  showSelf = false;

  constructor(private hf: Heightfield) {
    this.root = document.createElement('div');
    this.root.id = 'map';
    this.root.innerHTML = `<div class="sheet"><canvas></canvas><div class="caption">the keeper's chart<span>M to close</span></div></div>`;
    document.body.appendChild(this.root);
    this.canvas = this.root.querySelector('canvas')!;
    this.fogCanvas.width = this.fogCanvas.height = FOG;
    try {
      const raw = localStorage.getItem(STORE);
      if (raw) this.fog.set(Uint8Array.from(atob(raw), (c) => c.charCodeAt(0)).subarray(0, FOG * FOG));
    } catch {
      // No storage: the chart starts blank each time.
    }
  }

  /** Paint the island once: sea hatching, ink coast, contours and region washes. */
  private paintBase() {
    const c = document.createElement('canvas');
    c.width = c.height = RES;
    const g = c.getContext('2d')!;
    const img = g.createImageData(RES, RES);
    const h = new Float32Array(RES * RES);
    const step = WORLD_SIZE / RES;
    for (let j = 0; j < RES; j++)
      for (let i = 0; i < RES; i++) {
        const x = -WORLD_HALF + (i + 0.5) * step;
        const z = -WORLD_HALF + (j + 0.5) * step;
        const s = this.hf.sample(x, z);
        h[j * RES + i] = s.height;
        let col: number[];
        if (s.height < 0) {
          // Shallows lighter, deeps the night ink of the sea; faint horizontal wave hatching.
          const t = Math.min(1, -s.height / 30);
          col = lerp([44, 92, 150], [10, 20, 58], Math.sqrt(t));
          if ((j % 6 === 0 && (i + j * 3) % 14 < 7) || s.height > -1.2) col = lerp(col, [120, 170, 210], s.height > -1.2 ? 0.35 : 0.18);
        } else {
          col = lerp([214, 200, 170], [150, 140, 120], Math.min(1, s.height / 260));
          col = lerp(col, [96, 132, 110], Math.min(1, s.grove * 0.7));
          col = lerp(col, [150, 196, 150], s.meadow * 0.6);
          col = lerp(col, [140, 110, 190], s.lantern * 0.6);
          col = lerp(col, [226, 196, 128], s.dunes * 0.6);
          col = lerp(col, [120, 120, 140], Math.min(1, s.rock) * 0.5);
        }
        img.data.set([col[0], col[1], col[2], 255], (j * RES + i) * 4);
      }
    // Ink: the coastline and contour lines every 40 m, where a band boundary passes between texels.
    for (let j = 1; j < RES - 1; j++)
      for (let i = 1; i < RES - 1; i++) {
        const v = h[j * RES + i];
        const r = h[j * RES + i + 1];
        const d = h[(j + 1) * RES + i];
        const k = (j * RES + i) * 4;
        const coast = v >= 0 !== r >= 0 || v >= 0 !== d >= 0;
        const band = (a: number) => Math.floor(a / 40);
        const contour = v > 0 && (band(v) !== band(r) || band(v) !== band(d));
        if (coast) img.data.set([40, 30, 50, 255], k);
        else if (contour) for (let c = 0; c < 3; c++) img.data[k + c] *= 0.78;
      }
    g.putImageData(img, 0, 0);
    this.base = c;
  }

  /** Mark where you are as seen. Cheap: called every frame. */
  reveal(x: number, z: number, dt: number) {
    const cell = WORLD_SIZE / FOG;
    const cx = (x + WORLD_HALF) / cell;
    const cz = (z + WORLD_HALF) / cell;
    const r = REVEAL / cell;
    for (let j = Math.floor(cz - r); j <= Math.ceil(cz + r); j++)
      for (let i = Math.floor(cx - r); i <= Math.ceil(cx + r); i++) {
        if (i < 0 || j < 0 || i >= FOG || j >= FOG) continue;
        const d = Math.hypot(i + 0.5 - cx, j + 0.5 - cz) / r;
        if (d > 1) continue;
        const v = Math.round(255 * Math.min(1, (1 - d) * 2.2));
        if (v > this.fog[j * FOG + i]) {
          this.fog[j * FOG + i] = v;
          this.dirty = true;
        }
      }
    this.saveT += dt;
    if (this.dirty && this.saveT > 5) {
      this.saveT = 0;
      this.dirty = false;
      try {
        localStorage.setItem(STORE, btoa(String.fromCharCode(...this.fog)));
      } catch {
        // Storage full or blocked: the chart just won't persist.
      }
    }
  }

  revealed(x: number, z: number) {
    const cell = WORLD_SIZE / FOG;
    const i = Math.floor((x + WORLD_HALF) / cell);
    const j = Math.floor((z + WORLD_HALF) / cell);
    return i >= 0 && j >= 0 && i < FOG && j < FOG && this.fog[j * FOG + i] > 60;
  }

  /** heading: radians clockwise from north (-Z). */
  show(player: { x: number; z: number }, heading: number) {
    if (!this.base) this.paintBase();
    this.open = true;
    this.root.classList.add('open');
    this.draw(player, heading);
  }

  hide() {
    this.open = false;
    this.root.classList.remove('open');
  }

  static clear() {
    try {
      localStorage.removeItem(STORE);
    } catch {
      // Nothing to clear.
    }
  }

  private draw(player: { x: number; z: number }, heading: number) {
    const size = Math.min(innerWidth, innerHeight) * 0.82;
    const dpr = Math.min(devicePixelRatio, 2);
    this.canvas.width = this.canvas.height = Math.round(size * dpr);
    this.canvas.style.width = this.canvas.style.height = `${size}px`;
    const g = this.canvas.getContext('2d')!;
    const S = this.canvas.width;
    const toPx = (x: number, z: number) => [((x + WORLD_HALF) / WORLD_SIZE) * S, ((z + WORLD_HALF) / WORLD_SIZE) * S];
    g.imageSmoothingEnabled = true;
    g.drawImage(this.base!, 0, 0, S, S);

    // Unvisited country fades into the night: soft-edged, upscaled from the reveal grid.
    const fctx = this.fogCanvas.getContext('2d')!;
    const fimg = fctx.createImageData(FOG, FOG);
    for (let k = 0; k < FOG * FOG; k++) fimg.data.set([12, 16, 44, 215 - this.fog[k] * (215 / 255)], k * 4);
    fctx.putImageData(fimg, 0, 0);
    g.save();
    g.filter = `blur(${Math.round(S / FOG)}px)`;
    g.drawImage(this.fogCanvas, 0, 0, S, S);
    g.restore();

    const u = S / 900;
    g.textAlign = 'center';
    g.font = `italic ${Math.round(15 * u)}px 'Cormorant Garamond', serif`;
    for (const m of this.markers()) {
      const known = m.kind === 'beaconLit' || this.revealed(m.x, m.z);
      if (!known) continue;
      const [px, py] = toPx(m.x, m.z);
      g.save();
      g.translate(px, py);
      if (m.kind === 'beacon' || m.kind === 'beaconLit') {
        g.fillStyle = m.kind === 'beaconLit' ? '#ffc878' : 'rgba(40,30,50,0.8)';
        g.beginPath();
        g.moveTo(-4 * u, 6 * u);
        g.lineTo(-2.5 * u, -8 * u);
        g.lineTo(2.5 * u, -8 * u);
        g.lineTo(4 * u, 6 * u);
        g.fill();
        if (m.kind === 'beaconLit') {
          g.shadowColor = '#ffc878';
          g.shadowBlur = 12 * u;
          g.beginPath();
          g.arc(0, -10 * u, 3 * u, 0, Math.PI * 2);
          g.fill();
        }
      } else if (m.kind === 'star') {
        g.fillStyle = '#fff4dc';
        g.shadowColor = '#ffc878';
        g.shadowBlur = 10 * u;
        g.beginPath();
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * Math.PI * 2;
          const r = (k % 2 ? 2 : 8) * u;
          g.lineTo(Math.sin(a) * r, -Math.cos(a) * r);
        }
        g.fill();
      } else if (m.kind === 'lagoon') {
        g.strokeStyle = '#7ff0e0';
        g.lineWidth = 2 * u;
        g.beginPath();
        g.arc(0, 0, 9 * u, 0, Math.PI * 2);
        g.stroke();
      } else if (m.kind === 'wonder') {
        g.fillStyle = '#2a1e3a';
        g.beginPath();
        g.arc(0, 0, 4 * u, 0, Math.PI * 2);
        g.fill();
      } else {
        g.fillStyle = 'rgba(40,30,50,0.75)';
        g.font = `${Math.round(22 * u)}px 'Cormorant Garamond', serif`;
        g.fillText('?', 0, 7 * u);
      }
      if (m.label) {
        g.shadowBlur = 0;
        g.fillStyle = '#2a1e3a';
        g.fillText(m.label, 0, 22 * u);
      }
      g.restore();
    }

    if (!this.showSelf) return;
    // You: a small inked arrow pointing where you face.
    const [px, py] = toPx(player.x, player.z);
    g.save();
    g.translate(px, py);
    g.rotate(heading);
    g.fillStyle = '#ff8a6e';
    g.strokeStyle = '#2a1e3a';
    g.lineWidth = 1.5 * u;
    g.beginPath();
    g.moveTo(0, -11 * u);
    g.lineTo(7 * u, 8 * u);
    g.lineTo(0, 4 * u);
    g.lineTo(-7 * u, 8 * u);
    g.closePath();
    g.fill();
    g.stroke();
    g.restore();
  }
}
