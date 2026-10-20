// Memory films, half real and half drawn: real footage flattened into soft brushwork (Kuwahara),
// tones banded like gouache, inked edges, a little paper grain and a hand-drawn boil.
// Used by tools/memories/edit_memory.py as a Tesseract customShader on the finishing adjustment.

struct VertexInput {
  @location(0) position: vec2<f32>,
  @location(1) tex_coords: vec2<f32>,
  @location(2) color: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) clip_position: vec4<f32>,
  @location(0) tex_coords: vec2<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var out: VertexOutput;
  out.clip_position = vec4<f32>(input.position, 0.0, 1.0);
  out.tex_coords = input.tex_coords;
  return out;
}

struct Params {
  animationTime: f32,
  amount: f32,
  brush: f32,
  flatten: f32,
  levels: f32,
  ink: f32,
  inkThreshold: f32,
  boilFps: f32,
  saturation: f32,
  posterize: f32,
  haze: f32,
  edgeBlur: f32,
};

@group(0) @binding(0) var t_texture: texture_2d<f32>;
@group(0) @binding(1) var s_sampler: sampler;
@group(0) @binding(2) var<uniform> params: Params;

const R: i32 = 4;

fn hash(p: vec2<f32>) -> f32 {
  return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453);
}

fn lum(c: vec3<f32>) -> f32 {
  return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
}

fn tap(uv: vec2<f32>) -> vec3<f32> {
  return textureSampleLevel(t_texture, s_sampler, uv, 0.0).rgb;
}

fn author_frag(uv0: vec2<f32>) -> vec4<f32> {
  let dims = vec2<f32>(textureDimensions(t_texture));
  let px = 1.0 / dims;
  let source = textureSampleLevel(t_texture, s_sampler, uv0, 0.0);

  // The boil: the whole drawing shifts a fraction of a stroke a few times a second.
  let tick = floor(params.animationTime * params.boilFps);
  let cell = floor(uv0 * dims / 24.0);
  let wob = vec2<f32>(hash(cell + tick), hash(cell + tick + 17.0)) - 0.5;
  let uv = uv0 + wob * px * params.brush * 0.5;

  // Kuwahara: of four overlapping quadrants, take the mean of the calmest. Edges stay sharp,
  // texture inside a shape melts into a single stroke of colour.
  let step = px * params.brush;
  var best = vec3<f32>(0.0);
  var bestVar = 1e9;
  for (var q = 0; q < 4; q++) {
    let sx = select(-1.0, 1.0, (q & 1) == 1);
    let sy = select(-1.0, 1.0, (q & 2) == 2);
    var sum = vec3<f32>(0.0);
    var sum2 = vec3<f32>(0.0);
    for (var y = 0; y <= R; y++) {
      for (var x = 0; x <= R; x++) {
        let c = tap(uv + vec2<f32>(sx * f32(x), sy * f32(y)) * step);
        sum += c;
        sum2 += c * c;
      }
    }
    let n = f32((R + 1) * (R + 1));
    let mean = sum / n;
    let v = sum2 / n - mean * mean;
    let total = v.r + v.g + v.b;
    if (total < bestVar) {
      bestVar = total;
      best = mean;
    }
  }

  // Gouache tones: lightness pulled toward a few soft bands, colour kept.
  let l = lum(best);
  let banded = (floor(l * params.levels) + smoothstep(0.35, 0.65, fract(l * params.levels))) / params.levels;
  var col = best * mix(1.0, banded / max(l, 1e-3), params.flatten);

  // Storybook colour: fewer, richer flat colours.
  let grey = vec3<f32>(lum(col));
  col = max(mix(grey, col, params.saturation), vec3<f32>(0.0));
  let steps = params.levels * 2.0;
  col = mix(col, floor(col * steps + 0.5) / steps, params.posterize);

  // Ink: a Sobel edge on lightness, drawn as a dark warm line where it is strong enough.
  let e = px * 1.5;
  let tl = lum(tap(uv + vec2<f32>(-e.x, -e.y)));
  let tc = lum(tap(uv + vec2<f32>(0.0, -e.y)));
  let tr = lum(tap(uv + vec2<f32>(e.x, -e.y)));
  let ml = lum(tap(uv + vec2<f32>(-e.x, 0.0)));
  let mr = lum(tap(uv + vec2<f32>(e.x, 0.0)));
  let bl = lum(tap(uv + vec2<f32>(-e.x, e.y)));
  let bc = lum(tap(uv + vec2<f32>(0.0, e.y)));
  let br = lum(tap(uv + vec2<f32>(e.x, e.y)));
  let gx = (tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl);
  let gy = (bl + 2.0 * bc + br) - (tl + 2.0 * tc + tr);
  let edge = smoothstep(params.inkThreshold, params.inkThreshold + 0.18, length(vec2<f32>(gx, gy)));
  col = mix(col, vec3<f32>(0.09, 0.06, 0.12), edge * params.ink);

  // Half remembered: the frame melts into soft focus toward its edges, and a milky glow lifts it.
  let d = length((uv0 - 0.5) * vec2<f32>(dims.x / dims.y, 1.0));
  let soft = smoothstep(0.12, 0.8, d);
  let rad = px * (10.0 + 90.0 * soft * params.edgeBlur);
  var blur = vec3<f32>(0.0);
  for (var i = 0; i < 16; i++) {
    let a = f32(i) * 2.39996 + hash(uv0 * dims) * 6.2832;
    let r = sqrt((f32(i) + 0.5) / 16.0);
    blur += tap(uv0 + vec2<f32>(cos(a), sin(a)) * r * rad);
  }
  blur /= 16.0;
  // Even the middle is a little soft: nothing in a memory is quite in focus.
  col = mix(col, blur, clamp(soft * params.edgeBlur * 1.1 + 0.18 * params.haze, 0.0, 0.92));
  // Glow: the blurred light screened back over the picture, and the shadows lifted to a haze.
  col = vec3<f32>(1.0) - (vec3<f32>(1.0) - col) * (vec3<f32>(1.0) - blur * 0.55 * params.haze);
  col = mix(col, vec3<f32>(0.88, 0.81, 0.74), 0.24 * params.haze);

  // Paper: a faint tooth under everything.
  let paper = 0.95 + 0.05 * hash(floor(uv0 * dims / 2.0));
  col *= paper;

  return vec4<f32>(mix(source.rgb, col, params.amount), source.a);
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let raw = author_frag(input.tex_coords);
  return vec4<f32>(clamp(raw.rgb, vec3<f32>(0.0), vec3<f32>(raw.a)), raw.a);
}
