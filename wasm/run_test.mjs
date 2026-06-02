// Node test for slide.wasm: a synthetic heatmap with a bright vertical ridge at column 60,
// and an input path at column 50. The slide should pull the path east toward the ridge.
import fs from 'node:fs';

const DIR = 'C:/Users/MarceloChaves/Projects/slide-v2/src/wasm';
globalThis.fs = fs;

(0, eval)(fs.readFileSync(DIR + '/wasm_exec.js', 'utf8'));

const go = new globalThis.Go();
const { instance } = await WebAssembly.instantiate(fs.readFileSync(DIR + '/slide.wasm'), go.importObject);
go.run(instance);
await new Promise((r) => setTimeout(r, 50));

if (typeof globalThis.__slideV2Wasm !== 'function') {
  console.log('FUNC NOT REGISTERED; ready =', globalThis.__slideV2WasmReady);
  process.exit(1);
}

const W = 100, H = 100;
const grid = new Uint8Array(W * H);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const d = x - 60; // ridge at column 60
    grid[y * W + x] = Math.round(255 * Math.exp(-(d * d) / (2 * 9)));
  }
}

const req = {
  width: W,
  height: H,
  grid,
  west: 0, east: 0.01, south: 0, north: 0.01,
  smoothingStdDev: 100,
  path: [
    [0.005, 0.001],
    [0.005, 0.003],
    [0.005, 0.005],
    [0.005, 0.007],
    [0.005, 0.009],
  ],
};

const res = globalThis.__slideV2Wasm(req);
console.log('ok =', res.ok, '| loops =', res.loops);
if (res.ok) {
  console.log('input lon = 0.005 (col 50); ridge at col 60 (~lon 0.006)');
  console.log('corrected:', res.path.map((p) => [+p[0].toFixed(5), +p[1].toFixed(5)]));
} else {
  console.log('error:', res.error);
}
process.exit(0);
