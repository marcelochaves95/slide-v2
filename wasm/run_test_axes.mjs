// Axis test for slide.wasm. The original run_test.mjs used a VERTICAL ridge + VERTICAL path,
// which only exercises the X/longitude axis and is invariant under a vertical flip. This test
// exercises the Y/latitude axis with a HORIZONTAL ridge so we can catch any north/south
// orientation or frame bug between extractGrid's grid (row 0 = NORTH) and the Go surfacer.
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
const SOUTH = 0, NORTH = 0.01, WEST = 0, EAST = 0.01;

// CONTRACT (same as extractGrid): grid row 0 = NORTH, row H-1 = SOUTH.
// lat for a given grid row, linear across the bound:
const latOfRow = (row) => NORTH - (row / (H - 1)) * (NORTH - SOUTH);

// Build a horizontal Gaussian ridge centered at a given grid row (constant in x).
function ridgeAtRow(centerRow, sigma) {
  const grid = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const d = y - centerRow;
    const v = Math.round(255 * Math.exp(-(d * d) / (2 * sigma * sigma)));
    for (let x = 0; x < W; x++) grid[y * W + x] = v;
  }
  return grid;
}

function run(label, ridgeRow, pathRow) {
  const grid = ridgeAtRow(ridgeRow, 3);
  const lat = latOfRow(pathRow);
  const req = {
    width: W, height: H, grid,
    west: WEST, east: EAST, south: SOUTH, north: NORTH,
    smoothingStdDev: 120,
    path: [
      [0.003, lat], [0.004, lat], [0.005, lat], [0.006, lat], [0.007, lat],
    ],
  };
  const res = globalThis.__slideV2Wasm(req);
  if (!res.ok) { console.log(label, 'ERROR:', res.error); return; }
  const lats = res.path.map((p) => p[1]);
  const meanLat = lats.reduce((a, b) => a + b, 0) / lats.length;
  const ridgeLat = latOfRow(ridgeRow);
  const movedNorth = meanLat > lat;
  const ridgeIsNorth = ridgeLat > lat;
  const correct = movedNorth === ridgeIsNorth;
  console.log(label);
  console.log('  ridge row', ridgeRow, '-> lat', ridgeLat.toFixed(5), ridgeIsNorth ? '(NORTH of path)' : '(SOUTH of path)');
  console.log('  path  lat', lat.toFixed(5), '-> result mean lat', meanLat.toFixed(5),
    movedNorth ? '(moved NORTH)' : '(moved SOUTH)');
  console.log('  =>', correct ? 'CORRECT (moved toward ridge)' : '*** WRONG (moved AWAY from ridge) — Y AXIS BUG ***');
  console.log('  loops', res.loops);
}

console.log('=== Y/latitude axis test (horizontal ridge) ===\n');
run('A) ridge NORTH of path (expect move NORTH):', 30, 55);
console.log('');
run('B) ridge SOUTH of path (expect move SOUTH):', 75, 45);
process.exit(0);
