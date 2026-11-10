import { FILM, setUpStoryFilm } from './storyFilm.js';
import { setUpStoryRail } from './storyRail.js';
import editorDemo from '../../docs/media/demo.mp4?url';

export function setUpStudio() {
  const story = document.querySelector('.canvas-story');
  if (!story) return;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const clamp = (value) => Math.max(0, Math.min(1, value));
  const ease = (value) => { const t = clamp(value); return t * t * (3 - 2 * t); };
  const beats = [...story.querySelectorAll('[data-recording]')];
  const ending = story.querySelector('.story-ending');
  const renderRail = setUpStoryRail(story, beats);
  const renderFilm = setUpStoryFilm(story, reduced);
  let frame = 0;
  function update() {
    frame = 0;
    const viewport = window.innerHeight;
    const line = viewport * .2;
    const tops = beats.map((beat) => beat.getBoundingClientRect().top);
    const endingTop = ending.getBoundingClientRect().top;
    let current = 0;
    tops.forEach((top, index) => { if (top < line) current = index; });
    // One chapter's note leaves before the next arrives.
    beats.forEach((beat, index) => {
      const enter = ease((line - tops[index]) / (viewport * .16));
      // The last note makes way for the ending before the camera pulls back.
      const leave = ease(((tops[index + 1] ?? endingTop - viewport * .45) - line) / (viewport * .16));
      beat.toggleAttribute('data-away', enter * leave < .02);
      beat.style.setProperty('--chapter-opacity', String(enter * leave));
      beat.style.setProperty('--chapter-shift', `${reduced.matches ? 0 : (1 - enter) * 18 - (1 - leave) * 18}px`);
    });
    // The film never waits: every pixel of scroll is a moment of it. These are the scroll positions,
    // measured from here, at which the film must be at each stop; between them it runs evenly.
    const stops = [
      [-window.scrollY, 0],
      ...beats.map((beat, index) => [tops[index] - line, FILM[beat.dataset.recording][0]]),
      [endingTop - viewport * .55, FILM.ending[0]],
      [endingTop - viewport * .05, FILM.ending[1]],
    ];
    let time = stops.at(-1)[1];
    for (let index = 1; index < stops.length; index++) {
      const [from, start] = stops[index - 1];
      const [to, end] = stops[index];
      if (to <= 0) continue;
      // With reduced motion the film only ever shows its stops, never the travel between them.
      const amount = reduced.matches ? 0 : clamp(-from / Math.max(1, to - from));
      time = start + (end - start) * amount;
      break;
    }
    renderFilm(time);
    renderRail(beats[current], tops[0] < viewport * .5 && endingTop > viewport * .55);
    // The ending's words arrive with the pull-back, once the last scene has let go of the screen.
    ending.style.setProperty('--ending-opacity', String(ease((viewport * .45 - endingTop) / (viewport * .25))));
    if (endingTop < viewport * .5) ending.dataset.inked = '';
  }
  function requestUpdate() { if (!frame) frame = requestAnimationFrame(update); }
  window.addEventListener('scroll', requestUpdate, { passive: true });
  window.addEventListener('resize', requestUpdate);
  reduced.addEventListener('change', requestUpdate);
  update();

  // The one recording of the real editor: fetched only when asked for, here or from the ending.
  const video = document.getElementById('editor-film-video');
  const load = () => { if (!video.getAttribute('src')) video.src = editorDemo; };
  video.addEventListener('play', load);
  video.addEventListener('pointerdown', load, { once: true });
  video.addEventListener('focus', load, { once: true });
  document.getElementById('watch-editor').addEventListener('click', () => {
    load();
    video.scrollIntoView({ behavior: reduced.matches ? 'auto' : 'smooth', block: 'center' });
    video.play().catch(() => {});
  });
}
