// Prototype the behavior Marcelo asked for: KEEP his nodes, just move each one perpendicular onto
// the local heatmap band center (distance-weighted so it stays near where he drew). No resample,
// no new line, no node churn -> the result passes through his (corrected) points. Tested on real
// dumps; renders heat grid + input(yellow) + snapped(red) so we can see "red on yellow, on band".
import fs from 'node:fs';
import zlib from 'node:zlib';
const file = process.argv[2];
const suffix = process.argv[3] || '';
const dump = JSON.parse(fs.readFileSync(file, 'utf8'));
const { width: W, height: H, west, east, south, north, path: input } = dump;
const grid = new Uint8Array(Buffer.from(dump.gridBase64, 'base64'));
const colOfLon = (lon) => ((lon - west) / (east - west)) * W;
const rowOfLat = (lat) => ((north - lat) / (north - south)) * H;
const lonOfCol = (c) => west + (c / W) * (east - west);
const latOfRow = (r) => north - (r / H) * (north - south);
const M_PER_PX = ((north - south) * 111320) / H;

function sample(cx, cy) {
  if (cx < 0 || cy < 0 || cx > W - 1 || cy > H - 1) return 0;
  const x0 = Math.floor(cx), y0 = Math.floor(cy), x1 = Math.min(x0 + 1, W - 1), y1 = Math.min(y0 + 1, H - 1);
  const fx = cx - x0, fy = cy - y0;
  return grid[y0 * W + x0] * (1 - fx) * (1 - fy) + grid[y0 * W + x1] * fx * (1 - fy) + grid[y1 * W + x0] * (1 - fx) * fy + grid[y1 * W + x1] * fx * fy;
}
const inPx = input.map(([lon, lat]) => [colOfLon(lon), rowOfLat(lat)]);

// Per-node perpendicular snap: each node moves to the best band point near it (argmax of
// intensity * gaussian(distance)); then the perpendicular OFFSETS are smoothed ALONG the trail so
// independent peak-jumping doesn't cause zigzag — while along-track shape (curves) is preserved.
function snap(sigmaM, searchM, passes) {
  const sigmaPx = sigmaM / M_PER_PX, denom = 2 * sigmaPx * sigmaPx;
  const R = searchM / M_PER_PX;
  const N = inPx.length;
  const offs = new Array(N).fill(0);
  const perp = new Array(N).fill(null);
  for (let i = 1; i < N - 1; i++) {
    let tx = inPx[i + 1][0] - inPx[i - 1][0], ty = inPx[i + 1][1] - inPx[i - 1][1];
    const L = Math.hypot(tx, ty) || 1; tx /= L; ty /= L;
    const nx = -ty, ny = tx; perp[i] = [nx, ny];
    // PERPENDICULAR HILL-CLIMB to the local band ridge: step toward higher intensity until the
    // crest (hot center) — reaches a far center but won't cross a valley to a separate band.
    const px0 = inPx[i][0], py0 = inPx[i][1];
    const ss = (s) => sample(px0 + nx * s, py0 + ny * s);
    let off = 0, cur = ss(0), step = 1.0;
    for (let k = 0; k < Math.ceil(R / step) * 2; k++) {
      const vP = ss(off + step), vM = ss(off - step);
      if (vP > cur + 1 && vP >= vM) { off += step; cur = vP; }
      else if (vM > cur + 1) { off -= step; cur = vM; }
      else break;
      if (Math.abs(off) >= R) break;
    }
    // center on the contiguous near-peak PLATEAU around the landing point, so a wide flat-top band
    // lands on the MIDDLE, not the near edge where the climb first stopped.
    const thr = cur - Math.max(3, 0.08 * cur);
    let l = off, r = off;
    while (l - step >= -R && ss(l - step) >= thr) l -= step;
    while (r + step <= R && ss(r + step) >= thr) r += step;
    offs[i] = (l + r) / 2;
  }
  for (let p = 0; p < (passes || 0); p++) { // smooth offsets along the trail (endpoints stay 0)
    const q = offs.slice();
    for (let i = 1; i < N - 1; i++) q[i] = (offs[i - 1] + 2 * offs[i] + offs[i + 1]) / 4;
    for (let i = 1; i < N - 1; i++) offs[i] = q[i];
  }
  const out = inPx.map((p) => p.slice());
  for (let i = 1; i < N - 1; i++) out[i] = [inPx[i][0] + perp[i][0] * offs[i], inPx[i][1] + perp[i][1] * offs[i]];
  return out;
}
// Optional light smoothing of perpendicular jitter: move each node a little toward neighbor midpoint.
function relax(px, k, passes) {
  let p = px.map((q) => q.slice());
  for (let it = 0; it < passes; it++) {
    const q = p.map((v) => v.slice());
    for (let i = 1; i < p.length - 1; i++) {
      const mx = (p[i - 1][0] + p[i + 1][0]) / 2, my = (p[i - 1][1] + p[i + 1][1]) / 2;
      q[i] = [p[i][0] + k * (mx - p[i][0]), p[i][1] + k * (my - p[i][1])];
    }
    p = q;
  }
  return p;
}

function devFromInput(px) { let mx = 0, sm = 0; for (let i = 0; i < px.length; i++) { const d = Math.hypot(px[i][0] - inPx[i][0], px[i][1] - inPx[i][1]) * M_PER_PX; if (d > mx) mx = d; sm += d; } return { max: mx, mean: sm / px.length }; }
function intens(px) { let s = 0, n = 0; for (let i = 1; i < px.length; i++) { const steps = Math.ceil(Math.hypot(px[i][0] - px[i - 1][0], px[i][1] - px[i - 1][1])); for (let t = 0; t <= steps; t++) { s += sample(px[i - 1][0] + (px[i][0] - px[i - 1][0]) * t / steps, px[i - 1][1] + (px[i][1] - px[i - 1][1]) * t / steps); n++; } } return s / n; }
function turnDeg(px) { let t = 0, n = 0; for (let i = 1; i < px.length - 1; i++) { const a1 = Math.atan2(px[i][1] - px[i - 1][1], px[i][0] - px[i - 1][0]); const a2 = Math.atan2(px[i + 1][1] - px[i][1], px[i + 1][0] - px[i][0]); let d = Math.abs(a2 - a1); if (d > Math.PI) d = 2 * Math.PI - d; t += d * 180 / Math.PI; n++; } return n ? t / n : 0; }

console.log(`${file.split(/[\\/]/).pop()}  ${W}x${H}  ${M_PER_PX.toFixed(2)} m/px  nodes=${input.length}`);
console.log(`INPUT: intensity ${intens(inPx).toFixed(0)}, turn ${turnDeg(inPx).toFixed(1)}`);
for (const [sig, sr, pa] of [[0, 10, 2], [0, 15, 2], [0, 20, 2], [0, 25, 2], [0, 20, 3]]) {
  const s = snap(sig, sr, pa); const d = devFromInput(s);
  console.log(`FWHM-center window${sr} smooth${pa}: dev max ${d.max.toFixed(0)}m mean ${d.mean.toFixed(0)}m | intensity ${intens(s).toFixed(0)} | turn ${turnDeg(s).toFixed(1)}`);
}
const snapped = snap(0, 20, 2);

// render heat grid + input(yellow) + snapped(red)
let gmax = 0; for (const v of grid) if (v > gmax) gmax = v;
const SC = 3, OW = W * SC, OH = H * SC, img = new Uint8Array(OW * OH * 3);
for (let y = 0; y < OH; y++) for (let x = 0; x < OW; x++) { const v = grid[Math.floor(y / SC) * W + Math.floor(x / SC)]; const t = (v / Math.max(1, gmax)) * 3, o = (y * OW + x) * 3; img[o] = Math.max(0, Math.min(255, t * 255)); img[o + 1] = Math.max(0, Math.min(255, (t - 1) * 255)); img[o + 2] = Math.max(0, Math.min(255, (t - 2) * 255)); }
function plot(px, rgb, th) { for (let i = 1; i < px.length; i++) { const x0 = px[i - 1][0] * SC, y0 = px[i - 1][1] * SC, x1 = px[i][0] * SC, y1 = px[i][1] * SC, steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0)) + 1; for (let s = 0; s <= steps; s++) { const x = Math.round(x0 + (x1 - x0) * s / steps), y = Math.round(y0 + (y1 - y0) * s / steps); for (let dx = -th; dx <= th; dx++) for (let dy = -th; dy <= th; dy++) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= OW || yy >= OH) continue; const o = (yy * OW + xx) * 3; img[o] = rgb[0]; img[o + 1] = rgb[1]; img[o + 2] = rgb[2]; } } } }
function dot(cx, cy, rgb) { for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) { const xx = Math.round(cx * SC) + dx, yy = Math.round(cy * SC) + dy; if (xx < 0 || yy < 0 || xx >= OW || yy >= OH) continue; const o = (yy * OW + xx) * 3; img[o] = rgb[0]; img[o + 1] = rgb[1]; img[o + 2] = rgb[2]; } }
plot(snapped, [255, 40, 40], 1);
for (const p of inPx) dot(p[0], p[1], [255, 255, 0]);
function crc32(b) { let c, r = 0xffffffff; for (let n = 0; n < b.length; n++) { c = (r ^ b[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; r = (r >>> 8) ^ c; } return (r ^ 0xffffffff) >>> 0; }
function chunk(t, d) { const l = Buffer.alloc(4); l.writeUInt32BE(d.length, 0); const ty = Buffer.from(t, 'ascii'); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(Buffer.concat([ty, d])), 0); return Buffer.concat([l, ty, d, c]); }
const ih = Buffer.alloc(13); ih.writeUInt32BE(OW, 0); ih.writeUInt32BE(OH, 4); ih[8] = 8; ih[9] = 2;
const raw = Buffer.alloc((OW * 3 + 1) * OH); for (let y = 0; y < OH; y++) { raw[y * (OW * 3 + 1)] = 0; Buffer.from(img.subarray(y * OW * 3, (y + 1) * OW * 3)).copy(raw, y * (OW * 3 + 1) + 1); }
fs.writeFileSync(`C:/Users/MarceloChaves/Projects/slide-v2/wasm/dump_snap${suffix}.png`, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
console.log(`rendered wasm/dump_snap${suffix}.png  (yellow=your nodes, red=snapped through them)`);
