// Replay a REAL slide captured in the browser (window.__slideV2.dumpLastSlide()).
// Reads slide-dump.json, runs the actual Go WASM on the real heatmap grid, renders a scaled PNG so
// we can SEE the band vs the input/output lines, and sweeps smoothing. Ends the synthetic guessing.
//
// Usage: node wasm/replay_dump.mjs [path-to-slide-dump.json] [outSuffix]
import fs from 'node:fs';
import zlib from 'node:zlib';
import os from 'node:os';
import path from 'node:path';

const DIR = 'C:/Users/MarceloChaves/Projects/slide-v2/src/wasm';
globalThis.fs = fs;
(0, eval)(fs.readFileSync(DIR + '/wasm_exec.js', 'utf8'));
const go = new globalThis.Go();
const { instance } = await WebAssembly.instantiate(fs.readFileSync(DIR + '/slide.wasm'), go.importObject);
go.run(instance);
await new Promise((r) => setTimeout(r, 50));

const candidates = [process.argv[2], 'slide-dump.json', path.join(os.homedir(), 'Downloads', 'slide-dump.json')].filter(Boolean);
const file = candidates.find((p) => fs.existsSync(p));
if (!file) { console.log('dump not found:\n  ' + candidates.join('\n  ')); process.exit(1); }
const suffix = process.argv[3] || '';
console.log('loaded', file);
const dump = JSON.parse(fs.readFileSync(file, 'utf8'));
const { width: W, height: H, west, east, south, north, path: input } = dump;
const grid = new Uint8Array(Buffer.from(dump.gridBase64, 'base64'));

const colOfLon = (lon) => ((lon - west) / (east - west)) * W;
const rowOfLat = (lat) => ((north - lat) / (north - south)) * H;
const M_PER_PX = ((north - south) * 111320) / H;

function sampleGrid(cx, cy) {
  if (cx < 0) cx = 0; else if (cx > W - 1) cx = W - 1;
  if (cy < 0) cy = 0; else if (cy > H - 1) cy = H - 1;
  const x0 = Math.floor(cx), y0 = Math.floor(cy), x1 = Math.min(x0 + 1, W - 1), y1 = Math.min(y0 + 1, H - 1);
  const fx = cx - x0, fy = cy - y0;
  return grid[y0 * W + x0] * (1 - fx) * (1 - fy) + grid[y0 * W + x1] * fx * (1 - fy) + grid[y1 * W + x0] * (1 - fx) * fy + grid[y1 * W + x1] * fx * fy;
}
// densely sample intensity ALONG the polyline (not just at vertices) — mean & min
function intensityAlong(p) {
  let sum = 0, n = 0, min = 255;
  for (let i = 1; i < p.length; i++) {
    const x0 = colOfLon(p[i - 1][0]), y0 = rowOfLat(p[i - 1][1]);
    const x1 = colOfLon(p[i][0]), y1 = rowOfLat(p[i][1]);
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
    for (let s = 0; s <= steps; s++) {
      const v = sampleGrid(x0 + ((x1 - x0) * s) / steps, y0 + ((y1 - y0) * s) / steps);
      sum += v; n++; if (v < min) min = v;
    }
  }
  return { mean: sum / n, min };
}
function avgTurn(p) {
  let turn = 0, tn = 0;
  for (let i = 1; i < p.length - 1; i++) {
    const ax = colOfLon(p[i - 1][0]), ay = rowOfLat(p[i - 1][1]);
    const bx = colOfLon(p[i][0]), by = rowOfLat(p[i][1]);
    const cx = colOfLon(p[i + 1][0]), cy = rowOfLat(p[i + 1][1]);
    const a1 = Math.atan2(by - ay, bx - ax), a2 = Math.atan2(cy - by, cx - bx);
    let da = Math.abs(a2 - a1); if (da > Math.PI) da = 2 * Math.PI - da;
    turn += (da * 180) / Math.PI; tn++;
  }
  return tn ? turn / tn : 0;
}
// dump grid is now UNMASKED; re-apply the corridor here to replicate shipped behavior (render still
// uses the raw grid so we see nearby roads/branches the corridor removes).
const inPxAll = input.map(([lon, lat]) => [colOfLon(lon), rowOfLat(lat)]);
function distToPolyline2(px, py, poly) {
  let best = Infinity;
  for (let i = 1; i < poly.length; i++) {
    const ax = poly[i - 1][0], ay = poly[i - 1][1], bx = poly[i][0], by = poly[i][1];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0; if (t < 0) t = 0; else if (t > 1) t = 1;
    const ex = px - (ax + t * dx), ey = py - (ay + t * dy); const d2 = ex * ex + ey * ey; if (d2 < best) best = d2;
  }
  return best;
}
const maskedGrid = (() => {
  const g = grid.slice();
  if (dump.corridorSigmaMeters) { // soft corridor (current)
    const sPx = dump.corridorSigmaMeters / M_PER_PX, denom = 2 * sPx * sPx, cut2 = (3.5 * sPx) ** 2;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; if (!g[i]) continue; const d2 = distToPolyline2(x, y, inPxAll); g[i] = d2 > cut2 ? 0 : Math.round(g[i] * Math.exp(-d2 / denom)); }
  } else if (dump.corridorMeters) { // legacy hard corridor
    const c2 = (dump.corridorMeters / M_PER_PX) ** 2;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; if (g[i] && distToPolyline2(x, y, inPxAll) > c2) g[i] = 0; }
  }
  return g;
})();
function runSlide(extra) {
  const res = globalThis.__slideV2Wasm(Object.assign({ width: W, height: H, grid: maskedGrid, west, east, south, north, path: input }, extra));
  return res && res.ok ? res.path : null;
}

// grid intensity stats
let gmax = 0, gsum = 0;
for (const v of grid) { if (v > gmax) gmax = v; gsum += v; }
console.log(`\ngrid ${W}x${H}, ${input.length} input pts, ${M_PER_PX.toFixed(2)} m/px; grid max=${gmax}, mean=${(gsum / grid.length).toFixed(1)}`);
const ii = intensityAlong(input);
console.log(`effective smoothing ~= stdDev * ${M_PER_PX.toFixed(1)} m (ground)\n`);
console.log(`INPUT: meanIntensity ${ii.mean.toFixed(0)} (min ${ii.min.toFixed(0)}), avgTurn ${avgTurn(input).toFixed(1)}deg, pts ${input.length}`);
console.log('  (higher meanIntensity = more on the bright heatmap; lower turn = smoother)\n');
console.log('stdDev ang  -> meanInt(min) / turn / pts');
const outs = {};
for (const std of [6, 8, 12, 18, 26, 36]) {
  for (const ang of [0.1, 0.5]) {
    const p = runSlide({ smoothingStdDev: std, angleScale: ang });
    if (!p) { console.log(`  ${std} ${ang} ERR`); continue; }
    const t = intensityAlong(p);
    console.log(`  ${String(std).padEnd(3)} ${ang} -> ${t.mean.toFixed(0)}(${t.min.toFixed(0)}) / ${avgTurn(p).toFixed(1)} / ${p.length}`);
    outs[`s${std}a${ang}`] = p;
  }
}

// ---- render scaled PNG ----
const SC = 3;
const OW = W * SC, OH = H * SC;
const img = new Uint8Array(OW * OH * 3);
for (let y = 0; y < OH; y++) for (let x = 0; x < OW; x++) {
  const v = grid[Math.floor(y / SC) * W + Math.floor(x / SC)];
  const t = (v / Math.max(1, gmax)) * 3; // hot colormap so the bright core stands out
  const o = (y * OW + x) * 3;
  img[o] = Math.max(0, Math.min(255, t * 255));
  img[o + 1] = Math.max(0, Math.min(255, (t - 1) * 255));
  img[o + 2] = Math.max(0, Math.min(255, (t - 2) * 255));
}
function plot(p, rgb, thick) {
  for (let i = 1; i < p.length; i++) {
    const x0 = colOfLon(p[i - 1][0]) * SC, y0 = rowOfLat(p[i - 1][1]) * SC;
    const x1 = colOfLon(p[i][0]) * SC, y1 = rowOfLat(p[i][1]) * SC;
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0)) + 1;
    for (let s = 0; s <= steps; s++) {
      const x = Math.round(x0 + ((x1 - x0) * s) / steps), y = Math.round(y0 + ((y1 - y0) * s) / steps);
      for (let dx = -thick; dx <= thick; dx++) for (let dy = -thick; dy <= thick; dy++) {
        const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= OW || yy >= OH) continue;
        const o = (yy * OW + xx) * 3; img[o] = rgb[0]; img[o + 1] = rgb[1]; img[o + 2] = rgb[2];
      }
    }
  }
}
function dot(cx, cy, rgb) {
  for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) {
    const xx = Math.round(cx * SC) + dx, yy = Math.round(cy * SC) + dy; if (xx < 0 || yy < 0 || xx >= OW || yy >= OH) continue;
    const o = (yy * OW + xx) * 3; img[o] = rgb[0]; img[o + 1] = rgb[1]; img[o + 2] = rgb[2];
  }
}
if (outs['s8a0.1']) plot(outs['s8a0.1'], [255, 60, 60], 0);   // old std8 = red
if (outs['s12a0.1']) plot(outs['s12a0.1'], [60, 255, 90], 1); // shipped std12 = green
plot(input, [80, 160, 255], 0);                                // input = blue
for (const [lon, lat] of input) dot(colOfLon(lon), rowOfLat(lat), [255, 255, 255]); // input nodes = white

function crc32(buf) { let c, crc = 0xffffffff; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0); const t = Buffer.from(type, 'ascii'); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0); return Buffer.concat([len, t, data, crc]); }
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(OW, 0); ihdr.writeUInt32BE(OH, 4); ihdr[8] = 8; ihdr[9] = 2;
const raw = Buffer.alloc((OW * 3 + 1) * OH);
for (let y = 0; y < OH; y++) { raw[y * (OW * 3 + 1)] = 0; Buffer.from(img.subarray(y * OW * 3, (y + 1) * OW * 3)).copy(raw, y * (OW * 3 + 1) + 1); }
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
const out = `C:/Users/MarceloChaves/Projects/slide-v2/wasm/dump_render${suffix}.png`;
fs.writeFileSync(out, png);
console.log(`\nrendered ${out}\n  blue=input  yellow dots=input nodes  red=std8/ang0.1  green=std18/ang0.5`);
process.exit(0);
