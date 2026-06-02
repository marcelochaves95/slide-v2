// Runs in the page MAIN world. Port of the paulmach/slide algorithm to JS, working in
// heatmap pixel coordinates. Input/output paths are arrays of [px, py].
(function () {
  const NS = (window.__slideV2 = window.__slideV2 || {});
  if (NS.coreInstalled) return;
  NS.coreInstalled = true;

  // Options for the Go WASM slide. Smoothing is AUTO-derived from the heatmap band width by
  // default — no manual tuning. Only set fields here to override for debugging.
  NS.WASM_OPTIONS = NS.WASM_OPTIONS || {};

  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

  function pathLength(p) {
    let s = 0;
    for (let i = 1; i < p.length; i++) s += dist(p[i], p[i - 1]);
    return s;
  }

  function avgValue(surfacer, p) {
    let s = 0;
    for (const q of p) s += surfacer.valueAt(q[0], q[1]);
    return s / p.length;
  }

  // Evenly spaced n points along the polyline (by arc length), keeping both endpoints.
  function resample(path, n) {
    if (path.length < 2 || n < 2) return path.map((p) => p.slice());
    const cum = [0];
    for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + dist(path[i], path[i - 1]));
    const total = cum[cum.length - 1];
    if (total === 0) return path.map((p) => p.slice());
    const step = total / (n - 1);
    const out = [path[0].slice()];
    let seg = 1;
    for (let k = 1; k < n - 1; k++) {
      const target = k * step;
      while (seg < path.length - 1 && cum[seg] < target) seg++;
      const segLen = cum[seg] - cum[seg - 1] || 1;
      const t = (target - cum[seg - 1]) / segLen;
      out.push([
        path[seg - 1][0] + t * (path[seg][0] - path[seg - 1][0]),
        path[seg - 1][1] + t * (path[seg][1] - path[seg - 1][1]),
      ]);
    }
    out.push(path[path.length - 1].slice());
    return out;
  }

  // Iterative refinement (Jacobi update; endpoints fixed). Contributions ported from refine.go.
  function refine(surfacer, pts, o) {
    const n = pts.length;
    let curX = new Float64Array(n);
    let curY = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      curX[i] = pts[i][0];
      curY[i] = pts[i][1];
    }
    const origX = new Float64Array(curX); // for the max-displacement clamp
    const origY = new Float64Array(curY);
    let nextX = new Float64Array(n);
    let nextY = new Float64Array(n);
    const corrX = new Float64Array(n);
    const corrY = new Float64Array(n);

    let currentScore = 0;
    let prevScore = 0;
    let delta = 0;
    let loop = 0;

    for (loop = 0; loop < o.maxLoops; loop++) {
      nextX.set(curX);
      nextY.set(curY);

      for (let j = 1; j < n - 1; j++) {
        // gradient term
        let gx = 0, gy = 0;
        if (o.gradientScale !== 0) {
          const g = surfacer.gradientAt(curX[j], curY[j]);
          gx = g[0] * o.gradientScale;
          gy = g[1] * o.gradientScale;
        }
        // distance term (keeps points equidistant)
        let dx = 0, dy = 0;
        if (o.distanceScale !== 0) {
          const vx = curX[j] - curX[j - 1];
          const vy = curY[j] - curY[j - 1];
          const ux = curX[j + 1] - curX[j - 1];
          const uy = curY[j + 1] - curY[j - 1];
          const ud = ux * ux + uy * uy;
          if (ud !== 0) {
            const t = (ux * vx + uy * vy) / ud;
            const cxp = curX[j - 1] + ux * t;
            const cyp = curY[j - 1] + uy * t;
            const m1x = curX[j - 1] - cxp;
            const m1y = curY[j - 1] - cyp;
            const m2x = curX[j + 1] - cxp;
            const m2y = curY[j + 1] - cyp;
            dx = (m1x + m2x) * o.distanceScale;
            dy = (m1y + m2y) * o.distanceScale;
          }
        }
        // angle term (smooths sharp corners)
        let ax = 0, ay = 0;
        if (o.angleScale !== 0) {
          let n1x = curX[j - 1] - curX[j];
          let n1y = curY[j - 1] - curY[j];
          let n2x = curX[j + 1] - curX[j];
          let n2y = curY[j + 1] - curY[j];
          const l1 = Math.hypot(n1x, n1y);
          const l2 = Math.hypot(n2x, n2y);
          if (l1 > 0 && l2 > 0) {
            n1x /= l1; n1y /= l1; n2x /= l2; n2y /= l2;
            const factor = Math.cbrt(n1x * n2x + n1y * n2y) + 1;
            let sx = n1x + n2x;
            let sy = n1y + n2y;
            const sl = Math.hypot(sx, sy);
            if (sl > 0) {
              const mag = (Math.min(l1, l2) * o.angleScale * factor) / sl;
              ax = sx * mag;
              ay = sy * mag;
            }
          }
        }

        let nx = curX[j] + gx + dx + ax + corrX[j] * o.momentumScale;
        let ny = curY[j] + gy + dy + ay + corrY[j] * o.momentumScale;
        // clamp how far a point may drift from its original spot (anti loop-collapse / line-jump)
        if (o.maxShiftPx > 0) {
          const sx = nx - origX[j];
          const sy = ny - origY[j];
          const sd = Math.hypot(sx, sy);
          if (sd > o.maxShiftPx) {
            nx = origX[j] + (sx / sd) * o.maxShiftPx;
            ny = origY[j] + (sy / sd) * o.maxShiftPx;
          }
        }
        corrX[j] = nx - curX[j];
        corrY[j] = ny - curY[j];
        nextX[j] = nx;
        nextY[j] = ny;
      }

      let tmp = curX; curX = nextX; nextX = tmp;
      tmp = curY; curY = nextY; nextY = tmp;

      let sum = 0;
      for (let i = 0; i < n; i++) sum += surfacer.valueAt(curX[i], curY[i]);
      const pathScore = sum / n;
      prevScore = currentScore;
      currentScore = o.scoreSmoothing * prevScore + (1 - o.scoreSmoothing) * pathScore;
      delta = Math.abs(currentScore - prevScore);

      if (loop >= o.minLoops && delta < o.thresholdEpsilon) break;
    }

    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = [curX[i], curY[i]];
    return { path: out, loops: loop, delta };
  }

  function douglasPeucker(points, tol) {
    if (points.length < 3) return points.map((p) => p.slice());
    const keep = new Array(points.length).fill(false);
    keep[0] = keep[points.length - 1] = true;
    const stack = [[0, points.length - 1]];
    while (stack.length) {
      const [s, e] = stack.pop();
      let maxD = -1;
      let idx = -1;
      const ax = points[s][0], ay = points[s][1];
      const bx = points[e][0], by = points[e][1];
      const dx = bx - ax, dy = by - ay;
      const l2 = dx * dx + dy * dy;
      for (let i = s + 1; i < e; i++) {
        const px = points[i][0], py = points[i][1];
        let d;
        if (l2 === 0) {
          d = Math.hypot(px - ax, py - ay);
        } else {
          const t = ((px - ax) * dx + (py - ay) * dy) / l2;
          d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
        }
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (maxD > tol && idx > 0) {
        keep[idx] = true;
        stack.push([s, idx], [idx, e]);
      }
    }
    return points.filter((_, i) => keep[i]);
  }

  // Trim points bunched near the (fixed) endpoints, then simplify with Douglas-Peucker.
  function simplify(path, trimRadiusPx, tolPx) {
    const p = path.map((q) => q.slice());
    while (p.length > 2 && dist(p[0], p[1]) < trimRadiusPx) p.splice(1, 1);
    while (p.length > 2 && dist(p[p.length - 1], p[p.length - 2]) < trimRadiusPx) p.splice(p.length - 2, 1);
    return douglasPeucker(p, tolPx);
  }

  // Main entry. surfacer from NS.makeSurfacer; path is [[px,py],...]. Returns corrected pixels.
  NS.slide = function (surfacer, path, userOpts) {
    const o = Object.assign({}, NS.SLIDE_OPTIONS, userOpts);
    const mpp = surfacer.mpp;
    o.maxShiftPx = o.maxShiftMeters ? o.maxShiftMeters / mpp : 0;
    const resamplePx = o.resampleMeters / mpp;
    const n = Math.max(3, Math.ceil(pathLength(path) / resamplePx) + 3);
    const resampled = resample(path, n);
    const r = refine(surfacer, resampled, o);
    const out = simplify(r.path, o.trimRadiusMeters / mpp, o.simplifyTolMeters / mpp);
    return { path: out, refined: r.path, resampled, loops: r.loops, delta: r.delta };
  };

  // Builds an iD action that replaces the way's geometry with the corrected points.
  // Creates fresh nodes for the corrected points, keeps the endpoints, re-inserts "interesting"
  // nodes (junctions / tagged / in relations) onto the nearest spot of the new line so connected
  // features aren't dragged, then deletes the old interior nodes it no longer uses (when safe).
  function buildSlideAction(context, wayId, points) {
    const iD = window.iD;
    const projection = context.projection;

    function interesting(graph, node) {
      return (
        graph.parentWays(node).length > 1 ||
        graph.parentRelations(node).length > 0 ||
        node.hasInterestingTags()
      );
    }

    return function (graph) {
      const way = graph.entity(wayId);
      const oldIds = way.nodes.slice();
      if (oldIds.length < 2 || points.length < 2) return graph;
      const firstId = oldIds[0];
      const lastId = oldIds[oldIds.length - 1];

      // interior nodes that must be preserved (junctions / tagged / in relations)
      const keep = [];
      for (let i = 1; i < oldIds.length - 1; i++) {
        const node = graph.entity(oldIds[i]);
        if (interesting(graph, node)) keep.push(node);
      }

      // fresh nodes for the corrected interior points; endpoints stay
      let newNodes = [graph.entity(firstId)];
      for (let j = 1; j < points.length - 1; j++) {
        const nn = iD.osmNode({ loc: points[j] });
        graph = graph.replace(nn);
        newNodes.push(nn);
      }
      newNodes.push(graph.entity(lastId));

      // re-insert preserved nodes onto the nearest point of the new line
      for (const node of keep) {
        const choice = iD.geoChooseEdge(newNodes, projection(node.loc), projection);
        if (!choice) continue;
        const moved = node.move(choice.loc);
        graph = graph.replace(moved);
        newNodes.splice(choice.index, 0, moved);
      }

      const nodeIds = newNodes.map((n) => n.id);
      const usedIds = new Set(nodeIds);
      graph = graph.replace(way.update({ nodes: nodeIds }));

      // delete old interior nodes we no longer use (only if not shared/tagged/in relations)
      for (let i = 1; i < oldIds.length - 1; i++) {
        const id = oldIds[i];
        if (usedIds.has(id)) continue;
        const node = graph.hasEntity(id);
        if (node && !interesting(graph, node)) {
          graph = iD.actionDeleteNode(id)(graph);
        }
      }

      return graph;
    };
  }

  // Full pipeline: read the way, slide it to the heatmap, and apply the result to iD (undoable).
  // Extract a heatmap intensity grid (Uint8Array, row 0 = north, col 0 = west) for the path
  // bbox + margin, plus its lon/lat bounds, to feed the Go WASM surfacer.
  // Squared distance from a point to a polyline (pixels).
  function distToPolyline2(px, py, poly) {
    let best = Infinity;
    for (let i = 1; i < poly.length; i++) {
      const ax = poly[i - 1][0], ay = poly[i - 1][1];
      const bx = poly[i][0], by = poly[i][1];
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      const ex = px - (ax + t * dx), ey = py - (ay + t * dy);
      const d2 = ex * ex + ey * ey;
      if (d2 < best) best = d2;
    }
    return best;
  }

  function extractGrid(surf, pxPath, marginPx, corridorPx) {
    const fullW = surf.width;
    const fullH = surf.height;
    const data = surf.data;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [px, py] of pxPath) {
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
    const ox = Math.max(0, Math.floor(minX) - marginPx);
    const oy = Math.max(0, Math.floor(minY) - marginPx);
    const ex = Math.min(fullW, Math.ceil(maxX) + marginPx);
    const ey = Math.min(fullH, Math.ceil(maxY) + marginPx);
    const W = ex - ox;
    const H = ey - oy;
    const grid = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      const srcRow = (y + oy) * fullW;
      for (let x = 0; x < W; x++) {
        const p = (srcRow + x + ox) * 4;
        grid[y * W + x] = data[p + 3] > 0 ? data[p] : 0; // luma (R) masked by alpha
      }
    }
    // Corridor mask: zero everything farther than corridorPx from the drawn line. The hand trace
    // is reliable, so the slide should only correct LOCALLY — this stops it being dragged toward
    // brighter nearby features (roads, other trails) that aren't the trail being traced.
    if (corridorPx > 0) {
      const local = pxPath.map(([px, py]) => [px - ox, py - oy]);
      const c2 = corridorPx * corridorPx;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          if (grid[i] !== 0 && distToPolyline2(x, y, local) > c2) grid[i] = 0;
        }
      }
    }
    const nw = surf.pixelToLonLat(ox, oy);
    const se = surf.pixelToLonLat(ex, ey);
    return { width: W, height: H, grid, west: nw[0], north: nw[1], east: se[0], south: se[1] };
  }

  // Auto-estimate the heatmap band width near the path (perpendicular FWHM -> Gaussian std, in
  // meters) so the smoothing adapts to the heatmap instead of being hand-tuned.
  function estimateBandStdMeters(surf, pxPath, mpp) {
    const data = surf.data;
    const W = surf.width;
    const H = surf.height;
    const valAt = (px, py) => {
      const x = Math.round(px);
      const y = Math.round(py);
      if (x < 0 || y < 0 || x >= W || y >= H) return 0;
      const i = (y * W + x) * 4;
      return data[i + 3] > 0 ? data[i] : 0;
    };
    const maxPx = Math.max(10, Math.round(80 / mpp)); // scan up to +/-80 m perpendicular
    const widths = [];
    const stride = Math.max(1, Math.floor((pxPath.length - 2) / 15));
    for (let k = 1; k < pxPath.length - 1; k += stride) {
      const a = pxPath[k - 1];
      const b = pxPath[k + 1];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const L = Math.hypot(dx, dy);
      if (L === 0) continue;
      const nx = -dy / L;
      const ny = dx / L;
      const cx = pxPath[k][0];
      const cy = pxPath[k][1];
      const prof = [];
      let peak = 0;
      let peakIdx = 0;
      for (let d = -maxPx; d <= maxPx; d++) {
        const v = valAt(cx + nx * d, cy + ny * d);
        prof.push(v);
        if (v > peak) {
          peak = v;
          peakIdx = prof.length - 1;
        }
      }
      if (peak <= 0) continue;
      const half = peak / 2;
      let li = peakIdx;
      while (li > 0 && prof[li - 1] >= half) li--;
      let ri = peakIdx;
      while (ri < prof.length - 1 && prof[ri + 1] >= half) ri++;
      widths.push((ri - li) * mpp); // FWHM in meters
    }
    if (!widths.length) return 25;
    widths.sort((x, y) => x - y);
    const fwhm = widths[Math.floor(widths.length / 2)];
    return Math.max(8, Math.min(40, fwhm / 2.355)); // FWHM -> std, clamped
  }

  // Reduce node count with Douglas-Peucker in a local meters frame (keeps lon/lat exact).
  function simplifyLonLat(p, tolMeters, lat0) {
    if (p.length < 3) return p.slice();
    const mLat = 111320;
    const mLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
    const m = p.map((q) => [q[0] * mLon, q[1] * mLat]);
    const keep = new Array(p.length).fill(false);
    keep[0] = keep[p.length - 1] = true;
    const stack = [[0, p.length - 1]];
    while (stack.length) {
      const [s, e] = stack.pop();
      const ax = m[s][0], ay = m[s][1], bx = m[e][0], by = m[e][1];
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      let maxD = -1, idx = -1;
      for (let i = s + 1; i < e; i++) {
        const px = m[i][0], py = m[i][1];
        let d;
        if (l2 === 0) d = Math.hypot(px - ax, py - ay);
        else {
          const t = ((px - ax) * dx + (py - ay) * dy) / l2;
          d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
        }
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (maxD > tolMeters && idx > 0) {
        keep[idx] = true;
        stack.push([s, idx], [idx, e]);
      }
    }
    return p.filter((_, i) => keep[i]);
  }

  // Small separable box blur on a Float32 grid (only to get a stable gradient direction).
  function boxBlurFloat(src, W, H, r) {
    if (r < 1) return src.slice();
    const norm = 1 / (2 * r + 1);
    const tmp = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      const row = y * W;
      let sum = (r + 1) * src[row];
      for (let x = 1; x <= r; x++) sum += src[row + Math.min(x, W - 1)];
      for (let x = 0; x < W; x++) {
        tmp[row + x] = sum * norm;
        sum += src[row + Math.min(x + r + 1, W - 1)] - src[row + Math.max(x - r, 0)];
      }
    }
    const out = new Float32Array(W * H);
    for (let x = 0; x < W; x++) {
      let sum = (r + 1) * tmp[x];
      for (let y = 1; y <= r; y++) sum += tmp[Math.min(y, H - 1) * W + x];
      for (let y = 0; y < H; y++) {
        out[y * W + x] = sum * norm;
        sum += tmp[Math.min(y + r + 1, H - 1) * W + x] - tmp[Math.max(y - r, 0) * W + x];
      }
    }
    return out;
  }

  // Anisotropic smoothing: average each pixel ALONG the local band direction (perpendicular to the
  // heatmap gradient). Denoises along the band and preserves its curved centerline + across-profile
  // so the slide follows curves without a hand-tuned isotropic blur.
  function anisotropicSmoothGrid(grid, W, H, alongPx) {
    const f = new Float32Array(W * H);
    for (let i = 0; i < f.length; i++) f[i] = grid[i];
    const blur = boxBlurFloat(f, W, H, 2);
    const sample = (g, x, y) => {
      if (x < 0) x = 0;
      else if (x > W - 1) x = W - 1;
      if (y < 0) y = 0;
      else if (y > H - 1) y = H - 1;
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const x1 = Math.min(x0 + 1, W - 1);
      const y1 = Math.min(y0 + 1, H - 1);
      const dx = x - x0;
      const dy = y - y0;
      return (
        g[y0 * W + x0] * (1 - dx) * (1 - dy) +
        g[y0 * W + x1] * dx * (1 - dy) +
        g[y1 * W + x0] * (1 - dx) * dy +
        g[y1 * W + x1] * dx * dy
      );
    };
    const out = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const gx = sample(blur, x + 1, y) - sample(blur, x - 1, y);
        const gy = sample(blur, x, y + 1) - sample(blur, x, y - 1);
        const gm = Math.hypot(gx, gy);
        if (gm < 1e-3) {
          out[y * W + x] = grid[y * W + x];
          continue;
        }
        const bx = -gy / gm; // band direction = perpendicular to the gradient
        const by = gx / gm;
        let sum = 0;
        let n = 0;
        for (let t = -alongPx; t <= alongPx; t++) {
          sum += sample(f, x + t * bx, y + t * by);
          n++;
        }
        out[y * W + x] = Math.round(sum / n);
      }
    }
    return out;
  }

  // Full pipeline: read the heatmap, run the Go WASM slide, apply the result to iD (undoable).
  NS.slideAndApply = async function (context, way) {
    const need = ['osmNode', 'actionDeleteNode', 'geoChooseEdge'];
    const missing = need.filter((k) => typeof (window.iD || {})[k] !== 'function');
    if (missing.length) {
      console.warn('[slide-v2] missing iD API (cannot apply):', missing);
      return;
    }

    const wasmOk = NS.wasmReady ? await NS.wasmReady : false;
    if (!wasmOk || typeof window.__slideV2Wasm !== 'function') {
      console.warn('[slide-v2] WASM not ready — cannot slide');
      return;
    }

    const path = context.graph().childNodes(way).map((n) => n.loc.slice());
    if (path.length < 2) return;

    const surf = await NS.buildSurface(context, path);
    if (!surf.ok) {
      console.warn('[slide-v2] cannot read heatmap:', surf.reason);
      return;
    }

    const centerLat = path.reduce((a, p) => a + p[1], 0) / path.length;
    const mpp = NS.metersPerPixel(surf.z, surf.tileSize, centerLat);
    const opts = NS.WASM_OPTIONS;
    const pxPath = path.map(([lon, lat]) => surf.pixelOf(lon, lat));
    // Smoothing denoises the heatmap so the gradient is stable; it's a fixed value, NOT the band
    // width (band-width over-smoothed and cut curves). The real Strava band is bumpy (overlaid GPS
    // traces), so too little smoothing makes points settle at different lateral offsets -> kinks.
    // Calibrated on real dumps (wasm/run_dump_fix.mjs): stdDev 12 removes the kink (turn 22deg->8deg)
    // while the synthetic curve test (run_test_real.mjs) shows it costs only ~0.5 m on a tight curve.
    // (Effective ground smoothing ~= stdDev * 2.4 m; see utils/kernel.go.) Automatic; not per-trail.
    const smoothing = opts.smoothingStdDev != null ? opts.smoothingStdDev : 12;
    // Corridor: only snap to the heatmap within this distance of the drawn line, so the slide can't
    // be pulled off the trail toward brighter nearby roads/trails. The hand trace is trusted; the
    // slide makes only local corrections. Validated on real data (wasm/run_dump_fix.mjs): a ~20 m
    // corridor removes the road-bulge (25 m -> 4 m) and most zigzag. Automatic; not tuned per trail.
    const corridorMeters = opts.corridorMeters != null ? opts.corridorMeters : 20;
    const corridorPx = corridorMeters / mpp;
    const marginPx = Math.ceil((corridorMeters + 3.5 * smoothing) / mpp) + 6;
    const grid = extractGrid(surf, pxPath, marginPx, corridorPx);
    console.log('[slide-v2] surface', {
      smoothingStdDev: smoothing,
      corridorMeters,
      mpp: +mpp.toFixed(2),
      gridSize: grid.width + 'x' + grid.height,
    });

    const req = Object.assign(
      {
        width: grid.width,
        height: grid.height,
        grid: grid.grid,
        west: grid.west,
        east: grid.east,
        south: grid.south,
        north: grid.north,
        smoothingStdDev: smoothing,
        path: path,
      },
      opts
    );
    // Keep the exact WASM input so it can be dumped + replayed offline (NS.dumpLastSlide()).
    NS._lastSlide = req;

    const t0 = performance.now();
    const res = window.__slideV2Wasm(req);
    const runtimeMs = Math.round(performance.now() - t0);

    if (!res || !res.ok) {
      console.warn('[slide-v2] WASM slide failed:', res && res.error);
      return;
    }
    // The WASM resamples to 5 m spacing, so it returns far more points than needed. Simplify with
    // Douglas-Peucker (~3 m, ~GPS noise) so we don't add redundant nodes. Automatic; not tuned.
    const rawCount = res.path.length;
    const simplifyTol = opts.simplifyMeters != null ? opts.simplifyMeters : 3;
    const corrected = simplifyLonLat(res.path, simplifyTol, centerLat); // [[lon, lat], ...]
    if (NS.debugDrawPath) NS.debugDrawPath(corrected, 'cyan'); // result we apply (debug)
    context.perform(buildSlideAction(context, way.id, corrected), 'Slide geometry to Strava heatmap');

    console.log('[slide-v2] slid onto heatmap (WASM)', {
      wayId: way.id,
      nodesBefore: path.length,
      wasmPoints: rawCount,
      pointsAfter: corrected.length,
      loops: res.loops,
      gridSize: grid.width + 'x' + grid.height,
      runtimeMs,
    });
  };

  // Debug: download the exact last WASM input (grid + bound + path) as JSON so it can be replayed
  // offline (wasm/replay_dump.mjs) against the REAL heatmap data instead of synthetic guesses.
  // Usage: run a slide on the misbehaving trail, then `window.__slideV2.dumpLastSlide()`.
  NS.dumpLastSlide = function () {
    const r = NS._lastSlide;
    if (!r) {
      console.warn('[slide-v2] no slide captured yet — run a slide first');
      return;
    }
    // base64-encode the Uint8Array grid in chunks (avoids call-stack overflow on big arrays).
    let bin = '';
    const g = r.grid;
    for (let i = 0; i < g.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, g.subarray(i, i + 0x8000));
    }
    const dump = {
      width: r.width,
      height: r.height,
      west: r.west,
      east: r.east,
      south: r.south,
      north: r.north,
      smoothingStdDev: r.smoothingStdDev,
      path: r.path,
      gridBase64: btoa(bin),
    };
    const blob = new Blob([JSON.stringify(dump)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'slide-dump.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
    console.log('[slide-v2] dumped last slide ->', dump.width + 'x' + dump.height, 'grid,', r.path.length, 'pts');
  };

  // Part 7 verification: run the full slide and report whether it moved the line onto the heatmap.
  NS.debugSlide = async function (context, path, opts) {
    const surf = await NS.buildSurface(context, path, opts);
    if (!surf.ok) {
      console.warn('[slide-v2] slide build failed:', surf.reason, surf);
      return surf;
    }
    const centerLat = path.reduce((a, p) => a + p[1], 0) / path.length;
    const pxPath = path.map(([lon, lat]) => surf.pixelOf(lon, lat));
    const surfacer = NS.makeSurfacer(surf, pxPath, { centerLat });

    const t0 = performance.now();
    const res = NS.slide(surfacer, pxPath, {});
    const runtimeMs = Math.round(performance.now() - t0);

    let maxShift = 0;
    for (let i = 0; i < res.refined.length; i++) {
      const d = dist(res.refined[i], res.resampled[i]);
      if (d > maxShift) maxShift = d;
    }
    const correctedLonLat = res.path.map(([px, py]) => surf.pixelToLonLat(px, py));

    console.log('[slide-v2] slide done', {
      pointsIn: path.length,
      resampled: res.resampled.length,
      simplified: res.path.length,
      loops: res.loops,
      delta: +res.delta.toFixed(5),
      avgValueBefore: +avgValue(surfacer, res.resampled).toFixed(3),
      avgValueAfter: +avgValue(surfacer, res.refined).toFixed(3),
      maxShiftPx: +maxShift.toFixed(1),
      maxShiftMeters: +(maxShift * surfacer.mpp).toFixed(1),
      runtimeMs,
      gradientScale: NS.SLIDE_OPTIONS.gradientScale,
    });
    return { surf, surfacer, res, correctedLonLat };
  };
})();
