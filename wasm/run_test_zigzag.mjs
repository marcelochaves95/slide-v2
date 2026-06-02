// Reproduce the ZIGZAG seen on real trails. A STRAIGHT diagonal band (peak ~173 like the real
// gray heatmap) with per-pixel noise; the input path sits EXACTLY on the centerline, so any
// lateral wiggle in the output is a pure algorithm artifact. We sweep momentumScale x smoothing
// and report mean offset AND roughness (mean |2nd difference| of the perpendicular offset).
import fs from 'node:fs';
const DIR = 'C:/Users/MarceloChaves/Projects/slide-v2/src/wasm';
globalThis.fs = fs;
(0, eval)(fs.readFileSync(DIR + '/wasm_exec.js', 'utf8'));
const go = new globalThis.Go();
const { instance } = await WebAssembly.instantiate(fs.readFileSync(DIR + '/slide.wasm'), go.importObject);
go.run(instance);
await new Promise((r) => setTimeout(r, 50));

const M_PER_PX = 2.3, MPP_DEG = M_PER_PX / 111320;
const W = 320, H = 220;
const WEST = 0, SOUTH = 0, EAST = W * MPP_DEG, NORTH = H * MPP_DEG;
const lonOfCol = (c) => WEST + c * MPP_DEG;
const latOfRow = (r) => NORTH - r * MPP_DEG;
const colOfLon = (l) => (l - WEST) / MPP_DEG;
const rowOfLat = (l) => (NORTH - l) / MPP_DEG;

// Straight diagonal centerline: P0 + t*u
const P0 = [55, 175];
const dir = [210, -130];
const ulen = Math.hypot(dir[0], dir[1]);
const u = [dir[0] / ulen, dir[1] / ulen];
const nrm = [-u[1], u[0]];               // left normal
const signedPerp = (cx, cy) => (cx - P0[0]) * nrm[0] + (cy - P0[1]) * nrm[1];

function buildGrid(peak, sigmaPx, noiseAmp, seed) {
  let s = seed || 1; const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const grid = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = signedPerp(x, y);
      let v = peak * Math.exp(-(d * d) / (2 * sigmaPx * sigmaPx)) + (rnd() - 0.5) * 2 * noiseAmp;
      grid[y * W + x] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }
  return grid;
}
// Input path EXACTLY on the centerline.
function makeInput() {
  const pts = [];
  for (let t = 25; t <= ulen - 25; t += 16) pts.push([lonOfCol(P0[0] + t * u[0]), latOfRow(P0[1] + t * u[1])]);
  return pts;
}
function metrics(path) {
  const off = path.map(([lon, lat]) => signedPerp(colOfLon(lon), rowOfLat(lat)) * M_PER_PX);
  const meanAbs = off.reduce((a, b) => a + Math.abs(b), 0) / off.length;
  let rough = 0, n = 0;
  for (let i = 1; i < off.length - 1; i++) { rough += Math.abs(off[i + 1] - 2 * off[i] + off[i - 1]); n++; }
  return { meanAbs, rough: n ? rough / n : 0 };
}

const grid = buildGrid(173, 5, 30, 7);     // peak 173, sigma ~11m, per-pixel noise +/-30
const input = makeInput();
const im = metrics(input);
console.log(`band peak 173, sigma ~11m, noise +/-30; input ON centerline (meanOff ${im.meanAbs.toFixed(1)}m, rough ${im.rough.toFixed(2)})\n`);
console.log('cell = meanOff / roughness  (both in m; lower=better, roughness=zigzag)\n');

const moms = [0.0, 0.2, 0.4, 0.7];
const stds = [6, 8, 12, 16, 22];
process.stdout.write('std\\mom   ' + moms.map((m) => ('mom' + m).padEnd(13)).join('') + '\n');
for (const std of stds) {
  let line = String(std).padEnd(3) + '      ';
  for (const mom of moms) {
    const res = globalThis.__slideV2Wasm({
      width: W, height: H, grid, west: WEST, east: EAST, south: SOUTH, north: NORTH,
      smoothingStdDev: std, momentumScale: mom, path: input,
    });
    if (!res.ok) { line += 'ERR'.padEnd(13); continue; }
    const m = metrics(res.path);
    line += (m.meanAbs.toFixed(1) + '/' + m.rough.toFixed(2)).padEnd(13);
  }
  console.log(line);
}
process.exit(0);
