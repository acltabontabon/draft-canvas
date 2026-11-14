const LIFT_TIME = 55;

function pencilAt(x, y, time, duration, opacity = 0.8) {
  return { transform: `translate(${x}px, ${y}px)`, offset: time / duration, opacity };
}

export function animateOverviewInk() {
  const page = document.documentElement;
  if (!Object.hasOwn(page.dataset, 'overviewInkPending')) return;
  delete page.dataset.overviewInkPending;

  const motion = matchMedia('(prefers-reduced-motion: no-preference)');
  if (!motion.matches) return;
  const overview = document.getElementById('features');
  const pencil = overview.querySelector('.features-pencil');
  const underline = overview.querySelector('.features-underline path');
  const rail = overview.querySelector('.feature-rail');
  const marks = overview.querySelectorAll('.feature-mark');
  const matrix = underline.getScreenCTM();
  if (!matrix) return;

  const origin = overview.getBoundingClientRect();
  const railBounds = rail.getBoundingClientRect();
  const railX = railBounds.left + railBounds.width / 2;
  const length = underline.getTotalLength();
  const underlineStart = 510;
  const underlineEnd = 810;
  const railStart = 1060;
  const railEnd = 1460;
  const markDuration = 120;
  const total = railEnd + markDuration;
  const at = (x, y, time, opacity) => pencilAt(x - origin.left, y - origin.top, time, total, opacity);
  const start = underline.getPointAtLength(0).matrixTransform(matrix);
  const end = underline.getPointAtLength(length).matrixTransform(matrix);
  const frames = [at(start.x - 4, start.y - 4, underlineStart - LIFT_TIME, 0)];
  // Sample the underline in screen coordinates so the tip follows the actual curve at every width.
  for (let sample = 0; sample <= 16; sample += 1) {
    const progress = sample / 16;
    const point = underline.getPointAtLength(length * progress).matrixTransform(matrix);
    frames.push(at(point.x, point.y, underlineStart + progress * (underlineEnd - underlineStart)));
  }
  frames.push(
    at((end.x + railX) / 2, (end.y + railBounds.top) / 2 - 12, (underlineEnd + railStart) / 2, 0.56),
    at(railX, railBounds.top, railStart),
    at(railX, railBounds.bottom, railEnd),
    at(railX + 4, railBounds.bottom - 4, railEnd + LIFT_TIME, 0),
  );

  function draw(path, start, duration) {
    return path.animate([
      { strokeDasharray: '1 1', strokeDashoffset: 1 },
      { strokeDasharray: '1 1', strokeDashoffset: 0 },
    ], { delay: start, duration, fill: 'backwards' });
  }

  const travel = pencil.animate(frames, { duration: total, fill: 'backwards' });
  const animations = [
    travel,
    draw(underline, underlineStart, underlineEnd - underlineStart),
    rail.animate([{ transform: 'scaleY(0)' }, { transform: 'scaleY(1)' }], {
      delay: railStart, duration: railEnd - railStart, fill: 'backwards',
    }),
  ];
  for (const mark of marks) {
    const { top, height } = mark.getBoundingClientRect();
    const progress = (top + height / 2 - railBounds.top) / railBounds.height;
    const delay = railStart + Math.max(0, Math.min(1, progress)) * (railEnd - railStart);
    animations.push(draw(mark.querySelector('path'), delay, markDuration));
  }
  const listeners = new AbortController();
  const cancel = () => animations.forEach((animation) => animation.cancel());
  window.addEventListener('resize', cancel, { signal: listeners.signal });
  motion.addEventListener('change', cancel, { signal: listeners.signal });
  const cleanUp = () => listeners.abort();
  void travel.finished.then(cleanUp, cleanUp);
}

export function leadIntoExhibit(canvas, from, destination, onArrival) {
  const pencil = canvas.querySelector('.exhibit-pencil');
  const startScroll = window.scrollY;
  const canvasTop = canvas.getBoundingClientRect().top;
  const duration = Math.abs(canvasTop) > 1 ? 460 : 300;
  return movePencil(pencil, from, { x: destination.x, y: destination.y - canvasTop }, duration, () => {
    canvas.scrollIntoView({ behavior: 'instant' });
    onArrival();
  }, (progress) => window.scrollTo({ top: startScroll + canvasTop * progress, behavior: 'instant' }));
}

function movePencil(pencil, from, destination, duration, onArrival, scroll) {
  let frame;
  const started = performance.now();
  const listeners = new AbortController();

  function cancel() {
    cancelAnimationFrame(frame);
    listeners.abort();
    pencil.classList.remove('pencil-travelling');
    pencil.style.removeProperty('transform');
    pencil.style.removeProperty('opacity');
  }

  function arrive() {
    cancel();
    onArrival();
  }

  function move(now) {
    const progress = Math.max(0, Math.min(1, (now - started) / duration));
    const eased = progress * progress * (3 - 2 * progress);
    const x = from.x + (destination.x - from.x) * eased;
    const y = from.y + (destination.y - from.y) * eased - 48 * eased * (1 - eased);
    scroll(eased);
    pencil.style.transform = `translate(${x}px, ${y}px)`;
    pencil.style.opacity = String(Math.min(0.84, progress * 5));
    if (progress === 1) arrive();
    else frame = requestAnimationFrame(move);
  }

  pencil.classList.add('pencil-travelling');
  window.addEventListener('resize', arrive, { signal: listeners.signal });
  move(started);
  return cancel;
}

export function traceWithPencil(canvas, path, label) {
  const matrix = path.getScreenCTM();
  if (!matrix) return () => {};

  // The showcased route is straight, so the pencil can follow the same stroke from end to end.
  const length = path.getTotalLength();
  const origin = canvas.getBoundingClientRect();
  const start = path.getPointAtLength(0).matrixTransform(matrix);
  const end = path.getPointAtLength(length).matrixTransform(matrix);
  const pencil = canvas.querySelector('.exhibit-pencil');
  const duration = 480;
  const total = duration + LIFT_TIME;
  const trace = path.cloneNode(false);
  trace.removeAttribute('marker-end');
  trace.setAttribute('aria-hidden', 'true');
  path.after(trace);

  const animations = [
    trace.animate([
      { strokeDasharray: `${length} ${length}`, strokeDashoffset: length },
      { strokeDasharray: `${length} ${length}`, strokeDashoffset: 0 },
    ], { duration, fill: 'both' }),
    path.animate([{ opacity: 0 }, { opacity: 1 }], { delay: duration, duration: 75, fill: 'backwards' }),
    label.animate([{ opacity: 0 }, { opacity: 1 }], { delay: duration, duration: 145, fill: 'backwards' }),
    pencil.animate([
      pencilAt(start.x - origin.left, start.y - origin.top, 0, total, 0),
      pencilAt(start.x - origin.left + (end.x - start.x) * 45 / duration,
        start.y - origin.top + (end.y - start.y) * 45 / duration, 45, total),
      pencilAt(end.x - origin.left, end.y - origin.top, duration, total),
      pencilAt(end.x - origin.left + 4, end.y - origin.top - 4, total, total, 0),
    ], { duration: total }),
  ];
  const removeTrace = () => trace.remove();
  void animations[1].finished.then(removeTrace, removeTrace);
  return () => {
    for (const animation of animations) animation.cancel();
    removeTrace();
  };
}

const SKETCH_SHAPES = ':is(path, rect, ellipse, circle, line, polygon, polyline)[stroke]:not([stroke="none"])';

function transformInDrawing(shape, drawing) {
  // Use the SVG's own transforms so a detached draft copy keeps every parent offset and scale.
  let result = new DOMMatrix();
  for (let element = shape; element !== drawing; element = element.parentElement) {
    const transforms = element.transform.baseVal;
    for (let index = transforms.numberOfItems - 1; index >= 0; index -= 1) {
      const { a, b, c, d, e, f } = transforms.getItem(index).matrix;
      result.preMultiplySelf(new DOMMatrix([a, b, c, d, e, f]));
    }
  }
  return result;
}

function sketchCopy(shape, drawing, className) {
  const copy = shape.cloneNode(true);
  copy.setAttribute('transform', transformInDrawing(shape, drawing).toString());
  copy.setAttribute('class', className);
  for (const attr of ['filter', 'marker-start', 'marker-mid', 'marker-end', 'stroke-dasharray']) copy.removeAttribute(attr);
  return copy;
}

function sketchLabel(label, drawing, svgScale) {
  const bounds = label.getBBox();
  if (!bounds.width || !bounds.height) return [];
  const matrix = transformInDrawing(label, drawing);
  const left = bounds.x - 2;
  const width = bounds.width + 4;
  const baseline = label.y.baseVal.getItem(0).value;
  return [{
    label, left, width, bounds,
    pointAt: (fraction) => matrix.transformPoint({ x: left + width * fraction, y: baseline }),
    screenLength: width * Math.hypot(matrix.a, matrix.b) * svgScale,
  }];
}

export function drawWithPencil(canvas, art, order, onComplete, enter) {
  const finished = art.querySelector('.system-graph');
  const sheet = art.closest('.system-example').querySelector('[data-exhibit-sketch-sheet]');
  const svg = sheet ? sheet.content.firstElementChild.cloneNode(true) : finished;
  if (sheet) {
    svg.setAttribute('visibility', 'hidden');
    art.append(svg);
    order = svg.dataset.sketchOrder;
  }
  function removeSheet() {
    if (sheet) svg.remove();
  }
  const drawing = svg.querySelector('[role="img"] > g');
  const parts = new Map(Array.from(drawing.querySelectorAll(':scope > [data-diagram-node], :scope > [data-diagram-edge]'),
    (part) => [part.dataset.diagramNode ?? part.dataset.diagramEdge, part]));
  const scene = drawing.closest('[role="img"]');
  const screen = drawing.getScreenCTM();
  if (!screen) return removeSheet();
  const svgScale = Math.hypot(screen.a, screen.b);
  const labels = new Map(Array.from(drawing.querySelectorAll('[data-diagram-edge-labels]'),
    (part) => [part.dataset.diagramEdgeLabels, part]));
  const ids = new Set([...(order?.split(/\s+/) ?? []), ...parts.keys()]);
  const strokes = Array.from(ids).flatMap((id) => {
    const part = parts.get(id);
    const shapes = part ? Array.from(part.querySelectorAll(SKETCH_SHAPES)) : [];
    const shape = shapes[0];
    const length = shape?.getTotalLength();
    if (!length) return [];
    const matrix = transformInDrawing(shape, drawing);
    const pointAt = (fraction) => matrix.transformPoint(shape.getPointAtLength(length * fraction));
    const screenLength = length * Math.hypot(matrix.a, matrix.b) * svgScale;
    const lettering = Array.from((labels.get(id) ?? part).querySelectorAll('text'))
      .flatMap((label) => sketchLabel(label, drawing, svgScale));
    return [{ id, shape, details: shapes.slice(1), lettering, pointAt, screenLength }];
  });
  if (!strokes.length) return removeSheet();

  const handoff = 440;
  const hold = 650;
  const leadIn = 80;
  const inkFade = 160;
  const maxDuration = 5000;
  const singleViewPace = strokes.length > 20 ? 0.65 : 0.75;
  const pace = sheet ? 0.36 : singleViewPace;
  const pencil = canvas.querySelector('.exhibit-pencil');
  const animations = [];
  const frames = [];
  const filters = document.createElementNS(svg.namespaceURI, 'filter');
  filters.id = 'exhibit-pencil-grain';
  const texture = document.createElementNS(svg.namespaceURI, 'feTurbulence');
  texture.setAttribute('type', 'fractalNoise');
  texture.setAttribute('baseFrequency', '0.11');
  texture.setAttribute('numOctaves', '2');
  const wobble = document.createElementNS(svg.namespaceURI, 'feDisplacementMap');
  wobble.setAttribute('in', 'SourceGraphic');
  wobble.setAttribute('scale', '2.7');
  filters.append(texture, wobble);
  const draft = document.createElementNS(svg.namespaceURI, 'g');
  draft.setAttribute('class', 'exhibit-draft');
  draft.setAttribute('aria-hidden', 'true');
  draft.setAttribute('transform', drawing.getAttribute('transform') ?? '');
  draft.setAttribute('filter', 'url(#exhibit-pencil-grain)');
  draft.append(filters);
  // Keep the pencil in the same coordinate space as the ink, including when the canvas scrolls.
  const draftPencil = document.createElementNS(svg.namespaceURI, 'image');
  draftPencil.setAttribute('class', 'exhibit-draft-pencil');
  draftPencil.setAttribute('aria-hidden', 'true');
  draftPencil.setAttribute('href', pencil.currentSrc || pencil.src);
  const pencilSize = 20 / svgScale;
  draftPencil.setAttribute('width', pencilSize);
  draftPencil.setAttribute('height', pencilSize);
  draftPencil.setAttribute('x', -2 / svgScale);
  draftPencil.setAttribute('y', -18 / svgScale);
  let time = 0;
  let previous;
  const steps = [];

  function schedule(step, duration, maxLift) {
    const startPoint = step.pointAt(0);
    const distance = previous ? Math.hypot(startPoint.x - previous.x, startPoint.y - previous.y) : 0;
    step.lift = Math.max(32, Math.min(maxLift, 32 + distance * svgScale * 0.25) * pace);
    time += step.lift;
    step.start = time;
    step.duration = duration * pace;
    time += step.duration;
    previous = step.pointAt(1);
    steps.push(step);
  }

  for (const stroke of strokes) {
    schedule(stroke, Math.min(420, 95 + stroke.screenLength * 0.5), 125);
    for (const line of stroke.lettering) {
      schedule(line, Math.min(270, 65 + line.screenLength * 1.15), 52);
    }
  }
  // Fit the drawing into the available time while keeping the hold and crossfade readable.
  const drawingBudget = maxDuration - leadIn - hold - handoff;
  const drawingScale = Math.min(1, drawingBudget / (time + inkFade));
  for (const step of steps) {
    step.start = leadIn + step.start * drawingScale;
    step.duration *= drawingScale;
    step.lift *= drawingScale;
  }
  const revealAt = leadIn + Math.min(drawingBudget, (time + inkFade) * drawingScale) + hold;
  const total = revealAt + handoff;
  function pencilFrame(point, at, opacity, lift = 0) {
    return pencilAt(point.x, point.y - lift / svgScale, at, total, opacity);
  }

  function showInk(element, delay, duration) {
    animations.push(element.animate([{ opacity: 0 }, { opacity: 1 }], {
      delay, duration, fill: 'backwards', easing: 'ease-out',
    }));
  }

  function addInk(shape, className, delay) {
    const copy = sketchCopy(shape, drawing, className);
    draft.append(copy);
    showInk(copy, delay, inkFade * drawingScale);
  }

  function followInk(step) {
    const { pointAt, screenLength, start, duration, lift } = step;
    const finish = start + duration;
    if (!enter || step !== strokes[0]) {
      frames.push(pencilFrame(pointAt(0), start - Math.min(22, lift * 0.7), 0, 4));
    }
    const samples = Math.max(8, Math.ceil(screenLength / 8));
    for (let sample = 0; sample <= samples; sample += 1) {
      const fraction = sample / samples;
      frames.push(pencilFrame(pointAt(fraction), start + fraction * duration, 0.84));
    }
    frames.push(pencilFrame(pointAt(1), finish + 8 * drawingScale, 0, 4));
  }

  let nextClip = 0;
  function writeLabel(lettering) {
    const { label, bounds, left, width, start, duration } = lettering;
    const clip = document.createElementNS(svg.namespaceURI, 'clipPath');
    clip.id = `exhibit-lettering-${nextClip++}`;
    const aperture = document.createElementNS(svg.namespaceURI, 'rect');
    aperture.setAttribute('x', left);
    aperture.setAttribute('y', bounds.y - 6);
    aperture.setAttribute('height', bounds.height + 12);
    clip.append(aperture);

    const copy = sketchCopy(label, drawing, 'exhibit-sketch-label');
    const line = document.createElementNS(svg.namespaceURI, 'g');
    line.setAttribute('transform', copy.getAttribute('transform'));
    line.setAttribute('clip-path', `url(#${clip.id})`);
    copy.removeAttribute('transform');
    line.append(copy);
    draft.append(clip, line);
    animations.push(aperture.animate([{ width: '0px' }, { width: `${width}px` }], {
      delay: start, duration, fill: 'both',
    }));
    followInk(lettering);
  }

  for (const stroke of strokes) {
    const { id, shape, details, lettering, start, duration } = stroke;
    const finish = start + duration;
    const trace = sketchCopy(shape, drawing, 'exhibit-sketch-stroke');
    trace.dataset.sketchPart = id;
    trace.setAttribute('pathLength', '1');
    draft.append(trace);
    animations.push(trace.animate([
      { strokeDashoffset: 1, opacity: 0 },
      { strokeDashoffset: 0.97, opacity: 1, offset: 0.03 },
      { strokeDashoffset: 0, opacity: 1 },
    ], { delay: start, duration, fill: 'both' }));

    for (const detail of details) addInk(detail, 'exhibit-sketch-detail', finish - Math.min(duration, 35 * drawingScale));
    for (const route of [shape, ...details].filter((part) => part.hasAttribute('marker-end'))) {
      // Sketch the head after its route so arrows never appear ahead of the pencil.
      const arrow = sketchCopy(route, drawing, 'exhibit-sketch-arrowhead');
      arrow.setAttribute('marker-end', route.getAttribute('marker-end'));
      draft.append(arrow);
      showInk(arrow, finish, inkFade * drawingScale);
    }

    followInk(stroke);
    for (const line of lettering) writeLabel(line);
  }
  scene.before(draft);
  draft.append(draftPencil);
  if (sheet) {
    scene.setAttribute('visibility', 'hidden');
    svg.removeAttribute('visibility');
  }
  for (const layer of finished.querySelectorAll(':scope > [role="img"], :scope > [data-attachment-trigger], :scope > [data-exhibit-enter]')) {
    showInk(layer, revealAt, handoff);
  }
  animations.push(draft.animate([{ opacity: 1 }, { opacity: 0 }], {
    delay: revealAt, duration: handoff, fill: 'both', easing: 'ease-in-out',
  }));
  if (enter) frames.unshift(pencilFrame(strokes[0].pointAt(0), 0, 0.84));
  frames.push({ ...frames.at(-1), offset: 1 });
  const travel = draftPencil.animate(frames, { duration: total });
  animations.push(travel);

  let cancelEntrance;
  if (enter) {
    // The HTML pencil leads the transition. The SVG pencil takes over at the same tip position.
    draftPencil.setAttribute('visibility', 'hidden');
    for (const animation of animations) {
      animation.pause();
      animation.currentTime = 0;
    }
    const start = strokes[0].pointAt(0);
    cancelEntrance = enter(new DOMPoint(start.x, start.y).matrixTransform(screen), () => {
      draftPencil.removeAttribute('visibility');
      for (const animation of animations) animation.play();
    });
  }

  function cancel() {
    cancelEntrance?.();
    for (const animation of animations) animation.cancel();
    draft.remove();
    removeSheet();
  }

  void travel.finished.then(() => {
    cancel();
    onComplete();
  }, () => {});
  return cancel;
}
