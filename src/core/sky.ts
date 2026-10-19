// Fixed directions in the sky, as plain unit vectors. Azimuth 0 = north (-Z), clockwise toward
// east (+X). Renderers wrap these in their own vector types.
export interface Dir {
  x: number;
  y: number;
  z: number;
}

export function skyDir(azimuthDeg: number, elevationDeg: number): Dir {
  const az = (azimuthDeg * Math.PI) / 180;
  const el = (elevationDeg * Math.PI) / 180;
  return { x: Math.sin(az) * Math.cos(el), y: Math.sin(el), z: -Math.cos(az) * Math.cos(el) };
}

export const SKY_DIRS = {
  /** The brightest star: due north over the River of Light. */
  brightStar: skyDir(0, 22),
  moon: skyDir(58, 7),
  /** Key light: a cool wash from high above the star, so faces toward home catch the rim. */
  keyLight: skyDir(20, 38),
};
