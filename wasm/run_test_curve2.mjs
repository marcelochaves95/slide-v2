// Robustness check: does a SMALL smoothing still win when the band is narrow+faint, the noise is
// heavy, and there is a parallel decoy trail nearby? Same measurement as run_test_curve.mjs.
import fs from 'node:fs';
const DIR = 'C:/Users/MarceloChaves/Projects/slide-v2/src/wasm';
globalThis.fs = fs;
(0, eval)(fs.readFileSync(DIR + '/wasm_exec.js', 'utf8'));
const go = new globalThis.Go();
const { instance } = await WebAssembly.instantiate(fs.readFileSync(DIR + '/slide.wasm'), go.importObject);
go.run(instance);
await new Promise((r) => setTimeout(r, 50));

const W = 220, H = 160, MPP_DEG = 0.0001, M_PER_PX = 11.13;
const WEST = 0, SOUTH = 0, EAST = W * MPP_DEG, NORTH = H * MPP_DEG;
const lonOfCol = (c) => WEST + c * MPP_DEG;
const latOfRow = (r) => NORTH - r * MPP_DEG;
const colOfLon = (l) => (l - WEST) / MPP_DEG;
const rowOfLat = (l) => (NORTH - l) / MPP_DEG;

const A = 22, LAMBDA = 110, R0 = 80;
const centerRow = (c) => R0 + A * Math.sin((2 * Math.PI * c) / LAMBDA);

function buildGrid({ sigmaBand, noiseAmp, peak = 255, decoyOffset = 0, decoyPeak = 0 }, seed) {
  let s = seed || 1;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const grid = new Uint8Array(W * H);
  for (let x = 0; x < W; x++) {
    const c = centerRow(x);
    for (let y = 0; y < H; y++) {
      let v = peak * Math.exp(-((y - c) ** 2) / (2 * sigmaBand ** 2));
      if (decoyPeak) v += decoyPeak * Math.exp(-((y - (c + decoyOffset)) ** 2) / (2 * sigmaBand ** 2));
      v += (rnd() - 0.5) * 2 * noiseAmp;
      grid[y * W + x] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }
  return grid;
}

const trueLine = [];
for (let x = 0; x <= W; x += 0.5) trueLine.push([x, centerRow(x)]);
function distToTrue(px, py) {
  let best = Infinity;
  for (let i = 1; i < trueLine.length; i++) {
    const ax = trueLine[i - 1][0], ay = trueLine[i - 1][1], bx = trueLine[i][0], by = trueLine[i][1];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    if (d < best) best = d;
  }
  return best;
}
function makeInput() {
  let s = 42; const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const pts = [];
  for (let col = 10; col <= W - 10; col += 12) pts.push([lonOfCol(col), latOfRow(centerRow(col) + 7 + (rnd() - 0.5) * 8)]);
  return pts;
}
function meanOff(path) {
  const ds = path.map(([lon, lat]) => distToTrue(colOfLon(lon), rowOfLat(lat)));
  return [ds.reduce((a, b) => a + b, 0) / ds.length * M_PER_PX, Math.max(...ds) * M_PER_PX];
}

const scenarios = {
  'narrow faint + heavy noise': { sigmaBand: 1.6, noiseAmp: 50, peak: 180 },
  'parallel decoy 200m away   ': { sigmaBand: 2.6, noiseAmp: 35, peak: 255, decoyOffset: 18, decoyPeak: 230 },
  'very heavy noise           ': { sigmaBand: 2.6, noiseAmp: 75, peak: 255 },
};
const input = makeInput();
const [im, ix] = meanOff(input);
console.log('INPUT hand trace: meanOff', im.toFixed(1) + 'm  maxOff', ix.toFixed(1) + 'm\n');

for (const [name, cfg] of Object.entries(scenarios)) {
  const grid = buildGrid(cfg, 7);
  let line = `${name}:`;
  for (const std of [6, 10, 14, 20, 30]) {
    const res = globalThis.__slideV2Wasm({ width: W, height: H, grid, west: WEST, east: EAST, south: SOUTH, north: NORTH, smoothingStdDev: std, path: input });
    if (!res.ok) { line += `  std${std}=ERR`; continue; }
    const [m] = meanOff(res.path);
    line += `  std${std}=${m.toFixed(1)}m`;
  }
  console.log(line);
}
process.exit(0);
