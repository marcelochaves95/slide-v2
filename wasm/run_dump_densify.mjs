// "Falta detalhes": the per-node snap keeps the node count, so a curvy band between sparse nodes
// gets cut by straight segments. Fix = densify along the trail, snap EACH point onto the band
// (conservative, same as before), smooth offsets, then Douglas-Peucker simplify so we only keep
// extra nodes where the band actually curves. Renders input(yellow) vs detailed result(red)+nodes.
import fs from 'node:fs';
import zlib from 'node:zlib';
const file = process.argv[2], suffix = process.argv[3] || '';
const dump = JSON.parse(fs.readFileSync(file, 'utf8'));
const { width: W, height: H, west, east, south, north, path: input } = dump;
const grid = new Uint8Array(Buffer.from(dump.gridBase64, 'base64'));
const colOfLon = (lon) => ((lon - west) / (east - west)) * W;
const rowOfLat = (lat) => ((north - lat) / (north - south)) * H;
const M_PER_PX = ((north - south) * 111320) / H;
const inPx = input.map(([lon, lat]) => [colOfLon(lon), rowOfLat(lat)]);
function sample(cx, cy) {
  if (cx < 0 || cy < 0 || cx > W - 1 || cy > H - 1) return 0;
  const x0 = Math.floor(cx), y0 = Math.floor(cy), x1 = Math.min(x0 + 1, W - 1), y1 = Math.min(y0 + 1, H - 1), fx = cx - x0, fy = cy - y0;
  return grid[y0 * W + x0] * (1 - fx) * (1 - fy) + grid[y0 * W + x1] * fx * (1 - fy) + grid[y1 * W + x0] * (1 - fx) * fy + grid[y1 * W + x1] * fx * fy;
}
function resample(pts, stepPx) {
  const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = cum[cum.length - 1], n = Math.max(2, Math.round(total / stepPx)), out = [];
  let seg = 1;
  for (let k = 0; k <= n; k++) {
    const target = (k / n) * total;
    while (seg < pts.length - 1 && cum[seg] < target) seg++;
    const t = (target - cum[seg - 1]) / ((cum[seg] - cum[seg - 1]) || 1);
    out.push([pts[seg - 1][0] + t * (pts[seg][0] - pts[seg - 1][0]), pts[seg - 1][1] + t * (pts[seg][1] - pts[seg - 1][1])]);
  }
  return out;
}
function snapDense(pts, sigmaM, searchM, passes) {
  const denom = 2 * (sigmaM / M_PER_PX) ** 2, R = searchM / M_PER_PX, N = pts.length;
  const offs = new Float64Array(N), perp = new Array(N).fill(null);
  for (let i = 1; i < N - 1; i++) {
    let tx = pts[i + 1][0] - pts[i - 1][0], ty = pts[i + 1][1] - pts[i - 1][1]; const L = Math.hypot(tx, ty) || 1; tx /= L; ty /= L;
    const nx = -ty, ny = tx; perp[i] = [nx, ny];
    let best = 0, off = 0;
    for (let s = -R; s <= R; s += 0.25) { const v = sample(pts[i][0] + nx * s, pts[i][1] + ny * s); const sc = v * Math.exp(-(s * s) / denom); if (sc > best) { best = sc; off = s; } }
    offs[i] = off;
  }
  for (let p = 0; p < passes; p++) { const q = offs.slice(); for (let i = 1; i < N - 1; i++) q[i] = (offs[i - 1] + 2 * offs[i] + offs[i + 1]) / 4; for (let i = 1; i < N - 1; i++) offs[i] = q[i]; }
  const out = pts.map((p) => p.slice());
  for (let i = 1; i < N - 1; i++) out[i] = [pts[i][0] + perp[i][0] * offs[i], pts[i][1] + perp[i][1] * offs[i]];
  return out;
}
function dp(pts, tol) {
  if (pts.length < 3) return pts.slice();
  const keep = new Array(pts.length).fill(false); keep[0] = keep[pts.length - 1] = true; const st = [[0, pts.length - 1]];
  while (st.length) { const [s, e] = st.pop(); const ax = pts[s][0], ay = pts[s][1], bx = pts[e][0], by = pts[e][1], dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy; let md = -1, idx = -1;
    for (let i = s + 1; i < e; i++) { let t = l2 ? ((pts[i][0] - ax) * dx + (pts[i][1] - ay) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t)); const d = Math.hypot(pts[i][0] - (ax + t * dx), pts[i][1] - (ay + t * dy)); if (d > md) { md = d; idx = i; } }
    if (md > tol && idx > 0) { keep[idx] = true; st.push([s, idx], [idx, e]); } }
  return pts.filter((_, i) => keep[i]);
}

const stepPx = 6 / M_PER_PX;
const dense = resample(inPx, stepPx);
const snappedDense = snapDense(dense, 5, 10, 4);
const result = dp(snappedDense, 2.5 / M_PER_PX);
console.log(`${file.split(/[\\/]/).pop()} ${W}x${H} ${M_PER_PX.toFixed(2)} m/px | input ${inPx.length} nodes -> densified ${dense.length} -> simplified ${result.length} nodes`);

let gmax = 0; for (const v of grid) if (v > gmax) gmax = v;
const SC = 5, OW = W * SC, OH = H * SC, img = new Uint8Array(OW * OH * 3);
for (let y = 0; y < OH; y++) for (let x = 0; x < OW; x++) { const v = grid[Math.floor(y / SC) * W + Math.floor(x / SC)]; const t = (v / Math.max(1, gmax)) * 3, o = (y * OW + x) * 3; img[o] = Math.max(0, Math.min(255, t * 255)); img[o + 1] = Math.max(0, Math.min(255, (t - 1) * 255)); img[o + 2] = Math.max(0, Math.min(255, (t - 2) * 255)); }
function plot(px, rgb, th) { for (let i = 1; i < px.length; i++) { const x0 = px[i - 1][0] * SC, y0 = px[i - 1][1] * SC, x1 = px[i][0] * SC, y1 = px[i][1] * SC, steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0)) + 1; for (let s = 0; s <= steps; s++) { const x = Math.round(x0 + (x1 - x0) * s / steps), y = Math.round(y0 + (y1 - y0) * s / steps); for (let dx = -th; dx <= th; dx++) for (let dy = -th; dy <= th; dy++) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= OW || yy >= OH) continue; const o = (yy * OW + xx) * 3; img[o] = rgb[0]; img[o + 1] = rgb[1]; img[o + 2] = rgb[2]; } } } }
function dot(cx, cy, rgb, r) { for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) { const xx = Math.round(cx * SC) + dx, yy = Math.round(cy * SC) + dy; if (xx < 0 || yy < 0 || xx >= OW || yy >= OH) continue; const o = (yy * OW + xx) * 3; img[o] = rgb[0]; img[o + 1] = rgb[1]; img[o + 2] = rgb[2]; } }
plot(result, [255, 40, 40], 1);
for (const p of inPx) dot(p[0], p[1], [255, 255, 0], 3);          // input nodes yellow
for (const p of result) dot(p[0], p[1], [40, 200, 255], 2);       // result nodes cyan
function crc32(b) { let c, r = 0xffffffff; for (let n = 0; n < b.length; n++) { c = (r ^ b[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; r = (r >>> 8) ^ c; } return (r ^ 0xffffffff) >>> 0; }
function chunk(t, d) { const l = Buffer.alloc(4); l.writeUInt32BE(d.length, 0); const ty = Buffer.from(t, 'ascii'); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(Buffer.concat([ty, d])), 0); return Buffer.concat([l, ty, d, c]); }
const ih = Buffer.alloc(13); ih.writeUInt32BE(OW, 0); ih.writeUInt32BE(OH, 4); ih[8] = 8; ih[9] = 2;
const raw = Buffer.alloc((OW * 3 + 1) * OH); for (let y = 0; y < OH; y++) { raw[y * (OW * 3 + 1)] = 0; Buffer.from(img.subarray(y * OW * 3, (y + 1) * OW * 3)).copy(raw, y * (OW * 3 + 1) + 1); }
fs.writeFileSync(`C:/Users/MarceloChaves/Projects/slide-v2/wasm/dump_densify${suffix}.png`, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
console.log(`rendered wasm/dump_densify${suffix}.png (yellow=your nodes, cyan=new nodes, red=line)`);
