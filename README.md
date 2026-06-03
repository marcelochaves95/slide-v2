slide-v2
========

A small **Manifest V3 browser extension** that snaps OpenStreetMap geometry onto the **Strava
heatmap**, right inside the **iD editor** (`www.openstreetmap.org/id`).

You trace a trail by hand; slide-v2 nudges each of your nodes onto the heatmap band so the line sits
on where people actually go — without throwing away the nodes you drew.

> Status: personal/dev tool, loaded unpacked. Not on the Chrome Web Store.

Requirements
------------

- **Chrome 111+** (or a Chromium browser that supports MV3 `world: "MAIN"` content scripts).
- The **Strava Heatmap browser extension by julcnx**, installed and enabled, with you **logged in to
  Strava**. slide-v2 reads the *authenticated* heatmap tiles client-side, and relies on that
  extension to (a) attach your Strava cookie to the tile requests and (b) set
  `Access-Control-Allow-Origin: *` so the tiles can be read off a canvas without tainting it.
- The Strava heatmap overlay turned **on** in iD (provided by that extension).

slide-v2 itself needs no special permissions — it only runs on `www.openstreetmap.org/id*`.

Install (load unpacked)
-----------------------

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this repository folder (the one containing `manifest.json`).
3. Open the iD editor at `https://www.openstreetmap.org/id` and turn on the Strava heatmap overlay.

Usage
-----

1. Select a **way** (a line/trail) — or 2+ of its vertices.
2. Press **Alt+S**, or click **Slide** at the top of iD's edit menu.
3. The way's interior nodes snap onto the heatmap band. Endpoints and "interesting" nodes
   (shared junctions, tagged nodes, nodes in relations) are left in place, so connected features
   aren't dragged. The change is a single, undoable edit (Ctrl+Z).

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

Thanks also to **julcnx**'s Strava Heatmap extension, which makes the authenticated heatmap tiles
readable client-side.

License
-------

MIT — see [LICENSE.md](LICENSE.md).
