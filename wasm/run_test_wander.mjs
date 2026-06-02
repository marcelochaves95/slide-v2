// Realistic band = many overlaid GPS sub-traces (what the Strava heatmap actually is): a WIDE,
// BUMPY ridge whose lumps make the line wander side-to-side (the zigzag seen on real trails).
// Curved (sine) centerline so we measure BOTH curve-following (meanOff to true center) AND
// roughness (zigzag). Sweep smoothing x angleScale to find a combo that kills wander without
// cutting curves. (smoothing here is in WASM "stdDev" units; ~2.3 m/cell, same as the extension.)
import fs from 'node:fs';
const DIR = 'C:/Users/MarceloChaves/Projects/slide-v2/src/wasm';
globalThis.fs = fs;
(0, eval)(fs.readFileSync(DIR + '/wasm_exec.js', 'utf8'));
const go = new globalThis.Go();
const { instance } = await WebAssembly.instantiate(fs.readFileSync(DIR + '/slide.wasm'), go.importObject);
go.run(instance);
await new Promise((r) => setTimeout(r, 50));

const M_PER_PX = 2.3, MPP_DEG = M_PER_PX / 111320;
const W = 420, H = 260;
const WEST = 0, SOUTH = 0, EAST = W * MPP_DEG, NORTH = H * MPP_DEG;
const lonOfCol = (c) => WEST + c * MPP_DEG;
const latOfRow = (r) => NORTH - r * MPP_DEG;
const colOfLon = (l) => (l - WEST) / MPP_DEG;
const rowOfLat = (l) => (NORTH - l) / MPP_DEG;

const A = 24, LAMBDA = 230, R0 = 130;            // sine center; tightest radius:
const centerRow = (c) => R0 + A * Math.sin((2 * Math.PI * c) / LAMBDA);
const Rmin = (M_PER_PX / (A * (2 * Math.PI / LAMBDA) ** 2)).toFixed(0);

// Build the bumpy band from N sub-traces offset perpendicular by gaussian-random amounts.
function buildGrid(seed) {
  let s = seed || 1; const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const gauss = () => { let u = 0, v = 0; while (u === 0) u = rnd(); while (v === 0) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const N = 70, subSigma = 1.6, offStd = 7.5;     // thin sub-traces, lateral spread ~17m
  const offs = Array.from({ length: N }, () => gauss() * offStd);
  const f = new Float64Array(W * H);
  let peak = 0;
  for (let x = 0; x < W; x++) {
    const c = centerRow(x);
    for (let y = 0; y < H; y++) {
      let v = 0;
      for (let k = 0; k < N; k++) { const d = y - (c + offs[k]); v += Math.exp(-(d * d) / (2 * subSigma * subSigma)); }
      f[y * W + x] = v; if (v > peak) peak = v;
    }
  }
  const grid = new Uint8Array(W * H);
  for (let i = 0; i < f.length; i++) grid[i] = Math.max(0, Math.min(255, Math.round((f[i] / peak) * 173 + (rnd() - 0.5) * 2 * 18)));
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
  for (let col = 14; col <= W - 14; col += 15) pts.push([lonOfCol(col), latOfRow(centerRow(col) + offPx + (rnd() - 0.5) * 6)]);
  return pts;
}
function metrics(path) {
  const ds = path.map(([lon, lat]) => distToTrue(colOfLon(lon), rowOfLat(lat)) * M_PER_PX);
  const mean = ds.reduce((a, b) => a + b, 0) / ds.length;
  // roughness: heading-change between consecutive segments (deg), averaged -> zigzag indicator
  let turn = 0, n = 0;
  for (let i = 1; i < path.length - 1; i++) {
    const ax = colOfLon(path[i - 1][0]), ay = rowOfLat(path[i - 1][1]);
    const bx = colOfLon(path[i][0]), by = rowOfLat(path[i][1]);
    const cx = colOfLon(path[i + 1][0]), cy = rowOfLat(path[i + 1][1]);
    const v1x = bx - ax, v1y = by - ay, v2x = cx - bx, v2y = cy - by;
    const a1 = Math.atan2(v1y, v1x), a2 = Math.atan2(v2y, v2x);
    let da = Math.abs(a2 - a1); if (da > Math.PI) da = 2 * Math.PI - da;
    turn += (da * 180) / Math.PI; n++;
  }
  return { mean, turn: n ? turn / n : 0 };
}

const grid = buildGrid(7);
const input = makeInput(8);
const im = metrics(input);
console.log(`bumpy band (70 sub-traces, spread ~17m), curve Rmin ~${Rmin}m`);
console.log(`INPUT: meanOff ${im.mean.toFixed(1)}m, avgTurn ${im.turn.toFixed(1)}deg\n`);
console.log('cell = meanOff(m) / avgTurn(deg)   lower=better; avgTurn = zigzag\n');

const angles = [0.1, 0.3, 0.6, 1.0];
const stds = [8, 14, 20, 28, 38];
process.stdout.write('std\\ang  ' + angles.map((a) => ('ang' + a).padEnd(14)).join('') + '\n');
for (const std of stds) {
  let line = String(std).padEnd(3) + '     ';
  for (const ang of angles) {
    const res = globalThis.__slideV2Wasm({
      width: W, height: H, grid, west: WEST, east: EAST, south: SOUTH, north: NORTH,
      smoothingStdDev: std, angleScale: ang, path: input,
    });
    if (!res.ok) { line += 'ERR'.padEnd(14); continue; }
    const m = metrics(res.path);
    line += (m.mean.toFixed(1) + '/' + m.turn.toFixed(1)).padEnd(14);
  }
  console.log(line);
}
process.exit(0);
