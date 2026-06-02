// Final smoothing calibration at the REAL heatmap scale (~2.3 m/px, z15 512px tiles), with
// realistic trail-band widths and a moderately tight curve. Finds the smoothingStdDev that best
// recovers the true centerline, to choose a fixed automatic value (no per-trail tuning).
import fs from 'node:fs';
const DIR = 'C:/Users/MarceloChaves/Projects/slide-v2/src/wasm';
globalThis.fs = fs;
(0, eval)(fs.readFileSync(DIR + '/wasm_exec.js', 'utf8'));
const go = new globalThis.Go();
const { instance } = await WebAssembly.instantiate(fs.readFileSync(DIR + '/slide.wasm'), go.importObject);
go.run(instance);
await new Promise((r) => setTimeout(r, 50));

// Equator bound so lon/lat/Mercator are ~isotropic; choose deg/px to get the real m/px.
const M_PER_PX = 2.3;
const MPP_DEG = M_PER_PX / 111320;       // deg per pixel
const W = 400, H = 200;                  // ~920m x 460m
const WEST = 0, SOUTH = 0, EAST = W * MPP_DEG, NORTH = H * MPP_DEG;
const lonOfCol = (c) => WEST + c * MPP_DEG;
const latOfRow = (r) => NORTH - r * MPP_DEG;
const colOfLon = (l) => (l - WEST) / MPP_DEG;
const rowOfLat = (l) => (NORTH - l) / MPP_DEG;

// Curve in px: A=17px(~39m), lambda=130px(~300m) -> tightest radius ~58m (a real switchback-ish bend)
const A = 17, LAMBDA = 130, R0 = 100;
const centerRow = (c) => R0 + A * Math.sin((2 * Math.PI * c) / LAMBDA);
const Rmin = (M_PER_PX / (A * (2 * Math.PI / LAMBDA) ** 2)).toFixed(0);

function buildGrid(sigmaPx, noiseAmp, peak, seed) {
  let s = seed || 1; const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const grid = new Uint8Array(W * H);
  for (let x = 0; x < W; x++) {
    const c = centerRow(x);
    for (let y = 0; y < H; y++) {
      let v = peak * Math.exp(-((y - c) ** 2) / (2 * sigmaPx ** 2)) + (rnd() - 0.5) * 2 * noiseAmp;
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
    let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy)); if (d < best) best = d;
  }
  return best;
}
function makeInput(offPx) {
  let s = 42; const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const pts = [];
  for (let col = 12; col <= W - 12; col += 14) pts.push([lonOfCol(col), latOfRow(centerRow(col) + offPx + (rnd() - 0.5) * 6)]);
  return pts;
}
function meanOff(path) {
  const ds = path.map(([lon, lat]) => distToTrue(colOfLon(lon), rowOfLat(lat)));
  return ds.reduce((a, b) => a + b, 0) / ds.length * M_PER_PX;
}

console.log(`REAL scale: ${M_PER_PX} m/px, curve Rmin ~${Rmin}m, hand-trace offset varied\n`);
const bands = { 'wide band (FWHM 41m)': 7.5, 'med band (FWHM 24m)': 4.4, 'narrow band (FWHM 14m)': 2.6 };
const offsets = { 'close trace (~12m off)': 5, 'loose trace (~28m off)': 12 };

for (const [oName, off] of Object.entries(offsets)) {
  const input = makeInput(off);
  console.log(`${oName}: INPUT meanOff ${meanOff(input).toFixed(1)}m`);
  for (const [bName, sig] of Object.entries(bands)) {
    const grid = buildGrid(sig, 35, 255, 7);
    let line = `   ${bName.padEnd(24)}`;
    for (const std of [4, 6, 8, 10, 12, 16, 22]) {
      const res = globalThis.__slideV2Wasm({ width: W, height: H, grid, west: WEST, east: EAST, south: SOUTH, north: NORTH, smoothingStdDev: std, path: input });
      line += `  ${std}=${res.ok ? meanOff(res.path).toFixed(1) : 'ERR'}`;
    }
    console.log(line);
  }
  console.log('');
}
process.exit(0);
