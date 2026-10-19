# Lapis -- Shader brief for the s&box port

Everything the game draws, written out so it can be rebuilt in HLSL. The source is three.js r186 (WebGPU) with every material a TSL node graph; file and function names below are the ground truth. Snippets are pseudo-HLSL: `lerp`, `saturate`, `smoothstep(a,b,x)` (works with `a > b` like GLSL, so it fades *out*), `frac`. Where the snippet says `noise()` it means MaterialX Perlin, see 0.2.

---

## 0. Conventions you need before anything else

### 0.1 Space, units, time

| Thing | Three / Lapis | s&box | What to do |
|---|---|---|---|
| Up axis | +Y (glTF). Blender sources are Z-up: `three(x,y,z) = blender(x, z, -y)` (stated in `tools/blender/lighthouse.py`) | +Z | All the constants below are in **Y-up metres**. In each shader, convert once at the top: `float3 G = float3(W.x, W.z, -W.y) * INCH_TO_M` (adjust the sign to match how the FBX import lands), then paste the maths in as written. |
| Units | metres | inches (1 m = 39.37 u) | Noise frequencies, hatch spacing, fade distances, gait strides and fog density all assume metres. |
| `time` | seconds since start (TSL `time`) | `g_flTime` | -- |
| `cameraPosition`, `positionWorld`, `normalWorld` | world space | same | `positionLocal` = object space *before* instancing transforms. |
| Key light | `SKY.keyLight = dir(az 20, el 38)`, `src/config.ts` | constant | `dir(az,el) = (sin az cos el, sin el, -cos az cos el)`. Azimuth 0 = -Z (north). Most "lighting" in Lapis is a hard-coded `dot(N, KEY)`, not the engine's lights. |
| Other directions | `SKY.brightStar = dir(0,22)`, `SKY.moon = dir(58,7)` | constant | -- |

### 0.2 Shared helper functions (port these first)

| TSL | Meaning | HLSL port |
|---|---|---|
| `mx_noise_float(p)` | MaterialX gradient Perlin, 2D or 3D, output roughly in [-1, 1] | Port `mx_perlin_noise_float` from MaterialX `mx_noise.glsl` (public, ports 1:1) |
| `mx_fractal_noise_float(p, oct)` | fBm: `oct` octaves, lacunarity 2, diminish 0.5, amplitude 1 | sum of the above |
| `hash(x)` (`three/src/nodes/math/Hash.js`) | PCG: `uint s = (uint)x; s = s*747796405u + 2891336453u; uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u; return float((w >> 22u) ^ w) / 4294967296.0;` | **The seed is truncated to uint.** Fractional parts are lost, so `boil*3.7` steps in whole numbers. WGSL saturates negative floats to 0, so every world- or body-space seed goes through `src/render/seed.ts`, which folds negatives above 2^20: `hash(x < 0 ? -x + 1048576 : x)`. Port that wrapper too; plain `(uint)` of a negative float is undefined in HLSL. |
| `luminance(c)` | `dot(c, float3(0.2126, 0.7152, 0.0722))` | Applied to display-encoded values in the post pass, as written. |
| `color(0xRRGGBB)` | sRGB hex converted to **linear** | Scene materials work in linear. The post pass works in display space, so it re-encodes with `pow(x, 1/2.2)`, except in one place (see 1.5). |
| `fwidth` | screen-space derivative | `fwidth` |

### 0.3 Global scene setup (`src/main.ts`, `boot`)

- Renderer tone mapping: ACES Filmic, exposure 1.05. In Lapis this runs **inside the post pass** (`renderOutput`), not at the end of the frame. Scene shading is linear HDR.
- Fog: `FogExp2(PALETTE.fog = 0x2a3d9c, density 0.00034)`, so `f = 1 - exp(-(0.00034 * d)^2)`. It applies to every material unless that material is marked `fog:false`, which sky, stars, moon, moonbeams, beams, pillars and constellations are.
- Lights, which only affect `MeshStandard*` materials (terrain, stepping stones, prologue stone): directional key `0x9fb2ff` × 1.5 along `keyLight`, directional moon fill `PALETTE.moon` × 0.35, hemisphere `0x3550c0 / 0x0a0d1c` × 0.85. There are also four pooled point lights in `Landmarks.update` (`starGold`, on the nearest Hut, Cairn and StoneLantern) and one point light on the wisp.
- Background colour: `PALETTE.zenith`. No MSAA (`antialias:false`); the paint filter hides aliasing.
- Quality presets (`QUALITY` in `src/config.ts`):

| preset | pixelRatio | reflection RT scale | strokeSteps (LIC) | sparkles | motes | flora radius × | terrain LOD × |
|---|---|---|---|---|---|---|---|
| low | 0.75 | 0.25 | 5 | 0.4 | 0.5 | 0.6 | 0.6 |
| medium | 1 | 0.35 | 7 | 0.7 | 0.8 | 0.85 | 0.85 |
| high | 1.5 | 0.5 | 9 | 1 | 1 | 1 | 1 |

`fullDetail()` (`src/render/drawn.ts`) is `strokeSteps > 5`, i.e. medium and high. Treat it as a static shader combo.

### 0.4 Palette (`PALETTE`, `src/config.ts`) -- used by scene materials

| name | hex | name | hex |
|---|---|---|---|
| zenith | 060b2e | wetSand | 3b3f80 |
| sky | 101e78 | jungle | 0a1a12 |
| horizon | 2640a8 | jungleLit | 2a5a44 |
| cloud | 8b9de0 | rock | 151c44 |
| ultramarine | 1a2f9a | rockLit | 6f82d0 |
| deepSea | 050d3a | coral | ff6f55 |
| shallowSea | 2346b8 | salmon | f59b85 |
| foam | f3e6da | starGold | ffb065 |
| sand | e9d3cc | starWhite | fff2dc |
| moon | ffa25a | fog | 2a3d9c |

The post-process palette swatches are a separate list (1.4).

---

## 1. Painterly post-process -- `src/render/post.ts`, `createPost`

### 1.1 Pass graph

```
P0  scene pass        -> sceneColor (HDR linear), depth (0..1, 1 = far; NOT reversed-Z)
P1  bloom(sceneColor) -> glow           (three BloomNode: 5 mips at half res)
P2  composite         -> LDR RT  "ldr"  (stage 1: mist + grainy glow + ACES/sRGB + tone curve)
P3  sobel(ldr)        -> gaussian H, V  -> TENSOR RT (rgba16f)
P4  final             -> backbuffer      (stages 3..11, display-encoded, no further colour transform)
```

`rtt()` in the source marks where a pass has to resolve to a texture: ldr and tensor. Changing quality rebuilds the whole post chain, because STEPS changes.

Uniforms driven by game code: `paint` (always 1; master mix for stroke, palette, ink and dither), `boilRate` (fixed 10), `memoryMix`, `frost`, `nightmare` (see 7.4). Shared derived values:

```hlsl
float  boil  = floor(time * boilRate);       // 10 fps stepped clock: everything "hand-made" re-draws at 10fps
float2 px    = SV_Position.xy;               // pixel coords
float2 texel = 1.0 / screenSize;
bool   isSky = depth > 0.99999;
```

### 1.2 Stage 1 -- scene + mist + grainy glow + tone curve -> `ldr`

Inputs: sceneColor, depth, `projInv`, `camWorld`, `camPos.y`. Bloom settings are strength 1.1, radius 0.9, threshold 0.5. The three.js BloomNode does a luminosity high-pass (smoothWidth 0.01), then 5 mips from half resolution down, with separable Gaussian kernels [6,10,14,18,22] taps and mip weights [1, .8, .6, .4, .2] blended toward the mirrored weights by radius. Any decent bloom works; match it by eye.

```hlsl
float3 viewPos = ReconstructViewPos(uv, depth);           // getViewPosition
float3 world   = mul(camWorld, float4(viewPos,1)).xyz;
float  dist    = length(viewPos);
float  drift   = fbm3(float3(world.x*0.004, time*0.015, world.z*0.004));   // 3 octaves
// Mist sits on the ground you're standing on near you, on sea level far away.
float  localFloor = lerp(drift*10 + 2, camPos.y - 1.6 + drift*3, smoothstep(400, 80, dist));
float  layer   = exp(-max(world.y - localFloor, 0) / 14);
float  mistAmt = isSky ? 0 : (1 - exp(-dist*0.0045)) * layer * 0.38;
float3 mistCol = lerp(float3(0.07,0.10,0.32), float3(0.20,0.20,0.42), drift*0.5+0.5);
// Glow arrives as coarse 2x2-pixel printed grain.
float2 gcell  = floor(px/2);
float  grainy = hash(gcell.x + gcell.y*6151 + boil*3.7) * 1.5 + 0.25;
float3 hdr    = lerp(sceneColor, mistCol, mistAmt) + glow * lerp(1, grainy, 0.75);
float3 m      = LinearToSRGB(ACESFilmic(hdr * 1.05));        // renderOutput
float3 curved = m*m*(3 - 2*m)*0.55 + m*0.45;                // S-curve, 55% blend
ldr = float4(curved * float3(0.94, 0.96, 1.04), 1);
```

### 1.3 Stage 2 -- structure tensor -> `TENSOR`

```hlsl
float L(float2 o) { return luminance(ldr.Sample(uv + o*texel).rgb); }
float gx = L( 1,-1) + 2*L( 1,0) + L( 1,1) - L(-1,-1) - 2*L(-1,0) - L(-1,1);
float gy = L(-1, 1) + 2*L( 0,1) + L( 1,1) - L(-1,-1) - 2*L(0,-1) - L(1,-1);
TENSOR_in = float4(gx*gx, gy*gy, gx*gy, 1);
// three GaussianBlurNode, sigma param 4 -> kernelSize = 3 + 2*4 = 11 taps each side,
// weights w_i = exp(-0.5 i^2 / s^2), s = 11/3, normalised; separable H then V, full res.
```

Flow field, used at every LIC step:

```hlsl
float2 flowAt(float2 uvp) {
  float3 t = TENSOR.Sample(uvp).xyz;  float E=t.x, G=t.y, F=t.z;
  float disc = sqrt((E-G)*(E-G) + 4*F*F);
  float l1   = (E + G + disc) * 0.5;
  float2 tang = float2(l1 - E, -F);                       // minor eigenvector = along the contour
  float  strength = smoothstep(0.0004, 0.004, disc);
  float2 dir = length(tang) > 1e-5 ? normalize(tang) : float2(1,0);
  float  a   = noise2(uvp*screenSize*0.0025) * 0.9;        // flat-area fallback: slow mostly-horizontal swirl
  return normalize(lerp(float2(cos a, sin a), dir, strength));
}
```

### 1.4 Stage 3 -- line integral convolution with bristles

```hlsl
const int   STEPS  = strokeSteps;            // 5 / 7 / 9 (static combo)
const float stepPx = 14.4 / STEPS;           // total reach 14.4 px each way at every quality
float strokeBoil = isSky ? 0 : boil;         // sky holds still so stars don't crawl
float bristle(float2 p) { return hash(floor(p.x*0.55) + floor(p.y*0.55)*1931 + strokeBoil*17.31); }

float3 acc = ldr.Sample(uv).rgb;  float streak = bristle(px);  float wsum = 1;
for (sign in {+1,-1}) {
  float2 p = uv;  float2 d = flowAt(uv) * sign;
  for (int i = 1; i <= STEPS; i++) {
    p += d * stepPx * texel;
    float2 nd = flowAt(p);
    d = dot(nd, d) < 0 ? -nd : nd;           // eigenvectors are unsigned; keep heading the same way
    float w = 1 - i/(STEPS+1.0);
    acc += ldr.Sample(p).rgb * w;  streak += bristle(p*screenSize) * w;  wsum += w;
  }
}
float strokeMod = (streak/wsum - 0.5) * 0.22 + 1;
float3 c = lerp(ldr.Sample(uv).rgb, acc/wsum * strokeMod, paint);
```

Cost: 2·STEPS tensor taps plus 2·STEPS colour taps per pixel. This is the most expensive part of the frame.

### 1.5 Stage 4 -- palette mapping in Oklab

Swatches are the `SWATCHES` constant in `post.ts`, not `config.ts`. They are sRGB hex. Precompute their Oklab coordinates on the CPU using the exact sRGB-to-linear curve (`srgbToOklab`), and also keep their **linear** RGB.

| # | hex | # | hex | # | hex | # | hex |
|---|---|---|---|---|---|---|---|
| 0 | 0b0e07 | 5 | 27538e | 10 | b35d3d | 15 | d6cbcb |
| 1 | 0e1b2e | 6 | 2846c8 | 11 | bf7e77 | 16 | f2e6d8 |
| 2 | 132340 | 7 | 4b6ea1 | 12 | ff6e50 | 17 | 0f2620 (jungle) |
| 3 | 1e3156 | 8 | 8196b8 | 13 | ffb866 | 18 | 1c3d33 (jungle) |
| 4 | 173b73 | 9 | 815f5e | 14 | c9a2a3 | 19 | 2f5a4c (jungle) |

```hlsl
float3 toOklab(float3 c) {                     // pixel side uses a pow-2.2 approximation of linear
  float3 lin = pow(max(c,0), 2.2);
  float l = cbrt(max(dot(lin, float3(0.4122214708,0.5363325363,0.0514459929)),1e-6));
  float m = cbrt(max(dot(lin, float3(0.2119034982,0.6806995451,0.1073969566)),1e-6));
  float s = cbrt(max(dot(lin, float3(0.0883024619,0.2817188376,0.6299787005)),1e-6));
  return float3( 0.2104542553*l + 0.793617785*m - 0.0040720468*s,
                 1.9779984951*l - 2.428592205*m + 0.4505937099*s,
                 0.0259040371*l + 0.7827717662*m - 0.808675766*s);
}
float  dith = (hash(px.x + px.y*4099 + boil*7.13) - 0.5) * 0.035;   // on L only
float3 lab  = toOklab(c) + float3(dith,0,0);
// find the nearest two swatches, distance weighted (1.3, 1, 1) on (L, a, b)
for k: { float3 d = (lab - LAB[k]) * float3(1.3,1,1); float dd = dot(d,d); /* keep best, second */ }
float  t2    = smoothstep(0.3, 0.7, sqrt(bestD) / max(sqrt(bestD)+sqrt(secondD), 1e-5));
float3 quant = pow(lerp(LIN[best], LIN[second], t2), 1/2.2);       // back to display space
float  bright = smoothstep(0.75, 1.0, luminance(c));              // emissive accents keep their colour
c = lerp(c, quant, 0.62 * (1 - bright*0.6) * paint);
```

### 1.6 Stage 5 -- ink lines (depth silhouettes + tonal contours)

```hlsl
float2 wob = float2(noise3(float3(px*0.02, boil*0.37)),
                    noise3(float3(px*0.02 + 9.1, boil*0.37))) * (isSky ? 0 : 1.6);   // pixels
float ld(float2 o) { float d = DEPTH.Sample(uv + (wob+o)*texel).r; return log(1/max(1-d, 1e-6)); }
float dEdge = abs(ld(float2(1,0)) - ld(float2(-1,0))) + abs(ld(float2(0,1)) - ld(float2(0,-1)));
float tl(float2 o) { return luminance(ldr.Sample(uv + (wob+o)*texel).rgb); }
float tEdge = abs(tl(float2(1.5,0)) - tl(float2(-1.5,0))) + abs(tl(float2(0,1.5)) - tl(float2(0,-1.5)));
float lineNoise = noise3(float3(px*0.05, boil*0.61))*0.5 + 0.5;
float ink = max(smoothstep(0.35,0.9,dEdge), smoothstep(0.16,0.42,tEdge)*0.55*(isSky?0:1)) * (lineNoise*0.6+0.4);
c = lerp(c, INK, ink*0.6*paint);
```

`INK` is the literal `float3(0.0021, 0.0033, 0.0177)` (`0x070b24` linearised, kept on purpose though the image is display-space: it is the near-black the look was tuned to). `log(1/(1-d))` assumes a standard 0..1 perspective depth. With reversed-Z or linear depth, rebuild the same "log of distance-ish" signal, or retune the 0.35/0.9 thresholds.

### 1.7 Stage 7 -- canvas emboss

Input: `public/textures/canvas.png`, 1024², repeat, **no sRGB** (`NoColorSpace`); only `.r` is used.

```hlsl
float2 cuv = px / 1228.8;                        // 1024 * 1.2: canvas texels slightly larger than pixels
float ch  = CANVAS.Sample(cuv).r;
float chx = CANVAS.Sample(cuv + float2(1/1024.,0)).r;
float chy = CANVAS.Sample(cuv + float2(0,1/1024.)).r;
float relief = (chx - ch)*-0.7 + (chy - ch)*0.7;
c *= (relief*0.9 + 1) * (ch*0.16 + 0.9);         // pigment pools in the weave valleys
```

(There is no stage 6 in the source numbering.)

### 1.8 Stage 8 -- ordered dither in deep shadow

```hlsl
float bayer2(float2 a) { return frac(a.x*0.5 + a.y*a.y*0.75); }
float bayer4(float2 a) { return bayer2(a*0.5)*0.25 + bayer2(a); }
float dl = luminance(c);
float s  = frac(dl*7) > bayer4(floor(px)) ? 1 : -1;
c *= s*0.07*smoothstep(0.22, 0.04, dl)*paint + 1;
```

### 1.9 Stage 9 -- memory duotone (uniform `memoryMix`)

```hlsl
float2 rc  = floor(px/1.5);
float riso = (hash(rc.x + rc.y*3967 + boil*5.3) - 0.5) * 0.12;
float3 duo = lerp(Enc(0x161a52), Enc(0xc4c8f4), smoothstep(0.04, 0.85, luminance(c) + riso));  // Enc = sRGB hex as display value
c = lerp(c, duo, memoryMix*0.85);
```

### 1.10 Stage 10 -- night frost (uniform `frost`)

```hlsl
float fl = luminance(c);
c = lerp(c, fl*float3(0.86,0.93,1.06), frost*0.45) * (1 - frost*0.22);
float ev = length((uv-0.5)*float2(1.2,1));
float crystals = noise2(px*0.018)*0.6 + noise2(px*0.09)*0.25;
float frostEdge = smoothstep(0.98 - frost*0.5, 1.18 - frost*0.35, ev + crystals*0.12) * smoothstep(0.45, 0.75, frost);
c = lerp(c, float3(0.86,0.91,1.0), frostEdge*0.8);
```

### 1.11 Stage 10b -- nightmare curdle (uniform `nightmare` = dread)

```hlsl
float nl = luminance(c);
float3 curd = lerp(float3(0.02,0,0.03), float3(0.62,0.12,0.16), smoothstep(0.05,0.75,nl)) * (smoothstep(0,0.9,nl)*0.8 + 0.35);
c = lerp(c, curd, nightmare*0.7);
float vN    = noise2(px*0.012 + float2(boil*0.07, 0)) + noise2(px*0.05)*0.35;      // crawls at the boil rate
float veins = smoothstep(0.06, 0, abs(vN)) * smoothstep(1.05 - nightmare*0.65, 1.2 - nightmare*0.4, ev + vN*0.1);
float inkEdge = smoothstep(1.1 - nightmare*0.45, 1.25 - nightmare*0.3, ev + crystals*0.15);  // reuses frost's crystals
c = lerp(c, float3(0.01,0,0.02), max(veins, inkEdge) * smoothstep(0.1, 0.5, nightmare));
```

### 1.12 Stage 11 -- vignette, grain, output

```hlsl
float v = length((uv-0.5)*float2(1.1,1));
c = lerp(Enc(PALETTE.zenith)*0.7, c, smoothstep(0.9,0.3,v)*0.3 + 0.7);
c += (hash(px.x + px.y*4096 + boil*31) - 0.5) * 0.025;
OUT = float4(min(c, 1), 1);       // already display-encoded; do NOT let the engine tonemap/encode again
```

---

## 2. Drawn shading -- `src/render/drawn.ts` and terrain

### 2.1 Library (make this `drawn.hlsl`)

```hlsl
// A pen line about px pixels wide wherever c crosses an integer.
float penLines(float c, float px) {
  float f = frac(c); float d = min(f, 1-f); float w = max(fwidth(c), 1e-5);
  return smoothstep(w*px, w*px*0.4, d);
}
// Moonlight as three flat gouache tones. edge = small noise that wobbles the band boundaries.
void tones(float nl, float edge, float hi, out float tone, out float lit1, out float lit2) {
  lit1 = smoothstep(0.02, 0.07, nl+edge);
  lit2 = smoothstep(hi, hi+0.05, nl+edge);
  tone = lerp(0.34, lerp(0.68, 1.0, lit2), lit1);
}
// Constant on-screen density: spacing doubles per doubling of camera distance beyond 10 m, with a cross-fade between octaves.
float hatchAt(float coord, float camDist, float spacing, float px, float base /*=0.45*/) {
  float lvl = log2(max(camDist/10, 1));
  float s0  = exp2(floor(lvl)) * base * spacing;
  return lerp(penLines(coord/s0, px), penLines(coord/(2*s0), px), frac(lvl));
}
// Hatching laid in patches, each line broken into 1-2 m strokes.
float strokes(float3 p, float along, float across, bool patches) {
  float patch  = patches ? smoothstep(-0.25, 0.2, noise3(p*0.06)) : 1;
  float breaks = smoothstep(-0.35, -0.05, noise3(float3(along*0.55, across*1.7, 0)));
  return patch * breaks;
}
// Ink a built or living surface. col = painted colour (linear), n = world normal, wp = world pos.
float3 drawnSurface(float3 col, float3 n, float3 wp, float hi=0.6, float strength=0.72, float spacing=0.8) {
  float nl = dot(n, KEY);
  float edge = sin(wp.y*0.9 + wp.x*0.3) * 0.05;
  float tone, lit1, lit2; tones(nl, edge, hi, tone, lit1, lit2);
  float dc = length(wp - camPos);
  float2 view = normalize(wp.xz - camPos.xz);
  float upright = smoothstep(0.75, 0.45, abs(n.y));
  float uWall = dot(wp.xz, float2(-view.y, view.x));              // vertical strokes across the view on walls
  float uFlat = dot(wp.xz, normalize(float2(0.6,-0.8)));          // diagonal on flat faces
  float u = lerp(uFlat, uWall, upright) + sin(wp.y*0.7)*0.03;
  float v = lerp(dot(wp.xz, normalize(float2(0.8,0.6))), wp.y, upright);
#if FULL_DETAIL
  float main  = hatchAt(u, dc, spacing, 1.0, 0.3);
  float cross = hatchAt(v, dc, spacing, 0.9, 0.3);
  float broken = strokes(wp, v*2, u*3, false);
#else
  float main = penLines(u/(spacing*0.5), 1.0), cross = 0, broken = 1;
#endif
  float deep  = smoothstep(-0.15, -0.45, nl+edge);
  float hatch = (main*(1-lit1) + cross*deep) * broken * smoothstep(160, 50, dc);
  return lerp(col*(tone*0.7 + 0.45), C(0x0b1030), min(hatch*strength, 0.85));
}
```

The hatch is anchored in world space. `uWall` depends on view direction, so wall strokes stay vertical on screen as you orbit. That is intentional.

Used by: flora trunks, bark and mushroom flesh (3); deer (spacing .45), manta back (1.2, strength .5), tortoise (1.4); wonders, landmarks, puzzle `stoneMaterial()` (`src/world/puzzles.ts`, colour `0x6a74a8`).

### 2.2 Terrain -- `src/world/terrainMaterial.ts`, `createTerrainMaterial`

**Lit** material: `MeshStandard`, roughness 0.95 (0.25 when wet), metalness 0. The final colour mostly arrives through **emissive**. Albedo is `painted * 0.12`, so the engine lights (key, fill, hemi, lamp point lights) add only a dim layer, but enough for lamps to pool warm light on the ground.

Vertex attributes come from `src/world/terrainWorker.ts`: `terrainAttrs.xy = (rock, grove)` and `biomeAttrs.xyzw = (meadow, lantern, dunes, drowned)` region weights. Uniform: `reflection` texture (the water's mirror RT, see 5.1).

```hlsl
float3 p = wp; float h = p.y; float up = N.y; float slope = 1 - up;
float brush = fbm3(float3(p.x*0.06, p.y*0.02, p.z*0.06));   // 3 oct
float fine  = noise2(p.xz*0.7);
float large = fbm3(float3(p.x*0.004, 0, p.z*0.004));        // 3 oct
float streak = noise3(float3(p.x*0.09, p.y*0.006, p.z*0.09)); // vertical rain streaks
float3 sand    = lerp(C(sand), C(0xd9b3b0), brush*0.5+0.5) * (fine*0.06+0.97);
float3 jungle  = lerp(C(jungle), C(jungleLit), smoothstep(-0.3,0.6, brush+large*0.5)*0.6);
float3 granite = lerp(C(rock), C(rockLit), smoothstep(-0.6,0.8, streak+brush*0.5)) * 0.85;
float3 grass   = lerp(C(0x16302a), C(0x29504a), brush*0.5+0.5);
float sandMask = smoothstep(2.6,1.2, h+brush*0.8) * smoothstep(0.55,0.25, slope);
float vegMask  = smoothstep(0.15,0.55, grove+brush*0.15);
float cliff    = max(rock, smoothstep(0.55,0.8, slope));
float3 base = lerp(lerp(grass, jungle, vegMask), granite, cliff);
base = lerp(base, sand, sandMask);
```

**Region colours**, applied in order after sand:

| region (weight) | colour | mask multiplier |
|---|---|---|
| meadow (`b.x`) | `lerp(2a544c, 4f7f70, brush*.5+.5+large*.3)`, petals `e6dcf6` at `petals*0.7`; `petals = smoothstep(.72,.9,speck)*smoothstep(.2,.6,brush+.4)`, `speck = noise2(p.xz*2.3)` | `b.x*(1-sandMask*.8)*(1-cliff)` |
| lantern (`b.y`) | moss `lerp(1a1636, 2e2a5c, brush*.5+.5)` | `b.y*(1-sandMask)*(1-rock)` |
| dunes (`b.z`) | `lerp(b8a8cc, e2d6ec, ripple*.6+fine*.15+.2)`, `ripple = sin(p.x*.72+p.z*.96+brush*2.2)*.5+.5` | `b.z` |
| drowned (`b.w`) | paving `lerp(6a7096, 2a2f4c, grout+fine*.15)`; 2.6 m tiles, `grout = max(smoothstep(.06,0,frac(p.xz/2.6)))` | `b.w*0.85` |

**Wet-sand mirror band**, which reuses the water reflection RT:

```hlsl
float camDist = length(camPos - wp);
float wetMask = smoothstep(0.75,0.05, h+fine*0.25) * sandMask * smoothstep(320,90, camDist);
float2 ripple = float2(fine*0.004, noise2(p.xz*0.3)*0.004);
float3 mirrored = REFLECTION.Sample(float2(1-screenUV.x, screenUV.y) + ripple).rgb;
float3 painted = lerp(base, lerp(C(wetSand), mirrored*1.1, 0.9), wetMask);
roughness = lerp(0.95, 0.25, wetMask);
float silver = smoothstep(.35,.85, up) * smoothstep(120,520, h) * smoothstep(-.2,.5, brush+streak*.5);
painted = lerp(painted, C(0xaab8ec), silver*0.7);          // moonlit high ground
float rim = smoothstep(.55,1, up)*smoothstep(60,400, h)*0.03 + silver*0.05;
```

**Region glow**, emissive:

```hlsl
float spores = smoothstep(.78,.97, noise2(p.xz*0.9)) * (sin(time*1.3 + p.x*0.05)*0.3 + 0.7);
float grains = smoothstep(.93,1, speck) * 0.6;
float3 regionGlow = float3(.15,.85,.8)*spores*b.y*0.35 + float3(.75,.7,1)*grains*b.z*0.25 + float3(.6,.55,.8)*petals*b.x*0.12;
```

**Ink, hatching, contours and strata**:

```hlsl
float nl = dot(N, KEY);
float edge = noise3(p*0.05) * 0.12;
tones(nl, edge, 0.7, tone, lit1, lit2);
float3 along = cross(N, float3(0,1,0));
float2 contourDir = normalize(along.xz + float2(1e-4,0));
float2 dir = normalize(lerp(normalize(float2(.8,.6)), contourDir, smoothstep(.35,.6, slope)));  // only steep ground follows its form
float2 across = float2(-dir.y, dir.x);
float fade = smoothstep(1400, 600, camDist);
float shadow = 1 - lit1, deep = smoothstep(-.15,-.4, nl+edge), mid = lit1*(1-lit2);
float hand = noise3(float3(p.x*.15, 0, p.z*.15)) * 0.35;
float u = dot(p.xz, across) + hand, v = dot(p.xz, dir);
float hMain   = hatchAt(u,      camDist, 1, 1.1, 0.45);
float hCross  = hatchAt(v+hand, camDist, 1, 1.0, 0.45);
float hSparse = hatchAt(u,      camDist, 2, 0.9, 0.45);
float sandSoft = 1 - sandMask*0.8;                           // SAND EXCEPTION: sand only hatches in real shadow
float hatch = (hMain*shadow + hCross*deep + hSparse*mid*0.5*sandSoft*sandSoft) * strokes(p, v, u, true) * fade * 0.8;
float wob = noise3(float3(p.x*.02,0,p.z*.02))*3 + noise3(float3(p.x*.09,0,p.z*.09))*1.4;
float contour = penLines((h+wob)/12, 1.3) * smoothstep(4,20,h) * smoothstep(.03,.12, slope)
              * smoothstep(2500,300, camDist) * smoothstep(30,90, camDist) * 0.5;            // every 12 m
float strata  = penLines((h + streak*4)/2.6, 1.1) * smoothstep(.5,.8, slope) * smoothstep(500,60, camDist) * 0.45;
float3 inked = lerp(painted*tone, C(0x0b1030), min(max(hatch, max(contour, strata)), 0.85) * (1 - wetMask));
Albedo   = painted * 0.12;
Emissive = inked*0.5 + float3(.3,.36,.7)*rim + regionGlow;
```

Hatching rules in short: mid-tones get a sparse single hatch at double spacing; shadow gets the full hatch; deep shadow gets cross-hatching. Everything is broken into strokes and patches and fades out by 1400 m. Steep ground hatches along the contour, gentle ground on a fixed diagonal. The wet band never takes ink.

---

## 3. Flora -- `src/world/flora.ts`

**Unlit** (`MeshBasic`), double-sided, one instanced draw per (type × LOD × material part). Assets come from `/models/*.glb` children named `<Type>_hi` and `<Type>_lo`; each mesh part is keyed by its **material name**.

**Instance attributes** (`Batch`): `inst : float4 = (x, y, z, rotY)`, `scl : float`. Rebuilt on the CPU when the player moves 8 m (hi) or 30 m (lo), from 128 m blocks the worker generates within `FLORA.loadRadius` = 1500 m.

**Vertex shader**:

```hlsl
float c = cos(inst.w), s = sin(inst.w);
float3 lp = posLocal * scl;
float d = length(inst.xz - camPos.xz);
float keep = LOD_HI ? step(d, R_hi) : step(R_hi, d) * step(d, R_far);   // hard LOD band; 0 collapses the instance to a point
float woodSway = (part == "vine") ? 1 : 0.35;
float swayW = vc.r*vc.r * (vc.g > 0.25 ? 1 : woodSway);
float gust  = sin(time*0.35 + inst.x*0.004 + inst.z*0.003)*0.4 + 0.8;
float ph    = vc.b * 6.283;
float2 sway = float2(sin(time*1.15 + inst.x*0.07 + ph), sin(time*0.93 + inst.z*0.07 + ph + 1.3)) * swayW * gust * SWAY[type] * scl;
float3 world = float3(lp.x*c + lp.z*s + sway.x, lp.y, lp.z*c - lp.x*s + sway.y) * keep + inst.xyz;
float3 n = float3(ng.x*c + ng.z*s, ng.y, ng.z*c - ng.x*s);
```

**LOD radii** in metres. Radii × `QUALITY.flora` are uniforms `R_hi`/`R_far`. The CPU submits hi within `hi+12` and lo in `[hi-40, far+20]`; the shader's `step` does the exact cut. Distance fade is a *brightness* fade, not alpha: `col *= smoothstep(R_far, R_far*0.85, d)*0.3 + 0.7`.

| type | hi | far | sway | type | hi | far | sway |
|---|---|---|---|---|---|---|---|
| PalmTall | 110 | 1500 | .55 | Bush0 | 45 | 170 | .10 |
| PalmMid | 110 | 1500 | .50 | Bush1 | 60 | 300 | .10 |
| PalmLean | 110 | 1200 | .45 | GiantMushroomA/B | 90 | 900 | .04 |
| PalmYoung | 110 | 500 | .35 | LanternTree | 80 | 600 | .15 |
| CanopyA/B | 70 | 480 | .25 | MushroomCluster | 40 | 90 | 0 |
| Understory | 50 | 220 | .20 | Moonflowers | 45 | 170 | .22 |
| TreeFern | 50 | 220 | .25 | MeadowGrass | 35 | 95 | .40 |
| Banana | 70 | 220 | .30 | CrystalA/B | 60 | 700 | 0 |
| Vines | 70 | 140 | .40 | DuneGrass | 35 | 110 | .30 |
| FernA/B | 30 | 90 | .15 | Groundcover | 40 | 90 | .10 |

**Fragment** (`Flora.material`). Shared terms: `lambert = saturate(abs(dot(n,KEY))*0.7 + 0.3)` (double-sided cards), `variety = hash(inst.x*0.37 + inst.z*1.91)`. Branches are taken in this order:

| part name | colour |
|---|---|
| **REGION_GLOW** `mushroom_glow` 5fe8d8 ×0.45, `lantern_glow` ffc070 ×1.8, `moonflower_glow` ece0ff ×1.25, `crystal` c6b6ff ×0.75 | `C(hex)*k*(vc.r*0.4+0.7)*breathe`, `breathe = sin(time*0.7+variety*20)*0.15+0.9` |
| `mushroom_glow` extra (gills) | `rel = wp.xz - inst.xz; r = len(rel); ang = atan2(rel.y, rel.x)`; `gills = penLines(ang/2π*44, 2.4)*smoothstep(.4,1.2,r)`; `rim = smoothstep(.6,4.5,r)`; `mottle = hash(floor(ang*9)+variety*13)*.3+.75`; `col = lerp(col*(rim*rim*1.1+.12)*mottle, C(0b1030), gills*.85)`. The inner cap is kept under the bloom threshold so the lines survive. |
| **REGION_BASE** `mushroom_cap` 3a2a72, `mushroom_stem` 8a86b8, `grass` 3a6a60 | `C(hex)*(lambert*0.6+0.3)*(variety*0.25+0.85)` |
| **Palm glow** `trunk` | `lerp(salmon*0.12, coral*0.55, vc.r)*(lambert*0.3+0.7)` |
| `fruit` | `coral*0.35` |
| `flower` (banana) | `starGold*1.4` |
| `frond` | `lerp(coral, salmon, variety*0.45)*(vc.r*0.55+0.5)*(lambert*0.3+0.7)*0.95` |
| ...all four palm parts then | `*= glow * (variety*0.35+0.8) * (sin(time*0.45 + inst.x*0.013 + inst.z*0.017)*0.12+0.92)`; `glow` is a story uniform (7.4) |
| **Foliage** (anything else: `foliage`, `foliage_core`, `canopy_core`, `bark`, `fern`, `leaf_broad`, `vine`, `stem`) | `base = lerp(jungle, jungleLit, vc.r*0.6+variety*0.4)`; `col = base*(lambert*0.45+0.22)*(dark?0.55:1) + float3(.02,.05,.08)*saturate(n.y)*0.25`; dark = name contains `core` or `bark`, or is `trunk_dark` |
| `fern`, `leaf_broad` extra | `tip = vc.r^3*vc.g`; `col += float3(.2,.6,.85)*tip*(sin(time*0.8+variety*30)*.25+.75)*(fern?1.1:0.35)` |
| **drawnSurface pass** | if name is `trunk`, contains `bark` or `core`, or starts with `mushroom_` without `glow`: `col = drawnSurface(col, n, wp)`. This includes palm trunks *after* their glow colour. |

Mirror: every non-Palm batch is hidden in the reflection pass (`Flora.setMirror`), so the water reflects only the glowing palms.

---

## 4. Creatures

All are **unlit** with custom vertex animation. The `instanced()` helpers attach per-instance `float4` attributes shared by every material part of the model.

### 4.1 Star deer -- `fauna.ts`, `buildDeer`, 14 instances

Instance data: `pose = (x, y, z, yaw)` with yaw = heading - π/2, because the model faces +X; `gaitData = (phase, 0, scale, grazing 0/1)`. Phase advances `dt*(speed*2.6 + (grazing?0:0.5))`.

```hlsl
float3 gait(float3 lp, float4 vc, float phase, float stride, float lift) {     // shared walker encoding
  float leg = vc.g > 0.75 ? 1 : 0;
  float a = phase + vc.b*2π;
  return float3(lp.x + sin(a)*vc.r*stride*leg, lp.y + max(cos(a),0)*vc.r*lift*leg, lp.z);
}
float3 lp = gait(posLocal*G.z, vc, G.x, 0.28, 0.12);
lp.y += smoothstep(0.4,1.2, lp.x) * smoothstep(0.9,1.6, lp.y) * G.w * -0.55;  // grazing head dip (neck/head = +X, high)
world = yaw(lp, P.w) + P.xyz;   n = yaw(normal, P.w);
```

The swing is a small-angle rotation about the hip: `theta = stride / HIP_Z`. Deer 0.224 rad, tortoise 0.3, crawler 0.52. Useful if you would rather bake these into a skeleton.

Fragment:
- `antler_glow` (name contains `glow`): `starWhite*1.9*(sin(time*2 + P.x)*0.2+0.9)`.
- Body (`deer`): `drawnSurface(lerp(8a86c0, d8d0f2, lambert*.5+.5)*0.8, n, wp, spacing 0.45)` + `float3(.05,.06,.12)*saturate(n.y)`, plus **star flecks**: `rest = posLocal*scale*7; cell = floor(rest); h = hash(cell.x + cell.y*57 + cell.z*113); fleck = smoothstep(.93,.99,h)*smoothstep(.22,.05, len(rest-cell-.5))*(sin(time*(h*3+1.5) + h*40)*.5+.5); += C(e8f0ff)*fleck*1.8`. Here `lambert = saturate(abs(dot(n,KEY))*0.6+0.35)`.

### 4.2 Sky mantas -- `buildMantas`, 6 instances

Instance data: `orbit = (cx, cy, cz, radius)`, `mantaData = (angSpeed signed, phase, scale, heightWobble)`.

```hlsl
float a = time*M.x + M.y;
float3 lp = posLocal * M.z;
float beat = sin(time*0.9 + M.y - vc.r*1.4) * vc.r * vc.g * (abs(lp.z)*0.35 + 0.3);   // wingbeat rolls out to the tips
float dir = sign(M.x);
float heading = atan2(-cos(a)*dir, -sin(a)*dir);                                        // nose along the orbit tangent
float3 pos = float3(O.x + cos(a)*O.w, O.y + sin(time*0.25 + M.y)*M.w, O.z + sin(a)*O.w);
world = yaw(float3(lp.x, lp.y+beat, lp.z), heading) + pos;
```

Fragment:
- `manta_glow`: `C(7ff0ff)*1.6*(sin(time*1.5+M.y)*.25+.85)`.
- `manta`: `back = drawnSurface(lerp(1a2660, 4a60b0, lambert), nm, wp, spacing 1.2, strength .5)`; **belly** `lerp(back, C(9fb0e8)*.75, smoothstep(.15,-.5, nm.y))`; **spots** `span = abs(lp.z); row = penLines(span*0.9 + lp.x*0.2, 2.4); spots = smoothstep(.35,.8, sin(lp.x*5 + span*2)); ripple = sin(time*2.2 - span*1.3 + M.y)*.5+.5; += C(6ff4ee)*row*spots*smoothstep(.9,1.6,span)*(ripple*1.4+.3)`. Here `lambert = saturate(abs(dot(N_geom,KEY))*.5+.4)`; note it uses the un-yawed normal.

### 4.3 Moths -- `buildMoths`

240 GPU sprites, additive, renderOrder 4. The `Moth` mesh in fauna.glb is **not used**. Static random `s : float4` per sprite.

```hlsl
float3 flutter = float3(sin(t*(s.x*4+3) + s.y*30), sin(t*(s.y*5+4) + s.z*20)*0.6, cos(t*(s.z*4+3) + s.w*30)) * 0.9;
float3 local = fmod_pos(s.xyz*36 + flutter - camPos + 18, 36) - 18;           // wraps in a 36 m box round the camera
pos = float3(local.x + camPos.x, camPos.y + local.y*0.25 - 0.3, local.z + camPos.z);
float wing = sin(time*30 + s.w*50)*0.5 + 0.5;
size = float2(0.26*(wing*0.6+0.5), 0.18);
col = lerp(C(c6b8ff), C(8ff0e6), s.w) * exp(-3.2*r) * 1.9 * mothStrength;   // r = 2*|uv-.5|
```

`mothStrength` eases toward the Lantern Wood weight under the player; the sprites are hidden below 0.02.

### 4.4 Tortoise -- `buildTortoise`, one, non-instanced

Vertex: `gait(posLocal, vc, tortoisePhase, 0.9, 0.35)`, with phase advancing 0.9/s. Fragment: `lambert = saturate(dot(N,KEY)*.55+.45)`. Pairs (dark, light) by name: `moss` 1a4038/4f9078, `shell` 161c40/48528a, else (skin) 24223e/6a6890. `col = drawnSurface(lerp(dark,light,lambert*.5+.5)*.9, N, wp, spacing 1.4)`. Moss adds spores: `sp = posLocal*2.2`, cell hash `(x + y*31 + z*97)`, `dot = smoothstep(.9,.98,h)*smoothstep(.3,.08,len(sp-cell-.5))`, `+= C(9ff0c8)*dot*(sin(time*1.3+h*30)*.4+.9)`.

### 4.5 Wildlife -- `src/world/wildlife.ts`

| creature | draw | vertex | colour |
|---|---|---|---|
| **Birds** (`buildBirds`), 5 flocks × 12 instanced | opaque, double-sided | `flock=(cx,cy,cz,r)`, `bird=(angSpeed±, phase, offset, size)`. `a=time*B.x+B.y; r=F.w*(B.z*.5+.75)`; centre `y += sin(time*.6+B.y)*2.5 + B.z*6`; `pos = centre + (cos a, 0, sin a)*r`; `beat = sin(time*7.5+B.y*5)*smoothstep(-.2,.4, sin(time*.9+B.z*9))` (flap bursts, then glide); `lp=posLocal*B.w; lp.y += abs(lp.z)*beat*.7*vc.g`; bank about X by `0.35*sign(B.x)`; yaw `=-atan2(tz,tx)` with `tx=-sin a*sign, tz=cos a*sign` | `C(e9e0d4)*(saturate(abs(dot(Ng,KEY)))*.4+.55)` |
| **Jellyfish** (`buildJellies`), 70 instanced | **additive**, depthWrite off, renderOrder 3, hidden in mirror | `jelly=(x,y,z,phase)`. `pulse=sin(time*1.8+J.w*2π)`; `bell=1-vc.g`; scale `(1+.12p·bell, 1-.08p·bell, 1+.12p·bell)`; tentacle sway `(sin(time*1.1+vc.r*4+J.w*20)*vc.r*.25, 0, cos(time*.9+vc.r*3)*vc.r*.25)*vc.g`; slow drift circle radius 3 m (`time*0.07`, `time*0.06`) | `tint = lerp(coral, 8fd4ff, smoothstep(.3,.7,J.w))`; `col = tint*(bell*.7 + vc.g*(1-vc.r)*.15)*(pulse*.2+.9)*smoothstep(4,12, camDist)` (near fade) |
| Jelly halo | additive sprite at the water surface (y 0.08), size 2.4, mirror-hidden | same drift | `tint*exp(-4r)*0.5*(sin(time*1.8+w*2π)*.3+.8)` |
| **Fish** | 4 meshes, CPU parabola hop | none | `lerp(C(9fb4ff), starWhite, vc.g*.5)*1.3` |
| **Starlight whale** (`buildWhale`) | single mesh, CPU breach arc (7 s) | none | `sp=posLocal*.9; h=hash(cell.x+cell.y*57+cell.z*113); stars=smoothstep(.86,.95,h)*smoothstep(.32,.08,len(sp-cell-.5))*(sin(time*3+h*50)*.3+.9)`; `rim=(1-abs(nView.z))^2.5`; `belly=smoothstep(.2,-.6,Ng.y)`; `col = C(14205a)*(lambert*.8+.3) + C(8fa8ff)*rim*.45 + C(9fb8ff)*belly*.35 + starWhite*stars*2.4`, `lambert=saturate(dot(Ng,KEY)*.5+.5)` |
| Splash rings | 10 pooled additive sprites | CPU scale `size*(0.3+1.2t)` | `foam*(exp(-18|r-.75|) + exp(-6r)*.25)*strength` |

### 4.6 Nightmares -- `src/world/nightmares.ts`

Each spawned nightmare gets its **own material instances** with two per-object uniforms: `phase` (gait, which also seeds the noise) and `fade` (presence 0..1). Kinds are `Wraith` and `Crawler`, and each comes with a `NightmareThorns` patch. Unlit, double-sided. Vertex shader (`dress`), in object space:

```hlsl
float3 lp = posLocal; float3 pos;
if (CRAWLER) {                                   // walker encoding, tripod gait
  float leg = vc.g > 0.75; float a = phase + vc.b*2π;
  pos = float3(lp.x + sin(a)*vc.r*0.22*leg, lp.y + max(cos(a),0)*vc.r*0.14*leg, lp.z);
} else {                                         // wraith tendrils / thorn tips ripple like ink in water
  float w = sin(time*2.4 + vc.b*2π + vc.r*5) * vc.r * (vc.g*0.8 + 0.2);
  pos = float3(lp.x + w*0.12, lp.y + w*(THORNS?0.08:0.18), lp.z + cos(time*1.9 + vc.b*2π)*vc.r*0.1);
}
float boil = noise3(lp*1.6 + float3(0, time*0.9, phase*0.1)) * (THORNS?0.03:0.06) * (vc.r + 1);   // surface boils along normals
pos += Ngeom * boil;
pos.y -= (1 - fade) * (THORNS ? 2.6 : 3.2);       // emerge from / sink into the ground
```

Fragment: `lambert = saturate(abs(dot(Ng,KEY))*.5+.5)`; `veins = smoothstep(.07, 0, abs(noise3(lp*2.4 + float3(0,time*.25,phase*.05)))) * (sin(time*1.7+phase)*.35+.75)`.

| material | colour |
|---|---|
| `ink_eye` (contains `eye`) | `C(ff6a2a) * (3.6 + sin(time*7+phase)*.5 + sin(time*17.3+phase*2)*.3)`, ember flicker that blooms |
| `ink_edge` (contains `edge`) | `lerp(C(2a0c3a), C(7a1a3a), lambert) + C(b0183a)*veins*.6` |
| `ink` (else) | `lerp(C(020108), C(1a1430), lambert²) + C(5a0f2a)*(1-abs(nView.z))^3*.7 + C(c0183a)*veins*(THORNS?.9:.55)` |

**Smoke** is 200 GPU sprites, **alpha-blended** (not additive), renderOrder 3. Instance data `(x,y,z,age)`, simulated on the CPU (rise 0.7 m/s, life 2.2 s). `size = (age*2.4+0.6)*(age<1)`; `alpha = smoothstep(1,.3, r + noise2(uv*4+age*3)*.2)*smoothstep(0,.12,age)*(1-age)*.85`; `rgb = lerp(C(030108), C(5a1030), smoothstep(.35,.95,r))`.

The object-level motion (wraith bob, lunges, yaw) happens on the CPU.

### 4.7 Blob shadows -- `src/render/blobShadows.ts`

One instanced 2×2 ground quad. Instance `blob = (x, y+0.06, z, radius)`, where radius 0 hides it. `pos = local*radius + xyz`. Alpha-blended, depthWrite off, renderOrder 1, no depth offset beyond the +6 cm.

- Normal: `rgba = (C(05061a), smoothstep(1,.25,r)*0.5)`.
- Ink (nightmares): `wob = noise2(p*2.2 + float2(time*.25, B.x*.1))*.18; r = len(p)+wob; body = smoothstep(.95,.55,r); rim = smoothstep(.6,.85,r)*smoothstep(1,.85,r); rgba = (lerp(C(030108), C(5a0f2a), rim*.8), min(body+rim*.6,1)*.85)`. Here `p = (uv-.5)*2`.

Users: deer (r 1.2·scale), tortoise (7.5), nightmares (wraith 2.6, crawler 1.9, thorns 2.4, × presence).

---

## 5. Water, sky and set pieces

### 5.1 Water -- `src/world/water.ts`, `createWater`

A single 60 km plane at y=0, snapped to a 64 m grid round the camera so world-space noise stays put. `MeshBasic`, **transparent with depthWrite on**, renderOrder 1, fogged. Uses a planar reflector (`reflector({resolutionScale: QUALITY.reflection})`): the scene drawn from a camera mirrored about y=0 into an RT, sampled at `(1-screenU, screenV)`.

```hlsl
float2 p = wp.xz; float t = time;
float sx = noise3(float3(p*0.045 + float2(t*0.03, 0), t*0.12));
float sz = noise3(float3(p*0.045 + float2(31, t*0.025), t*0.12));
float fx = noise3(float3(p*0.32 + float2(t*0.12, 7), t*0.4));
float fz = noise3(float3(p*0.32 + float2(13, -t*0.1), t*0.4));
float dist = -viewPos.z;  float detailFade = smoothstep(400, 40, dist);
float swell = sin(p.y*0.22 + p.x*0.05 + t*0.9 + sx*2.5);
float3 n = normalize(float3(sx*0.3 + fx*0.14*detailFade, 1, sz*0.3 + fz*0.14*detailFade + swell*0.12));
float3 V = normalize(camPos - wp);  float ndv = saturate(dot(n, V));
float fresnel = pow(1-ndv, 3)*0.7 + 0.12;
float2 ruv = float2(1-screenUV.x, screenUV.y) + float2(n.x*0.035, n.z*0.08) * (smoothstep(2500,60,dist)*0.75 + 0.25);
float3 refl = REFLECTION.Sample(ruv).rgb;
float sceneZ = LinearViewZ(DepthBuffer(screenUV));                      // opaque depth behind the water
float depth = max(viewPos.z - sceneZ, 0) * (ndv*0.7 + 0.3);             // metres of water, view-corrected
float3 body = lerp(C(shallowSea), C(deepSea), smoothstep(0.5, 14, depth));
float sheen = pow(saturate(dot(reflect(-V, n), BRIGHT_STAR)), 160) * 0.07;
float crest = smoothstep(0.35, 1, swell) * 0.1 * smoothstep(1800, 100, dist);
float3 col = lerp(body, refl, fresnel) + C(horizon)*crest + C(starWhite)*sheen;
// Foam: thin noise-broken lip at the shore plus soft rolling bands.
float fn = noise3(float3(p*0.18, t*0.25));
float bands = sin(depth*2.6 - t*1.3 + fn*3)*0.5 + 0.5;
float lipBreak = noise3(float3(p*0.9, t*0.4));
float lip = smoothstep(0.28, 0.03, depth + fn*0.12 + lipBreak*0.1) * smoothstep(260, 60, dist);
float rolling = smoothstep(.62,.92, bands) * smoothstep(3.2, 0.4, depth) * smoothstep(-.3,.3, fn);
float foam = saturate(max(lip, rolling*0.85));
col = lerp(col, C(foam)*0.9, foam);
// Secret lagoons (`LAGOONS` in `src/core/heightfield.ts`, formerly `src/world/`: x, z, r): luminous turquoise lit from below.
float lag = max_k smoothstep(L.r-4, L.r-18, length(wp.xz - L.xz));
float glowBand = sin(depth*1.6 - t*0.6 + fn*2)*0.5 + 0.5;
float3 lagCol = lerp(C(0d4f66), C(6ff4ee), smoothstep(2.8,0.1,depth)*0.55 + glowBand*0.45) * 1.7;   // blooms
col = lerp(col, lerp(lagCol, refl, fresnel*0.35), lag*0.9);
OUT = float4(col, max(smoothstep(0, 0.5, depth), foam) * 0.97);
```

Pass the lagoon centres as a small constant array.

**Boat water mask** (`Avatar`, `src/game/avatar.ts`): a hull-shaped plane at y 0.14 with `colorWrite:false` and renderOrder 0.9. It writes depth only, so the water (renderOrder 1) does not draw inside the boat.

### 5.2 Sparkles (glitter path) -- `src/world/sparkles.ts`

Three additive sprite layers, renderOrder 2, hidden in mirror. Each sprite has static random `s : float4`. Layers as (count, span m, sizeScale, near m): (22000, 240, 1.1, 5), (22000, 900, 1.4, 40), (18000, 2600, 2.0, 160); counts × `QUALITY.sparkles`.

```hlsl
float2 xz = fmod_pos(s.xy*span - camPos.xz + span/2, span) - span/2 + camPos.xz;   // wrap round camera
float3 pos = float3(xz.x, noise3(float3(xz*0.05, time*0.2))*0.12 + 0.06, xz.y);
float rate = s.z*3 + 1.5;
float tick = floor(time*rate + s.w*10), phase = frac(time*rate + s.w*10);
float3 facet = normalize(float3((hash(tick + s.x*9137)-.5)*.9, 1, (hash(tick + s.y*5711)-.5)*.9));  // re-rolled per tick
float3 V = normalize(camPos - pos);
float glint = pow(saturate(dot(reflect(-V, facet), normalize(guide))), 9);    // lights when the facet mirrors the guide
float ambient = pow(hash(tick + s.z*3001), 40) * 0.5;
float d = length(xz - camPos.xz);
float bright = (glint*1.6 + ambient) * sin(phase*π) * smoothstep(span/2, span*0.375, d) * smoothstep(near, near*3, d) * intensity;
float clearance = smoothstep(1.5, 8.0, viewPos.z - SceneViewZ());            // clearance fade: kill glints over shallows/sand
size = (0.4 + d*0.0045) * (min(bright,1.6)*0.8 + 0.25) * sizeScale * (bright > 0.02);
col = lerp(starWhite, starGold, smoothstep(.55,.85, s.w)) * starShape(uv, min(bright*.5+.45, 1), 0) * bright * clearance * 1.8;
```

`guide` is a direction uniform: `SKY.brightStar` by default. At sea `guideTo` lerps it toward `normalize(goalDir.x, 0.32, goalDir.z)`, so the path points at the next fallen star. `intensity` = 1 (`setIntensity` exists but nothing calls it).

### 5.3 starShape -- `src/render/starShape.ts`

The four-point star used by stars, sparkles, fallen stars and constellations.

```hlsl
float starShape(float2 uv, float rays, float diag) {
  float2 q = uv*2-1, a = abs(q); float r = length(q);
  float core = exp(-14*r)*1.4 + exp(-40*r)*2.0;
  float reach = max(rays, 0.001);
  float rayH = exp(-55*a.y) * pow(saturate(1 - a.x/reach), 2.2);
  float rayV = exp(-55*a.x) * pow(saturate(1 - a.y/reach), 2.2);
  float2 d = abs(float2(q.x+q.y, q.x-q.y)*0.7071);
  float rayD = max(exp(-90*d.y)*pow(saturate(1-d.x/(reach*.45)),3), exp(-90*d.x)*pow(saturate(1-d.y/(reach*.45)),3)) * diag;
  return core + max(rayH, rayV) + rayD;
}
```

### 5.4 Sky -- `src/world/sky.ts`, `createSky`

All of it is camera-centred, depthWrite off, fog off, drawn first.

**Dome** (`skyDome`): unit sphere × 15000 + camPos, BackSide, renderOrder -10. `dir = normalize(posGeom); el = dir.y`.

```hlsl
col = lerp(C(horizon), C(sky), smoothstep(-.02,.22,el));
col = lerp(col, C(zenith), smoothstep(.18,.95,el));
col = lerp(col, C(fog)*0.7, smoothstep(0,-.08,el));
float toMoon = saturate(dot(dir, MOON));
col += C(moon) * (pow(toMoon,30)*0.22 + pow(toMoon,6)*0.025);
col += C(starWhite) * pow(saturate(dot(dir, BRIGHT_STAR)), 900) * 0.12;
float cn = fbm3(float3(dir.x*2.4, dir.y*30, dir.z*2.4) + float3(time*0.002,0,0));  // 4 oct, long horizontal streaks
float cloud = smoothstep(.02,.4,cn) * smoothstep(-.01,.04,el) * smoothstep(.24,.06,el);
float3 cloudLit = lerp(C(cloud)*.55, C(cloud), smoothstep(-.2,.4,cn)) + C(moon)*pow(toMoon,6)*.4;
col = lerp(col, cloudLit, cloud*0.5);
float milky = exp(-pow(dot(dir, normalize(float3(.9,.25,.35)))/0.2, 2));    // Milky Way band
float3 cell = floor(dir*900); float seed = hash(dot(cell, float3(12.9898,78.233,37.719)));
float tiny = step(lerp(1.01,.994,milky), seed) * (sin(time*(seed*1.2+.4) + seed*100)*.12+.88) * smoothstep(0,.08,el) * (1-cloud);
col += lerp(starWhite, starGold, frac(seed*17)) * tiny * milky * 0.4;
col += float3(.05,.06,.16) * milky * smoothstep(0,.2,el);
```

**Stars** (`starField(650)`): additive sprites, renderOrder -9. Instance `dirSize = (dir.xyz, size)`, where size = `0.0026 + 0.0095*rnd^5` (fraction of radius) and elevation is biased low; `meta = (gold 0/1 (55%), rnd, brightness .4-1, 0)`. `pos = camPos + dir*12000; scale = size*12000; tw = sin(time*(meta.y*.25+.15) + meta.y*40)*.4+.6; col = lerp(starWhite, starGold, meta.x)*starShape(uv, min(size*110,.95), 0)*meta.z*tw*smoothstep(0,.06,dir.y)*1.6`.

**Bright star blaze** (`heroStar`), renderOrder -8, at `BRIGHT_STAR*12000`: `scale = 1320*(sin(time*.7)*.06+1)*(blaze*1.4+1)`; `col = lerp(starWhite, starGold, .35)*starShape(uv, 1, blaze*.3+.7)*(blaze*1.8+2.2)`. `blaze` is a uniform (7.4).

**Moon** (`moon`), renderOrder -8, at `MOON*12000`, scale 1080. `q = uv*2-1; disc = smoothstep(.36,.33,|q|); shadow = smoothstep(.31,.35, |q-(.13,.06)|); crescent = disc*(shadow*.85+.15); halo = exp(-6|q|)*.04; mott = fbm3(float3(q*6,1))*.15+.92`; `col = C(moon)*(crescent*mott*.62 + halo)`. It is kept under the bloom threshold on purpose.

**Shooting star** (`ShootingStar`), renderOrder -7. Uniforms `t` (0..1 life), `from`, `to` (directions) and `angle` (screen-space rotation, computed on the CPU from the projected motion). `k=saturate(t); e=k*k*.6+k*.4; pos = camPos + normalize(lerp(from,to,e))*10800`; sprite 1440 × 144, rotated by `angle`. `head = exp(-12*len(((uv.x-.92)*4, uv.y-.5))); tail = smoothstep(0,.92,uv.x)*exp(-30|uv.y-.5|); alive = step(0,t)*step(t,1)*smoothstep(1,.75,t)`; `col = starWhite*max(head*3, tail*1.2)*alive*2`.

### 5.5 Moonbeams and motes

**Moonbeams** (`src/world/moonbeams.ts`): a pool of 48 additive sprites, fog off, bottom-anchored (`center (0.5,0)`), screen-facing billboards 2.5-5.5 m × 22-32 m, placed on the CPU from a 13 m hash grid where `grove >= 0.45`. `col = C(9fb4ff)*exp(-5|uv.x-.5|)*smoothstep(0,.25,uv.y)*(smoothstep(1,.7,uv.y)*.5+.5)*(sin(time*.4 + i*1.7)*.25+.75)*0.42*fade`. Per-sprite `fade` is driven by distance and by "inside the jungle". Hidden in mirror.

**Motes** (`src/world/motes.ts`): additive sprites wrapped round the camera, renderOrder 3, hidden in mirror.
- Fireflies: 700 in a 70 m box. `y = cam.y + local.y*.35 - .5`; drift amplitude 2.2; blink `life = smoothstep(.55,1, sin(t*(s.w*1.2+.4) + s.z*60))`; size `.09 + d*.002`; colour `lerp(starGold, ffe2a0, s.x)*2.4`.
- Rising star motes: 240 in a 260 m box. `cycle = frac(t*.025*(s.w*.8+.6) + s.z)`; `y = cycle*28 - 2`; `life = smoothstep(0,.15,cycle)*smoothstep(1,.55,cycle)`; size `.12 + d*.0025`; colour `lerp(bfd0ff, starWhite, s.y)*1.4`.
- Both use the glow `exp(-5r) + exp(-18r)*2` and fade `smoothstep(half, half*.6, d)*smoothstep(.6, 2, d)`.

### 5.6 Waterfalls -- `src/world/waterfalls.ts`

**Curtain**: a CPU-built 28×6 strip, ballistic from the lip to the pool (`y = lip.y*(1-t²) - .3t`, width 4.5→8 m). Attributes `uv` (u across, t = 0 at the lip, 1 at the pool) and `seed`. Alpha-blended, depthWrite off, double-sided, renderOrder 5.

```hlsl
float flow = t*t*6 + t*3 - time*1.4;                          // accelerates as it falls
float streak = noise2(float2(u*22 + seed, flow*1.2))*.5+.5;
float fine   = noise2(float2(u*60 + seed, flow*3))*.5+.5;
float inkL   = penLines(u*16 + noise2(float2(u*4, t*2+seed))*.6, 1.0) * smoothstep(.1,.4,t) * .35;
float edges  = smoothstep(.5,.36, abs(u-.5));
float foam   = smoothstep(.55,1,t)*.8 + smoothstep(.38,.5,abs(u-.5))*.6 + smoothstep(.75,.95,fine)*.5;
float3 col = lerp(C(6ff4ee)*.42*(streak*.7+.45), C(f2ece0)*.62, min(foam,1)) + smoothstep(.9,.98,fine)*.5;
col = lerp(col, C(0b1030), inkL);
float a = min((streak*.35 + .5 + foam*.3) * edges * smoothstep(0,.05,t), .95);
```

**Foam and mist puffs**: alpha sprites. `rgb = C(tint)*k`, `a = smoothstep(1,.35, r + noise2(uv*5 + time*.3)*.15)*.7`, with foam `f2ece0 ×.5` and mist `bfe8f0 ×.28`; positions animated on the CPU. **Rings**: RingGeometry(.85, 1), alpha `0.5*fade`, colour `e6f4f2`, scale and fade cycled on the CPU.

### 5.7 Lighthouses and props -- `src/world/landmarks.ts`, `Landmarks.material`

Unlit, double-sided. `variety = hash(floor(wp.x*.31 + wp.z*.17))`. The lit uniform `L` is **per lighthouse** for `lamp_glass`, `star_crystal` and `rune_glow`: every Beacon or Lighthouse instance gets its own copies of those three materials, so they can be lit one at a time. Other materials are shared.

| material name | shader |
|---|---|
| `lamp_glass` | **additive**, transparent, depthWrite off: `lerp(C(6a7ac8)*.08, starGold*.35, L)`. The crystal shows through it. |
| `star_crystal` | `lerp(C(9fb4ff)*.9, C(fff0d0)*4.5, L)*(sin(time*1.6)*.15+1)`. The `StarCrystal` node spins (`0.25 + 0.6L` rad/s) and bobs on the CPU. |
| `rune_glow` | `lerp(C(7a8cff)*.9, C(b8fff4)*2.4, L) * (sin(wp.y*.6 - time*1.4)*.3+.75)`, light crawling up the tower |
| any other `*glow*` (`window_glow`, `lamp_glow`, `candle_glow`, `lantern_glow`) | `starGold*2.2*(sin(time*9+variety*40)*.08 + sin(time*23+variety*13)*.05 + .9)`, candle flicker |
| solids | `tint` from the table below (default `34405e`). `painted = tint*(variety*.2+.85)*(vc.r*.25+.8)*.85`; `col = drawnSurface(painted, N, wp) + float3(.08,.1,.22)*saturate(N.y)*.12` |
| lighthouse **masonry and base course** (Beacon/Lighthouse solids) | `src/render/lighthouseShading.ts`, `masonry`. In model space, `arc = angle(lp)*len(lp.xz)`. Walls: `max(penLines(lp.y/.62, .8), penLines(arc/1.3 + floor(lp.y/.62)*.5, .7))`; floors and treads: rings `len/.8` and joints `arc/1.1 + floor(ring)*.5`; blended by `upright`, broken by noise, faded `smoothstep(45, 12, dist)`. `col = lerp(col*foot, C(0b1030), ink*.42)` with `foot = smoothstep(.2, 4.5, lp.y)*.22 + .78`. `lighthouse_white` turns `stone` below 1.6 m on the outer face (the door bay is modelled white to the ground). |
| lighthouse **interior** | `inside = max(tower, lampRoom)`: `tower = smoothstep(wallR-.12, wallR-.3, len)*smoothstep(23.2, 22.8, lp.y)`, `lampRoom` = inside r 2.12 between 22.9 and 26.4 m. `interiorShade`: warm light from the stair lanterns (nearest lantern found by unwinding the point onto the stair helix, pool `smoothstep(6, .8, d)`, flicker per lantern), `crown = smoothstep(16.5, 21.5, lp.y)*.75`, cold light from the floor runes. Three tones (dark `tint*(.13,.12,.24)`, violet-leaning mid, warm high), hatched where unlit, masonry ink on top. |

Solid tints: wood 6b5450, thatch 7a6650, stone 5b6890, rope 8a7a68, sail e8dfd0, lighthouse_white c9c0b0, lighthouse_band = coral, ruin_stone 8a90b8, ruin_moss 3f6a7a, marble b8b8d8.

**Beam cones** (`makeBeam`): two open cylinders (radius 0.35·scale at the lamp spreading to 7 at the far end, length 160·max(.7, scale)) laid horizontally and opposite each other. Additive, fog off, double-sided. `col = C(ffe0a8)*pow(1-uv.y, 1.8)*.22`. Group rotates 0.35 rad/s; scale `min(1, L*1.2)`; visible when `L > .05`.

`Landmarks.lamp` (the shared fallback uniform) is never driven, so it is 0. `RuneRing_0..2` are removed at load.

### 5.8 Wonders -- `src/world/wonders.ts`, `Wonders.material`

Unlit, double-sided. `near1` is a uniform: proximity to the nearest wonder, eased.
- Name contains `glow` or `light`: `tint` = moontree `bfe4ff`, ring `c6a0ff`, bell `8ff0e6`, else starGold. `col = C(tint)*((ring?.7:1.1) + near1*.5)*(sin(time*1.3 + lp.y*.6)*.2+.9)`.
  - `mushroom_glow` on the fairy ring (giant gills): `gills = penLines(atan2(lp.z,lp.x)/2π*72, 1.2)`; `col = lerp(col*(smoothstep(1,7,len(lp.xz))*.8+.3), C(0b1030), gills*.5)`.
- Solids: tint by the first substring match: bone d8d2e6, stone 6a74a8, rock 4a5488, bark 5a4a78, wood 6b5450, bronze 6a8a8a, mushroom_cap 4a2f8a, mushroom_stem cfc6ea, moss 3f6a7a, roof 3a4478, leaf 9fc6ff, foliage 5a7ab8, grass 3a6a60, ruin 8a90b8 (default 5b6890). `col = drawnSurface(tint*.9, N, wp) + float3(.07,.09,.2)*saturate(N.y)*.6`.
- The floating rocks bob and rotate on the CPU. Vertex colours are unused here.

### 5.9 Puzzles and smaller effects

| effect | file | trick |
|---|---|---|
| **Bell marks, visible only in the reflection** | `puzzleBells.ts`, `BellPool` | The "truth" marks are additive sprites (`C(8ff0e6)*tex.r*2.2`, a 96² canvas texture of n dots, 1.4 m, 4.4 m up + 1.5 m per extra ring). They are `visible = false` normally and switched on only while the reflection camera renders (`setMirror(true)`), and only if the puzzle is unsolved and the player has stood still for 1.5 s. "Lie" marks (`ffc878`) do the opposite: visible to the main camera, hidden in the mirror. Bronze: `lerp(lerp(2a4a4a, 7aa8a0, lambert), C(ffd08a)*1.4, glow)` with `lambert = saturate(dot(N,KEY)*.55+.45)`. |
| Constellation stone dials | `puzzleStones.ts` | `lerp(C(1a2040), lerp(C(a8c0ff)*1.2, starGold*2.4, glow), max(tex.r, rim))`, `rim = exp(-30*abs(2|uv-.5|-1))*.6` |
| Glowcaps and mirror caps | `puzzleWood.ts` | cap `lerp(lerp(1a1636, 3a2a72, lambert), C(tint)*2.2*(sin(time*1.8)*.12+1), lit)`; roots additive `C(5fe8d8)*(sin(time*1.2)*.15+.45)`; light beam additive `C(fff0c8)*(sin(time*6)*.15+1.6)` |
| Firefly jar, footprints | `puzzleMeadow.ts` | glow sprite `C(tint)*(exp(-5r) + exp(-16r)*1.5)*k`; additive footprint quads `C(bfe0ff)*sole*smoothstep(7.5,2.5, dist to player)*shimmer*1.1` (needs a player-position uniform) |
| Starlight currents | `currents.ts` | additive ribbons, attribute `flowUv = (along m, across 0..1)`; `flowPos = along - time*speed`; lanes noise, streaks and hash glints; `tint = lerp(ffd6a0, bcd0ff, lanes)` |
| Stepping stones | `stones.ts` | lit `MeshStandard` (rough .6), instanced: `lerp(lerp(2c3557, 5b6797, top*grain), 141a33, wet)`, emissive `float3(.04,.05,.1)*top` |
| Fallen stars and pillars | `story/fallenStars.ts` | additive starShape core (`seen` fades by distance for unmarked stars); pillar sprite 2.2 × 90 m, `starGold*exp(-14|uv.x-.5|)*(1-uv.y)^1.6*shimmer*smoothstep(1400,300,d)*smoothstep(6,35,d)*.55` |
| Echo figures | `story/echoes.ts` | additive rim-light silhouettes: `rim = (1-|nView.z|)^1.6`, scanline shimmer `hash(floor(lp.y*40) + floor(time*12))` |
| Constellations | `story/constellation.ts` | additive starShape sprites (renderOrder -6), cold `8ea2f0` → warm on `lit`; additive line segments starGold × .7 |
| Wisp | `game/wisp.ts` | additive sprite, core plus two beating wings (`sin(time*38)`), renderOrder 6 |
| Prologue | `story/prologue.ts` | alpha-blended blue footprints (`C(9fb4ff)*1.4`, opacity from two soft ovals) with polygon offset; distant figure as a pure `040510` silhouette with opacity `fade` |

---

## 6. Vertex colour encodings (COLOR_0) and material-name keys

glTF vertex colours can arrive as 16-bit normalised values (`wildlife.ts mergedGeometry` normalises them). 8-bit is enough everywhere: B phases quantise harmlessly and R gait weights are linear.

| asset family (file) | R | G | B | read by |
|---|---|---|---|---|
| **Props and jungle flora** (`build_assets.py`: palms, canopy, ferns, bushes, vines, jetty, hut, wreck...) | 0 at part root → 1 at tip: sway weight and glow ramp. `ramp_r` rewrites R as height through the object for solid props. | part id: 0 trunk/hull/wood, 1 frond/foliage, 0.5 fruit/detail | per-part random (sway phase) | flora: sway `R²·(G>.25 ? 1 : .35)`, palm glow ramp, fern tips `R³·G`; landmarks: brightness `R*.25+.8` |
| **Region flora** (`biomes.py`: mushrooms, lantern tree, moonflowers, meadow and dune grass, crystals) | root → tip | 0 wood/stem/stone, 1 leaf/petal/grass, **0.5 glow/emissive** | per-part random | flora (as above; REGION_GLOW brightness `R*.4+.7`) |
| **Ruins** (`biomes.py`, `finish_ruin`) | height through the object from z = -2 (they stand in water) to top | 0 | random | landmarks brightness |
| **Creatures** (`build_assets.py` creatures: Bird, Jellyfish, Fish, Whale) | along the body, head/root 0 → tail/tip 1 | **1 wings, fins, tentacles**, 0 body | per-part random | birds flap `abs(lp.z)*beat*G`; jelly bell `1-G`, tentacle sway `R·G`; fish tint `G` |
| **Walkers** (`fauna.py`: StarDeer, Tortoise) | leg swing weight `clamp((HIP_Z - z)/HIP_Z)`: 0 at/above the hip, 1 at the foot. **HIP_Z: StarDeer 1.25 m, Tortoise 3.0 m.** Linear in z, so swing = θ·R·HIP_Z. | 1 legs, 0 body/head/antlers/shell, 0.5 deer antler star buds | leg phase: FL 0.0, BR 0.25, FR 0.5, BL 0.75; 0 elsewhere | `gait()`; leg mask `G > 0.75` |
| **Fliers** (`fauna.py`: SkyManta, Moth) | 0 body → 1 wing/tail tip | 1 wings and tail, 0 body | 0 | manta wingbeat `sin(...- R*1.4)*R*G` |
| **Crawler** (`nightmares.py`) | walker encoding, **HIP_Z 0.42 m** (all six hips) | 1 legs incl. knee spurs | tripod: L-front, R-mid, L-back 0.0; R-front, L-mid, R-back 0.5 | nightmare crawler gait |
| **Wraith** (`nightmares.py`) | 0 core → 1 tendril/finger tips; robe ramps 0 → 0.35 down to the hem; hood, eyes, torso 0 | 1 tendrils, arms, sleeves, fingers; 0 robe, hood, eyes | per tendril/arm phase | ripple `sin(2.4t + B·2π + R·5)·R·(.8G+.2)`; boil amplitude `(R+1)` |
| **NightmareThorns** (`nightmares.py`) | 0 root → 1 tip per tendril; 0 on puddle/knot | `smoothstep(.25,.6,R)`: rigid stems 0, swaying tips 1 | per tendril | as wraith, with smaller amplitudes |
| **Wonders** (`fauna.py`, wonders.glb) | height 0 ground → 1 top on solids; root → tip on sway parts | 0 solid, 0.5 glow, 1 may sway | random | not read by the current shader (reserved for sway) |
| **Lighthouse** (`lighthouse.py`) | height through the whole asset 0..1 | 0 solid, 0.5 glow | random | landmarks brightness `R*.25+.8` |

Blender is +Z up and +Y left; the shaders use glTF axes (local up = Y, left = -Z). Walkers and fliers face **+X**, so game yaw = heading - π/2.

**Material names the shaders key on** (substring = `includes`, exact = `===`):

| key | match | where |
|---|---|---|
| `glow` | substring | fauna (`antler_glow`, `manta_glow`), landmarks (`window_glow`, `lamp_glow`, `candle_glow`, `lantern_glow`), wonders (also `light`) |
| `lamp_glass`, `star_crystal`, `rune_glow` | exact | landmarks, per-lighthouse lit uniform |
| `mushroom_glow`, `lantern_glow`, `moonflower_glow`, `crystal` | exact | flora REGION_GLOW (`mushroom_glow` also gets gills; on wonders a substring match gets ring gills) |
| `mushroom_cap`, `mushroom_stem`, `grass` | exact | flora REGION_BASE (`mushroom_*` non-glow also drawn) |
| `trunk`, `frond`, `fruit`, `flower` | exact | palm and banana glow |
| `fern`, `leaf_broad` | exact | starlit frond tips |
| `vine` | exact | full-length sway |
| `core`, `bark` (substring), `trunk_dark` (exact) | | darker foliage, drawn surface |
| `ink_eye` / `ink_edge` / `ink` | substring `eye`, `edge` | nightmares |
| `tortoise_moss` / `tortoise_shell` / skin | substring `moss`, `shell` | tortoise |
| `lantern_glow` on the boat | exact | `avatar.ts`, flat `C(ffb070)*1.6` |
| node names | `<Type>_hi/_lo`, `StarDeer`, `SkyManta`, `Tortoise`, `Bird`, `Jellyfish`, `Fish`, `Whale`, `Wraith`, `Crawler`, `NightmareThorns`, `DreamLighthouse`, `StarCrystal`, `RuneRing_n`, `MoonTree`, `MushroomRing`, `WhaleSkeleton`, `BellTower`, `FloatingRocks` | loaders |

---

## 7. Porting notes for s&box

### 7.1 Lit or unlit

- **Lit** (engine lighting contributes): terrain (albedo × 0.12 + big emissive), stepping stones, prologue stone. Everything else is **unlit** with hard-coded `dot(N, KEY)` shading.
- Recommendation: make all of it unlit or emissive-only in s&box and fake the lamp pools on terrain with a small point-light array in the terrain shader. Otherwise the Source 2 lighting, AO and shadows will fight the drawn look. Turn off engine shadows on everything; the blob shadows replace them.
- Disable engine tonemapping, auto-exposure and bloom on the camera. The post pass does its own bloom → ACES → sRGB → painterly chain and writes display-ready values.

### 7.2 Custom vertex shaders and instancing

| needs a custom VS | instanced? | per-instance data |
|---|---|---|
| Flora (rotation, scale, sway, LOD collapse) | yes, thousands | `float4 inst`, `float scl` |
| Deer | yes, 14 | `pose`, `gaitData` |
| Mantas | yes, 6 | `orbit`, `mantaData` |
| Birds | yes, 60 | `flock`, `bird` |
| Jellyfish and halos | yes, 70 | `jelly`, `jellyGlow` |
| Blob shadows | yes, ≤25 per pool | `blob` |
| Tortoise, nightmares (gait, ripple, boil, sink) | no | per-object `phase`, `fade` |
| GPU sprite clouds: sparkles (62k), stars (650), motes (940), moths (240), smoke (200) | yes, camera-wrapped in the VS | static random `float4` (smoke: CPU-updated) |
| Sky dome, stars, moon, shooting star | camera-centred in the VS | -- |

Everything that wraps round the camera (`fmod` in the VS) needs a huge or disabled bounding box; three uses `frustumCulled = false` on all of these.

### 7.3 Render order, transparency, blending

| order | what | blend | depth write |
|---|---|---|---|
| -10 | sky dome | opaque (BackSide) | off |
| -9 / -8 / -7 / -6 | stars / hero star + moon / shooting star / constellations | **additive** | off |
| 0 | opaque world (terrain, flora, props, creatures, nightmares) | opaque | on |
| 0.9 | boat water mask | colour write off | **on** |
| 1 | water | alpha | **on** |
| 1 | blob shadows | alpha | off |
| 2 | sparkles, currents | additive | off |
| 3 | jellyfish, jelly halos, motes, nightmare smoke (alpha) | additive (smoke alpha) | off |
| 4 | moths | additive | off |
| 5 | waterfall curtain | alpha | off |
| 6 | wisp | additive | off |
| unordered | moonbeams, beams, lamp glass, glow sprites, fallen stars, puzzle glows, echoes, splash rings | additive | off |
| unordered | waterfall puffs and rings, footprints | alpha | off |

The water and sparkles both read the **opaque depth buffer** (depth and clearance fades), so they must draw after opaques, with the depth texture available. Fog is on by default for every material except those marked `fog:false` (sky, stars, moon, moonbeams, beacon beams, pillars, constellations). With additive blending three fogs the colour toward the fog colour. Check that this does not add a fog-coloured haze over the quads; disabling fog on additive effects is probably what you want.

### 7.4 The mirror pass

Reflection = scene rendered from a camera mirrored about the y=0 plane into an RT at `QUALITY.reflection` × resolution, sampled with `screenUV.flipX()` by water and wet sand. Visibility rules in `main.ts`, `scene.onBeforeRender` / `onAfterRender`:

| in the reflection | objects |
|---|---|
| **hidden** | sparkles, motes, moonbeams, all fauna (deer, mantas, moths, tortoise), jellyfish and halos, every non-Palm flora batch, bell "lie" marks |
| **only here** | bell "truth" marks (`BellPool.setMirror`, gated by unsolved and still > 1.5 s) |
| special | terrain's `reflection` input is pointed at a 1×1 dummy `(12,22,80)` while the mirror renders, and for a few frames after a resize, so it never samples its own target |
| never in scene | the player body (first person; story-relevant: the Keeper casts no reflection) |

In s&box, do this with a second camera rendering to a texture and render tags: tag mirror-hidden objects `no_reflect` and mirror-only objects `reflect_only`; the main camera excludes `reflect_only`, the reflection camera excludes `no_reflect`. Mirror about the water plane with an oblique clip plane.

### 7.5 Uniforms driven from game code each frame

| uniform | owner | driven by | easing |
|---|---|---|---|
| `time` | global | seconds | -- |
| `boil` (`floor(time*10)`) | post | derived | -- |
| `paint` = 1, `boilRate` = 10 | post | constants (settings could expose them) | -- |
| `frost` | post | `story.onNight(p)` → target `max(0,(p-.55)/.45)` | `dt*0.8` |
| `memoryMix` | post | 1 while a memory voice line plays (`story.onMemory(seconds)`) | in `dt*1.2`, out `dt*0.7` |
| `nightmare` | post | `Nightmares.dread*(1 - flareFlash)`; dread = max over live of `clamp((45-d)/35)`, itself eased `dt*1.5` | `dt*2` |
| `blaze` | sky | `story.allLit` | `dt*0.3` |
| `glow` (palms) | flora | `1 + 0.12 × completed constellations` (`story.ts`) | `dt*0.4` |
| `lit` per lighthouse | landmarks | `lightBeacon(i)` → target 1 | `dt*0.8`; also drives beam scale, visibility, crystal spin |
| `guide` (dir) | sparkles | bright star, or toward the next goal at sea | lerp `dt*0.8` |
| `R_hi`, `R_far` per flora type | flora | quality | on change |
| `mothStrength` | fauna | Lantern Wood weight at the player | `dt` |
| `tortoisePhase` | fauna | += 0.9·dt | -- |
| `phase`, `fade` per nightmare | nightmares | gait speed; presence (emerge +0.35/s, dissolve -0.7/s) | -- |
| `near1` | wonders | proximity to the nearest wonder | `dt` |
| `fade` per moonbeam, `fade` per waterfall ring, `strength` per splash ring | various | CPU | -- |
| shooting star `t`, `from`, `to`, `angle` | sky | `fire()` and `update()` | -- |
| puzzle `glow` / `lit` / `jarGlow` / `gentle`, fallen-star `alpha` / `pillarAlpha`, wisp `glow`, constellation `lit` / `complete`, echo `fade` | puzzles, story | game state | -- |
| instance buffers: deer `pose`/`gaitData`, mantas, birds, jellies, blob shadows, smoke | | CPU, each frame or on recentre | -- |

### 7.6 Suggested porting order

1. **Helpers**: MaterialX Perlin and fBm, PCG hash with the negative-seed fold, `starShape`, `drawn.hlsl` (penLines, tones, hatchAt, strokes, drawnSurface), the Y-up metre conversion.
2. **Post chain** (section 1), on a greybox. It defines the look; check it against browser screenshots before tuning any material. Order: stage 1 → tensor → LIC → palette → ink → canvas/dither → vignette/grain, then memory, frost and nightmare.
3. **Terrain** (2.2), including the region weights and a stub reflection texture.
4. **Sky**: dome, stars, moon, hero star, shooting star.
5. **Water** with the planar reflection RT and depth-behind-water; then wet sand; then the mirror tag rules.
6. **Flora** instancing (VS sway and LOD), then the palm glow and the region glow and base colours.
7. **Landmarks and lighthouses** (per-instance lit), **wonders**, puzzle stone material.
8. **Sprites**: sparkles (needs scene depth), motes, moonbeams, glow sprites, fallen stars.
9. **Creatures**: deer and tortoise (walker gait), mantas, birds, jellyfish, whale, fish; blob shadows.
10. **Nightmares** (VS boil, gait, sink, smoke, ink pools), together with post stage 10b.
11. **Set pieces**: waterfalls, currents, bell marks visible only in the mirror, echoes, constellations.
