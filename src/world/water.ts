import * as THREE from 'three/webgpu';
import {
  cameraFar, cameraNear, cameraPosition, color, dot, float, max, mix, mx_noise_float, normalize, perspectiveDepthToViewZ,
  positionView, positionWorld, pow, reflect, reflector, saturate, sin, smoothstep, time, vec2, vec3, viewportDepthTexture,
} from 'three/tsl';
import { PALETTE, QUALITY, SKY, onQualityChange } from '../config';
import { LAGOONS } from './heightfield';

export function createWater() {
  const reflection = reflector({ resolutionScale: QUALITY.reflection });
  reflection.target.rotateX(-Math.PI / 2);
  onQualityChange(() => (reflection.reflector.resolutionScale = QUALITY.reflection));

  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: true });
  const p = positionWorld.xz;
  const t = time;

  // Two octaves of drifting slopes stand in for a wave normal; cheap and painterly enough.
  const sx = mx_noise_float(vec3(p.mul(0.045).add(vec2(t.mul(0.03), 0)), t.mul(0.12)));
  const sz = mx_noise_float(vec3(p.mul(0.045).add(vec2(31.0, t.mul(0.025))), t.mul(0.12)));
  const fx = mx_noise_float(vec3(p.mul(0.32).add(vec2(t.mul(0.12), 7)), t.mul(0.4)));
  const fz = mx_noise_float(vec3(p.mul(0.32).add(vec2(13, t.mul(-0.1))), t.mul(0.4)));
  const dist = positionView.z.negate();
  const detailFade = smoothstep(400, 40, dist);
  // Long swell bands roughly across the star direction, like the brushed wave rows in ref 4.
  const swell = sin(p.y.mul(0.22).add(p.x.mul(0.05)).add(t.mul(0.9)).add(sx.mul(2.5)));
  const n = normalize(vec3(sx.mul(0.3).add(fx.mul(0.14).mul(detailFade)), 1, sz.mul(0.3).add(fz.mul(0.14).mul(detailFade)).add(swell.mul(0.12))));

  const v = normalize(cameraPosition.sub(positionWorld));
  const ndv = saturate(dot(n, v));
  const fresnel = pow(float(1).sub(ndv), 3).mul(0.7).add(0.12);

  reflection.uvNode = reflection.uvNode!.add(vec2(n.x.mul(0.035), n.z.mul(0.08)).mul(smoothstep(2500, 60, dist).mul(0.75).add(0.25)));
  const reflected = reflection.rgb;

  // Water depth behind this fragment, in view-space metres, from the opaque depth buffer.
  const sceneZ = perspectiveDepthToViewZ(viewportDepthTexture(), cameraNear, cameraFar);
  const depth = max(positionView.z.sub(sceneZ), 0).mul(ndv.mul(0.7).add(0.3));

  const body = mix(color(PALETTE.shallowSea), color(PALETTE.deepSea), smoothstep(0.5, 14, depth));
  // Moon-path sheen toward the bright one; the sparkle sprites add the star glints on top.
  const sd = vec3(SKY.brightStar.x, SKY.brightStar.y, SKY.brightStar.z);
  const sheen = pow(saturate(dot(reflect(v.negate(), n), sd)), 160).mul(0.07);
  // Crests catching skylight give the painted wave rows; troughs keep the deep ultramarine.
  const crest = smoothstep(0.35, 1.0, swell).mul(0.1).mul(smoothstep(1800, 100, dist));
  let col = mix(body, reflected.mul(1.0), fresnel).add(color(PALETTE.horizon).mul(crest)).add(color(PALETTE.starWhite).mul(sheen));

  // Cream foam: a hard lip at the shoreline plus soft bands rolling in, broken by noise.
  const fn = mx_noise_float(vec3(p.mul(0.18), t.mul(0.25)));
  const bands = sin(depth.mul(2.6).sub(t.mul(1.3)).add(fn.mul(3))).mul(0.5).add(0.5);
  // Far terrain is coarse: whole triangles sit just under the surface and would foam as flat
  // polygons, so the lip is thin, noise-broken, and fades out with distance.
  const lipBreak = mx_noise_float(vec3(p.mul(0.9), t.mul(0.4)));
  const lip = smoothstep(0.28, 0.03, depth.add(fn.mul(0.12)).add(lipBreak.mul(0.1))).mul(smoothstep(260, 60, dist));
  const rolling = smoothstep(0.62, 0.92, bands).mul(smoothstep(3.2, 0.4, depth)).mul(smoothstep(-0.3, 0.3, fn));
  const foam = saturate(max(lip, rolling.mul(0.85)));
  col = mix(col, color(PALETTE.foam).mul(0.9), foam);

  // Secret lagoons: still, luminous turquoise water, lit from below.
  let lagoon: any = float(0);
  for (const L of LAGOONS) lagoon = max(lagoon, smoothstep(L.r - 4, L.r - 18, positionWorld.xz.sub(vec2(L.x, L.z)).length()));
  const glowBand = sin(depth.mul(1.6).sub(t.mul(0.6)).add(fn.mul(2))).mul(0.5).add(0.5);
  // Bright enough to bloom: the light comes up through the water, strongest in the shallows.
  const lagoonCol = mix(color(0x0d4f66), color(0x6ff4ee), smoothstep(2.8, 0.1, depth).mul(0.55).add(glowBand.mul(0.45))).mul(1.7);
  col = mix(col, mix(lagoonCol, reflected, fresnel.mul(0.35)), lagoon.mul(0.9));
  mat.colorNode = col;
  mat.opacityNode = max(smoothstep(0.0, 0.5, depth), foam).mul(0.97);

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.scale.setScalar(60000);
  mesh.frustumCulled = false;
  mesh.name = 'water';
  mesh.renderOrder = 1;

  return {
    mesh,
    reflection,
    target: reflection.target,
    update(focus: THREE.Vector3) {
      // Snap to a coarse grid so world-space noise stays still under a moving camera.
      mesh.position.set(Math.round(focus.x / 64) * 64, 0, Math.round(focus.z / 64) * 64);
      reflection.target.position.set(0, 0, 0);
    },
  };
}
