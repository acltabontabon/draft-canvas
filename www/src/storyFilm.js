// The story film (scripts/story-film.py): one continuous move through an architecture diagram
// drawn in chalk, with a stop for each chapter. It never runs on its own account: the scroll
// position picks the moment and the film glides to it. Scrolling it into view draws the diagram,
// reading on flies the camera, and scrolling back retraces it.
//
// It is not a video. A video can only be scrubbed by seeking, which is never quite smooth and is
// worst backwards. The film arrives as its frames (scripts/pack-film.mjs) and is drawn to a canvas,
// so any moment is as near as any other, in either direction.
//
// INTRO and FILM are the render's own numbers: the length of the opening in which the diagram is
// drawn, then each stop's seconds counted from the end of that opening.
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
const pack = (small) => `${import.meta.env.BASE_URL}clips/story-film${small ? '-small' : ''}.bin`;
// How long the picture takes to close most of the distance to where the scroll is: long enough to
// glide to rest when the wheel stops, short enough that it never feels behind the hand.
const GLIDE = .11;

export function setUpStoryFilm(story, reduced) {
  const canvas = story.querySelector('.story-film');
  if (!canvas) return () => {};
  const context = canvas.getContext('2d');
  const small = window.matchMedia('(max-width: 700px)');
  const loader = story.querySelector('.film-loader span');
  let bytes = null;
  let offsets = null;
  let count = 0;
  let fps = 24;
  let loaded = 0;
  let target = 0;
  let shown = 0;
  let drawn = -1;
  let frame = 0;
  let last = 0;
  // Decoded frames near the current moment. They are large, so only a window of them is kept.
  const decoded = new Map();
  const pending = new Set();
  const KEEP = small.matches ? 40 : 30;

  const available = () => {
    // Frames arrive in order, so the film can be scrubbed as far as it has downloaded.
    if (!offsets) return 0;
    let low = 0;
    let high = count;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (offsets[middle] <= loaded) low = middle; else high = middle - 1;
    }
    return low;
  };
  function want(index) {
    if (index < 0 || index >= available() || decoded.has(index) || pending.has(index) || pending.size >= 6) return;
    pending.add(index);
    createImageBitmap(new Blob([bytes.subarray(offsets[index], offsets[index + 1])], { type: 'image/webp' })).then((bitmap) => {
      pending.delete(index);
      decoded.set(index, bitmap);
      if (decoded.size > KEEP) {
        // Let go of whichever frame is furthest from where the film is now.
        let furthest = index;
        for (const key of decoded.keys()) if (Math.abs(key - shown * fps) > Math.abs(furthest - shown * fps)) furthest = key;
        decoded.get(furthest).close();
        decoded.delete(furthest);
      }
      wake();
    }).catch(() => pending.delete(index));
  }
  function paint(bitmap) {
    const scale = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.round(canvas.clientWidth * scale);
    const height = Math.round(canvas.clientHeight * scale);
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    // Fill the stage, keeping the side of the frame the scenes are composed on.
    const fit = Math.max(width / bitmap.width, height / bitmap.height);
    const across = small.matches ? .22 : 0;
    context.fillStyle = '#000';
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, (width - bitmap.width * fit) * across, (height - bitmap.height * fit) / 2, bitmap.width * fit, bitmap.height * fit);
  }
  function step(now) {
    frame = 0;
    if (!offsets) return;
    const elapsed = Math.min(.05, (now - last) / 1000 || .016);
    last = now;
    const gap = target - shown;
    shown = reduced.matches || Math.abs(gap) < .004 ? target : shown + gap * (1 - Math.exp(-elapsed / GLIDE));
    const limit = Math.max(0, available() - 1);
    const index = Math.min(limit, Math.max(0, Math.round(shown * fps)));
    // Decode this frame and the ones the scroll is heading for.
    const ahead = gap >= 0 ? 1 : -1;
    want(index);
    for (let reach = 1; reach <= 10; reach++) { want(index + ahead * reach); if (reach <= 3) want(index - ahead * reach); }
    // Draw the exact frame, or until it is ready the nearest one that is.
    let pick = -1;
    for (let reach = 0; reach <= 6 && pick < 0; reach++) {
      if (decoded.has(index - ahead * reach)) pick = index - ahead * reach;
      else if (decoded.has(index + ahead * reach)) pick = index + ahead * reach;
    }
    if (pick >= 0 && pick !== drawn) { paint(decoded.get(pick)); drawn = pick; }
    if (shown !== target || pick !== index || pending.size) frame = requestAnimationFrame(step);
  }
  function wake() { if (!frame) { last = performance.now(); frame = requestAnimationFrame(step); } }

  async function load() {
    const response = await fetch(pack(small.matches));
    if (!response.ok || !response.body) throw new Error('film');
    const reader = response.body.getReader();
    let head = new Uint8Array(0);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!bytes) {
        // The index comes first; once it is in, the size of everything else is known.
        const joined = new Uint8Array(head.length + value.length);
        joined.set(head);
        joined.set(value, head.length);
        head = joined;
        if (head.length < 20) continue;
        const view = new DataView(head.buffer);
        count = view.getUint32(4, true);
        const start = 20 + 4 * (count + 1);
        if (head.length < start) continue;
        fps = view.getUint32(8, true);
        offsets = new Uint32Array(count + 1);
        for (let index = 0; index <= count; index++) offsets[index] = view.getUint32(20 + 4 * index, true);
        bytes = new Uint8Array(offsets[count]);
        bytes.set(head);
        loaded = head.length;
      } else {
        bytes.set(value, loaded);
        loaded += value.length;
      }
      if (loader) loader.textContent = `chalking the board… ${Math.round(loaded / offsets[count] * 100)}%`;
      // The board opens as soon as the opening and the first chapter are in; the rest keeps arriving.
      if (story.dataset.film === undefined && available() > Math.min(count, fps * 7)) story.dataset.film = '';
      wake();
    }
    story.dataset.film = '';
    wake();
  }
  // The privacy rule against network calls is the editor's; this is the marketing site fetching its own asset.
  load().catch(() => { story.dataset.film = 'missing'; });
  window.addEventListener('resize', () => { drawn = -1; wake(); });

  return (time) => {
    target = Math.max(0, time + INTRO);
    wake();
  };
}
