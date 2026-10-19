import { abs, exp, float, length, max, pow, saturate, vec2, Fn } from 'three/tsl';

// TSL's generic typings fight swizzles on function params; these are float/vec2 nodes.
type F = any;

/**
 * The four-point star from the paintings: a soft core with thin cross rays.
 * `p` is the sprite uv in [0,1]; `rays` scales ray length; `diag` adds faint diagonal rays.
 */
export const starShape = Fn(([p, rays, diag]: [F, F, F]) => {
  const q: F = p.mul(2).sub(1).toVar();
  const a: F = abs(q).toVar();
  const r = length(q);
  const core = exp(r.mul(-14)).mul(1.4).add(exp(r.mul(-40)).mul(2.0));
  const thin = float(55);
  const reach = rays.max(0.001);
  const rayH = exp(a.y.mul(thin.negate())).mul(pow(saturate(float(1).sub(a.x.div(reach))), 2.2));
  const rayV = exp(a.x.mul(thin.negate())).mul(pow(saturate(float(1).sub(a.y.div(reach))), 2.2));
  // Rotate 45 degrees for the faint secondary rays on the hero star.
  const d = vec2(q.x.add(q.y), q.x.sub(q.y)).mul(0.7071);
  const ad = abs(d);
  const rayD = max(
    exp(ad.y.mul(-90)).mul(pow(saturate(float(1).sub(ad.x.div(reach.mul(0.45)))), 3)),
    exp(ad.x.mul(-90)).mul(pow(saturate(float(1).sub(ad.y.div(reach.mul(0.45)))), 3)),
  ).mul(diag);
  return core.add(max(rayH, rayV)).add(rayD);
});
