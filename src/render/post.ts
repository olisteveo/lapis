import * as THREE from 'three/webgpu';
import {
  abs, color, dot, exp, float, floor, fract, getViewPosition, hash, length, luminance, max, min, mix, mx_fractal_noise_float,
  mx_noise_float, normalize, pass, pow, renderOutput, rtt, screenCoordinate, screenSize, screenUV, select, smoothstep,
  sqrt, texture, time, uniform, vec2, vec3, vec4,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { gaussianBlur } from 'three/addons/tsl/display/GaussianBlurNode.js';
import { PALETTE } from '../config';

// TSL's generics can't follow values through these unrolled loops; nodes are typed loosely.
type N = any;

/** Swatches measured from the reference paintings (k-means), plus the vivid accents k-means averages away. */
const SWATCHES = [
  0x0b0e07, 0x0e1b2e, 0x132340, 0x1e3156, 0x173b73, 0x27538e, 0x2846c8, 0x4b6ea1,
  0x8196b8, 0x815f5e, 0xb35d3d, 0xbf7e77, 0xff6e50, 0xffb866, 0xc9a2a3, 0xd6cbcb, 0xf2e6d8,
];

function srgbToOklab(hex: number): [number, number, number] {
  const c = new THREE.Color(hex); // three converts to linear on construction
  const l = Math.cbrt(0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b);
  const m = Math.cbrt(0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b);
  const s = Math.cbrt(0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function toOklab(c: N): N {
  const lin = pow(max(c, vec3(0)), vec3(2.2));
  const l = pow(dot(lin, vec3(0.4122214708, 0.5363325363, 0.0514459929)).max(1e-6), 1 / 3);
  const m = pow(dot(lin, vec3(0.2119034982, 0.6806995451, 0.1073969566)).max(1e-6), 1 / 3);
  const s = pow(dot(lin, vec3(0.0883024619, 0.2817188376, 0.6299787005)).max(1e-6), 1 / 3);
  return vec3(
    l.mul(0.2104542553).add(m.mul(0.793617785)).sub(s.mul(0.0040720468)),
    l.mul(1.9779984951).sub(m.mul(2.428592205)).add(s.mul(0.4505937099)),
    l.mul(0.0259040371).add(m.mul(0.7827717662)).sub(s.mul(0.808675766)),
  );
}

/**
 * Drawing renderer. The 3D scene is only reference material: every frame is re-made as a
 * painting. Strokes follow the image's own contours (structure tensor + line integral),
 * colour is pulled onto the paintings' palette, ink lines trace silhouettes, everything
 * sits on canvas, and the hand-made parts re-draw at 10fps like drawn animation.
 */
export function createPost(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
  const pipeline = new THREE.RenderPipeline(renderer);
  const scenePass = pass(scene, camera);
  const sceneColor = scenePass.getTextureNode('output');
  const paint = uniform(1);
  const boilRate = uniform(10);
  // Stepped time: anything keyed to this re-draws in discrete frames, never smoothly.
  const boil = floor(time.mul(boilRate)) as N;
  const px = screenCoordinate.xy as N;
  const texel = vec2(1).div(screenSize) as N;

  // ---- 1. Scene + mist + glow, tone-mapped to display space.
  const glow = bloom(sceneColor, 1.1, 0.9, 0.5);
  const depthTex = scenePass.getTextureNode('depth') as N;
  const depth = depthTex.sample(screenUV).r as N;
  const viewPos = getViewPosition(screenUV, depth, uniform(camera.projectionMatrixInverse)) as N;
  const world = uniform(camera.matrixWorld).mul(vec4(viewPos, 1)).xyz as N;
  const dist = length(viewPos) as N;
  const isSky = depth.greaterThan(0.99999);
  const drift = mx_fractal_noise_float(vec3(world.x.mul(0.004), time.mul(0.015), world.z.mul(0.004)), 3) as N;
  const layer = exp(max(world.y.sub(drift.mul(10).add(2)), 0).div(-16));
  const mistAmt = select(isSky, float(0), float(1).sub(exp(dist.mul(-0.0014))).mul(layer).mul(0.3));
  const mistCol = mix(vec3(0.07, 0.1, 0.32), vec3(0.2, 0.2, 0.42), drift.mul(0.5).add(0.5));
  const hdr = mix(sceneColor.rgb, mistCol, mistAmt).add(glow.rgb);
  const mapped = renderOutput(vec4(hdr, 1)).rgb as N;
  // Paint contrast: deepen the darks and lift the lights, the paintings never sit in mid-grey.
  const curved = mapped.mul(mapped).mul(float(3).sub(mapped.mul(2))).mul(0.55).add(mapped.mul(0.45));
  const ldr = rtt(vec4(curved.mul(vec3(0.94, 0.96, 1.04)), 1)) as N;

  // ---- 2. Structure tensor of the image, smoothed: tells each pixel which way its contour runs.
  const lum = (o: N) => luminance(ldr.sample(screenUV.add(o.mul(texel))).rgb);
  const gx = lum(vec2(1, -1)).add(lum(vec2(1, 0)).mul(2)).add(lum(vec2(1, 1)))
    .sub(lum(vec2(-1, -1))).sub(lum(vec2(-1, 0)).mul(2)).sub(lum(vec2(-1, 1)));
  const gy = lum(vec2(-1, 1)).add(lum(vec2(0, 1)).mul(2)).add(lum(vec2(1, 1)))
    .sub(lum(vec2(-1, -1))).sub(lum(vec2(0, -1)).mul(2)).sub(lum(vec2(1, -1)));
  // Wrapped in rtt so the blur becomes a sampleable texture (the blur node itself is not).
  const tensor = rtt(gaussianBlur(vec4(gx.mul(gx), gy.mul(gy), gx.mul(gy), 1), null, 4)) as N;

  // In flat areas (open sky, still water) there is no contour; fall back to a slow, mostly
  // horizontal swirl so those regions still carry brush direction, as in the paintings.
  const swirl = (p: N) => {
    const a = mx_noise_float(p.mul(0.0025)).mul(0.9);
    return vec2(a.cos(), a.sin());
  };
  const flowAt = (uvp: N): N => {
    const t = tensor.sample(uvp) as N;
    const E = t.x;
    const G = t.y;
    const F = t.z;
    const disc = sqrt(E.sub(G).mul(E.sub(G)).add(F.mul(F).mul(4)));
    const l1 = E.add(G).add(disc).mul(0.5);
    const tang = vec2(l1.sub(E), F.negate());
    const strength = smoothstep(0.0004, 0.004, disc);
    const dir = select(length(tang).greaterThan(1e-5), normalize(tang), vec2(1, 0));
    return normalize(mix(swirl(uvp.mul(screenSize)), dir, strength));
  };

  // ---- 3. Line integral along the flow: smears colour into strokes and carries a bristle
  // noise with it, so each stroke has streaks. Bristles re-lay at the boil rate.
  const STEPS = 9;
  const stepPx = 1.6;
  const bristle = (p: N) => hash(floor(p.x.mul(0.55)).add(floor(p.y.mul(0.55)).mul(1931)).add(boil.mul(17.31)));
  let acc: N = ldr.sample(screenUV).rgb;
  let streak: N = bristle(px);
  let wsum: N = float(1);
  for (const sign of [1, -1]) {
    let p: N = screenUV;
    let d: N = flowAt(screenUV).mul(sign);
    for (let i = 1; i <= STEPS; i++) {
      p = p.add(d.mul(stepPx).mul(texel));
      const nd = flowAt(p);
      // Eigenvectors have no sign; keep marching the same way round.
      d = select(dot(nd, d).lessThan(0), nd.negate(), nd);
      const w = float(1 - i / (STEPS + 1));
      acc = acc.add(ldr.sample(p).rgb.mul(w));
      streak = streak.add(bristle(p.mul(screenSize)).mul(w));
      wsum = wsum.add(w);
    }
  }
  const strokeMod = streak.div(wsum).sub(0.5).mul(0.22).add(1);
  let c: N = mix(ldr.sample(screenUV).rgb, acc.div(wsum).mul(strokeMod), paint);

  // ---- 4. Pull colour onto the reference palette: nearest two swatches in Oklab, blended.
  const labs = SWATCHES.map(srgbToOklab);
  const dither = hash(px.x.add(px.y.mul(4099)).add(boil.mul(7.13))).sub(0.5).mul(0.035);
  const lab = toOklab(c).add(vec3(dither, 0, 0));
  let best: N = vec3(0);
  let bestD: N = float(1e9);
  let second: N = vec3(0);
  let secondD: N = float(1e9);
  SWATCHES.forEach((hex, k) => {
    const [L, A, B] = labs[k];
    const diff = lab.sub(vec3(L, A, B)).mul(vec3(1.3, 1, 1));
    const dd = dot(diff, diff);
    const sw = color(hex);
    const isBest = dd.lessThan(bestD);
    const isSecond = dd.lessThan(secondD);
    second = select(isBest, best, select(isSecond, sw, second));
    secondD = select(isBest, bestD, select(isSecond, dd, secondD));
    best = select(isBest, sw, best);
    bestD = select(isBest, dd, bestD);
  });
  // Near-hard choice between the two nearest: flat painted fields with soft transitions.
  const t2 = smoothstep(0.3, 0.7, sqrt(bestD).div(sqrt(bestD).add(sqrt(secondD)).max(1e-5)));
  // color() gives linear values; the image at this point is display-encoded.
  const quant = pow(mix(best, second, t2), vec3(1 / 2.2));
  // Bright emissive accents (glowing palms, stars) keep their own colour.
  const bright = smoothstep(0.75, 1.0, luminance(c));
  c = mix(c, quant, float(0.62).mul(float(1).sub(bright.mul(0.6))).mul(paint));

  // ---- 5. Ink: silhouettes from depth, inner contours from tone, wobbling at the boil rate.
  const wobble = vec2(
    mx_noise_float(vec3(px.mul(0.02), boil.mul(0.37))),
    mx_noise_float(vec3(px.mul(0.02).add(9.1), boil.mul(0.37))),
  ).mul(1.6);
  const ld = (o: N) => {
    const dd = depthTex.sample(screenUV.add(wobble.add(o).mul(texel))).r;
    // Perspective depth is too compressed to edge-detect directly; spread it out first.
    return float(1).div(float(1).sub(dd).max(1e-6)).log();
  };
  const dEdge = abs(ld(vec2(1, 0)).sub(ld(vec2(-1, 0)))).add(abs(ld(vec2(0, 1)).sub(ld(vec2(0, -1)))));
  const tl = (o: N) => luminance(ldr.sample(screenUV.add(wobble.add(o).mul(texel))).rgb);
  const tEdge = abs(tl(vec2(1.5, 0)).sub(tl(vec2(-1.5, 0)))).add(abs(tl(vec2(0, 1.5)).sub(tl(vec2(0, -1.5)))));
  const lineNoise = mx_noise_float(vec3(px.mul(0.05), boil.mul(0.61))).mul(0.5).add(0.5);
  const ink = max(smoothstep(0.35, 0.9, dEdge), smoothstep(0.16, 0.42, tEdge).mul(0.55)).mul(lineNoise.mul(0.6).add(0.4));
  c = mix(c, color(0x070b24), ink.mul(0.6).mul(paint));

  // ---- 6. Stipple: tiny warm and cream dots through the dark blues, as in every reference.
  const cell = floor(px.div(3)) as N;
  const sh = hash(cell.x.add(cell.y.mul(7919)).add(boil.mul(13.7)));
  const blueDark = smoothstep(0.35, 0.08, luminance(c)).mul(smoothstep(0.0, 0.08, c.b.sub(c.r)));
  const dotOn = smoothstep(0.9965, 1.0, sh).mul(blueDark);
  const dotCol = mix(color(PALETTE.starGold), color(PALETTE.starWhite), fract(sh.mul(91)));
  c = mix(c, pow(dotCol, vec3(1 / 2.2)), dotOn.mul(0.8).mul(paint));

  // ---- 7. Canvas: emboss the weave, let pigment pool in the valleys.
  const canvasTex = new THREE.TextureLoader().load('/textures/canvas.png');
  canvasTex.wrapS = canvasTex.wrapT = THREE.RepeatWrapping;
  canvasTex.colorSpace = THREE.NoColorSpace;
  const cuv = px.div(1024 * 1.2);
  const ch = texture(canvasTex, cuv).r as N;
  const chx = texture(canvasTex, cuv.add(vec2(1 / 1024, 0))).r as N;
  const chy = texture(canvasTex, cuv.add(vec2(0, 1 / 1024))).r as N;
  const relief = chx.sub(ch).mul(-0.7).add(chy.sub(ch).mul(0.7));
  c = c.mul(relief.mul(0.9).add(1)).mul(ch.mul(0.16).add(0.9));

  // ---- 8. Vignette and grain.
  const v = length(screenUV.sub(0.5).mul(vec2(1.1, 1)));
  c = mix(pow(color(PALETTE.zenith), vec3(1 / 2.2)).mul(0.7), c, smoothstep(0.9, 0.3, v).mul(0.3).add(0.7));
  c = c.add(hash(px.x.add(px.y.mul(4096)).add(boil.mul(31))).sub(0.5).mul(0.025));

  pipeline.outputNode = vec4(min(c, vec3(1)), 1);
  pipeline.outputColorTransform = false;
  return { pipeline, paint, boilRate };
}
