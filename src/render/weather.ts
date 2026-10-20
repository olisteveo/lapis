import { uniform } from 'three/tsl';

/**
 * Weather the picture responds to (core/squalls.ts drives it): the painting pass thickens and greys
 * its mist, glows dim, and lightning lights the whole frame for an instant.
 */
export const weather = {
  /** 0..1: how hard the squall is raining and blowing. */
  storm: uniform(0),
  /** 0..1: a lightning flash, decaying fast. */
  flash: uniform(0),
  /** Wind (x, z) the rain slants along, scaled by the storm. */
  windX: uniform(0),
  windZ: uniform(0),
};
