// Cross-section analysis of a dump: at each input vertex, sample the heatmap perpendicular to the
// trace and find where the brightness peaks. If the peak is consistently to ONE side, the trace
// runs BESIDE a brighter feature (road) and the slide gets pulled onto it. If peaks are ~centered,
// the trace is on the band and any failure is wiggle, not a jump.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const file = [process.argv[2], path.join(os.homedir(), 'Downloads', 'slide-dump.json')].find((p) => p && fs.existsSync(p));
const dump = JSON.parse(fs.readFileSync(file, 'utf8'));
const { width: W, height: H, west, east, south, north, path: input } = dump;
const grid = new Uint8Array(Buffer.from(dump.gridBase64, 'base64'));
const colOfLon = (lon) => ((lon - west) / (east - west)) * W;
const rowOfLat = (lat) => ((north - lat) / (north - south)) * H;
const M_PER_PX = ((north - south) * 111320) / H;
console.log(`${file.split(/[\\/]/).pop()}: ${W}x${H}, ${input.length} pts, ${M_PER_PX.toFixed(2)} m/px, corridorMeters=${dump.corridorMeters}`);

function sample(cx, cy) {
  if (cx < 0 || cy < 0 || cx > W - 1 || cy > H - 1) return 0;
  const x0 = Math.floor(cx), y0 = Math.floor(cy), x1 = Math.min(x0 + 1, W - 1), y1 = Math.min(y0 + 1, H - 1);
  const fx = cx - x0, fy = cy - y0;
  return grid[y0 * W + x0] * (1 - fx) * (1 - fy) + grid[y0 * W + x1] * fx * (1 - fy) + grid[y1 * W + x0] * (1 - fx) * fy + grid[y1 * W + x1] * fx * fy;
}
const px = input.map(([lon, lat]) => [colOfLon(lon), rowOfLat(lat)]);
const maxOff = 26 / M_PER_PX; // scan +/-26 m perpendicular (signed: + = left of travel dir)
const peaks = [], centroids = [], traceVals = [];
for (let i = 1; i < px.length - 1; i++) {
  const ax = px[i - 1], bx = px[i + 1];
  let dx = bx[0] - ax[0], dy = bx[1] - ax[1]; const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
  const nx = -dy, ny = dx; // left normal
  let best = -1, bestOff = 0, sw = 0, swo = 0;
  for (let s = -maxOff; s <= maxOff; s += 0.5) {
    const v = sample(px[i][0] + nx * s, px[i][1] + ny * s);
    if (v > best) { best = v; bestOff = s; }
    sw += v; swo += v * s;
  }
  peaks.push(bestOff * M_PER_PX);
  centroids.push((sw > 0 ? swo / sw : 0) * M_PER_PX);
  traceVals.push(sample(px[i][0], px[i][1]));
}
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const frac = (a, f) => a.filter(f).length / a.length;
console.log(`\nperpendicular peak offset from trace (+ = left, - = right of travel):`);
console.log(`  median ${med(peaks).toFixed(1)}m, mean ${mean(peaks).toFixed(1)}m`);
console.log(`  |offset|>8m: ${(frac(peaks, (v) => Math.abs(v) > 8) * 100).toFixed(0)}% of vertices`);
console.log(`  same-side consistency: left ${(frac(peaks, (v) => v > 2) * 100).toFixed(0)}%, right ${(frac(peaks, (v) => v < -2) * 100).toFixed(0)}%, center ${(frac(peaks, (v) => Math.abs(v) <= 2) * 100).toFixed(0)}%`);
console.log(`centroid offset: median ${med(centroids).toFixed(1)}m  | trace intensity: median ${med(traceVals).toFixed(0)}`);
console.log(`\nread: large one-sided peak offset => trace runs BESIDE a brighter feature (slide jumps to it).`);
console.log(`      peaks scattered/centered => trace is on the band; failure is wiggle, not a jump.`);
