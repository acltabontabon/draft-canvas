/**
 * Every old link, forwarded to the same page at the new address.
 *
 *   /draft-canvas/docs/getting-started/  ->  https://draftcanvas.dev/docs/getting-started/
 *   /draft-canvas/editor/anything        ->  https://app.draftcanvas.dev/
 *
 * Runs on 404.html, which GitHub Pages serves for any path here that no longer exists. The link on
 * the page says the same thing for anyone without scripts. A replace, not a push, so Back does not
 * land on this page again.
 */
(function () {
  var prefix = '/draft-canvas/';
  var path = window.location.pathname;
  var rest = path.indexOf(prefix) === 0 ? path.slice(prefix.length) : '';
  var target = rest.indexOf('editor/') === 0 || rest === 'editor'
    ? 'https://app.draftcanvas.dev/'
    : 'https://draftcanvas.dev/' + rest + window.location.search + window.location.hash;

  var link = document.getElementById('forward');
  if (link) link.href = target;
  window.location.replace(target);
})();
