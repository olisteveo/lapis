// Shared "drawn, not lit" shading: flat tones, pen-width hatching at a constant density on screen,
// laid in broken strokes and patches the way an illustrator hatches, never ruled edge to edge.
import { abs, cameraPosition, color, dot, float, fract, fwidth, length, min, mix, mx_noise_float, normalize, sin, smoothstep, vec2, vec3 } from 'three/tsl';
import { QUALITY, SKY } from '../config';

type N = any;

/** A pen line of roughly constant on-screen width (in pixels) wherever c crosses a whole number. */
export function penLines(c: N, px: number) {
  const f = fract(c);
  const d = min(f, f.oneMinus());
  const w = fwidth(c).max(1e-5);
  return smoothstep(w.mul(px), w.mul(px * 0.4), d);
}

/**
 * Moonlight as three flat tones with wobbly edges, like gouache. nl is N.L; edge is a small noise
 * that wobbles the band boundaries. Returns { tone, lit1, lit2 } where lit1 = out of shadow and
 * lit2 = in the highlight.
 */
export function tones(nl: N, edge: N, highlight = 0.7) {
  const lit1 = smoothstep(0.02, 0.07, nl.add(edge));
  const lit2 = smoothstep(highlight, highlight + 0.05, nl.add(edge));
  const tone = mix(float(0.34), mix(float(0.68), float(1.0), lit2), lit1);
  return { tone, lit1, lit2 };
}

/**
 * Hatching along a coordinate (distance across the hatch direction, in metres) at a constant
 * density on screen: spacing doubles with each doubling of camera distance, blended between octaves.
 */
export function hatchAt(coord: N, camDist: N, spacing: number, px: number, base = 0.45) {
  const lvl = camDist.div(10).max(1).log2();
  const s0 = lvl.floor().exp2().mul(base * spacing);
  return mix(penLines(coord.div(s0), px), penLines(coord.div(s0.mul(2)), px), lvl.fract());
}

/**
 * Where hatching is laid: in patches, with lines broken into strokes. along is the coordinate along
 * the hatch direction (metres); p is a world position for the patch noise.
 */
export function strokes(p: N, along: N, across: N, patches = true) {
  const patch = patches ? smoothstep(-0.25, 0.2, mx_noise_float(vec3(p.x.mul(0.06), p.y.mul(0.06), p.z.mul(0.06)))) : float(1);
  // Each line breaks into strokes of a metre or two; the break pattern shifts from line to line.
  const breaks = smoothstep(-0.35, -0.05, mx_noise_float(vec3(along.mul(0.55), across.mul(1.7), 0)));
  return patch.mul(breaks);
}

/** Low quality drops the stroke-break noise and the second hatch octave: the costliest parts. */
export const fullDetail = () => QUALITY.strokeSteps > 5;

/**
 * Ink a built or living surface: flat moonlight tones, then pen hatching in shadow (crossed in deep
 * shadow). Walls and trunks hatch vertically; roofs, decks and floors on a diagonal.
 * col: the painted colour; n: world normal; wp: world position.
 */
export function drawnSurface(col: N, n: N, wp: N, opts: { highlight?: number; strength?: number; spacing?: number } = {}) {
  const key = normalize(vec3(SKY.keyLight.x, SKY.keyLight.y, SKY.keyLight.z));
  const nl = dot(n, key);
  const edge = sin(wp.y.mul(0.9).add(wp.x.mul(0.3))).mul(0.05);
  const t = tones(nl, edge, opts.highlight ?? 0.6);
  const dc = length(wp.sub(cameraPosition));
  const view = normalize(wp.xz.sub(cameraPosition.xz));
  const upright = smoothstep(0.75, 0.45, abs(n.y));
  // Vertical strokes on walls (across the view), diagonal on flat-ish faces.
  const uWall = dot(wp.xz, vec2(view.y.negate(), view.x));
  const uFlat = dot(wp.xz, normalize(vec2(0.6, -0.8)));
  const u = mix(uFlat, uWall, upright).add(sin(wp.y.mul(0.7)).mul(0.03));
  const v = mix(dot(wp.xz, normalize(vec2(0.8, 0.6))), wp.y, upright);
  const spacing = opts.spacing ?? 0.8;
  const main = fullDetail() ? hatchAt(u, dc, spacing, 1.0, 0.3) : penLines(u.div(spacing * 0.5), 1.0);
  const cross = fullDetail() ? hatchAt(v, dc, spacing, 0.9, 0.3) : float(0);
  const deep = smoothstep(-0.15, -0.45, nl.add(edge));
  const broken = fullDetail() ? strokes(wp, v.mul(2), u.mul(3), false) : float(1);
  const hatch = main.mul(float(1).sub(t.lit1)).add(cross.mul(deep)).mul(broken).mul(smoothstep(160, 50, dc));
  return mix(col.mul(t.tone.mul(0.7).add(0.45)), color(0x0b1030), hatch.mul(opts.strength ?? 0.72).min(0.85));
}
