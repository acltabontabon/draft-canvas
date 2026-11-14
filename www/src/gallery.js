import { playExhibitBrief } from './canvas-intro.js';
import { drawWithPencil, leadIntoExhibit, traceWithPencil } from './pencil.js';

function positionCanvasAnnotation(figure, annotation, anchor, targets, gap = 14, avoidHighlightedEdges = false) {
  const canvas = figure.getBoundingClientRect();
  const art = anchor.closest('.example-art');
  const artBounds = art.getBoundingClientRect();
  const target = anchor.getBoundingClientRect();
  const left = Math.max(artBounds.left, 0) + gap;
  const top = Math.max(artBounds.top + parseFloat(getComputedStyle(art).paddingTop), 0) + gap;
  const right = Math.min(artBounds.right, document.documentElement.clientWidth) - gap;
  const bottom = Math.min(artBounds.bottom, innerHeight) - gap;
  const { offsetWidth: width, offsetHeight: height } = annotation;

  if (right - left < width || bottom - top < height
      || target.right < left || target.left > right || target.bottom < top || target.top > bottom) {
    return false;
  }

  const middleX = (target.left + target.right - width) / 2;
  const middleY = (target.top + target.bottom - height) / 2;
  const obstacles = targets
    .filter((element) => element.closest('.example-art') === art && !element.dataset.diagramEdge)
    .map((element) => element.getBoundingClientRect())
    // A boundary can contain a note. Its full interior is available space.
    .filter((rect) => rect.width < artBounds.width * 0.45 && rect.height < artBounds.height * 0.45);
  obstacles.push(target);

  const candidates = [
    [target.right + gap, middleY],
    [target.left - width - gap, middleY],
    [middleX, target.top - height - gap],
    [middleX, target.bottom + gap],
  ];
  if (avoidHighlightedEdges) {
    for (const edge of targets) {
      if (!edge.dataset.diagramEdge || !edge.hasAttribute('data-note-target') || edge.closest('.example-art') !== art) continue;
      for (const path of edge.querySelectorAll('path[marker-end]')) {
        const { left, right, top, bottom } = path.getBoundingClientRect();
        // A straight SVG path's bounds can have zero height or width, even with a visible stroke.
        obstacles.push({ left: left - 5, right: right + 5, top: top - 5, bottom: bottom + 5 });
      }
    }
    candidates.push(
      [target.left - width - gap, target.top - height - gap],
      [target.right + gap, target.top - height - gap],
      [target.left - width - gap, target.bottom + gap],
      [target.right + gap, target.bottom + gap],
    );
  }
  const positions = candidates.map(([x, y]) => {
    const clampedX = Math.max(left, Math.min(x, right - width));
    const clampedY = Math.max(top, Math.min(y, bottom - height));
    const overlap = obstacles.reduce((area, rect) => area
      + Math.max(0, Math.min(clampedX + width, rect.right) - Math.max(clampedX, rect.left))
      * Math.max(0, Math.min(clampedY + height, rect.bottom) - Math.max(clampedY, rect.top)), 0);
    return { x: clampedX, y: clampedY, score: overlap + Math.hypot(clampedX - x, clampedY - y) };
  });
  const best = positions.reduce((first, next) => next.score < first.score ? next : first);
  annotation.style.left = `${best.x - canvas.left}px`;
  annotation.style.top = `${best.y - canvas.top}px`;
  return true;
}

function diagramId({ dataset }) {
  return dataset.diagramNode ?? dataset.diagramEdge ?? dataset.diagramEdgeLabels
    ?? dataset.diagramOpenPoint ?? dataset.attachmentTrigger ?? dataset.exhibitEnter.split('/').at(-1);
}

function setUpNoteHighlights(figure, playTrace) {
  const note = figure.querySelector('.exhibit-note');
  const diagramTarget = '[data-diagram-node], [data-diagram-edge], [data-diagram-edge-labels], [data-diagram-open-point], [data-attachment-trigger], [data-exhibit-enter]';
  const targets = Array.from(figure.querySelectorAll(diagramTarget));
  const paths = new Map();
  for (const pair of figure.dataset.exhibitBranches?.split(' ') ?? []) {
    const [edge, destination] = pair.split(':');
    const anchors = targets.filter(({ dataset }) => (dataset.diagramEdge ?? dataset.diagramEdgeLabels) === edge);
    const related = targets.filter(({ dataset }) => dataset.diagramNode === destination);
    const branch = { anchors, related };
    for (const anchor of anchors) paths.set(anchor, branch);
  }
  for (const path of figure.dataset.exhibitNodePaths?.split(' ') ?? []) {
    const [node, connections] = path.split(':');
    const ids = connections.split(',');
    const anchors = targets.filter(({ dataset }) => dataset.diagramNode === node);
    const related = targets.filter(({ dataset }) =>
      ids.includes(dataset.diagramNode ?? dataset.diagramEdge ?? dataset.diagramEdgeLabels));
    const highlight = { anchors, related, isolate: true };
    for (const anchor of anchors) paths.set(anchor, highlight);
  }
  const phrases = new Map(Array.from(note.querySelectorAll('[data-exhibit-highlight]'), (phrase) => {
    const ids = phrase.dataset.exhibitHighlight.split(' ');
    const relatedIds = phrase.dataset.exhibitRelated?.split(' ') ?? [];
    const anchors = targets.filter((element) => ids.includes(diagramId(element)));
    const related = targets.filter(({ dataset }) =>
      relatedIds.includes(dataset.diagramNode ?? dataset.diagramEdge ?? dataset.diagramEdgeLabels));
    return [phrase, { phrase, anchors, related, isolate: phrase.hasAttribute('data-isolate-path') }];
  }));
  const phraseByTarget = new Map();
  for (const [phrase, { anchors }] of phrases) {
    for (const element of anchors) {
      // The drill-down control explains navigation even when its shape also illustrates scope.
      if (!phraseByTarget.has(element) || element.dataset.exhibitEnter && phrase.dataset.noteDepth !== undefined) {
        phraseByTarget.set(element, phrase);
      }
    }
  }
  for (const element of targets) {
    if (!element.dataset.diagramEdge || !(phraseByTarget.has(element) || paths.has(element))) continue;
    // Keep the hover area stable and wider than the visible stroke, including through pencil replays.
    for (const path of element.querySelectorAll('path[marker-end]')) {
      const hit = document.createElementNS(path.namespaceURI, 'path');
      hit.setAttribute('d', path.getAttribute('d'));
      hit.setAttribute('class', 'exhibit-edge-hit');
      hit.setAttribute('aria-hidden', 'true');
      element.append(hit);
    }
  }

  function highlightAt(element) {
    if (!(element instanceof Element)) return;
    const prompt = element.closest('[data-exhibit-highlight]');
    const target = element.closest(diagramTarget);
    return phrases.get(prompt) ?? paths.get(target) ?? phrases.get(phraseByTarget.get(target));
  }

  let highlighted = [];
  let active;
  let hovered;
  let focused;
  let stopTrace;
  const cues = document.createElement('div');
  cues.className = 'exhibit-cues';
  cues.setAttribute('aria-hidden', 'true');
  figure.append(cues);
  const cueAnchors = new Map();

  function clearCues() {
    cueAnchors.clear();
    cues.replaceChildren();
  }

  function positionCues() {
    for (const [mark, anchor] of cueAnchors) {
      mark.toggleAttribute('data-cue-positioned', positionCanvasAnnotation(figure, mark, anchor, targets, 7));
    }
  }

  function showCues() {
    clearCues();
    const anchors = new Map();
    for (const [element, phrase] of phraseByTarget) {
      if (phrase.hidden || element.closest('[hidden]')) continue;
      const id = diagramId(element);
      const { diagramEdgeLabels, diagramOpenPoint, attachmentTrigger, exhibitEnter } = element.dataset;
      if (!anchors.has(id) || diagramEdgeLabels || diagramOpenPoint || attachmentTrigger || exhibitEnter) {
        anchors.set(id, element.querySelector('.depth-mark') ?? element);
      }
    }
    for (const anchor of anchors.values()) {
      const mark = document.createElement('span');
      mark.className = 'exhibit-cue';
      mark.style.animationDelay = `${cues.childElementCount * 35}ms`;
      cues.append(mark);
      cueAnchors.set(mark, anchor);
    }
    positionCues();
  }

  function position() {
    if (!active?.phrase) return;
    const detail = active.phrase.nextElementSibling;
    const visible = active.anchors.filter((element) => !element.closest('[hidden]'));
    const { isolate } = active;
    const anchor = visible.find((element) => element.dataset.diagramOpenPoint
      || (isolate ? element.dataset.diagramNode : element.dataset.diagramEdgeLabels))
      ?? visible.find((element) => element.dataset.diagramNode || element.dataset.diagramEdge);
    detail.toggleAttribute('data-note-positioned', Boolean(anchor && positionCanvasAnnotation(figure, detail, anchor, targets, 14, isolate)));
  }

  function update() {
    const next = hovered ?? focused;
    if (next === active) return;
    stopTrace?.();
    active?.phrase?.removeAttribute('data-note-active');
    active?.phrase?.nextElementSibling.removeAttribute('data-note-positioned');
    for (const element of highlighted) delete element.dataset.noteTarget;
    active = next;
    const { phrase, anchors = [], related = [], isolate = false } = active ?? {};
    figure.toggleAttribute('data-exhibit-isolate', isolate);
    highlighted = [...anchors, ...related];
    phrase?.setAttribute('data-note-active', '');
    for (const element of anchors) element.dataset.noteTarget = '';
    for (const element of related) element.dataset.noteTarget = element.dataset.diagramNode ? 'soft' : '';
    position();
    stopTrace = phrase?.dataset.traceConnector ? playTrace(phrase.dataset.traceConnector, highlighted) : undefined;
  }

  figure.addEventListener('pointerover', (event) => {
    if (event.pointerType === 'touch') return;
    hovered = highlightAt(event.target);
    update();
  });
  figure.addEventListener('pointerout', (event) => {
    if (event.pointerType === 'touch') return;
    hovered = highlightAt(event.relatedTarget);
    update();
  });

  for (const [phrase, highlight] of phrases) {
    phrase.addEventListener('focus', () => { focused = highlight; update(); });
    phrase.addEventListener('blur', () => { focused = undefined; update(); });
    phrase.addEventListener('click', () => {
      phrase.focus({ preventScroll: true });
      focused = highlight;
      update();
    });
  }
  return {
    position,
    positionCues,
    clearCues,
    showCues,
    reset() {
      hovered = focused = undefined;
      update();
    },
  };
}

export function setUpGallery() {
  const gallery = document.getElementById('example');
  if (!gallery) return;

  const exhibits = gallery.querySelector('.example-gallery');
  const scenes = Array.from(exhibits.querySelectorAll('.system-example'));
  const announcement = exhibits.querySelector('[data-exhibit-announcement]');
  const indexSection = document.getElementById('examples');
  const cards = Array.from(indexSection.querySelectorAll('.example-card'));
  const browse = gallery.querySelector('.exhibit-browse');
  const features = document.getElementById('features');
  const peek = gallery.querySelector('[data-attachment-peek]');
  const motion = window.matchMedia('(prefers-reduced-motion: no-preference)');
  let activeScene = 0;
  let activeTrigger;
  let pinned = false;
  let closeTimer;
  let updateFrame;
  let dismissSketch;
  let enteringExhibit = false;
  const seenScenes = new Set();
  const noteHighlights = [];

  function closePeek() {
    clearTimeout(closeTimer);
    activeTrigger?.setAttribute('aria-expanded', 'false');
    activeTrigger = undefined;
    pinned = false;
    peek.hidden = true;
  }

  function positionPeek() {
    const target = activeTrigger.getBoundingClientRect();
    const width = document.documentElement.clientWidth;
    const topLimit = 12;
    if (target.bottom < topLimit || target.top > innerHeight || target.right < 0 || target.left > width) {
      closePeek();
      return;
    }
    const { offsetWidth, offsetHeight } = peek;
    const x = Math.max(12, Math.min(width - offsetWidth - 12, target.left));
    const below = target.bottom + 5;
    const y = below + offsetHeight + 12 <= innerHeight
      ? below
      : Math.max(topLimit, target.top - offsetHeight - 5);
    peek.style.left = `${x}px`;
    peek.style.top = `${y}px`;
  }

  function showPeek(trigger, entries, pin = false) {
    if (dismissSketch) return;
    clearTimeout(closeTimer);
    if (activeTrigger === trigger) {
      if (pin && pinned) closePeek();
      else if (pin) pinned = true;
      return;
    }
    if (pinned && !pin) return;
    closePeek();
    activeTrigger = trigger;
    pinned = pin;
    trigger.setAttribute('aria-expanded', 'true');
    const content = document.createElement('dl');
    for (const entry of entries) {
      content.append(entry.cloneNode(true));
    }
    peek.replaceChildren(content);
    peek.hidden = false;
    positionPeek();
  }

  function scheduleClose(trigger) {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      if (activeTrigger !== trigger || pinned) return;
      if (!peek.matches(':hover') && !trigger.matches(':hover, :focus-visible')) closePeek();
    }, 180);
  }

  function connect(trigger, entries) {
    trigger.setAttribute('aria-controls', peek.id);
    trigger.setAttribute('aria-expanded', 'false');
    trigger.addEventListener('pointerenter', (event) => {
      if (event.pointerType === 'mouse') showPeek(trigger, entries);
    });
    trigger.addEventListener('pointerleave', () => scheduleClose(trigger));
    trigger.addEventListener('focus', () => showPeek(trigger, entries));
    trigger.addEventListener('blur', () => scheduleClose(trigger));
    trigger.addEventListener('click', () => showPeek(trigger, entries, true));
  }

  for (const figure of scenes) {
    noteHighlights.push(setUpNoteHighlights(figure, (edgeId, elements) => {
      if (dismissSketch || !motion.matches || !Element.prototype.animate) return;
      const path = elements.find((element) => element.dataset.diagramEdge === edgeId)?.querySelector('path[marker-end]');
      const label = elements.find((element) => element.dataset.diagramEdgeLabels === edgeId);
      if (!path || !label) return;
      return traceWithPencil(gallery, path, label);
    }));
    for (const marker of figure.querySelectorAll('[data-attachment-trigger]')) {
      const room = marker.closest('[data-exhibit-room]') ?? figure;
      const template = room.querySelector('[data-exhibit-attachments]');
      const entries = Array.from(template.content.children);
      marker.setAttribute('tabindex', '0');
      const attached = entries.filter((entry) => entry.dataset.attachmentNode === marker.dataset.attachmentTrigger);
      connect(marker, attached);
      marker.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        if (!event.repeat) showPeek(marker, attached, true);
      });
    }
  }

  peek.addEventListener('pointerenter', () => clearTimeout(closeTimer));
  peek.addEventListener('pointerleave', () => {
    if (activeTrigger) scheduleClose(activeTrigger);
  });
  document.addEventListener('pointerdown', (event) => {
    if (activeTrigger && !activeTrigger.contains(event.target) && !peek.contains(event.target)) closePeek();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const canGoUp = !dismissSketch && !activeTrigger && parents.length && depthExhibit.contains(document.activeElement);
    if (enteringExhibit) focusExhibit();
    dismissSketch?.();
    if (activeTrigger) closePeek();
    noteHighlights[activeScene].reset();
    if (canGoUp) goUp();
  });

  const rooms = Array.from(exhibits.querySelectorAll('[data-exhibit-room]'));
  const depthExhibit = rooms[0].closest('.system-example');
  const trail = depthExhibit.querySelector('[data-exhibit-trail]');
  const triggers = new Map(Array.from(depthExhibit.querySelectorAll('[data-exhibit-enter]'), (trigger) =>
    [trigger.dataset.exhibitEnter, trigger],
  ));
  let parents = [];
  let traversingLevels = false;

  function roomAtLocation() {
    return rooms.find((room) => room.dataset.exhibitRoom === history.state?.exhibitRoom) ?? rooms[0];
  }

  function trailTo(room) {
    if (room === rooms[0]) return [];
    const path = room.dataset.exhibitRoom.split('/');
    return path.map((_, index) => triggers.get(path.slice(0, index + 1).join('/')));
  }

  function showTrail(room) {
    const items = parents.map((trigger, index) => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = trigger.closest('[data-exhibit-room]').dataset.roomLabel;
      button.addEventListener('click', () => goUp(index));
      item.append(button);
      return item;
    });
    const current = document.createElement('li');
    current.setAttribute('aria-current', 'location');
    current.textContent = room.dataset.roomLabel;
    trail.replaceChildren(...items, current);
  }

  function showRoom(room) {
    closePeek();
    for (const view of rooms) view.hidden = view !== room;
    const note = room.closest('.system-example').querySelector('.exhibit-note');
    const roomPath = room.dataset.exhibitRoom;
    const hasRoomPrompts = Array.from(note.querySelectorAll('[data-note-room]'))
      .some((prompt) => prompt.dataset.noteRoom === roomPath);
    for (const prompt of note.querySelectorAll('.exhibit-phrase')) {
      prompt.hidden = prompt.dataset.noteRoom ? prompt.dataset.noteRoom !== roomPath : hasRoomPrompts;
    }
    showTrail(room);
    if (depthExhibit === scenes[activeScene]) {
      const highlights = noteHighlights[activeScene];
      highlights.reset();
      highlights.clearCues();
      highlights.showCues();
    }
  }

  let finishRoomTransition;
  function moveRoom(room, trigger, opening) {
    finishRoomTransition?.();
    const previous = rooms.find((view) => !view.hidden);
    showRoom(room);
    if (!motion.matches || !Element.prototype.animate || previous === room) return;

    previous.inert = true;
    previous.dataset.exhibitLeaving = '';
    previous.hidden = false;
    depthExhibit.dataset.depthTransition = '';
    const parent = opening ? previous : room;
    const child = opening ? room : previous;
    const shape = trigger.querySelector('.depth-hit').getBoundingClientRect();
    const center = { x: shape.x + shape.width / 2, y: shape.y + shape.height / 2 };
    const parentGraph = parent.querySelector('.system-graph');
    const childGraph = child.querySelector('.system-graph');
    const parentBounds = parentGraph.getBoundingClientRect();
    const childFrame = childGraph.getBoundingClientRect();
    const childBounds = childGraph.querySelector('[role="img"]').getBoundingClientRect();
    const childCenter = { x: childBounds.x + childBounds.width / 2, y: childBounds.y + childBounds.height / 2 };
    const childScale = Math.min(0.42, shape.width / childBounds.width, shape.height / childBounds.height);
    const rest = { opacity: 1, transform: 'none' };
    const zoom = {
      opacity: 0,
      transform: `translate(${parentBounds.x + parentBounds.width / 2 - center.x}px, ${parentBounds.y + parentBounds.height / 2 - center.y}px) scale(1.8)`,
      transformOrigin: `${center.x - parentBounds.x}px ${center.y - parentBounds.y}px`,
    };
    const box = {
      opacity: 0,
      transform: `translate(${center.x - childCenter.x}px, ${center.y - childCenter.y}px) scale(${childScale})`,
      transformOrigin: `${childCenter.x - childFrame.x}px ${childCenter.y - childFrame.y}px`,
    };
    const options = { duration: 400, easing: 'cubic-bezier(.22,.72,.26,1)', fill: 'both' };
    const parentRest = { ...rest, transformOrigin: zoom.transformOrigin };
    const childRest = { ...rest, transformOrigin: box.transformOrigin };
    const animations = [
      parentGraph.animate(opening ? [parentRest, zoom] : [zoom, parentRest], options),
      childGraph.animate(opening ? [box, childRest] : [childRest, box], options),
    ];
    function finish() {
      if (finishRoomTransition !== finish) return;
      finishRoomTransition = undefined;
      previous.hidden = true;
      previous.inert = false;
      delete previous.dataset.exhibitLeaving;
      delete depthExhibit.dataset.depthTransition;
      for (const animation of animations) animation.cancel();
      noteHighlights[activeScene].positionCues();
    }
    finishRoomTransition = finish;
    void Promise.all(animations.map((animation) => animation.finished)).then(finish, finish);
  }

  for (const [path, trigger] of triggers) {
    const room = rooms.find((view) => view.dataset.exhibitRoom === path);
    function enter() {
      if (traversingLevels || room === roomAtLocation()) return;
      history.pushState({ exhibitRoom: path }, '');
      restoreLevel(room);
    }
    trigger.setAttribute('tabindex', '0');
    trigger.addEventListener('click', enter);
    trigger.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      if (!event.repeat) enter();
    });
  }

  function goUp(index = parents.length - 1) {
    if (traversingLevels) return;
    traversingLevels = true;
    history.go(index - parents.length);
  }

  function restoreLevel(room, fromHistory = false) {
    const next = trailTo(room);
    if (next.length === parents.length && next.every((trigger, index) => trigger === parents[index])) return;
    dismissSketch?.();
    const opening = next.length > parents.length;
    const trigger = opening ? next[parents.length] : parents[next.length];
    parents = next;
    moveRoom(room, trigger, opening);
    const focus = () => {
      if (parents === next && !depthExhibit.hidden) (opening ? room : trigger).focus({ preventScroll: true });
    };
    // Focus after the browser restores its own state for the history entry.
    if (fromHistory) requestAnimationFrame(focus);
    else focus();
  }

  // C4 entries share the Stripe fragment, so moving between them only fires popstate.
  window.addEventListener('popstate', () => {
    traversingLevels = false;
    if (indexSection.hidden && scenes[activeScene] === depthExhibit && location.hash === `#${depthExhibit.id}`) {
      restoreLevel(roomAtLocation(), true);
    }
  });
  motion.addEventListener('change', () => finishRoomTransition?.());
  showRoom(rooms[0]);

  function revealScene(figure, highlights, enter) {
    const firstVisit = !seenScenes.has(figure);
    seenScenes.add(figure);
    if (!firstVisit || (figure === depthExhibit && parents.length) || !motion.matches || !Element.prototype.animate) {
      highlights.showCues();
      return;
    }
    const art = figure.querySelector('.example-art:not([hidden])');
    const listeners = new AbortController();
    function finish() {
      dismissSketch = undefined;
      enteringExhibit = false;
      delete figure.dataset.briefing;
      delete figure.dataset.sketching;
      listeners.abort();
      highlights.showCues();
    }
    function startSketch() {
      cancel = drawWithPencil(gallery, art, figure.dataset.exhibitSketch, finish, enter);
      if (!cancel) {
        finish();
        return;
      }
      figure.dataset.sketching = '';
      delete figure.dataset.briefing;
    }
    dismissSketch = () => {
      cancel?.();
      finish();
    };
    motion.addEventListener('change', () => {
      if (enteringExhibit) focusExhibit();
      dismissSketch();
    }, { signal: listeners.signal });
    let cancel;
    if (enter) startSketch();
    else {
      figure.dataset.briefing = '';
      cancel = playExhibitBrief(figure, startSketch);
    }
  }

  function clearSceneEffects() {
    closePeek();
    finishRoomTransition?.();
    dismissSketch?.();
    noteHighlights[activeScene].reset();
    noteHighlights[activeScene].clearCues();
  }

  function showIndex() {
    clearSceneEffects();
    for (const figure of scenes) figure.hidden = true;
    indexSection.hidden = false;
    browse.hidden = true;
    announcement.textContent = '';
  }

  function showScene(index) {
    clearSceneEffects();
    activeScene = index;
    indexSection.hidden = true;
    browse.hidden = false;
    for (const [position, figure] of scenes.entries()) figure.hidden = position !== index;
    if (scenes[index] === depthExhibit) {
      const room = roomAtLocation();
      parents = trailTo(room);
      showRoom(room);
    }
    const title = scenes[index].getAttribute('aria-label');
    for (const card of cards) {
      if (card.hash === location.hash) card.setAttribute('aria-current', 'true');
      else card.removeAttribute('aria-current');
    }
    announcement.textContent = `Diagram ${index + 1} of ${scenes.length}. ${title}`;
  }

  function locationIndex() {
    return scenes.findIndex((figure) => `#${figure.id}` === location.hash);
  }

  function readLocation(event) {
    if (enteringExhibit) dismissSketch?.();
    const section = [features, indexSection].find(({ id }) => location.hash === `#${id}`);
    if (section) {
      showIndex();
      // The grid may have been hidden when the browser tried to resolve its fragment.
      if (section === indexSection) indexSection.scrollIntoView({ behavior: 'instant' });
      section.focus({ preventScroll: true });
      return;
    }
    const index = locationIndex();
    if (index === -1) {
      showIndex();
      return;
    }
    const previousHash = new URL(event.oldURL).hash;
    const enteringGallery = ['', `#${features.id}`, `#${indexSection.id}`].includes(previousHash);
    if (!indexSection.hidden || index !== activeScene || !seenScenes.has(scenes[index])) {
      showScene(index);
      revealScene(scenes[index], noteHighlights[index]);
    }
    if (enteringGallery) {
      gallery.scrollIntoView();
      scenes[index].querySelector('.example-art:not([hidden])').focus({ preventScroll: true });
    }
  }

  function scheduleUpdate() {
    if (updateFrame) return;
    updateFrame = requestAnimationFrame(() => {
      updateFrame = 0;
      if (activeTrigger) positionPeek();
      noteHighlights[activeScene].position();
      noteHighlights[activeScene].positionCues();
    });
  }

  function focusExhibit() {
    gallery.scrollIntoView({ behavior: 'instant' });
    scenes[activeScene].querySelector('.example-art:not([hidden])').focus({ preventScroll: true });
  }

  for (const card of cards) {
    const index = scenes.findIndex((figure) => `#${figure.id}` === card.hash);
    if (index === -1) continue;
    const scene = scenes[index];
    const preview = card.querySelector('.example-card-preview');

    // The thumbnail keeps its SVG paint definitions separate from the live exhibit.
    const graph = scene.querySelector('.system-graph').cloneNode(true);
    graph.querySelectorAll(':scope > g:not([role="img"]), .exhibit-edge-hit').forEach((node) => node.remove());
    const image = new Image();
    image.alt = '';
    image.decoding = 'async';
    image.loading = 'lazy';
    image.src = `data:image/svg+xml,${encodeURIComponent(new XMLSerializer().serializeToString(graph))}`;
    preview.append(image);

    card.addEventListener('click', (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      // Finish the anchor scroll before saving this position in the browser's history.
      if (location.hash === `#${indexSection.id}`) indexSection.scrollIntoView({ behavior: 'instant' });
      const bounds = preview.getBoundingClientRect();
      const from = { x: bounds.left + bounds.width / 2, y: Math.max(20, Math.min(innerHeight - 12, bounds.bottom)) };
      if (location.hash !== card.hash) history.pushState(null, '', card.hash);
      showScene(index);
      enteringExhibit = motion.matches && Boolean(Element.prototype.animate) && !seenScenes.has(scene);
      revealScene(scene, noteHighlights[index], enteringExhibit ? (destination, startDrawing) =>
        leadIntoExhibit(gallery, from, destination, () => {
          enteringExhibit = false;
          focusExhibit();
          startDrawing();
        }) : undefined);
      if (!enteringExhibit) focusExhibit();
    });
  }

  const initialScene = locationIndex();
  exhibits.dataset.enhanced = '';
  if (initialScene >= 0) {
    showScene(initialScene);
    // The browser may have resolved the fragment before this exhibit was visible.
    gallery.scrollIntoView({ behavior: 'instant' });
    revealScene(scenes[initialScene], noteHighlights[initialScene]);
  } else {
    showIndex();
    if (location.hash === `#${indexSection.id}`) indexSection.scrollIntoView({ behavior: 'instant' });
  }
  delete document.documentElement.dataset.sketchPending;
  window.addEventListener('hashchange', readLocation);
  window.addEventListener('scroll', scheduleUpdate, { passive: true, capture: true });
  window.addEventListener('resize', () => {
    noteHighlights[activeScene].reset();
    scheduleUpdate();
  });
  motion.addEventListener('change', () => {
    noteHighlights[activeScene].reset();
  });
}
