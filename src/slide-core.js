// Runs in the page MAIN world. Snaps an OSM way's nodes onto the Strava heatmap band: for each
// interior node, find the brightest point perpendicular to the trail (biased to the drawn line)
// and move it there, keeping the user's nodes. Paths from iD are [lon, lat]; pixel work uses the
// heatmap surface built in heatmap.js.
(function () {
  const NS = (window.__slideV2 = window.__slideV2 || {});
  if (NS.coreInstalled) return;
  NS.coreInstalled = true;

  // Options for the heatmap snap (all automatic by default; set only to override for debugging):
  //   snapSearchMeters  – half-window searched perpendicular for the local band (default 7)
  //   snapSigmaMeters   – how strongly the result stays on the drawn line (default 4)
  //   snapSmoothPasses  – smoothing of the sideways offsets along the trail (default 2)
  NS.SNAP_OPTIONS = NS.SNAP_OPTIONS || {};

  // Bilinear sample of the heatmap intensity (luma R channel, masked by alpha) at a pixel.
  function sampleSurf(surf, px, py) {
    const W = surf.width, H = surf.height, d = surf.data;
    if (px < 0) px = 0; else if (px > W - 1) px = W - 1;
    if (py < 0) py = 0; else if (py > H - 1) py = H - 1;
    const x0 = Math.floor(px), y0 = Math.floor(py);
    const x1 = Math.min(x0 + 1, W - 1), y1 = Math.min(y0 + 1, H - 1);
    const fx = px - x0, fy = py - y0;
    const at = (x, y) => { const i = (y * W + x) * 4; return d[i + 3] > 0 ? d[i] : 0; };
    return (
      at(x0, y0) * (1 - fx) * (1 - fy) + at(x1, y0) * fx * (1 - fy) +
      at(x0, y1) * (1 - fx) * fy + at(x1, y1) * fx * fy
    );
  }

  // Snap each interior node onto its LOCAL band — a small, conservative refinement that keeps the
  // result on the trail the user traced. For each node, take the brightest point within a SMALL
  // perpendicular window (±`snapSearchMeters`), gaussian-biased to the drawn line (`snapSigmaMeters`),
  // so it nudges onto the local band but stays near his trace and won't hop to a brighter neighbour
  // (road/parallel trail). Sideways offsets are smoothed along the trail to remove jitter. We KEEP
  // his nodes (just nudge each). Endpoints unchanged. Input/output are pixel paths.
  function snapToBand(surf, pxPath, mpp, opts) {
    const sigmaPx = (opts.snapSigmaMeters != null ? opts.snapSigmaMeters : 4) / mpp;
    const R = (opts.snapSearchMeters != null ? opts.snapSearchMeters : 7) / mpp;
    const passes = opts.snapSmoothPasses != null ? opts.snapSmoothPasses : 2;
    const denom = 2 * sigmaPx * sigmaPx;
    const N = pxPath.length;
    const offs = new Float64Array(N);
    const perp = new Array(N).fill(null);
    for (let i = 1; i < N - 1; i++) {
      let tx = pxPath[i + 1][0] - pxPath[i - 1][0];
      let ty = pxPath[i + 1][1] - pxPath[i - 1][1];
      const L = Math.hypot(tx, ty) || 1; tx /= L; ty /= L;
      const nx = -ty, ny = tx; // perpendicular to the local trail direction
      perp[i] = [nx, ny];
      // brightest point within ±R, weighted by closeness to the drawn line; best=0 so an empty
      // perpendicular (no heatmap) leaves the node put.
      let best = 0, off = 0;
      for (let s = -R; s <= R; s += 0.25) {
        const v = sampleSurf(surf, pxPath[i][0] + nx * s, pxPath[i][1] + ny * s);
        const score = v * Math.exp(-(s * s) / denom);
        if (score > best) { best = score; off = s; }
      }
      offs[i] = off;
    }
    for (let p = 0; p < passes; p++) { // smooth the offsets along the trail (endpoints stay 0)
      const q = offs.slice();
      for (let i = 1; i < N - 1; i++) q[i] = (offs[i - 1] + 2 * offs[i] + offs[i + 1]) / 4;
      for (let i = 1; i < N - 1; i++) offs[i] = q[i];
    }
    const out = pxPath.map((p) => p.slice());
    for (let i = 1; i < N - 1; i++) {
      out[i] = [pxPath[i][0] + perp[i][0] * offs[i], pxPath[i][1] + perp[i][1] * offs[i]];
    }
    return out;
  }

  // Action: move each interior node to its snapped location, preserving node IDs / count / order so
  // junctions, tags and relation membership stay intact. Endpoints and "interesting" nodes
  // (shared junctions / tagged / in relations) are left untouched so connected features aren't dragged.
  function buildSnapAction(wayId, newLocs) {
    return function (graph) {
      const way = graph.entity(wayId);
      const ids = way.nodes;
      for (let i = 1; i < ids.length - 1; i++) {
        const loc = newLocs[i];
        if (!loc) continue;
        const node = graph.hasEntity(ids[i]);
        if (!node) continue;
        if (
          graph.parentWays(node).length > 1 ||
          graph.parentRelations(node).length > 0 ||
          node.hasInterestingTags()
        ) {
          continue;
        }
        graph = graph.replace(node.move(loc));
      }
      return graph;
    };
  }

  // Crop the heatmap surface to the path's bbox (+ margin). Only used to capture the debug dump
  // (NS.dumpLastSlide); the snap itself samples the full surface directly.
  function extractGrid(surf, pxPath, marginPx) {
    const fullW = surf.width, fullH = surf.height, data = surf.data;
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
    const W = ex - ox, H = ey - oy;
    const grid = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      const srcRow = (y + oy) * fullW;
      for (let x = 0; x < W; x++) {
        const p = (srcRow + x + ox) * 4;
        grid[y * W + x] = data[p + 3] > 0 ? data[p] : 0; // luma (R) masked by alpha
      }
    }
    const nw = surf.pixelToLonLat(ox, oy);
    const se = surf.pixelToLonLat(ex, ey);
    return { width: W, height: H, grid, west: nw[0], north: nw[1], east: se[0], south: se[1] };
  }

  // Full pipeline: read the heatmap and snap the way's nodes onto the band (undoable). Keeps the
  // user's nodes — only nudges each one locally onto the heatmap.
  NS.slideAndApply = async function (context, way) {
    if (!window.iD) {
      console.warn('[slide-v2] iD not available');
      return;
    }
    const path = context.graph().childNodes(way).map((n) => n.loc.slice());
    if (path.length < 3) {
      console.info('[slide-v2] need at least 3 nodes (2 endpoints + 1 interior) to snap');
      return;
    }

    const surf = await NS.buildSurface(context, path);
    if (!surf.ok) {
      console.warn('[slide-v2] cannot read heatmap:', surf.reason);
      return;
    }

    const centerLat = path.reduce((a, p) => a + p[1], 0) / path.length;
    const mpp = NS.metersPerPixel(surf.z, surf.tileSize, centerLat);
    const opts = NS.SNAP_OPTIONS;
    const pxPath = path.map(([lon, lat]) => surf.pixelOf(lon, lat));

    const t0 = performance.now();
    const snappedPx = snapToBand(surf, pxPath, mpp, opts);
    const runtimeMs = Math.round(performance.now() - t0);

    // endpoints unchanged (null); interior nodes get a new lon/lat
    const newLocs = snappedPx.map((p, i) =>
      i === 0 || i === snappedPx.length - 1 ? null : surf.pixelToLonLat(p[0], p[1])
    );

    // Keep the raw heatmap crop + path for offline debugging (NS.dumpLastSlide / Alt+Shift+S).
    const crop = extractGrid(surf, pxPath, Math.ceil(30 / mpp));
    NS._lastSlide = {
      width: crop.width, height: crop.height,
      west: crop.west, east: crop.east, south: crop.south, north: crop.north,
      path: path, grid: crop.grid, template: surf.template,
    };

    context.perform(buildSnapAction(way.id, newLocs), 'Slide geometry to Strava heatmap');

    console.log('[slide-v2] snapped to heatmap', {
      wayId: way.id,
      nodes: path.length,
      mpp: +mpp.toFixed(2),
      cropSize: crop.width + 'x' + crop.height,
      runtimeMs,
    });
  };

  // Debug: download the last slide's heatmap crop + path as JSON for offline inspection.
  // Usage: run a slide on the misbehaving trail, then `window.__slideV2.dumpLastSlide()` (or Alt+Shift+S).
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
      path: r.path,
      template: r.template,
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
})();
