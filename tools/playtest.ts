// Simulated playtesters, headless: the same bots as lapis.playtest() in the browser, run against
// the engine-free rules in src/core. `npm run playtest [runs]`
import { createHeightfield, findSpawn } from '../src/core/heightfield';
import { layoutPrologue } from '../src/core/placement';
import { layoutWonders } from '../src/core/wonders';
import { layoutPuzzles, skyFeatures } from '../src/core/puzzles';
import { playtest } from '../src/core/playtest';

const runs = Number(process.argv[2] ?? 50);
const hf = createHeightfield();
const layout = layoutPrologue(hf, findSpawn(hf));
const boatAz = ((((Math.atan2(layout.seaward.x, -layout.seaward.z) * 180) / Math.PI) % 360) + 360) % 360;
const sites = layoutPuzzles(hf, layoutWonders(hf), boatAz);
const t0 = performance.now();
const rows = playtest(sites, skyFeatures(boatAz), runs);
console.table(rows.map(({ puzzle, skill, solved, minutes, mistakes, stuck }) => ({ puzzle, skill, solved, minutes, mistakes, stuck: String(stuck).slice(0, 60) })));
console.log(`${sites.length} puzzles x 4 skills x ${runs} runs in ${Math.round(performance.now() - t0)} ms`);
