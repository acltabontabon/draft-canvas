// A pencilled index of the story: one small sketch per chapter, down the margin. It shows where
// the reader is, how much is left, and takes them straight to the part they came for.
const GLYPHS = {
  present: 'M3 6.6q3-.4 6 0l-.1 5q-2.9.3-5.8 0z M15 12.2q3-.4 6 0l-.1 5q-2.9.3-5.8 0z M9 9.2h2.6q1.6 0 1.6 1.6v2.4q0 1.5 1.8 1.5',
  nodi: 'M5.6 8.6q6.4-1 12.8 0l.3 8.2q-6.7 1-13.4 0z M12 8V5.2 M11.2 4.4h1.6 M9.4 12v1.7 M14.6 12v1.7 M10 15.5q2 1 4 0',
  inside: 'M3.4 4.6q8.6-.8 17.2 0l-.3 14.8q-8.3.7-16.6 0z M8.8 9.8q3.6-.4 7.2 0l-.1 5.6q-3.5.3-7 0z',
  evidence: 'M8.2 7.2L3.6 12l4.6 4.8 M15.8 7.2l4.6 4.8-4.6 4.8 M13.6 5.4l-3.2 13.2',
  collaboration: 'M4.6 3.8l1.3 10 2.6-3.2 4 .2z M12.8 10.6l1.3 9.8 2.5-3.1 4 .1z',
  points: 'M8.8 9.2q.4-3.4 3.3-3.4 3 .1 3 2.8 0 1.7-1.8 2.6-1.4.8-1.4 2.6 M11.9 17.6v.4',
};
const RING = 'M12.4 1.6c6.4-.5 10.5 4.2 10.2 10.4S18.3 22.7 12 22.4 1.4 18.1 1.6 12 5.4 2.2 13.4 1.5';

export function setUpStoryRail(story, beats, jump) {
  const rail = document.createElement('nav');
  rail.className = 'story-rail';
  rail.setAttribute('aria-label', 'Chapters');
  rail.hidden = true;
  const marks = beats.map((beat, index) => {
    const mark = document.createElement('button');
    mark.type = 'button';
    mark.setAttribute('aria-label', beat.dataset.chapter);
    mark.innerHTML = `<span>${beat.dataset.chapter}</span><svg viewBox="0 0 24 24" aria-hidden="true">`
      + `<path class="rail-ring" pathLength="1" d="${RING}"/><path class="rail-glyph" transform="translate(4.4 4.4) scale(.63)" d="${GLYPHS[beat.dataset.recording]}"/></svg>`;
    mark.addEventListener('click', () => {
      // Land where the chapter's scene has arrived and its note is up, not on its first frame.
      const bounds = beat.getBoundingClientRect();
      jump(bounds.top + window.scrollY - window.innerHeight * .2 + bounds.height * .5);
    });
    mark.addEventListener('keydown', (event) => {
      const step = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1
        : event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 0;
      const next = marks[index + step];
      if (!step || !next) return;
      event.preventDefault();
      next.focus();
    });
    rail.append(mark);
    return mark;
  });
  story.append(rail);
  let shown = -2;
  return (current, visible) => {
    const index = visible ? beats.indexOf(current) : -1;
    if (index === shown) return;
    shown = index;
    rail.hidden = false;
    rail.toggleAttribute('data-open', visible);
    rail.inert = !visible;
    marks.forEach((mark, i) => {
      if (i === index) mark.setAttribute('aria-current', 'step');
      else mark.removeAttribute('aria-current');
      mark.toggleAttribute('data-read', i < index);
    });
  };
}
