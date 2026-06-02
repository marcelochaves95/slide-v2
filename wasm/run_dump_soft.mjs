// Test a SOFT corridor: instead of zeroing beyond a hard radius, weight intensity by distance from
// the drawn line (× e^(−d²/2σ²)). This makes a dim-but-close trail beat a bright-but-far road, so
// the slide polishes locally instead of jumping to brighter neighbors. Tune σ on all real dumps.
// Usage: node wasm/run_dump_soft.mjs <dump.json>
import fs from 'node:fs';
const DIR = 'C:/Users/MarceloChaves/Projects/slide-v2/src/wasm';
globalThis.fs = fs;
(0, eval)(fs.readFileSync(DIR + '/wasm_exec.js', 'utf8'));
const go = new globalThis.Go();
const { instance } = await WebAssembly.instantiate(fs.readFileSync(DIR + '/slide.wasm'), go.importObject);
go.run(instance);
await new Promise((r) => setTimeout(r, 50));

const file = process.argv[2];
const dump = JSON.parse(fs.readFileSync(file, 'utf8'));
const { width: W, height: H, west, east, south, north, path: input } = dump;
const raw = new Uint8Array(Buffer.from(dump.gridBase64, 'base64'));
const colOfLon = (lon) => ((lon - west) / (east - west)) * W;
const rowOfLat = (lat) => ((north - lat) / (north - south)) * H;
const M_PER_PX = ((north - south) * 111320) / H;
const inPx = input.map(([lon, lat]) => [colOfLon(lon), rowOfLat(lat)]);

function d2ToInput(px, py) {
  let best = Infinity;
  for (let i = 1; i < inPx.length; i++) {
    const ax = inPx[i - 1][0], ay = inPx[i - 1][1], bx = inPx[i][0], by = inPx[i][1];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0; if (t < 0) t = 0; else if (t > 1) t = 1;
    const ex = px - (ax + t * dx), ey = py - (ay + t * dy); const d2 = ex * ex + ey * ey; if (d2 < best) best = d2;
  }
  return best;
}
function softGrid(sigmaM) {
  const sPx = sigmaM / M_PER_PX, denom = 2 * sPx * sPx;
  const g = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; if (!raw[i]) continue;
    g[i] = Math.round(raw[i] * Math.exp(-d2ToInput(x, y) / denom));
  }
  return g;
}
function hardGrid(radM) {
  const r2 = (radM / M_PER_PX) ** 2; const g = raw.slice();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; if (g[i] && d2ToInput(x, y) > r2) g[i] = 0; }
  return g;
}
function runSlide(grid, std) {
  const res = globalThis.__slideV2Wasm({ width: W, height: H, grid, west, east, south, north, smoothingStdDev: std, path: input });
  return res && res.ok ? res.path : null;
}
function dev(p) { let mx = 0, sm = 0; for (const [lo, la] of p) { const d = Math.sqrt(d2ToInput(colOfLon(lo), rowOfLat(la))) * M_PER_PX; if (d > mx) mx = d; sm += d; } return { max: mx, mean: sm / p.length }; }
function turn(p) { let t = 0, n = 0; for (let i = 1; i < p.length - 1; i++) { const a1 = Math.atan2(rowOfLat(p[i][1]) - rowOfLat(p[i - 1][1]), colOfLon(p[i][0]) - colOfLon(p[i - 1][0])); const a2 = Math.atan2(rowOfLat(p[i + 1][1]) - rowOfLat(p[i][1]), colOfLon(p[i + 1][0]) - colOfLon(p[i][0])); let d = Math.abs(a2 - a1); if (d > Math.PI) d = 2 * Math.PI - d; t += d * 180 / Math.PI; n++; } return n ? t / n : 0; }
function row(label, p) { if (!p) { console.log(label, 'ERR'); return; } const d = dev(p); console.log(`  ${label.padEnd(22)} devMax ${d.max.toFixed(0)}m mean ${d.mean.toFixed(0)}m | turn ${turn(p).toFixed(1)} | pts ${p.length}`); }

console.log(`${file.split(/[\\/]/).pop()}  ${W}x${H}  ${M_PER_PX.toFixed(2)} m/px  corridorMeters(dump)=${dump.corridorMeters}`);
console.log('hard corridor (current): '); row('hard20 std12', runSlide(hardGrid(20), 12));
console.log('soft corridor sigma x smoothing std (devMax small=follows trace/curves; turn small=smooth):');
for (const s of [5, 8]) for (const std of [8, 10, 12]) row(`soft${s} std${std}`, runSlide(softGrid(s), std));
