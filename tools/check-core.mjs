// src/core holds the game's rules: engine-free, so they port to s&box (C#) mechanically.
// It may import only from itself and plain libraries, never Three.js or the rest of src/.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

const core = resolve('src/core');
const allowed = new Set(['simplex-noise']);
const bad = [];
const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : f.endsWith('.ts') ? [join(d, f)] : []));
for (const file of walk(core)) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
    const spec = m[1];
    if (spec.startsWith('.')) {
      const target = resolve(dirname(file), spec);
      if (!target.startsWith(core)) bad.push(`${file}: imports ${spec} (outside src/core)`);
    } else if (!allowed.has(spec)) bad.push(`${file}: imports ${spec}`);
  }
}
if (bad.length) {
  console.error('src/core must stay engine-free:\n  ' + bad.join('\n  '));
  process.exit(1);
}
console.log(`src/core is engine-free (${walk(core).length} files).`);
