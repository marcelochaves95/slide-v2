// Experiment on the REAL dump: the slide gets pulled to nearby BRIGHT roads off the faint trail.
// Test fixes that exploit "the hand trace is good, so only correct locally":
//   (A) corridor mask: zero heatmap farther than D meters from the drawn line
//   (B) intensity clip: cap intensity so roads don't outshine the trail
// Metric: deviation from the INPUT line (bulge = big maxDev) + turn (zigzag) + intensity.
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

const file = [process.argv[2], path.join(os.homedir(), 'Downloads', 'slide-dump.json')].find((p) => p && fs.existsSync(p));
const dump = JSON.parse(fs.readFileSync(file, 'utf8'));
const { width: W, height: H, west, east, south, north, path: input } = dump;
const grid0 = new Uint8Array(Buffer.from(dump.gridBase64, 'base64'));
const colOfLon = (lon) => ((lon - west) / (east - west)) * W;
const rowOfLat = (lat) => ((north - lat) / (north - south)) * H;
const M_PER_PX = ((north - south) * 111320) / H;
const inPx = input.map(([lon, lat]) => [colOfLon(lon), rowOfLat(lat)]);

function distToPolyline(px, py, poly) {
  let best = Infinity;
  for (let i = 1; i < poly.length; i++) {
    const ax = poly[i - 1][0], ay = poly[i - 1][1], bx = poly[i][0], by = poly[i][1];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy)); if (d < best) best = d;
  }
  return best;
}
function corridorMask(corridorM) {
  const cpx = corridorM / M_PER_PX;
  const g = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    g[y * W + x] = distToPolyline(x, y, inPx) <= cpx ? grid0[y * W + x] : 0;
  }
  return g;
}
function runSlide(grid, extra) {
  const res = globalThis.__slideV2Wasm(Object.assign({ width: W, height: H, grid, west, east, south, north, path: input }, extra));
  return res && res.ok ? res.path : null;
}
function devFromInput(p) {
  let max = 0, sum = 0, n = 0;
  for (const [lon, lat] of p) { const d = distToPolyline(colOfLon(lon), rowOfLat(lat), inPx) * M_PER_PX; if (d > max) max = d; sum += d; n++; }
  return { max, mean: sum / n };
}
function avgTurn(p) {
  let turn = 0, tn = 0;
  for (let i = 1; i < p.length - 1; i++) {
    const a1 = Math.atan2(rowOfLat(p[i][1]) - rowOfLat(p[i - 1][1]), colOfLon(p[i][0]) - colOfLon(p[i - 1][0]));
    const a2 = Math.atan2(rowOfLat(p[i + 1][1]) - rowOfLat(p[i][1]), colOfLon(p[i + 1][0]) - colOfLon(p[i][0]));
    let da = Math.abs(a2 - a1); if (da > Math.PI) da = 2 * Math.PI - da; turn += (da * 180) / Math.PI; tn++;
  }
  return tn ? turn / tn : 0;
}
function report(label, p) {
  if (!p) { console.log(label, 'ERR'); return; }
  const d = devFromInput(p);
  console.log(`${label.padEnd(34)} devFromInput max ${d.max.toFixed(0)}m mean ${d.mean.toFixed(0)}m | turn ${avgTurn(p).toFixed(1)} | pts ${p.length}`);
}

console.log(`grid ${W}x${H}, ${M_PER_PX.toFixed(2)} m/px\n`);
console.log('BASELINE (full grid):');
report('  std8 ang0.1', runSlide(grid0, { smoothingStdDev: 8, angleScale: 0.1 }));
report('  std12 ang0.3', runSlide(grid0, { smoothingStdDev: 12, angleScale: 0.3 }));
console.log('\nCORRIDOR MASK (ang0.1 = shipped default angle):');
const outputs = {};
for (const D of [15, 20, 30]) {
  const g = corridorMask(D);
  for (const std of [8, 12]) {
    for (const ang of [0.1, 0.3]) {
      const p = runSlide(g, { smoothingStdDev: std, angleScale: ang });
      report(`  corridor ${D}m, std${std}, ang${ang}`, p);
      outputs[`c${D}s${std}a${ang}`] = p;
    }
  }
}
outputs['c20s12'] = outputs['c20s12a0.3'];

// render: baseline(red) vs corridor20/std12(green) vs input(blue), corridor edges (dim)
const SC = 3, OW = W * SC, OH = H * SC;
const img = new Uint8Array(OW * OH * 3);
const maskShow = corridorMask(20);
for (let y = 0; y < OH; y++) for (let x = 0; x < OW; x++) {
  const gi = Math.floor(y / SC) * W + Math.floor(x / SC); const v = grid0[gi];
  const o = (y * OW + x) * 3;
  if (maskShow[gi] === 0) { img[o] = v * 0.35; img[o + 1] = v * 0.35; img[o + 2] = v * 0.55; } // outside corridor dimmed/blue-ish
  else { img[o] = v; img[o + 1] = v; img[o + 2] = v; }
}
function plot(p, rgb, thick) {
  if (!p) return;
  for (let i = 1; i < p.length; i++) {
    const x0 = colOfLon(p[i - 1][0]) * SC, y0 = rowOfLat(p[i - 1][1]) * SC, x1 = colOfLon(p[i][0]) * SC, y1 = rowOfLat(p[i][1]) * SC;
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0)) + 1;
    for (let s = 0; s <= steps; s++) { const x = Math.round(x0 + ((x1 - x0) * s) / steps), y = Math.round(y0 + ((y1 - y0) * s) / steps);
      for (let dx = -thick; dx <= thick; dx++) for (let dy = -thick; dy <= thick; dy++) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= OW || yy >= OH) continue; const o = (yy * OW + xx) * 3; img[o] = rgb[0]; img[o + 1] = rgb[1]; img[o + 2] = rgb[2]; } }
  }
}
plot(runSlide(grid0, { smoothingStdDev: 8, angleScale: 0.1 }), [255, 40, 40], 1); // baseline red
plot(outputs['c20s12'], [40, 255, 80], 1);                                         // corridor fix green
plot(input, [60, 160, 255], 0);                                                    // input blue
function crc32(buf) { let c, crc = 0xffffffff; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0); const t = Buffer.from(type, 'ascii'); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0); return Buffer.concat([len, t, data, crc]); }
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(OW, 0); ihdr.writeUInt32BE(OH, 4); ihdr[8] = 8; ihdr[9] = 2;
const raw = Buffer.alloc((OW * 3 + 1) * OH);
for (let y = 0; y < OH; y++) { raw[y * (OW * 3 + 1)] = 0; Buffer.from(img.subarray(y * OW * 3, (y + 1) * OW * 3)).copy(raw, y * (OW * 3 + 1) + 1); }
fs.writeFileSync('C:/Users/MarceloChaves/Projects/slide-v2/wasm/dump_fix.png', Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
console.log('\nrendered wasm/dump_fix.png  (dim/blue=outside corridor)  red=baseline std8  green=corridor20 std12  blue=input');
process.exit(0);
