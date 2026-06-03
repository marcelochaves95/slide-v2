slide-v2
========

A small **Manifest V3 browser extension** that snaps OpenStreetMap geometry onto the **Strava
heatmap**, right inside the **iD editor** (`www.openstreetmap.org/id`).

You trace a trail by hand; slide-v2 nudges each of your nodes onto the heatmap band so the line sits
on where people actually go — without throwing away the nodes you drew.

> Status: personal/dev tool, loaded unpacked. Not on the Chrome Web Store.

Pre-requisites
--------------

slide-v2 reads the **authenticated** Strava heatmap tiles client-side, so it depends on the heatmap
already being visible in iD. Set that up first:

1. **Strava account** — free, at https://www.strava.com/register/free (needed to view the heatmap).
2. **Strava Heatmap extension by julcnx** — install it from the Chrome Web Store / Firefox Add-ons
   (see [julcnx/strava-heatmap-extension](https://github.com/julcnx/strava-heatmap-extension)). It
   authenticates the tiles (attaches your Strava cookie) and adds `Access-Control-Allow-Origin: *`,
   which is what lets slide-v2 read the tiles off a canvas.
3. **Enable the heatmap overlay in iD:**
   1. Open the iD editor: https://www.openstreetmap.org/edit?editor=id
   2. Press **B** (Background settings) → scroll to **Overlays** → select a **Strava Heatmap** overlay.
   3. If you see *"Click the Strava Heatmap extension icon to log into Strava…"*, click the **red**
      extension icon to log in.
   4. Use the **green** extension icon to pick the **activity type and color** of the heatmap.
   5. **Shift+Q** toggles the heatmap on/off.

A browser that supports MV3 `world: "MAIN"` content scripts is required (**Chrome 111+** or
equivalent Chromium).

Install slide-v2 (load unpacked)
--------------------------------

1. `chrome://extensions` → enable **Developer mode** (top-right).
2. Click **Load unpacked** → select this repository folder (the one containing `manifest.json`).
3. Reload the iD editor tab. slide-v2 only runs on `www.openstreetmap.org/id*` and needs no special
   permissions of its own.

To update after pulling changes: hit the **↻** (reload) on the extension card in `chrome://extensions`,
then refresh the iD tab.

Usage
-----

1. Make sure the Strava heatmap overlay is on (see pre-requisites) and the trail's band is visible.
2. Select a **way** (a line/trail) — or 2+ of its vertices.
3. Press **Alt+S**, or click **Slide** at the top of iD's edit menu.
4. The way's interior nodes snap onto the heatmap band. Endpoints and "interesting" nodes (shared
   junctions, tagged nodes, nodes in relations) stay put, so connected features aren't dragged. It's
   a single, undoable edit (**Ctrl+Z**).

### Debug shortcuts

- **Alt+Shift+H** — overlay the heatmap *as the extension reads it* (gray intensity → heat colormap,
  white = hottest) on the map, to check the line lands on the band. Toggle again to remove.
- **Alt+Shift+S** — download `slide-dump.json`: the heatmap crop + path of the last slide, for
  offline inspection.

How it works
------------

- `capture-context.js` grabs iD's internal `context` (by wrapping `iD.coreContext()`), giving access
  to the graph, projection, and selection.
- `heatmap.js` reads the active Strava heatmap tiles for the path's bounding box, forcing the **gray**
  color scheme (pixel luminance ≈ activity intensity), stitches them to a canvas, and exposes a
  surface with `pixelOf` / `pixelToLonLat` and a per-pixel intensity sampler.
- `slide-core.js` does the **snap**: for each interior node it searches *perpendicular* to the local
  trail direction for the brightest heatmap point within a small window, weighted toward where you
  drew the line (so it refines onto the local band instead of jumping to a brighter neighbour such as
  a parallel road), then smooths the sideways offsets along the trail. It **keeps your nodes** (IDs,
  count, order, junctions, tags) — it only moves each one a little.
- `slide-operation.js` wires up the **Alt+S** shortcut and the **Slide** button in iD's edit menu.

All four scripts run in the page's `MAIN` world (and in all frames, since iD runs in an iframe).

Troubleshooting
---------------

- **"Slide" does nothing / "cannot read heatmap".** Make sure the julcnx extension is enabled, you're
  logged in to Strava (red icon → log in), and a Strava Heatmap overlay is selected and visible in iD.
- **"tainted canvas".** Same cause — the tiles weren't served with the CORS header. Confirm the
  julcnx extension is on and the heatmap is actually loading.
- **The line lands off the band you see.** Open the console and look for the `[slide-v2] heatmap …`
  line: it logs the exact tile URL being read. If it warns that it fell back to `all/gray`, or the
  activity in the URL doesn't match the sport you picked in julcnx, the extension is reading a
  different heatmap than the one displayed — pick the matching overlay in iD. Use **Alt+Shift+H** to
  compare the read heatmap against the blue one.
- Open the DevTools console **in the iD iframe context** (the context selector at the top of the
  Console, usually `id-embed`) if you want to call `window.__slideV2.*` helpers by hand.

Credits
-------

slide-v2 was originally **forked from and inspired by [paulmach/slide](https://github.com/paulmach/slide)**
(MIT) — the project that introduced "sliding" OpenStreetMap geometry onto the Strava heatmap and first
integrated it into the iD editor.

It is, however, an **independent re-implementation**: a Manifest V3 extension with its own client-side
snapping algorithm. paulmach's original resamples a rough line and reshapes it with an iterative
gradient/distance/angle cost function — great for crude input that needs major reshaping. slide-v2
instead assumes the hand trace is already good and only makes a small local correction, so it does
**not** use any of paulmach/slide's code.

Thanks also to **[julcnx](https://github.com/julcnx/strava-heatmap-extension)**'s Strava Heatmap
extension, which makes the authenticated heatmap tiles readable client-side.

License
-------

MIT — see [LICENSE.md](LICENSE.md).
