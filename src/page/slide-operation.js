// Runs in the page MAIN world. Slide trigger via Alt+S and a button in iD's edit menu.
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

  function runSlide() {
    const context = NS.getContext && NS.getContext();
    if (!context) {
      console.info('[slide-v2] no iD context yet — open the editor and try again');
      return;
    }

    const ids = selectedIDs(context);
    const way = resolveWay(context, ids);
    if (!way) {
      console.info('[slide-v2] select a line (way) or 2+ of its vertices first', {
        selectedIDs: ids,
      });
      return;
    }

    const nodes = context.graph().childNodes(way);
    const path = nodes.map((n) => n.loc); // [lon, lat]
    if (path.length < 2) {
      console.info('[slide-v2] selected way has fewer than 2 nodes');
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

    if (NS.debugSampleHeatmap) {
      NS.debugSampleHeatmap(context, path).catch((e) =>
        console.warn('[slide-v2] heatmap sampling error', e)
      );
    }
  }
  NS.runSlide = runSlide;

  // --- Alt+S shortcut ---
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
      runSlide();
    },
    true
  );

  // --- Button in iD's edit/operations menu (shown on select / right-click) ---
  // The button reuses iD's native `.edit-menu-item` classes, so iD's own CSS styles it.
  // The original iD "Slide" operation icon (#operation-slide), inlined as path data and
  // recolored to currentColor so it matches the other edit-menu icons.
  const SLIDE_ICON =
    '<div class="icon-wrap"><svg class="icon operation" viewBox="423 382 14 16">' +
    '<path fill="currentColor" d="M429,385 L429,388 L428,388 L427,389 L430,392 L433,389 L432,388 L431,388 L431,385 C431,385 429,385 429,385 z"/>' +
    '<path fill="currentColor" d="M432,398 C433.333,398 434.219,397.219 434.719,396.719 C435.219,396.219 435.333,396 436,396 L437,396 L437,394 L436,394 C434.667,394 433.781,394.781 433.281,395.281 C432.781,395.781 432.667,396 432,396 C431.833,396 431.794,395.991 431.594,395.75 C431.393,395.509 431.156,395.062 430.906,394.562 C430.656,394.062 430.393,393.509 429.969,393 C429.544,392.491 428.833,392 428,392 C426.667,392 425.781,392.781 425.281,393.281 C424.781,393.781 424.667,394 424,394 L423,394 L423,396 L424,396 C425.333,396 426.219,395.219 426.719,394.719 C427.219,394.219 427.333,394 428,394 C428.167,394 428.206,394.009 428.406,394.25 C428.607,394.491 428.844,394.938 429.094,395.438 C429.344,395.938 429.607,396.491 430.031,397 C430.456,397.509 431.167,398 432,398 z M437,384 L423,384 L423,382 L437,382 L437,384 z"/>' +
    '</svg></div>';

  // Attach iD's own tooltip (heading + description + shortcut badge), like the native operations.
  function attachTooltip(context, btn) {
    try {
      const uiTooltip = window.iD && window.iD.uiTooltip;
      if (typeof uiTooltip === 'function' && typeof context.container === 'function') {
        // Match iD's edit menu: prefer the tooltip on the right; flip to left only when there
        // isn't room before the viewport's right edge (see iD edit_menu tooltipPosition).
        const r = btn.getBoundingClientRect();
        const vp = (typeof context.surfaceRect === 'function' && context.surfaceRect()) || null;
        const viewportRight = vp ? vp.left + vp.width : window.innerWidth;
        const side = r.right + 210 + 35 > viewportRight ? 'left' : 'right';
        console.info('[slide-v2] tooltip side', {
          side,
          btnRight: Math.round(r.right),
          viewportRight: Math.round(viewportRight),
        });
        const tip = uiTooltip()
          .heading(() => 'Slide')
          .title(() => 'Slide geometry to the Strava heatmap.')
          .keys(['Alt+S']);
        tip.placement(side);
        context.container().selectAll('.edit-menu-item-slide').call(tip);
        return 'native:' + side;
      }
    } catch (e) {
      console.info('[slide-v2] native tooltip unavailable, using title attr', e);
    }
    btn.title = 'Slide to Strava heatmap (Alt+S)';
    return 'fallback';
  }

  function injectMenuButton(menu) {
    if (!menu || menu.querySelector('.edit-menu-item-slide')) return;
    const context = NS.getContext && NS.getContext();
    if (!context || !resolveWay(context, selectedIDs(context))) return; // only for sliddable lines

    const sample = menu.querySelector('.edit-menu-item');
    const btn = document.createElement('button');
    btn.className = 'edit-menu-item edit-menu-item-slide';
    if (sample && sample.style.height) btn.style.height = sample.style.height;
    btn.innerHTML = SLIDE_ICON;
    btn.addEventListener('pointerdown', (e) => e.stopPropagation());
    btn.addEventListener('mousedown', (e) => e.stopPropagation());
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      runSlide();
    });

    menu.insertBefore(btn, menu.firstChild); // put Slide at the top of the menu
    const tooltipMode = attachTooltip(context, btn);
    console.log('[slide-v2] added Slide button to edit menu (top, tooltip: ' + tooltipMode + ')');
  }

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.classList && node.classList.contains('edit-menu')) {
          injectMenuButton(node);
        } else if (node.querySelector) {
          const menu = node.querySelector('.edit-menu');
          if (menu) injectMenuButton(menu);
        }
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  console.log('[slide-v2] slide operation ready — select a line and press Alt+S (or use the edit menu)');
})();
