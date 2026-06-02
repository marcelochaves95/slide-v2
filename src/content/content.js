// slide-v2 content script (isolated world). Confirms the extension loads on the iD editor page/iframe.
console.log('[slide-v2] content script loaded', {
  url: location.href,
  frame: window.top === window ? 'top' : 'iframe',
});
