// Renders a shaded top-down map of the world for layout review.
// node tools/map.ts <out.png> [size]
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { createHeightfield, findSpawn, WORLD_HALF } from '../src/world/heightfield.ts';

const out = process.argv[2] ?? 'map.png';
const N = Number(process.argv[3] ?? 768);
// Optional crop: node tools/map.ts out.png 512 <centreX> <centreZ> <spanMetres>
const cx = Number(process.argv[4] ?? 0);
const cz = Number(process.argv[5] ?? 0);
const span = Number(process.argv[6] ?? WORLD_HALF * 2);
const hf = createHeightfield();
const step = span / N;
const x0 = cx - span / 2;
const z0 = cz - span / 2;
const heights = new Float32Array(N * N);
for (let j = 0; j < N; j++)
  for (let i = 0; i < N; i++) heights[j * N + i] = hf.height(x0 + i * step, z0 + j * step);

const spawn = findSpawn(hf);
const px = Buffer.alloc(N * (N * 3 + 1));
for (let j = 0; j < N; j++) {
  px[j * (N * 3 + 1)] = 0;
  for (let i = 0; i < N; i++) {
    const h = heights[j * N + i];
    const hx = heights[j * N + Math.min(N - 1, i + 1)] - h;
    const hz = heights[Math.min(N - 1, j + 1) * N + i] - h;
    const shade = Math.max(0.25, Math.min(1.3, 0.85 - (hx + hz) * 0.06));
    let c: number[];
    if (h < 0) c = [20 + h * 0.3, 40 + h * 0.5, 120 + h];
    else if (h < 1.2) c = [230, 210, 200];
    else if (h < 60) c = [40, 70, 45];
    else c = [90 + Math.min(120, h / 5), 100 + Math.min(110, h / 5), 140 + Math.min(100, h / 6)];
    const o = j * (N * 3 + 1) + 1 + i * 3;
    const isSpawn = Math.hypot(x0 + i * step - spawn.x, z0 + j * step - spawn.z) < Math.max(4, span / 160);
    px[o] = isSpawn ? 255 : Math.max(0, Math.min(255, c[0] * shade));
    px[o + 1] = isSpawn ? 40 : Math.max(0, Math.min(255, c[1] * shade));
    px[o + 2] = isSpawn ? 40 : Math.max(0, Math.min(255, c[2] * shade));
  }
}

function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  let c = ~0;
  for (const b of td) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(~c >>> 0);
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0);
ihdr.writeUInt32BE(N, 4);
ihdr[8] = 8;
ihdr[9] = 2;
writeFileSync(out, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(px)), chunk('IEND', Buffer.alloc(0))]));
let max = -Infinity;
let land = 0;
for (const h of heights) {
  max = Math.max(max, h);
  if (h > 0) land++;
}
console.log(`spawn ${spawn.x.toFixed(0)},${spawn.z.toFixed(0)} max ${max.toFixed(0)}m land ${((land / heights.length) * 100).toFixed(0)}% (${((land / heights.length) * (WORLD_HALF * 2 / 1000) ** 2).toFixed(1)} km2)`);
