// The story film (scripts/story-film.py): one continuous move through an architecture diagram
// drawn in chalk, with a stop for each chapter. On arrival it plays its opening, in which the
// diagram is drawn. After that the scroll position picks the moment and the film glides to it:
// reading down the page flies the camera, and scrolling back retraces it. INTRO and FILM are the
// render's own numbers: the opening's length, then each stop's seconds counted from its end.
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
const clip = (small) => `${import.meta.env.BASE_URL}clips/story-film${small ? '-small' : ''}.mp4`;

export function setUpStoryFilm(story, reduced) {
  const video = story.querySelector('.story-film');
  if (!video) return () => {};
  let target = INTRO;
  let frame = 0;
  let ready = false;
  let opening = false;

  function step() {
    frame = 0;
    if (!ready) return;
    if (opening) {
      // The opening plays as an ordinary film; it ends at the story's first frame, or the moment the reader scrolls on.
      if (video.currentTime >= INTRO - .04 || target > INTRO + .08) opening = false;
      frame = requestAnimationFrame(step);
      return;
    }
    const at = video.currentTime;
    const gap = target - at;
    if (reduced.matches) {
      if (Math.abs(gap) > .02 && !video.seeking) video.currentTime = target;
      if (Math.abs(gap) > .02) frame = requestAnimationFrame(step);
      return;
    }
    if (gap > .045) {
      // Forwards, the film is simply played, at a speed that falls as it nears the moment the scroll
      // asked for. Decoded in order it never drops a frame, and it glides to rest instead of halting.
      if (gap > 3.5 && !video.seeking) video.currentTime = target - 1.2;
      video.playbackRate = Math.max(.2, Math.min(4, gap * 3));
      if (video.paused) video.play().catch(() => {});
    } else {
      if (!video.paused) video.pause();
      if (gap > -.045) return;
      // Backwards there is nothing to play, so it steps back through the film, each step shorter than the last.
      if (!video.seeking) video.currentTime = gap < -3.5 ? target + 1.2 : at + gap * .3;
    }
    frame = requestAnimationFrame(step);
  }
  function begin() {
    if (ready) return;
    ready = true;
    story.dataset.film = '';
    if (!reduced.matches && target <= INTRO + .08) {
      opening = true;
      video.currentTime = 0;
      video.playbackRate = 1;
      video.play().catch(() => { opening = false; });
    }
    if (!frame) frame = requestAnimationFrame(step);
  }
  video.muted = true;
  // Scrubbing wants the film in hand, so the board waits for it, but not forever on a slow line.
  video.addEventListener('canplaythrough', begin, { once: true });
  video.addEventListener('loadeddata', () => setTimeout(begin, 3500), { once: true });
  video.addEventListener('error', () => { ready = false; story.dataset.film = 'missing'; });
  video.preload = 'auto';
  video.src = clip(window.matchMedia('(max-width: 700px)').matches);
  video.load();

  return (time) => {
    target = time + INTRO;
    if (!frame) frame = requestAnimationFrame(step);
  };
}
