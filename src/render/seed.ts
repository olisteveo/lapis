import { hash as tslHash, select } from 'three/tsl';

type N = any;

/**
 * hash() truncates its seed to a uint, and WebGPU clamps every negative float to 0 on the way, so
 * all negative seeds hash alike. Negatives are folded onto their own range above 2^20; positive
 * seeds hash exactly as before.
 */
export const hash = (seed: N) => tslHash(select(seed.lessThan(0), seed.negate().add(1048576), seed));
