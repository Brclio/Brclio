/* Shared by the desktop account client and the browser preview. */
(() => {
  'use strict';
  const base = '/api/account/suggestions';
  const id = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
  const read = new RegExp(`^(?:/${id})?(?:\\?cursor=[1-9][0-9]{0,7})?$`);
  const comment = new RegExp(`^/${id}/comments$`);
  const rating = new RegExp(`^/${id}/rating$`);

  function isSuggestionRequest(path, method) {
    if (typeof path !== 'string' || !path.startsWith(base)) return false;
    const suffix = path.slice(base.length);
    if (method === 'GET') return read.test(suffix);
    if (method === 'POST') return suffix === '' || comment.test(suffix);
    return method === 'PUT' && rating.test(suffix);
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = isSuggestionRequest;
  else window.BrclioSuggestionRequest = isSuggestionRequest;
})();
