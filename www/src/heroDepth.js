// The diagram on the hero's whiteboard, alive: a rendered loop (scripts/hero-depth.py) in which the
// boxes float above the board and the view drifts past them. It is laid over the illustration, and
// the flat diagram is masked out of the picture only once the loop is really playing, so a blocked
// autoplay, a failed download or reduced motion all leave the drawing exactly as it was.
const clip = `${import.meta.env.BASE_URL}clips/hero-depth.mp4`;

export function setUpHeroDepth(art, reduced) {
  const video = art.querySelector('.conversation-depth');
  if (!video) return;
  let ready = false;
  let onScreen = true;
  let settle = 0;

  function rest() {
    clearTimeout(settle);
    delete art.dataset.depth;
    video.pause();
  }
  function sync() {
    // The opening sketch draws the flat diagram stroke by stroke; the loop waits for it to finish.
    if (!ready || reduced.matches || art.dataset.drawing) { rest(); return; }
    if (!art.dataset.depth) {
      // Frame 0 is the head-on pose that lines up with the drawing, so the two can cross over:
      // the loop fades in over the flat diagram first, then the flat one is masked away.
      video.currentTime = 0;
      art.dataset.depth = 'arriving';
      settle = setTimeout(() => { if (art.dataset.depth) art.dataset.depth = 'on'; }, 450);
    }
    if (!onScreen) { video.pause(); return; }
    video.play().catch((error) => {
      if (error.name === 'AbortError') return;
      ready = false;
      rest();
    });
  }

  video.muted = true;
  video.addEventListener('canplaythrough', () => { ready = true; sync(); }, { once: true });
  video.addEventListener('error', () => { ready = false; rest(); });
  new MutationObserver(sync).observe(art, { attributes: true, attributeFilter: ['data-drawing'] });
  reduced.addEventListener('change', sync);
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((entries) => {
      onScreen = entries.some((entry) => entry.isIntersecting);
      if (art.dataset.depth) sync();
    }).observe(art);
  }
  // Fetched after the opening sketch has had the first moment to itself.
  if (!reduced.matches) setTimeout(() => { video.src = clip; video.load(); }, 800);
}
