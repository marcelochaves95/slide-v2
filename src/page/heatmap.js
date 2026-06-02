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
      rgbaAt,
    };
  }

  NS.buildSurface = buildSurface;

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
