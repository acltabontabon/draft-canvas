// Anyone who types www. lands on the apex, at the same path.
export default {
  fetch(request) {
    const url = new URL(request.url);
    url.hostname = 'draftcanvas.dev';
    return Response.redirect(url.href, 301);
  },
};
