// The story film (scripts/story-film.py): one continuous move through an architecture diagram
// drawn in chalk, with a stop for each chapter. It never runs on its own account: the scroll
// position picks the moment and the film glides to it. Scrolling it into view draws the diagram,
// reading on flies the camera, and scrolling back retraces it.
//
// It is not a video. A video can only be scrubbed by seeking, which is never quite smooth and is
// worst backwards. The film arrives as its frames and is drawn to a canvas, so any moment is as
// near as any other, in either direction. The frames come as ordinary images, a few stacked in
// each (scripts/pack-film.mjs): this page makes no network request of its own, and images are the
// browser's to load.
//
// INTRO and FILM are the render's own numbers: the length of the opening in which the diagram is
// drawn, then each stop's seconds counted from the end of that opening.
import manifest from './filmManifest.json';

export const INTRO = 2;
export const FILM = {
  dive: [0, 2],
  present: [2, 6],
  nodi: [6, 10.5],
  inside: [10.5, 15],
  evidence: [15, 19],
  collaboration: [19, 23.5],
  points: [23.5, 27.5],
  ending: [27.5, 30],
};
// How long the picture takes to close most of the distance to where the scroll is: long enough to
// glide to rest when the wheel stops, short enough that it never feels behind the hand.
const GLIDE = .11;

export function setUpStoryFilm(story, reduced) {
  const canvas = story.querySelector('.story-film');
  if (!canvas) return () => {};
  const context = canvas.getContext('2d');
  const small = window.matchMedia('(max-width: 700px)');
  const size = small.matches ? 'small' : 'large';
  const { width, height } = manifest.sizes[size];
  const { frames, fps, perStrip, strips } = manifest;
  const source = (strip) => `${import.meta.env.BASE_URL}clips/film/${size}/${String(strip).padStart(3, '0')}.webp`;
  const loader = story.querySelector('.film-loader span');
  let target = 0;
  let shown = 0;
  let drawn = -1;
  let frame = 0;
  let last = 0;
  // Decoded strips around the current moment. A decoded strip is large, so only a few are kept.
  const decoded = new Map();
  const KEEP = 5;

  function want(strip) {
    if (strip < 0 || strip >= strips || decoded.has(strip)) return;
    const image = new Image();
    const entry = { image, ready: false };
    decoded.set(strip, entry);
    image.decoding = 'async';
    image.src = source(strip);
    image.decode().then(() => { entry.ready = true; wake(); }).catch(() => { if (decoded.get(strip) === entry) decoded.delete(strip); });
    if (decoded.size > KEEP) {
      // Let go of whichever strip is furthest from where the film is now; the browser's cache still has its file.
      const here = shown * fps / perStrip;
      let furthest = strip;
      for (const key of decoded.keys()) if (Math.abs(key - here) > Math.abs(furthest - here)) furthest = key;
      decoded.delete(furthest);
    }
  }
  function paint(image, row) {
    const scale = Math.min(2, window.devicePixelRatio || 1);
    const stageWidth = Math.round(canvas.clientWidth * scale);
    const stageHeight = Math.round(canvas.clientHeight * scale);
    if (canvas.width !== stageWidth || canvas.height !== stageHeight) { canvas.width = stageWidth; canvas.height = stageHeight; }
    // Fill the stage, keeping the side of the frame the scenes are composed on.
    const fit = Math.max(stageWidth / width, stageHeight / height);
    const across = small.matches ? .22 : 0;
    context.fillStyle = '#000';
    context.fillRect(0, 0, stageWidth, stageHeight);
    context.drawImage(image, 0, row * height, width, height, (stageWidth - width * fit) * across, (stageHeight - height * fit) / 2, width * fit, height * fit);
  }
  function step(now) {
    frame = 0;
    const elapsed = Math.min(.05, (now - last) / 1000 || .016);
    last = now;
    const gap = target - shown;
    shown = reduced.matches || Math.abs(gap) < .004 ? target : shown + gap * (1 - Math.exp(-elapsed / GLIDE));
    const index = Math.min(frames - 1, Math.max(0, Math.round(shown * fps)));
    const strip = Math.floor(index / perStrip);
    // Have this strip decoded, and the ones the scroll is heading for.
    const ahead = gap >= 0 ? 1 : -1;
    want(strip);
    want(strip + ahead);
    want(strip + 2 * ahead);
    want(strip - ahead);
    const entry = decoded.get(strip);
    if (entry?.ready && index !== drawn) { paint(entry.image, index % perStrip); drawn = index; }
    if (shown !== target || index !== drawn) frame = requestAnimationFrame(step);
  }
  function wake() { if (!frame) { last = performance.now(); frame = requestAnimationFrame(step); } }

  // Every strip is asked for once, in order and a few at a time, so that by the time the scroll
  // reaches a scene its pictures are already in the browser's cache. The board opens as soon as
  // the opening and the first chapter are in; the rest keeps arriving behind it.
  let asked = 0;
  let arrived = 0;
  function warm() {
    if (asked >= strips) return;
    const image = new Image();
    const done = () => {
      arrived += 1;
      if (loader) loader.textContent = `chalking the board… ${Math.round(arrived / strips * 100)}%`;
      if (arrived >= Math.min(strips, Math.ceil(fps * 7 / perStrip))) { story.dataset.film = ''; wake(); }
      warm();
    };
    image.onload = done;
    image.onerror = () => { if (story.dataset.film === undefined) story.dataset.film = 'missing'; done(); };
    image.src = source(asked++);
  }
  for (let lane = 0; lane < 4; lane++) warm();
  window.addEventListener('resize', () => { drawn = -1; wake(); });

  return (time) => {
    target = Math.max(0, time + INTRO);
    wake();
  };
}
