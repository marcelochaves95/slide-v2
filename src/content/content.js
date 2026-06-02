// slide-v2 content script (isolated world). Bridges extension resources (the Go WASM runtime)
// into the page's MAIN world, where the rest of slide-v2 runs.
(function () {
  console.log('[slide-v2] content script loaded', {
    frame: window.top === window ? 'top' : 'iframe',
  });

  // Pass the WASM resource URL to the MAIN world via a shared-DOM element.
  const cfg = document.createElement('div');
  cfg.id = 'slidev2-wasm-cfg';
  cfg.style.display = 'none';
  cfg.dataset.wasmUrl = chrome.runtime.getURL('src/wasm/slide.wasm');
  (document.documentElement || document.head).appendChild(cfg);

  // Inject the Go WASM runtime glue (defines window.Go in the MAIN world).
  const s = document.createElement('script');
  s.src = chrome.runtime.getURL('src/wasm/wasm_exec.js');
  s.onload = () => console.log('[slide-v2] wasm_exec.js loaded');
  s.onerror = () => console.warn('[slide-v2] failed to load wasm_exec.js');
  (document.head || document.documentElement).appendChild(s);
})();
