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
  jungle: 0x08140f,
  jungleLit: 0x1d3a35,
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

export const RENDER = {
  maxPixelRatio: 1.5,
  fov: 48,
  near: 0.25,
  far: 24000,
  fogDensity: 0.0005,
};

export const TERRAIN = {
  chunkSize: 512,
  /** [max distance, segments per chunk side] from fine to coarse. */
  lods: [
    [520, 256],
    [1150, 128],
    [2300, 64],
    [4200, 32],
    [Infinity, 16],
  ] as [number, number][],
};

export const FLORA = {
  blockSize: 128,
  loadRadius: 1500,
  hiRadius: 110,
  jungleHiRadius: 120,
};
