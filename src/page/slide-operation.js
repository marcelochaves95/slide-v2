// Runs in the page MAIN world. Registers the slide shortcut (Alt+S) and reads the selected way.
(function () {
  const NS = (window.__slideV2 = window.__slideV2 || {});
  if (NS.operationInstalled) return;
  NS.operationInstalled = true;

  function selectedIDs(context) {
    try {
      if (typeof context.selectedIDs === 'function') return context.selectedIDs() || [];
      const mode = typeof context.mode === 'function' ? context.mode() : null;
      if (mode && typeof mode.selectedIDs === 'function') return mode.selectedIDs() || [];
    } catch (e) {
      console.warn('[slide-v2] could not read selection', e);
    }
    return [];
  }

  // The way to slide: a single selected way, or the way that is the shared parent of selected vertices.
  function resolveWay(context, ids) {
    const graph = context.graph();

    if (ids.length === 1) {
      const e = graph.hasEntity(ids[0]);
      if (e && e.type === 'way') return e;
    }

    const parentIdLists = ids
      .map((id) => graph.hasEntity(id))
      .filter((e) => e && e.type === 'node')
      .map((node) => graph.parentWays(node).map((w) => w.id));

    if (parentIdLists.length) {
      let shared = parentIdLists[0];
      for (let i = 1; i < parentIdLists.length; i++) {
        shared = shared.filter((id) => parentIdLists[i].includes(id));
      }
      if (shared.length) return graph.entity(shared[0]);
    }
    return null;
  }

  function onShortcut() {
    const context = NS.getContext && NS.getContext();
    if (!context) {
      console.warn('[slide-v2] no iD context yet — open the editor and try again');
      return;
    }

    const ids = selectedIDs(context);
    const way = resolveWay(context, ids);
    if (!way) {
      console.warn('[slide-v2] select a line (way) or 2+ of its vertices first', {
        selectedIDs: ids,
      });
      return;
    }

    const nodes = context.graph().childNodes(way);
    const path = nodes.map((n) => n.loc); // [lon, lat]
    if (path.length < 2) {
      console.warn('[slide-v2] selected way has fewer than 2 nodes');
      return;
    }

    console.log('[slide-v2] slide requested (stub)', {
      wayId: way.id,
      tags: way.tags && (way.tags.name || way.tags.highway || way.tags.surface),
      nodeCount: path.length,
      first: path[0],
      last: path[path.length - 1],
      path,
    });
  }

  window.addEventListener(
    'keydown',
    (e) => {
      if (!(e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyS')) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      onShortcut();
    },
    true
  );

  console.log('[slide-v2] slide operation ready — select a line and press Alt+S');
})();
