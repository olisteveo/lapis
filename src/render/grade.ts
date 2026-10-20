import * as THREE from 'three/webgpu';
import { LUTCubeLoader } from 'three/addons/loaders/LUTCubeLoader.js';
import { GRADES } from '../config';

/** The two LUT slots the painted frame is graded through, crossfaded by `blend` (see post.ts). */
export interface GradeSlots {
  lutA: { value: THREE.Texture };
  lutB: { value: THREE.Texture };
  sizeA: { value: number };
  sizeB: { value: number };
  blend: { value: number };
}

interface Lut {
  texture: THREE.Data3DTexture;
  size: number;
}

/** A 2x2x2 identity: trilinear filtering between its corners reproduces the input exactly. */
function identity(): Lut {
  const data = new Uint8Array(2 * 2 * 2 * 4);
  for (let b = 0, i = 0; b < 2; b++)
    for (let g = 0; g < 2; g++)
      for (let r = 0; r < 2; r++, i += 4) data.set([r * 255, g * 255, b * 255, 255], i);
  const texture = new THREE.Data3DTexture(data, 2, 2, 2);
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = texture.wrapR = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return { texture, size: 2 };
}

/**
 * Colour grades as .cube LUTs, one mood per chapter (GRADES in config.ts), so the look can be graded
 * like a photo in Resolve, Photoshop or anything that exports a .cube from a screenshot of the game.
 * Chapters without one stay neutral. Walking into another chapter's region crossfades to its mood.
 */
export class Grade {
  readonly neutral = identity();
  private luts = new Map<string, Lut>();
  private loader = new LUTCubeLoader().setType(THREE.UnsignedByteType);
  private from: Lut = this.neutral;
  private to: Lut = this.neutral;
  private blend = 1;
  private wanted = '';
  private slots: GradeSlots | null = null;

  constructor(private fadeSeconds = 4) {}

  /** Points a (re)built post pipeline at the current grade. */
  attach(slots: GradeSlots) {
    this.slots = slots;
    this.apply();
  }

  /** Loads a .cube for a chapter (or any key), replacing what was there. */
  async load(key: string, url: string) {
    const cube = await this.loader.loadAsync(url);
    this.luts.get(key)?.texture.dispose();
    this.luts.set(key, { texture: cube.texture3D, size: cube.size });
    if (this.wanted === key) this.fadeTo(this.luts.get(key)!, true);
  }

  async loadAll() {
    await Promise.all(
      Object.entries(GRADES).map(([key, url]) => url && this.load(key, url).catch((e) => console.warn(`grade ${key}:`, e))),
    );
  }

  /** The mood to show; unknown or ungraded keys mean neutral. */
  set(key: string) {
    if (key === this.wanted) return;
    this.wanted = key;
    this.fadeTo(this.luts.get(key) ?? this.neutral);
  }

  update(dt: number) {
    if (this.blend >= 1) return;
    this.blend = Math.min(1, this.blend + dt / this.fadeSeconds);
    this.apply();
  }

  private fadeTo(lut: Lut, now = false) {
    if (lut === this.to) return;
    if (lut === this.from && !now) {
      // Turning back mid-fade: run the same fade in reverse instead of popping.
      [this.from, this.to, this.blend] = [this.to, this.from, 1 - this.blend];
      this.apply();
      return;
    }
    // A third mood mid-fade starts from whichever slot dominates the screen right now.
    this.from = this.blend < 0.5 ? this.from : this.to;
    this.to = lut;
    this.blend = now ? 1 : 0;
    this.apply();
  }

  private apply() {
    if (!this.slots) return;
    const s = this.slots;
    s.lutA.value = this.from.texture;
    s.sizeA.value = this.from.size;
    s.lutB.value = this.to.texture;
    s.sizeB.value = this.to.size;
    // Smoothstep so the crossfade eases in and out rather than ramping linearly.
    s.blend.value = this.blend * this.blend * (3 - 2 * this.blend);
  }
}
