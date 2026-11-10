import { setUpHeroDepth } from './heroDepth.js';
import { setUpSketchDrawing } from './sketchDrawing.js';
import { FILM, setUpStoryFilm } from './storyFilm.js';
import { setUpStoryRail } from './storyRail.js';
import editorDemo from '../../docs/media/demo.mp4?url';

export function setUpStudio() {
  const art = document.querySelector('.studio-art');
  if (!art) return;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const caption = document.getElementById('art-caption-text');
  const descriptions = {
    flow: 'A request moves through the architecture.',
    depth: 'The big picture holds another picture inside.',
    nodi: 'Your own agent. Another way to see the system.',
    together: 'Different perspectives, drawing on the same canvas.',
    questions: 'Some questions belong in the picture.',
  };
  for (const zone of art.querySelectorAll('.art-zone')) {
    const engage = () => {
      if (art.dataset.drawing) return;
      art.dataset.ink = zone.dataset.topic;
      caption.textContent = descriptions[zone.dataset.topic];
    };
    zone.addEventListener('pointerenter', engage);
    zone.addEventListener('pointermove', (event) => {
      engage();
      if (zone.dataset.topic === 'flow') {
        const bounds = zone.getBoundingClientRect();
        art.style.setProperty('--flow-progress', String(Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width))));
      }
    });
    zone.addEventListener('focus', engage);
    zone.addEventListener('pointerleave', () => { delete art.dataset.ink; });
    zone.addEventListener('blur', () => { delete art.dataset.ink; });
    zone.addEventListener('click', () => {
      engage();
      art.style.setProperty('--flow-progress', '1');
    });
  }
  setUpSketchDrawing(art, reduced);
  setUpHeroDepth(art, reduced);

  const story = document.querySelector('.canvas-story');
  const world = story.querySelector('.canvas-world');
  const opening = story.querySelector('.story-opening');
  const clamp = (value) => Math.max(0, Math.min(1, value));
  const ease = (value) => { const t = clamp(value); return t * t * (3 - 2 * t); };
  const beats = [...story.querySelectorAll('[data-recording]')];
  const renderRail = setUpStoryRail(story, beats);
  const renderFilm = setUpStoryFilm(story, reduced);
  // This much of a chapter's scroll flies the camera to its stop; the rest holds there to be read.
  const FLIGHT = .55;
  const lerp = ([from, to], amount) => from + (to - from) * clamp(amount);
  const ending = story.querySelector('.story-ending');
  let frame = 0;
  function update() {
    frame = 0;
    const viewport = window.innerHeight;
    const bounds = opening.getBoundingClientRect();
    const progress = clamp(-bounds.top / Math.max(1, bounds.height * .85));
    const artHeight = art.querySelector('.art-crop').getBoundingClientRect().height;
    world.style.setProperty('--camera-y', `${-artHeight * progress}px`);
    // The drawing hands over to the film completely; a ghost of it would sit across every chapter.
    world.style.setProperty('--meeting-opacity', String(.95 * (1 - progress)));
    const firstTop = beats[0].getBoundingClientRect().top;
    let current = beats[0];
    for (const beat of beats) if (beat.getBoundingClientRect().top < viewport * .2) current = beat;
    // The outgoing pair clears before the incoming pair enters, avoiding overlapping diagrams.
    for (let index = 0; index < beats.length; index++) {
      const beat = beats[index];
      const top = beat.getBoundingClientRect().top;
      const nextTop = beats[index + 1]?.getBoundingClientRect().top ?? Infinity;
      const enter = index === 0 ? 1 : ease((viewport * .2 - top) / (viewport * .16));
      const leave = ease((nextTop - viewport * .2) / (viewport * .16));
      const opacity = enter * leave;
      const shift = reduced.matches ? 0 : (1 - enter) * 18 - (1 - leave) * 18;
      beat.style.setProperty('--chapter-opacity', String(opacity));
      beat.style.setProperty('--chapter-shift', `${shift}px`);
      if (beat === current) {
        world.style.setProperty('--chapter-opacity', String(opacity));
        world.style.setProperty('--chapter-shift', `${shift}px`);
      }
    }
    const rect = current.getBoundingClientRect();
    // How far through its flight the current chapter is: under 1 the film is travelling, past 1 it has arrived.
    const flight = (viewport * .2 - rect.top) / (rect.height * FLIGHT);
    const endingTop = ending.getBoundingClientRect().top;
    const closing = clamp((viewport * .95 - endingTop) / (viewport * .75));
    // The film leads into the opening as the drawing slides away, then each chapter takes it further.
    let time = lerp(FILM.dive, progress);
    if (flight > 0) time = lerp(FILM[current.dataset.recording], reduced.matches ? 1 : flight);
    if (closing > 0) time = lerp(FILM.ending, reduced.matches ? 1 : closing);
    renderFilm(time, clamp(progress * 2));
    renderRail(current, firstTop < viewport * .5 && endingTop > viewport * .55);
    if (endingTop < viewport * .7) ending.dataset.inked = '';
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
