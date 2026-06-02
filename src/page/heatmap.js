// Runs in the page MAIN world. Reads Strava heatmap tile intensities client-side.
// Relies on the julcnx Strava Heatmap extension to authenticate the tiles (Cookie) and
// set `Access-Control-Allow-Origin: *`, which lets us read the canvas without tainting it.
(function () {
  const NS = (window.__slideV2 = window.__slideV2 || {});
  if (NS.heatmapInstalled) return;
  NS.heatmapInstalled = true;

  const DEFAULT_ZOOM = 15; // authenticated Strava heatmap tops out at native z15
  const MAX_TILES = 100; // safety cap for the bbox

  function tileX(lon, z) {
    return ((lon + 180) / 360) * Math.pow(2, z);
  }
  function tileY(lat, z) {
    const rad = (lat * Math.PI) / 180;
    return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * Math.pow(2, z);
  }

  function findStravaTemplate(context) {
    try {
      const bg = context.background && context.background();
      const sources = bg && bg.overlayLayerSources ? bg.overlayLayerSources() : [];
      for (const s of sources) {
        const tmpl = typeof s.template === 'function' ? s.template() : s.template;
        if (tmpl && /identified\/globalheat/.test(tmpl)) return tmpl;
      }
    } catch (e) {
      /* fall through to default */
    }
    return null;
  }

  // Use the gray color scheme so pixel luminance ~= activity intensity. IMPORTANT: keep the SAME
  // activity type (all/ride/run/winter/water) as the heatmap the user is viewing — only the color
  // changes to gray. If we can't find the active template we fall back to "all", which may NOT match
  // what the user sees (different bands) — that mismatch would make the slide read the wrong heatmap.
  function grayTemplate(context) {
    const active = findStravaTemplate(context);
    if (active) {
      const gray = active.replace(/(identified\/globalheat\/[^/]+\/)[^/]+/, '$1gray');
      console.log('[slide-v2] heatmap: active template found, reading', gray);
      return gray;
    }
    const fallback = 'https://content-a.strava.com/identified/globalheat/all/gray/{z}/{x}/{y}.png?v=19';
    console.warn(
      '[slide-v2] heatmap: could NOT find the active Strava overlay — falling back to "all/gray".',
      'If your blue heatmap is a different sport (Ride/Run/Winter/Water), the bands WON\'T match. Using:',
      fallback
    );
    return fallback;
  }

  function tileUrl(template, x, y, z) {
    return template
      .replace(/\{zoom\}/g, z)
      .replace(/\{z\}/g, z)
      .replace(/\{x\}/g, x)
      .replace(/\{y\}/g, y);
  }

  function loadImage(url) {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }

  // path: array of [lon, lat]. Downloads the heatmap tiles covering the path bbox (+1 tile
  // margin) and returns a sampler. Async.
  async function buildSurface(context, path, opts) {
    const z = (opts && opts.zoom) || DEFAULT_ZOOM;
    const template = grayTemplate(context);

    let minTX = Infinity, maxTX = -Infinity, minTY = Infinity, maxTY = -Infinity;
    for (const [lon, lat] of path) {
      const tx = tileX(lon, z);
      const ty = tileY(lat, z);
      if (tx < minTX) minTX = tx;
      if (tx > maxTX) maxTX = tx;
      if (ty < minTY) minTY = ty;
      if (ty > maxTY) maxTY = ty;
    }
    const x0 = Math.floor(minTX) - 1;
    const x1 = Math.floor(maxTX) + 1;
    const y0 = Math.floor(minTY) - 1;
    const y1 = Math.floor(maxTY) + 1;
    const cols = x1 - x0 + 1;
    const rows = y1 - y0 + 1;
    if (cols * rows > MAX_TILES) {
      return { ok: false, reason: 'bbox too large (' + cols * rows + ' tiles) at zoom ' + z };
    }

    const jobs = [];
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        jobs.push(loadImage(tileUrl(template, tx, ty, z)).then((img) => ({ tx, ty, img })));
      }
    }
    const tiles = await Promise.all(jobs);
    const loaded = tiles.filter((t) => t.img);
    if (!loaded.length) {
      return { ok: false, reason: 'no tiles loaded (network/auth?)', template, z };
    }

    const tileSize = loaded[0].img.naturalWidth || 256;
    const canvas = document.createElement('canvas');
    canvas.width = cols * tileSize;
    canvas.height = rows * tileSize;
    const ctx2d = canvas.getContext('2d', { willReadFrequently: true });
    for (const t of loaded) {
      ctx2d.drawImage(t.img, (t.tx - x0) * tileSize, (t.ty - y0) * tileSize, tileSize, tileSize);
    }

    let imageData;
    try {
      imageData = ctx2d.getImageData(0, 0, canvas.width, canvas.height);
    } catch (e) {
      return {
        ok: false,
        reason: 'tainted canvas — is the Strava Heatmap extension on and logged in?',
        template,
        z,
        error: String(e),
      };
    }

    const data = imageData.data;
    const W = canvas.width;
    const H = canvas.height;
    const scale = Math.pow(2, z) * tileSize;
    const originX = x0 * tileSize;
    const originY = y0 * tileSize;

    function pixelOf(lon, lat) {
      const px = ((lon + 180) / 360) * scale - originX;
      const rad = (lat * Math.PI) / 180;
      const py =
        ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * scale - originY;
      return [Math.floor(px), Math.floor(py)];
    }

    function rgbaAt(lon, lat) {
      const [px, py] = pixelOf(lon, lat);
      if (px < 0 || py < 0 || px >= W || py >= H) return null;
      const i = (py * W + px) * 4;
      return [data[i], data[i + 1], data[i + 2], data[i + 3]];
    }

    function pixelToLonLat(px, py) {
      const lon = ((px + originX) / scale) * 360 - 180;
      const n = Math.PI * (1 - (2 * (py + originY)) / scale);
      const lat = (Math.atan(Math.sinh(n)) * 180) / Math.PI;
      return [lon, lat];
    }

    return {
      ok: true,
      template,
      z,
      tileSize,
      tileRange: { x0, x1, y0, y1 },
      canvas: { width: W, height: H },
      tilesLoaded: loaded.length,
      tilesTotal: tiles.length,
      data,
      width: W,
      height: H,
      pixelOf,
      pixelToLonLat,
      rgbaAt,
    };
  }

  NS.buildSurface = buildSurface;

  // Debug: paint OUR heatmap surface (the gray intensity the slide reads) over the iD map as a
  // heat colormap (black→red→yellow→white = hottest), semi-transparent so the blue heatmap shows
  // through. Lets you SEE the same reference as the offline images and verify the trail sits on the
  // hot core. If this heat overlay doesn't line up with the blue heatmap, our coords are off.
  // Toggle: call again (or Alt+Shift+H) to remove. NOTE: it's a snapshot of the current view —
  // after panning/zooming, toggle off+on to reposition.
  NS.debugHeatOverlay = async function () {
    const existing = document.getElementById('slidev2-debug-overlay');
    if (existing) {
      existing.remove();
      console.log('[slide-v2] heat overlay OFF');
      return;
    }
    const context = NS.getContext && NS.getContext();
    if (!context) {
      console.warn('[slide-v2] no iD context');
      return;
    }
    let path;
    try {
      const ids = (context.selectedIDs && context.selectedIDs()) || [];
      const graph = context.graph();
      const e = ids.length === 1 && graph.hasEntity(ids[0]);
      if (e && e.type === 'way') path = graph.childNodes(e).map((n) => n.loc);
    } catch (err) {
      /* ignore */
    }
    // Fall back to the last slid trail, so you can toggle the overlay right after a slide without
    // re-selecting the way.
    if (!path && NS._lastSlide && NS._lastSlide.path) path = NS._lastSlide.path;
    if (!path) {
      console.warn('[slide-v2] select a single way (trail) first (or run a slide), then toggle again');
      return;
    }
    const surf = await buildSurface(context, path);
    if (!surf.ok) {
      console.warn('[slide-v2] surface:', surf.reason);
      return;
    }
    const cv = document.createElement('canvas');
    cv.width = surf.width;
    cv.height = surf.height;
    const cx = cv.getContext('2d');
    const img = cx.createImageData(surf.width, surf.height);
    const d = surf.data;
    const o = img.data;
    let gmax = 1;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0 && d[i] > gmax) gmax = d[i];
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 0) {
        const t = (d[i] / gmax) * 3; // hot colormap, normalized to the local max
        o[i] = Math.max(0, Math.min(255, t * 255));
        o[i + 1] = Math.max(0, Math.min(255, (t - 1) * 255));
        o[i + 2] = Math.max(0, Math.min(255, (t - 2) * 255));
        o[i + 3] = 150; // semi-transparent so the blue heatmap underneath shows for comparison
      } else {
        o[i + 3] = 0;
      }
    }
    cx.putImageData(img, 0, 0);

    const p1 = context.projection(surf.pixelToLonLat(0, 0));
    const p2 = context.projection(surf.pixelToLonLat(surf.width, surf.height));
    cv.style.position = 'absolute';
    cv.style.left = Math.min(p1[0], p2[0]) + 'px';
    cv.style.top = Math.min(p1[1], p2[1]) + 'px';
    cv.style.width = Math.abs(p2[0] - p1[0]) + 'px';
    cv.style.height = Math.abs(p2[1] - p1[1]) + 'px';
    cv.style.imageRendering = 'pixelated';
    cv.style.pointerEvents = 'none';
    cv.style.zIndex = '5000';
    cv.id = 'slidev2-debug-overlay';

    const host =
      context.container().select('.main-map').node() ||
      context.container().node() ||
      document.body;
    host.appendChild(cv);
    console.log('[slide-v2] heat overlay ON (white = hottest). The trail should sit on the white core. Alt+Shift+H toggles; after panning, toggle off+on.');
  };
  // keep the old name working
  NS.debugSurfaceOverlay = NS.debugHeatOverlay;

  // --- Surfacer: turns the pixel grid into a cost surface with valueAt / gradientAt ---

  // Suggested slide weights (from the Go stravaheat surfacer).
  NS.SLIDE_OPTIONS = {
    gradientScale: 10, // [0,1] pixel-space surface needs a bigger scale than the Go mercator default (0.5) — tune
    distanceScale: 0.4,
    angleScale: 0.3,
    momentumScale: 0.7,
    smoothingMeters: 25,
    resampleMeters: 5,
    trimRadiusMeters: 15,
    simplifyTolMeters: 4,
    minLoops: 100,
    maxLoops: 4000,
    thresholdEpsilon: 0.0005,
    scoreSmoothing: 0.2,
    maxShiftMeters: 40,
  };

  function metersPerPixel(z, tileSize, lat) {
    return (Math.cos((lat * Math.PI) / 180) * 40075016.686) / (tileSize * Math.pow(2, z));
  }
  NS.metersPerPixel = metersPerPixel;

  // Normalized Gaussian smoothing kernel. A plain Gaussian keeps enough reach for the gradient
  // to pull the line in from a distance (the sharp-spike variant killed that reach). Applied on
  // the small cropped grid, so direct convolution is cheap.
  function slideKernel(sigmaPx) {
    if (!(sigmaPx > 0)) return [1];
    const size = Math.max(1, Math.ceil(sigmaPx * 3));
    const k = new Array(2 * size + 1);
    let sum = 0;
    for (let i = -size; i <= size; i++) {
      const v = Math.exp(-(i * i) / (2 * sigmaPx * sigmaPx));
      k[i + size] = v;
      sum += v;
    }
    for (let i = 0; i < k.length; i++) k[i] /= sum;
    return k;
  }

  function convolveSeparable(src, W, H, kernel) {
    const half = (kernel.length - 1) / 2;
    const tmp = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) {
        let acc = 0;
        for (let k = -half; k <= half; k++) {
          let xx = x + k;
          if (xx < 0) xx = 0;
          else if (xx >= W) xx = W - 1;
          acc += src[row + xx] * kernel[k + half];
        }
        tmp[row + x] = acc;
      }
    }
    const out = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let acc = 0;
        for (let k = -half; k <= half; k++) {
          let yy = y + k;
          if (yy < 0) yy = 0;
          else if (yy >= H) yy = H - 1;
          acc += tmp[yy * W + x] * kernel[k + half];
        }
        out[y * W + x] = acc;
      }
    }
    return out;
  }

  // surf: result of buildSurface; pxPath: the path in full heatmap pixel coords.
  // Crops to the path bbox (+ margin) so the sharp kernel can be applied cheaply.
  // valueAt = raw intensity (luma masked by alpha); gradientAt = gradient of the smoothed surface.
  NS.makeSurfacer = function (surf, pxPath, opts) {
    opts = opts || {};
    const fullW = surf.width;
    const fullH = surf.height;
    const data = surf.data;
    const smoothingMeters =
      opts.smoothingMeters != null ? opts.smoothingMeters : NS.SLIDE_OPTIONS.smoothingMeters;
    const mpp = metersPerPixel(surf.z, surf.tileSize, opts.centerLat || 0);
    const sigmaPx = smoothingMeters / mpp;

    const kernel = slideKernel(sigmaPx);
    const margin = (kernel.length - 1) / 2 + Math.ceil(20 / mpp); // kernel reach + ~20m of room

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [px, py] of pxPath) {
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
    const ox = Math.max(0, Math.floor(minX) - margin);
    const oy = Math.max(0, Math.floor(minY) - margin);
    const W = Math.min(fullW, Math.ceil(maxX) + margin) - ox;
    const H = Math.min(fullH, Math.ceil(maxY) + margin) - oy;

    const raw = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      const srcRow = (y + oy) * fullW;
      for (let x = 0; x < W; x++) {
        const p = (srcRow + x + ox) * 4;
        raw[y * W + x] = data[p + 3] > 0 ? data[p] / 255 : 0; // R (luma) masked by alpha
      }
    }
    const smooth = convolveSeparable(raw, W, H, kernel);

    // fx, fy are full-pixel coords; map them into the crop.
    function sample(grid, fx, fy) {
      let x = fx - ox;
      let y = fy - oy;
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
      const a = grid[y0 * W + x0];
      const b = grid[y0 * W + x1];
      const c = grid[y1 * W + x0];
      const d = grid[y1 * W + x1];
      return a * (1 - dx) * (1 - dy) + b * dx * (1 - dy) + c * (1 - dx) * dy + d * dx * dy;
    }

    return {
      W,
      H,
      ox,
      oy,
      mpp,
      sigmaPx,
      raw,
      smooth,
      valueAt: (px, py) => sample(raw, px, py),
      smoothAt: (px, py) => sample(smooth, px, py),
      gradientAt: (px, py) => [
        (sample(smooth, px + 1, py) - sample(smooth, px - 1, py)) / 2,
        (sample(smooth, px, py + 1) - sample(smooth, px, py - 1)) / 2,
      ],
    };
  };

  // Part 6 verification: build the surfacer and check the gradient ascends toward the heatmap.
  NS.debugSurfacer = async function (context, path, opts) {
    const surf = await buildSurface(context, path, opts);
    if (!surf.ok) {
      console.warn('[slide-v2] surfacer build failed:', surf.reason, surf);
      return surf;
    }
    const centerLat = path.reduce((a, p) => a + p[1], 0) / path.length;
    const pxPath = path.map(([lon, lat]) => surf.pixelOf(lon, lat));
    console.time('[slide-v2] smoothing');
    const surfacer = NS.makeSurfacer(surf, pxPath, { centerLat });
    console.timeEnd('[slide-v2] smoothing');

    let ascends = 0;
    let withGrad = 0;
    let sumV = 0;
    let sumG = 0;
    const samples = [];
    for (const [lon, lat] of path) {
      const [px, py] = surf.pixelOf(lon, lat);
      const v = surfacer.valueAt(px, py);
      const [gx, gy] = surfacer.gradientAt(px, py);
      const gmag = Math.hypot(gx, gy);
      sumV += v;
      sumG += gmag;
      if (gmag > 1e-6) {
        withGrad++;
        const s = surfacer.smoothAt(px, py);
        const s2 = surfacer.smoothAt(px + gx / gmag, py + gy / gmag); // step 1px uphill
        if (s2 >= s - 1e-9) ascends++;
      }
      if (samples.length < 8) {
        samples.push({ v: +v.toFixed(3), gx: +gx.toFixed(4), gy: +gy.toFixed(4) });
      }
    }
    console.log('[slide-v2] surfacer OK', {
      sigmaPx: +surfacer.sigmaPx.toFixed(1),
      metersPerPixel: +surfacer.mpp.toFixed(2),
      avgValue: +(sumV / path.length).toFixed(3),
      avgGradMag: +(sumG / path.length).toFixed(4),
      gradientAscends: withGrad ? ascends + '/' + withGrad : 'no gradient',
      samples,
    });
    return { surf, surfacer };
  };

  function stat(vals) {
    if (!vals.length) return null;
    let min = Infinity, max = -Infinity, sum = 0;
    for (const v of vals) {
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
    }
    return { min, max, avg: Math.round(sum / vals.length) };
  }

  // Verification helper: sample intensity along a path and log a summary.
  NS.debugSampleHeatmap = async function (context, path, opts) {
    const surf = await buildSurface(context, path, opts);
    if (!surf.ok) {
      console.warn('[slide-v2] heatmap read failed:', surf.reason, surf);
      return surf;
    }
    const samples = path.map(([lon, lat]) => {
      const rgba = surf.rgbaAt(lon, lat);
      return rgba ? { a: rgba[3], luma: rgba[0] } : { a: null, luma: null };
    });
    const valid = samples.filter((s) => s.a !== null);
    console.log('[slide-v2] heatmap read OK', {
      template: surf.template,
      zoom: surf.z,
      tileSize: surf.tileSize,
      tiles: surf.tilesLoaded + '/' + surf.tilesTotal,
      canvas: surf.canvas,
      alpha: stat(valid.map((s) => s.a)),
      luma: stat(valid.map((s) => s.luma)),
      first10: samples.slice(0, 10),
    });
    return surf;
  };
})();
