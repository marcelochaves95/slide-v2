// Smoke-test helper: writes a slide-dump.json in the dump format (bumpy curved band + offset input)
// so we can validate replay_dump.mjs before asking for a real browser dump. Not used at runtime.
import fs from 'node:fs';
const W = 360, H = 240, M_PER_PX = 2.3, MPP_DEG = M_PER_PX / 111320;
const west = 0, south = 0, east = W * MPP_DEG, north = H * MPP_DEG;
const A = 22, LAMBDA = 220, R0 = 120;
const centerRow = (c) => R0 + A * Math.sin((2 * Math.PI * c) / LAMBDA);
let s = 7; const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
const gauss = () => { let u = 0; while (u === 0) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); };
const N = 70, sub = 1.6, offs = Array.from({ length: N }, () => gauss() * 7.5);
const f = new Float64Array(W * H); let peak = 0;
for (let x = 0; x < W; x++) { const c = centerRow(x); for (let y = 0; y < H; y++) { let v = 0; for (let k = 0; k < N; k++) { const d = y - (c + offs[k]); v += Math.exp(-(d * d) / (2 * sub * sub)); } f[y * W + x] = v; if (v > peak) peak = v; } }
const grid = new Uint8Array(W * H);
for (let i = 0; i < f.length; i++) grid[i] = Math.max(0, Math.min(255, Math.round((f[i] / peak) * 173 + (rnd() - 0.5) * 36)));
const lonOfCol = (c) => west + c * MPP_DEG, latOfRow = (r) => north - r * MPP_DEG;
const path = [];
for (let col = 14; col <= W - 14; col += 15) path.push([lonOfCol(col), latOfRow(centerRow(col) + 8 + (rnd() - 0.5) * 6)]);
let bin = ''; for (let i = 0; i < grid.length; i += 0x8000) bin += String.fromCharCode.apply(null, grid.subarray(i, i + 0x8000));
const dump = { width: W, height: H, west, east, south, north, smoothingStdDev: 8, path, gridBase64: Buffer.from(bin, 'binary').toString('base64') };
fs.writeFileSync('C:/Users/MarceloChaves/Projects/slide-v2/slide-dump.json', JSON.stringify(dump));
console.log('wrote slide-dump.json', W + 'x' + H, path.length, 'pts');
