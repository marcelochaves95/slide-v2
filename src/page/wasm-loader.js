// Runs in the page MAIN world. Instantiates the Go slide WASM (the proven algorithm) and
// exposes window.__slideV2Wasm. The runtime (window.Go) and the .wasm URL are provided by the
// isolated content script, since extension resources can't be referenced from the MAIN world.
(function () {
  const NS = (window.__slideV2 = window.__slideV2 || {});
  if (NS.wasmInit) return;
  NS.wasmInit = true;

  function waitFor(check, tries, delay) {
    return new Promise((resolve) => {
      let i = 0;
      const t = setInterval(() => {
        if (check() || ++i >= tries) {
          clearInterval(t);
          resolve(check());
        }
      }, delay);
    });
  }

  NS.wasmReady = (async () => {
    await waitFor(() => document.getElementById('slidev2-wasm-cfg'), 400, 25);
    const cfg = document.getElementById('slidev2-wasm-cfg');
    if (!cfg || !cfg.dataset.wasmUrl) {
      console.warn('[slide-v2] WASM config element missing');
      return false;
    }
    await waitFor(() => typeof window.Go === 'function', 400, 25);
    if (typeof window.Go !== 'function') {
      console.warn('[slide-v2] Go runtime (wasm_exec.js) did not load');
      return false;
    }
    try {
      const go = new window.Go();
      const resp = await fetch(cfg.dataset.wasmUrl);
      const bytes = await resp.arrayBuffer();
      const { instance } = await WebAssembly.instantiate(bytes, go.importObject);
      go.run(instance);
      await waitFor(() => typeof window.__slideV2Wasm === 'function', 400, 10);
      const ok = typeof window.__slideV2Wasm === 'function';
      console.log('[slide-v2] WASM ' + (ok ? 'ready ✓' : 'failed to register __slideV2Wasm'));
      return ok;
    } catch (e) {
      console.warn('[slide-v2] WASM instantiate failed (page CSP may block wasm):', e);
      return false;
    }
  })();
})();
