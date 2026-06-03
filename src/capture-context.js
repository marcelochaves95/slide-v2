// Runs in the page MAIN world at document_start. Captures the live iD editor context.
(function () {
  const NS = (window.__slideV2 = window.__slideV2 || {});
  if (NS.installed) return;
  NS.installed = true;
  NS.context = null;

  function isContext(c) {
    return (
      !!c &&
      typeof c === 'object' &&
      ['graph', 'history', 'background', 'perform'].some(
        (m) => typeof c[m] === 'function'
      )
    );
  }

  let announced = false;
  function announce(context, via) {
    NS.context = context;
    if (announced) return;
    announced = true;
    console.log(`[slide-v2] iD context ready (via ${via})`, context);
    window.dispatchEvent(new CustomEvent('slidev2:context-ready'));
  }

  // Always returns the freshest valid context for the rest of the extension.
  NS.getContext = function () {
    if (isContext(NS.context)) return NS.context;
    if (isContext(window.context)) return window.context;
    return null;
  };

  // Preferred path: wrap iD.coreContext so capture doesn't depend on another extension.
  function wrapInit(context) {
    if (
      isContext(context) &&
      typeof context.init === 'function' &&
      !context.init.__slideV2
    ) {
      const origInit = context.init;
      context.init = function () {
        const result = origInit.apply(this, arguments);
        announce(context, 'coreContext');
        return result !== undefined ? result : context;
      };
      context.init.__slideV2 = true;
    }
    return context;
  }
  function wrapID(iD) {
    if (iD && typeof iD.coreContext === 'function' && !iD.coreContext.__slideV2) {
      const orig = iD.coreContext;
      const wrapped = function () {
        return wrapInit(orig.apply(this, arguments));
      };
      wrapped.__slideV2 = true;
      try {
        iD.coreContext = wrapped;
      } catch (e) {
        // coreContext not writable here; the window.context fallback still covers us.
      }
    }
    return iD;
  }

  let current = window.iD ? wrapID(window.iD) : undefined;
  try {
    Object.defineProperty(window, 'iD', {
      configurable: true,
      enumerable: true,
      get() {
        return current;
      },
      set(value) {
        current = wrapID(value);
      },
    });
  } catch (e) {
    console.warn('[slide-v2] could not hook window.iD', e);
  }

  // Fallback: the Strava Heatmap extension (julcnx) exposes the live context as window.context.
  let tries = 0;
  const poll = setInterval(() => {
    if (announced) {
      clearInterval(poll);
    } else if (isContext(window.context)) {
      announce(window.context, 'window.context');
      clearInterval(poll);
    } else if (++tries > 150) {
      clearInterval(poll);
    }
  }, 200);
})();
