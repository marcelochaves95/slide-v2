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

  // Use the gray color scheme so pixel luminance ~= activity intensity.
  function grayTemplate(context) {
    const active = findStravaTemplate(context);
    if (active) return active.replace(/(identified\/globalheat\/[^/]+\/)[^/]+/, '$1gray');
    return 'https://content-a.strava.com/identified/globalheat/all/gray/{z}/{x}/{y}.png?v=19';
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

  // --- Surfacer: turns the pixel grid into a cost surface with valueAt / gradientAt ---

  // Suggested slide weights (from the Go stravaheat surfacer).
  NS.SLIDE_OPTIONS = {
    gradientScale: 0.5,
    distanceScale: 0.2,
    angleScale: 0.1,
    momentumScale: 0.7,
    smoothingMeters: 25,
  };

  function metersPerPixel(z, tileSize, lat) {
    return (Math.cos((lat * Math.PI) / 180) * 40075016.686) / (tileSize * Math.pow(2, z));
  }

  // Fast Gaussian blur via 3 box-blur passes (Kutskir) — O(W*H) regardless of sigma.
  function boxesForGauss(sigma, n) {
    const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
    let wl = Math.floor(wIdeal);
    if (wl % 2 === 0) wl--;
    const wu = wl + 2;
    const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
    const m = Math.round(mIdeal);
    const sizes = [];
    for (let i = 0; i < n; i++) sizes.push(i < m ? wl : wu);
    return sizes;
  }

  function boxBlurH(src, dst, W, H, r) {
    if (r < 1) {
      dst.set(src);
      return;
    }
    const norm = 1 / (2 * r + 1);
    for (let y = 0; y < H; y++) {
      const row = y * W;
      let sum = (r + 1) * src[row];
      for (let x = 1; x <= r; x++) sum += src[row + (x < W ? x : W - 1)];
      for (let x = 0; x < W; x++) {
        dst[row + x] = sum * norm;
        const add = x + r + 1;
        const rem = x - r;
        sum += src[row + (add < W ? add : W - 1)] - src[row + (rem > 0 ? rem : 0)];
      }
    }
  }

  function boxBlurV(src, dst, W, H, r) {
    if (r < 1) {
      dst.set(src);
      return;
    }
    const norm = 1 / (2 * r + 1);
    for (let x = 0; x < W; x++) {
      let sum = (r + 1) * src[x];
      for (let y = 1; y <= r; y++) sum += src[(y < H ? y : H - 1) * W + x];
      for (let y = 0; y < H; y++) {
        dst[y * W + x] = sum * norm;
        const add = y + r + 1;
        const rem = y - r;
        sum += src[(add < H ? add : H - 1) * W + x] - src[(rem > 0 ? rem : 0) * W + x];
      }
    }
  }

  function gaussianBlur(src, W, H, sigma) {
    const out = new Float32Array(src);
    if (!(sigma > 0)) return out;
    const tmp = new Float32Array(W * H);
    for (const w of boxesForGauss(sigma, 3)) {
      const r = (w - 1) / 2;
      boxBlurH(out, tmp, W, H, r);
      boxBlurV(tmp, out, W, H, r);
    }
    return out;
  }

  // surf: result of buildSurface. Returns a surfacer in heatmap pixel coords.
  // valueAt = raw intensity (luma masked by alpha); gradientAt = gradient of the smoothed surface.
  NS.makeSurfacer = function (surf, opts) {
    opts = opts || {};
    const W = surf.width;
    const H = surf.height;
    const data = surf.data;
    const smoothingMeters =
      opts.smoothingMeters != null ? opts.smoothingMeters : NS.SLIDE_OPTIONS.smoothingMeters;
    const mpp = metersPerPixel(surf.z, surf.tileSize, opts.centerLat || 0);
    const sigmaPx = smoothingMeters / mpp;

    const raw = new Float32Array(W * H);
    for (let i = 0, p = 0; i < raw.length; i++, p += 4) {
      raw[i] = data[p + 3] > 0 ? data[p] / 255 : 0; // R (luma) masked by alpha
    }
    const smooth = gaussianBlur(raw, W, H, sigmaPx);

    function sample(grid, x, y) {
      if (x < 0) x = 0;
      else if (x > W - 1) x = W - 1;
      if (y < 0) y = 0;
      else if (y > H - 1) y = H - 1;
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const x1 = Math.min(x0 + 1, W - 1);
      const y1 = Math.min(y0 + 1, H - 1);
      const fx = x - x0;
      const fy = y - y0;
      const a = grid[y0 * W + x0];
      const b = grid[y0 * W + x1];
      const c = grid[y1 * W + x0];
      const d = grid[y1 * W + x1];
      return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
    }

    return {
      W,
      H,
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
    console.time('[slide-v2] smoothing');
    const surfacer = NS.makeSurfacer(surf, { centerLat });
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
