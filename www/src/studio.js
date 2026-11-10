import { FILM, INTRO, setUpStoryFilm } from './storyFilm.js';
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
  const renderFilm = setUpStoryFilm(story, reduced);
  // The film never waits: every pixel of scroll is a moment of it. These are the scroll positions at
  // which the film must be at each stop; between them it runs evenly.
  function stopsNow() {
    const viewport = window.innerHeight;
    const page = (element) => element.getBoundingClientRect().top + window.scrollY;
    const endingTop = page(ending);
    const journey = page(story);
    return [
      // Scrolling the board into view draws the diagram; by the time it fills the screen the story can start.
      [journey - viewport * .8, -INTRO],
      [journey, 0],
      ...beats.map((beat) => [page(beat) - viewport * .2, FILM[beat.dataset.recording][0]]),
      [endingTop - viewport * .55, FILM.ending[0]],
      [endingTop - viewport * .05, FILM.ending[1]],
    ];
  }
  // Read one way it turns a scroll position into the film's moment; read the other way, a moment into a scroll position.
  function across(stops, value, from, to) {
    for (let index = 1; index < stops.length; index++) {
      const a = stops[index - 1];
      const b = stops[index];
      if (value <= b[from] || index === stops.length - 1) return a[to] + (b[to] - a[to]) * clamp((value - a[from]) / Math.max(.001, b[from] - a[from]));
    }
    return stops[0][to];
  }
  // The index does not teleport. It scrolls the page there itself, easing in and out and in no
  // hurry, and since the film is locked to the scroll, every scene on the way goes by, either way.
  let trip = 0;
  const endTrip = () => { cancelAnimationFrame(trip); trip = 0; };
  const renderRail = setUpStoryRail(story, beats, (top) => {
    endTrip();
    if (reduced.matches) { window.scrollTo({ top, behavior: 'instant' }); return; }
    const from = window.scrollY;
    const start = performance.now();
    const duration = Math.max(1400, Math.min(6000, Math.abs(top - from) * 1.1));
    const tick = (now) => {
      const u = clamp((now - start) / duration);
      // Slow away, steady across, slow to rest.
      window.scrollTo({ top: from + (top - from) * (u * u * u * (u * (u * 6 - 15) + 10)), behavior: 'instant' });
      trip = u < 1 ? requestAnimationFrame(tick) : 0;
    };
    trip = requestAnimationFrame(tick);
  });
  // The reader's own scroll always wins.
  for (const type of ['wheel', 'touchstart', 'keydown']) window.addEventListener(type, endTrip, { passive: true });
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
    const stops = stopsNow();
    let time = across(stops, window.scrollY, 0, 1);
    // With reduced motion the film only ever shows its stops, never the travel between them.
    if (reduced.matches) time = stops.reduce((last, [at, moment]) => (at <= window.scrollY ? moment : last), 0);
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
