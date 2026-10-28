import { setUpRecordedStory } from './recordedStory.js';
import { setUpSketchDrawing } from './sketchDrawing.js';
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

  const story = document.querySelector('.canvas-story');
  const world = story.querySelector('.canvas-world');
  const opening = story.querySelector('.story-opening');
  const clamp = (value) => Math.max(0, Math.min(1, value));
  const ease = (value) => { const t = clamp(value); return t * t * (3 - 2 * t); };
  const beats = [...story.querySelectorAll('[data-recording]')];
  const renderRecording = setUpRecordedStory(story, reduced);
  const connection = story.querySelector('.world-connection path');
  connection.classList.add('scroll-stroke');
  let frame = 0;
  function update() {
    frame = 0;
    const viewport = window.innerHeight;
    const bounds = opening.getBoundingClientRect();
    const progress = clamp(-bounds.top / Math.max(1, bounds.height * .85));
    const artHeight = art.querySelector('.art-crop').getBoundingClientRect().height;
    world.style.setProperty('--camera-y', `${-artHeight * progress}px`);
    world.style.setProperty('--meeting-opacity', String(.95 - progress * .7));
    const firstTop = beats[0].getBoundingClientRect().top;
    const line = clamp((viewport * .95 - firstTop) / (viewport * .25));
    connection.style.strokeDashoffset = String(1 - line);
    connection.style.opacity = line > 0 ? '1' : '0';
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
    // The next chapter must not ghost through the opening on tall screens.
    const reveal = line < 1 ? 0 : clamp((viewport * .7 - firstTop) / (viewport * .4));
    const visible = reveal > 0;
    world.style.setProperty('--recording-reveal', String(reveal));
    story.querySelector('.recorded-art').style.visibility = visible ? 'visible' : 'hidden';
    // Copy is pinned in reading position before the first frame advances.
    renderRecording(current.dataset.recording, visible, rect.top <= viewport * .04 && Number(world.style.getPropertyValue('--chapter-opacity')) > .98);
  }
  function requestUpdate() { if (!frame) frame = requestAnimationFrame(update); }
  window.addEventListener('scroll', requestUpdate, { passive: true });
  window.addEventListener('resize', requestUpdate);
  reduced.addEventListener('change', requestUpdate);
  update();

  const dialog = document.getElementById('editor-film');
  const video = document.getElementById('editor-film-video');
  document.getElementById('watch-editor').addEventListener('click', () => {
    video.src = editorDemo;
    dialog.showModal();
    video.play().catch(() => {});
  });
  document.getElementById('close-editor-film').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => video.pause());
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
}
