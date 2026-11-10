// The story film (scripts/story-film.py): one continuous move through the whiteboard's diagram,
// with a stop for each chapter. It never plays on its own. The scroll position picks the moment,
// and the film eases toward it, so reading down the page flies the camera and scrolling back
// retraces it. These are the film's seconds for each stop, the same numbers the render uses.
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
const clip = `${import.meta.env.BASE_URL}clips/story-film.mp4`;

export function setUpStoryFilm(story, reduced) {
  const video = story.querySelector('.story-film');
  if (!video) return () => {};
  let target = 0;
  let shown = -1;
  let frame = 0;
  let ready = false;

  function step() {
    frame = 0;
    if (!ready) return;
    const gap = target - shown;
    if (Math.abs(gap) < .015) return;
    // A seek in flight is left to land; asking again mid-seek only makes the decoder start over.
    if (!video.seeking) {
      shown = shown < 0 || reduced.matches || Math.abs(gap) < .04 ? target : shown + gap * .2;
      video.currentTime = shown;
    }
    frame = requestAnimationFrame(step);
  }
  video.muted = true;
  video.addEventListener('loadeddata', () => { ready = true; story.dataset.film = ''; if (!frame) frame = requestAnimationFrame(step); }, { once: true });
  video.addEventListener('error', () => { ready = false; delete story.dataset.film; });
  video.preload = 'auto';
  video.src = clip;
  video.load();

  return (time, opacity) => {
    target = time;
    video.style.setProperty('--film-opacity', opacity.toFixed(3));
    if (!frame) frame = requestAnimationFrame(step);
  };
}
