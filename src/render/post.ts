import * as THREE from 'three/webgpu';
import {
  color, float, hash, length, luminance, mix, mx_noise_float, pass, renderOutput, screenCoordinate, screenSize,
  screenUV, select, smoothstep, time, uniform, vec2, vec3, vec4, max, exp, getViewPosition, mx_fractal_noise_float,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { gaussianBlur } from 'three/addons/tsl/display/GaussianBlurNode.js';
import type { Node, TextureNode } from 'three/webgpu';
import { PALETTE } from '../config';

/**
 * Kuwahara filter: per pixel, take the mean of whichever of four quadrants is least varied.
 * Flattens texture into brush-like patches while keeping silhouettes crisp: the oil-paint look.
 */
function kuwahara(tex: TextureNode, radius: number, baseUV: Node) {
  const texel = vec2(1).div(screenSize);
  const quads = [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ];
  const n = (radius + 1) * (radius + 1);
  let best: Node | null = null;
  let bestVar: Node | null = null;
  for (const [qx, qy] of quads) {
    let sum: Node = vec3(0);
    let sum2: Node = float(0);
    for (let j = 0; j <= radius; j++)
      for (let i = 0; i <= radius; i++) {
        const c = tex.sample((baseUV as any).add(vec2(i * qx, j * qy).mul(texel))).rgb;
        sum = (sum as any).add(c);
        const l = luminance(c);
        sum2 = (sum2 as any).add(l.mul(l));
      }
    const mean = (sum as any).div(n);
    const ml = luminance(mean);
    const variance = (sum2 as any).div(n).sub(ml.mul(ml));
    if (!best) {
      best = mean;
      bestVar = variance;
    } else {
      const better: any = variance.lessThan(bestVar);
      best = select(better, mean, best);
      bestVar = select(better, variance, bestVar);
    }
  }
  return best as any;
}

export function createPost(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
  const pipeline = new THREE.RenderPipeline(renderer);
  const scenePass = pass(scene, camera);
  const sceneColor = scenePass.getTextureNode('output');

  const paint = uniform(0.85);
  const canvasAmt = uniform(1);
  // Brush flow: a slow noise field nudges where each patch samples, so strokes wander
  // organically instead of sitting on the pixel grid.
  const fp = screenCoordinate.xy;
  const flow = vec2(mx_noise_float(fp.mul(0.012)), mx_noise_float(fp.mul(0.012).add(31.7))).mul(2.2).div(screenSize);
  const painted = mix(sceneColor.rgb, kuwahara(sceneColor, 3, screenUV.add(flow)), paint);
  const glow = bloom(sceneColor, 1.0, 0.85, 0.5);

  // Dream mist: rebuild world position from depth, then pool luminous haze low in the
  // valleys and over the water, drifting slowly, thickening with distance.
  const depth = scenePass.getTextureNode('depth').sample(screenUV).r;
  const viewPos = getViewPosition(screenUV, depth, uniform(camera.projectionMatrixInverse));
  const world = uniform(camera.matrixWorld).mul(vec4(viewPos, 1)).xyz;
  const dist = length(viewPos);
  const drift = mx_fractal_noise_float(vec3(world.x.mul(0.004), time.mul(0.015), world.z.mul(0.004)), 3);
  const floor = drift.mul(10).add(2);
  const layer = exp(max(world.y.sub(floor), 0).div(-16));
  const sky = depth.greaterThan(0.99999);
  const mistAmt = select(sky, float(0), float(1).sub(exp(dist.mul(-0.0018))).mul(layer).mul(0.6));
  const wisps = smoothstep(-0.2, 0.6, mx_fractal_noise_float(vec3(world.x.mul(0.03), world.y.mul(0.05).sub(time.mul(0.04)), world.z.mul(0.03)), 2));
  const nearMist = smoothstep(12, 45, dist).mul(smoothstep(180, 60, dist)).mul(layer).mul(wisps).mul(0.14);
  const mistCol = mix(vec3(0.07, 0.1, 0.32), vec3(0.2, 0.2, 0.42), drift.mul(0.5).add(0.5));
  const misted = mix(painted, mistCol, select(sky, float(0), max(mistAmt, nearMist)));

  let hdr: any = misted.add(glow.rgb);
  // Soft focus toward the edges of vision, like the blur at the rim of a dream.
  const rimMask = smoothstep(0.32, 0.75, length(screenUV.sub(0.5).mul(vec2(1.25, 1))));
  const blurred = gaussianBlur(vec4(hdr, 1), null, 6);
  hdr = mix(hdr, blurred.rgb, rimMask.mul(0.85));
  const mapped = renderOutput(vec4(hdr, 1)).rgb;

  // Grade toward the reference palette: blue-lifted shadows, a touch more saturation.
  const lum = luminance(mapped);
  let c = mapped.add(color(PALETTE.ultramarine).mul(float(1).sub(lum)).mul(0.06));
  c = mix(vec3(lum), c, 1.12);

  // Canvas: weave + fibres + slow diagonal brush drag, fixed to the screen like a real canvas.
  const px = screenCoordinate.xy;
  const weave = mx_noise_float(px.mul(0.9)).mul(0.7);
  const warp = mx_noise_float(vec2(px.x.mul(0.35), px.y.mul(0.07)));
  const weft = mx_noise_float(vec2(px.x.mul(0.07), px.y.mul(0.35)).add(17));
  const diag = vec2(px.x.add(px.y), px.x.sub(px.y)).mul(0.7071);
  const brush = mx_noise_float(vec2(diag.x.mul(0.004), diag.y.mul(0.03)));
  const grain = hash(px.x.add(px.y.mul(4096)).add(time.mul(60).floor().mul(7919))).sub(0.5);
  const canvasMod = weave.mul(0.03).add(warp.mul(0.04)).add(weft.mul(0.04)).add(brush.mul(0.06)).add(grain.mul(0.035)).mul(canvasAmt);
  c = c.mul(canvasMod.add(1)).add(max(lum.oneMinus().mul(0.008), 0).mul(canvasMod.abs().mul(4)));

  const v = length(screenUV.sub(0.5).mul(vec2(1.1, 1)));
  const vignette = smoothstep(0.85, 0.3, v);
  c = mix(color(PALETTE.zenith).mul(0.6), c, vignette.mul(0.35).add(0.65));

  pipeline.outputNode = vec4(c, 1);
  pipeline.outputColorTransform = false;
  return { pipeline, paint, canvasAmt };
}
