import * as THREE from 'three/webgpu';
import {
  attribute, cameraPosition, color, cross, dot, float, min, mix, mx_fractal_noise_float, mx_noise_float, normalize,
  normalWorld, positionWorld, smoothstep, texture, vec2, vec3, screenUV, max, sin, time, floor, length,
} from 'three/tsl';
import { PALETTE, SKY } from '../config';
import { hash } from '../render/seed';
import { BIOMES } from '../core/heightfield';
import { hatchAt, penLines, strokes, tones } from '../render/drawn';

type N = any;

/**
 * Reflection source shared by the water and the wet sand. The water's reflector owns the
 * render target; terrain samples it through this proxy, which is pointed at a dummy while
 * the reflection pass itself is drawing (sampling your own render target is illegal).
 */
export function createReflectionProxy() {
  const dummy = new THREE.DataTexture(new Uint8Array([12, 22, 80, 255]), 1, 1);
  dummy.needsUpdate = true;
  return { node: texture(dummy), dummy };
}

/**
 * Painterly terrain: sand that blushes pink, mirror-wet shorelines, near-black jungle,
 * granite walls with vertical rain streaks, all broken up by brush-scale noise.
 */
export function createTerrainMaterial(reflection: THREE.TextureNode) {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
  const attrs = attribute<'vec2'>('terrainAttrs', 'vec2');
  const rock = attrs.x;
  const grove = attrs.y;
  const p = positionWorld;
  const h = p.y;
  const up = normalWorld.y;
  const slope = up.oneMinus();

  const brush = mx_fractal_noise_float(vec3(p.x.mul(0.06), p.y.mul(0.02), p.z.mul(0.06)), 3);
  const fine = mx_noise_float(vec2(p.x.mul(0.7), p.z.mul(0.7)));
  const large = mx_fractal_noise_float(vec3(p.x.mul(0.004), 0, p.z.mul(0.004)), 3);

  const sand = mix(color(PALETTE.sand), color(0xd9b3b0), brush.mul(0.5).add(0.5)).mul(fine.mul(0.06).add(0.97));
  const jungle = mix(color(PALETTE.jungle), color(PALETTE.jungleLit), smoothstep(-0.3, 0.6, brush.add(large.mul(0.5))).mul(0.6));
  // Vertical streaking: stretch noise along Y so granite walls read as rain-washed faces.
  const streak = mx_noise_float(vec3(p.x.mul(0.09), p.y.mul(0.006), p.z.mul(0.09)));
  const granite = mix(color(PALETTE.rock), color(PALETTE.rockLit), smoothstep(-0.6, 0.8, streak.add(brush.mul(0.5)))).mul(0.85);
  const grass = mix(color(0x16302a), color(0x29504a), brush.mul(0.5).add(0.5));

  const sandMask = smoothstep(2.6, 1.2, h.add(brush.mul(0.8))).mul(smoothstep(0.55, 0.25, slope));
  const vegMask = smoothstep(0.15, 0.55, grove.add(brush.mul(0.15)));
  let base = mix(grass, jungle, vegMask);
  base = mix(base, granite, max(rock, smoothstep(0.55, 0.8, slope)));
  base = mix(base, sand, sandMask);

  // ---- Regions. Weights arrive per vertex: meadow, lantern, dunes, drowned.
  const biome = attribute<'vec4'>('biomeAttrs', 'vec4') as any;
  const speck = mx_noise_float(vec2(p.x.mul(2.3), p.z.mul(2.3)));
  // Moonflower Meadows: soft blue-green grass, flecked with pale petals.
  const meadowGrass = mix(color(0x2a544c), color(0x4f7f70), brush.mul(0.5).add(0.5).add(large.mul(0.3)));
  const petals = smoothstep(0.72, 0.9, speck).mul(smoothstep(0.2, 0.6, brush.add(0.4)));
  const meadow = mix(meadowGrass, color(0xe6dcf6), petals.mul(0.7));
  base = mix(base, meadow, biome.x.mul(float(1).sub(sandMask.mul(0.8))).mul(float(1).sub(max(rock, smoothstep(0.55, 0.8, slope)))));
  // Lantern Wood: deep violet moss with glowing teal spores.
  const moss = mix(color(0x1a1636), color(0x2e2a5c), brush.mul(0.5).add(0.5));
  base = mix(base, moss, biome.y.mul(float(1).sub(sandMask)).mul(float(1).sub(rock)));
  // Glass Dunes: pale lilac sand combed into ripples.
  const duneRipple = sin(p.x.mul(0.72).add(p.z.mul(0.96)).add(brush.mul(2.2))).mul(0.5).add(0.5);
  const dune = mix(color(0xb8a8cc), color(0xe2d6ec), duneRipple.mul(0.6).add(fine.mul(0.15)).add(0.2));
  base = mix(base, dune, biome.z);
  // Drowned Town: old paving under the shallows.
  const tile = vec2(p.x, p.z).div(2.6).fract();
  const grout = max(smoothstep(0.06, 0.0, tile.x), smoothstep(0.06, 0.0, tile.y));
  const paving = mix(color(0x6a7096), color(0x2a2f4c), grout.add(fine.mul(0.15)));
  base = mix(base, paving, biome.w.mul(0.85));

  // Mirror-wet band at the waterline reuses the water's reflection target (refs 2 and 3).
  // The wet band fades with distance: coarse far terrain would show it as flat mirrored triangles.
  const camDist = cameraPosition.sub(positionWorld).length();
  const wetMask = smoothstep(0.75, 0.05, h.add(fine.mul(0.25))).mul(sandMask).mul(smoothstep(320, 90, camDist));
  const ripple = vec2(fine.mul(0.004), mx_noise_float(vec2(p.x.mul(0.3), p.z.mul(0.3))).mul(0.004));
  const mirrored = reflection.sample(screenUV.flipX().add(ripple)).rgb;
  const wetColor = mix(color(PALETTE.wetSand), mirrored.mul(1.1), 0.9);
  mat.colorNode = mix(base, wetColor, wetMask);
  mat.roughnessNode = mix(float(0.95), float(0.25), wetMask);

  // Moonlit silver on upward-facing high ground, like the snow-dusted peaks in refs 1 and 4.
  const silver = smoothstep(0.35, 0.85, up).mul(smoothstep(120, 520, h)).mul(smoothstep(-0.2, 0.5, brush.add(streak.mul(0.5))));
  mat.colorNode = mix(mat.colorNode, color(0xaab8ec), silver.mul(0.7));
  const rim = smoothstep(0.55, 1.0, up).mul(smoothstep(60, 400, h)).mul(0.03).add(silver.mul(0.05));
  // Light that belongs to the regions: spores in the Lantern Wood, starry grains in the dunes,
  // petals catching the moon in the meadows.
  const spores = smoothstep(0.78, 0.97, mx_noise_float(vec2(p.x.mul(0.9), p.z.mul(0.9)))).mul(sin(time.mul(1.3).add(p.x.mul(0.05))).mul(0.3).add(0.7));
  const grains = smoothstep(0.93, 1.0, speck).mul(0.6);
  // Points of light are a world-space jittered cell each: big enough to survive the painted
  // strokes up close, and faded out with distance before they would shimmer as sub-pixel dots.
  const lights = (scale: number, chance: number, radius: number, seed: number) => {
    const q = p.xz.mul(scale);
    const cell = floor(q);
    const h = (o: number) => hash(cell.x.mul(157.3).add(cell.y.mul(311.7)).add(seed + o));
    const at = cell.add(vec2(h(0), h(1)).mul(0.6).add(0.2));
    const dot1 = smoothstep(radius, radius * 0.3, length(q.sub(at))).mul(smoothstep(chance, chance + 0.01, h(2)));
    return { dot: dot1, phase: h(3) };
  };
  const near = smoothstep(90, 25, camDist);
  // Meadows: glow-worms in the grass, each breathing on its own slow clock.
  const worms = lights(0.6, 0.82, 0.13, 11);
  const wormLight = worms.dot.mul(sin(time.mul(worms.phase.mul(0.8).add(0.4)).add(worms.phase.mul(60))).mul(0.5).add(0.5)).mul(near);
  // Dunes: glitter. Grains flash as you move past them, keyed to where the eye is, like real sand.
  const glint = lights(1.6, 0.86, 0.11, 23);
  const facing = sin(glint.phase.mul(80).add(cameraPosition.x.mul(0.9)).add(cameraPosition.z.mul(0.7)).add(time.mul(0.6)));
  const glitter = glint.dot.mul(smoothstep(0.7, 1.0, facing)).mul(near);
  // Drowned Town: sea light runs in the grout and rolls outward from the old square in slow waves.
  const fromSquare = length(p.xz.sub(vec2(BIOMES.drowned.x, BIOMES.drowned.z)));
  const swell = smoothstep(0.6, 1.0, sin(fromSquare.mul(0.12).sub(time.mul(0.9))));
  const seaLight = grout.mul(swell.mul(0.8).add(0.25)).mul(smoothstep(600, 80, camDist));
  const regionGlow = vec3(0.15, 0.85, 0.8).mul(spores).mul(biome.y).mul(0.35)
    .add(vec3(0.75, 0.7, 1.0).mul(grains).mul(biome.z).mul(0.25))
    .add(vec3(0.6, 0.55, 0.8).mul(petals).mul(biome.x).mul(0.3))
    .add(vec3(0.85, 0.95, 0.6).mul(wormLight).mul(biome.x).mul(4.5))
    .add(vec3(0.8, 0.9, 1.0).mul(glitter).mul(biome.z).mul(3.0))
    .add(vec3(0.2, 0.8, 0.95).mul(seaLight).mul(biome.w).mul(0.9));

  // ---- Drawn, not lit. The moon's light is laid on as three flat tones with wobbly edges, like
  // gouache; shadow is hatched in ink along the lie of the land; hills carry contour lines and
  // cliffs carry strata. Scene lights still reach the (dimmed) albedo, so lamps pool warm light.
  const key = normalize(vec3(SKY.keyLight.x, SKY.keyLight.y, SKY.keyLight.z));
  const nl = dot(normalWorld, key);
  const edge = mx_noise_float(vec3(p.x.mul(0.05), p.y.mul(0.05), p.z.mul(0.05))).mul(0.12);
  const { tone, lit1, lit2 } = tones(nl, edge);
  const painted: N = mat.colorNode;
  // Hatching follows the contour (across the slope); on flat ground it falls on a diagonal.
  const along = cross(normalWorld, vec3(0, 1, 0));
  const contourDir = normalize(vec2(along.x, along.z).add(vec2(0.0001, 0)));
  const flatDir = normalize(vec2(0.8, 0.6));
  // Only steep ground hatches along its form; gentle ground takes a plain diagonal hatch, since
  // its facets would kink form-following lines into something like a map.
  const dir = normalize(mix(flatDir, contourDir, smoothstep(0.35, 0.6, slope)));
  const across = vec2(dir.y.negate(), dir.x);
  const camD = camDist;
  const fade = smoothstep(1400, 600, camD);
  const shadow = float(1).sub(lit1);
  const deep = smoothstep(-0.15, -0.4, nl.add(edge));
  const mid = lit1.mul(float(1).sub(lit2));
  const hand = mx_noise_float(vec3(p.x.mul(0.15), 0, p.z.mul(0.15))).mul(0.35);
  const u = dot(p.xz, across).add(hand);
  const v = dot(p.xz, dir);
  const hatchMain = hatchAt(u, camD, 1, 1.1);
  const hatchCross = hatchAt(v.add(hand), camD, 1, 1.0);
  const hatchSparse = hatchAt(u, camD, 2, 0.9);
  // Mid tones get a light single hatch, shadow the full hatch, deep shadow crossed, all laid in
  // broken strokes and patches. Sand stays soft and painted: it only hatches in real shadow.
  const marks = strokes(p, v, u);
  const sandSoft = float(1).sub(sandMask.mul(0.8));
  const hatch = hatchMain.mul(shadow).add(hatchCross.mul(deep)).add(hatchSparse.mul(mid).mul(0.5).mul(sandSoft.mul(sandSoft)))
    .mul(marks).mul(fade).mul(0.8);
  // Contours every 12 m on rising ground, as on a hand-drawn chart; strata on the cliffs.
  // A hand's wobble, so contours meander instead of following the mesh's straight facets.
  const wob = mx_noise_float(vec3(p.x.mul(0.02), 0, p.z.mul(0.02))).mul(3).add(mx_noise_float(vec3(p.x.mul(0.09), 0, p.z.mul(0.09))).mul(1.4));
  const contour = penLines(h.add(wob).div(12), 1.3).mul(smoothstep(4, 20, h)).mul(smoothstep(0.03, 0.12, slope)).mul(smoothstep(2500, 300, camD)).mul(smoothstep(30, 90, camD)).mul(0.5);
  const strata = penLines(h.add(streak.mul(4)).div(2.6), 1.1).mul(smoothstep(0.5, 0.8, slope)).mul(smoothstep(500, 60, camD)).mul(0.45);
  const ink = color(0x0b1030);
  let inked: N = mix(painted.mul(tone), ink, min(max(hatch, max(contour, strata)), float(0.85)).mul(float(1).sub(wetMask)));
  // Far beaches sink into the dusk: a pale strip only a pixel tall against dark water and hills
  // shimmers as the camera moves, so distant sand keeps its hue but loses its brightness.
  const farSand = sandMask.mul(smoothstep(180, 700, camD)).mul(0.75);
  inked = mix(inked, inked.mul(vec3(0.38, 0.38, 0.5)), farSand);
  mat.colorNode = painted.mul(0.12);
  mat.emissiveNode = inked.mul(0.5).add(vec3(0.3, 0.36, 0.7).mul(rim)).add(regionGlow);
  return mat;
}
