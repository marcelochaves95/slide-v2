// Realistic diagnostic for slide.wasm: a CURVED (sine) ridge with NOISE, like a real Strava
// trail. We feed a slightly-off, jittered path (simulating a hand-traced line) and measure how
// far the slid result lands from the TRUE centerline. Sweeps smoothingStdDev to expose the
// reach-vs-curve-cutting tradeoff. All geometry defined in pixels, converted to lon/lat for the
// request and back for measurement.
import fs from 'node:fs';

const DIR = 'C:/Users/MarceloChaves/Projects/slide-v2/src/wasm';
globalThis.fs = fs;
(0, eval)(fs.readFileSync(DIR + '/wasm_exec.js', 'utf8'));
const go = new globalThis.Go();
const { instance } = await WebAssembly.instantiate(fs.readFileSync(DIR + '/slide.wasm'), go.importObject);
go.run(instance);
await new Promise((r) => setTimeout(r, 50));

const W = 220, H = 140;
const MPP_DEG = 0.0001;            // ~11.13 m per pixel near the equator
const WEST = 0, SOUTH = 0;
const EAST = WEST + W * MPP_DEG;    // x = col
const NORTH = SOUTH + H * MPP_DEG;  // row 0 = NORTH
const M_PER_PX = 11.13;

const lonOfCol = (col) => WEST + col * MPP_DEG;
const latOfRow = (row) => NORTH - row * MPP_DEG;
const colOfLon = (lon) => (lon - WEST) / MPP_DEG;
const rowOfLat = (lat) => (NORTH - lat) / MPP_DEG;

// True centerline: a sine wave. center row as a function of column.
const A = 22, LAMBDA = 110, R0 = 70;
const centerRow = (col) => R0 + A * Math.sin((2 * Math.PI * col) / LAMBDA);

// Build a noisy Gaussian band around the sine centerline.
function buildGrid(sigmaBand, noiseAmp, seed) {
  let s = seed || 1;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const grid = new Uint8Array(W * H);
  for (let x = 0; x < W; x++) {
    const c = centerRow(x);
    for (let y = 0; y < H; y++) {
      const d = y - c;
      let v = 255 * Math.exp(-(d * d) / (2 * sigmaBand * sigmaBand));
      v += (rnd() - 0.5) * 2 * noiseAmp;       // speckle
      grid[y * W + x] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }
  return grid;
}

// Dense true centerline polyline (px) for distance measurement.
const trueLine = [];
for (let x = 0; x <= W; x += 0.5) trueLine.push([x, centerRow(x)]);
function distToTrue(px, py) {
  let best = Infinity;
  for (let i = 1; i < trueLine.length; i++) {
    const ax = trueLine[i - 1][0], ay = trueLine[i - 1][1];
    const bx = trueLine[i][0], by = trueLine[i][1];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    if (d < best) best = d;
  }
  return best;
}

// Input path: the true centerline, sampled coarsely, with a constant perpendicular offset + jitter
// (simulating an imperfect hand trace). Defined in px, then converted to lon/lat.
function makeInputPath() {
  let s = 42;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const pts = [];
  for (let col = 10; col <= W - 10; col += 12) {
    const off = 7 + (rnd() - 0.5) * 8;           // ~7px off + jitter
    pts.push([lonOfCol(col), latOfRow(centerRow(col) + off)]);
  }
  return pts;
}

function stats(label, lonlatPath) {
  const ds = lonlatPath.map(([lon, lat]) => distToTrue(colOfLon(lon), rowOfLat(lat)));
  const mean = ds.reduce((a, b) => a + b, 0) / ds.length;
  const max = Math.max(...ds);
  console.log(
    `  ${label.padEnd(22)} pts=${String(lonlatPath.length).padStart(3)}  ` +
    `meanOff=${(mean * M_PER_PX).toFixed(1)}m  maxOff=${(max * M_PER_PX).toFixed(1)}m`
  );
  return mean * M_PER_PX;
}

const grid = buildGrid(2.6, 35, 7);   // band sigma ~2.6px(~29m), noise +/-35
const input = makeInputPath();

console.log('=== Curved + noisy band: reach-vs-corner-cutting sweep ===');
console.log(`band sigma ~29m, noise +/-35, sine amplitude ${(A * M_PER_PX).toFixed(0)}m, wavelength ${(LAMBDA * M_PER_PX).toFixed(0)}m`);
console.log(`tightest radius ~${(M_PER_PX / (A * Math.pow(2 * Math.PI / LAMBDA, 2))).toFixed(0)}m\n`);
stats('INPUT (hand trace)', input);
console.log('');

for (const std of [10, 20, 30, 45, 70, 110]) {
  const res = globalThis.__slideV2Wasm({
    width: W, height: H, grid, west: WEST, east: EAST, south: SOUTH, north: NORTH,
    smoothingStdDev: std, path: input,
  });
  if (!res.ok) { console.log(`  stdDev=${std}m  ERROR ${res.error}`); continue; }
  stats(`AFTER stdDev=${std}m`, res.path);
}
process.exit(0);
