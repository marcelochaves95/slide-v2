// Runs in the page MAIN world. Port of the paulmach/slide algorithm to JS, working in
// heatmap pixel coordinates. Input/output paths are arrays of [px, py].
(function () {
  const NS = (window.__slideV2 = window.__slideV2 || {});
  if (NS.coreInstalled) return;
  NS.coreInstalled = true;

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

        const cx = gx + dx + ax + corrX[j] * o.momentumScale;
        const cy = gy + dy + ay + corrY[j] * o.momentumScale;
        nextX[j] = curX[j] + cx;
        nextY[j] = curY[j] + cy;
        corrX[j] = cx;
        corrY[j] = cy;
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
    const resamplePx = o.resampleMeters / mpp;
    const n = Math.max(3, Math.ceil(pathLength(path) / resamplePx) + 3);
    const resampled = resample(path, n);
    const r = refine(surfacer, resampled, o);
    const out = simplify(r.path, o.trimRadiusMeters / mpp, o.simplifyTolMeters / mpp);
    return { path: out, refined: r.path, resampled, loops: r.loops, delta: r.delta };
  };

  // Part 7 verification: run the full slide and report whether it moved the line onto the heatmap.
  NS.debugSlide = async function (context, path, opts) {
    const surf = await NS.buildSurface(context, path, opts);
    if (!surf.ok) {
      console.warn('[slide-v2] slide build failed:', surf.reason, surf);
      return surf;
    }
    const centerLat = path.reduce((a, p) => a + p[1], 0) / path.length;
    const surfacer = NS.makeSurfacer(surf, { centerLat });
    const pxPath = path.map(([lon, lat]) => surf.pixelOf(lon, lat));

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
