import { Vector3 } from 'three';

// The whole look hangs off this palette, pulled from the reference paintings.
export const PALETTE = {
  zenith: 0x060b2e,
  sky: 0x101e78,
  horizon: 0x2640a8,
  cloud: 0x8b9de0,
  ultramarine: 0x1a2f9a,
  deepSea: 0x050d3a,
  shallowSea: 0x2346b8,
  foam: 0xf3e6da,
  sand: 0xe9d3cc,
  wetSand: 0x3b3f80,
  jungle: 0x0a1a12,
  jungleLit: 0x2a5a44,
  rock: 0x151c44,
  rockLit: 0x6f82d0,
  coral: 0xff6f55,
  salmon: 0xf59b85,
  starGold: 0xffb065,
  starWhite: 0xfff2dc,
  moon: 0xffa25a,
  fog: 0x2a3d9c,
} as const;

const dir = (azimuthDeg: number, elevationDeg: number) => {
  const az = (azimuthDeg * Math.PI) / 180;
  const el = (elevationDeg * Math.PI) / 180;
  // Azimuth 0 = north (-Z), clockwise toward east (+X).
  return new Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
};

export const SKY = {
  /** The bright one: due north over the River of Light. Glitter paths on the water point home. */
  brightStar: dir(0, 22),
  moon: dir(58, 7),
  /** Key light: a cool wash from high above the star, so faces toward home catch the rim. */
  keyLight: dir(20, 38),
};

export type QualityName = 'low' | 'medium' | 'high';

interface Quality {
  /** Cap on device pixel ratio; the paint filter hides low resolution well. */
  pixelRatio: number;
  fps: number;
  reflection: number;
  strokeSteps: number;
  sparkles: number;
  motes: number;
  /** Multiplier on flora draw radii. */
  flora: number;
  /** Multiplier on terrain LOD distances. */
  terrain: number;
}

const QUALITIES: Record<QualityName, Quality> = {
  low: { pixelRatio: 0.75, fps: 30, reflection: 0.25, strokeSteps: 5, sparkles: 0.4, motes: 0.5, flora: 0.6, terrain: 0.6 },
  medium: { pixelRatio: 1, fps: 60, reflection: 0.35, strokeSteps: 7, sparkles: 0.7, motes: 0.8, flora: 0.85, terrain: 0.85 },
  high: { pixelRatio: 1.5, fps: 60, reflection: 0.5, strokeSteps: 9, sparkles: 1, motes: 1, flora: 1, terrain: 1 },
};

function pickQuality(): QualityName {
  const q = new URLSearchParams(location.search).get('quality');
  if (q === 'low' || q === 'medium' || q === 'high') return q;
  try {
    const saved = localStorage.getItem('lapis.quality');
    if (saved === 'low' || saved === 'medium' || saved === 'high') return saved;
  } catch {
    // Storage blocked: fall through to the default.
  }
  return 'medium';
}

export const QUALITY_NAME = pickQuality();
export const QUALITY = QUALITIES[QUALITY_NAME];

/** Cycle presets; most of them size GPU resources at startup, so the page reloads. */
export function cycleQuality() {
  const order: QualityName[] = ['low', 'medium', 'high'];
  const next = order[(order.indexOf(QUALITY_NAME) + 1) % order.length];
  try {
    localStorage.setItem('lapis.quality', next);
  } catch {
    // Ignore; the reload will fall back to the default.
  }
  const url = new URL(location.href);
  url.searchParams.delete('quality');
  location.href = url.toString();
}

export const RENDER = {
  maxPixelRatio: QUALITY.pixelRatio,
  fov: 48,
  near: 0.25,
  far: 24000,
  fogDensity: 0.00034,
};

export const TERRAIN = {
  chunkSize: 512,
  /** [max distance, segments per chunk side] from fine to coarse. */
  lods: [
    [520 * QUALITY.terrain, 256],
    [1150 * QUALITY.terrain, 128],
    [2300 * QUALITY.terrain, 64],
    [4200 * QUALITY.terrain, 32],
    [Infinity, 16],
  ] as [number, number][],
};

export const FLORA = {
  blockSize: 128,
  loadRadius: 1500,
  hiRadius: 110,
  jungleHiRadius: 120,
};
