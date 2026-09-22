/**
 * The site's behaviour, all of it optional.
 *
 * Every section reads, and every link works, with this file blocked: the reveal animation only
 * removes an opacity, the demo tabs fall back to one clip with its own controls, the download rows
 * are real links in the HTML before anything here runs, and the notice for returning visitors is
 * the only thing that is not in the markup at all — because it should not be shown to someone
 * arriving for the first time.
 */

import { setUpDownloads } from './downloads.js';

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

/* ── Reveal ─────────────────────────────────────────────────────────────────────────────── */

function setUpReveal() {
  const pending = new Set(document.querySelectorAll('.reveal'));
  const show = (item) => {
    item.classList.add('shown');
    pending.delete(item);
  };

  if (reduceMotion.matches || !('IntersectionObserver' in window)) {
    pending.forEach(show);
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        show(entry.target);
        observer.unobserve(entry.target);
      }
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
  );

  for (const item of pending) observer.observe(item);

  /*
   * The safety net, and the reason this is not just the observer.
   *
   * An IntersectionObserver only samples at frame boundaries, so anything the viewport crosses
   * *entirely* within one frame never reports as intersecting — a jump to `#export`, an End key,
   * a restored scroll position on reload. The element would then sit at opacity 0 for as long as
   * the page is open, which is a section of the page silently missing rather than a missing
   * animation. This sweeps up anything the viewport has already passed, and takes itself off the
   * moment there is nothing left to reveal.
   */
  let queued = false;
  const sweep = () => {
    queued = false;
    const edge = window.innerHeight;
    for (const item of [...pending]) {
      if (item.getBoundingClientRect().top < edge) show(item);
    }
    if (!pending.size) window.removeEventListener('scroll', onScroll);
  };
  const onScroll = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(sweep);
  };

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('load', onScroll, { once: true });
  onScroll();
}

/* ── The spine ──────────────────────────────────────────────────────────────────────────── */

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(name, attributes) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}

/**
 * The connector that makes six sections one canvas.
 *
 * A routed line down the left margin with a stub and a junction at every chapter, built from where
 * the chapters actually are rather than from numbers written down here — so it stays right when a
 * paragraph grows, the window changes width, or a section is added. It draws in as you scroll, and
 * each junction lights when you reach it.
 *
 * Only at widths that have a margin to put it in. It is decoration, so it carries no meaning that
 * is not already in the headings, and it is hidden from assistive technology entirely.
 */
function setUpSpine() {
  const main = document.getElementById('main');
  const wide = window.matchMedia('(min-width: 1240px)');
  if (!main) return;

  let svg = null;
  let drawn = null;
  let junctions = [];
  let span = { origin: 0, top: 0, bottom: 0 };

  function teardown() {
    svg?.remove();
    svg = null;
    drawn = null;
    junctions = [];
  }

  function build() {
    teardown();
    if (!wide.matches) return;

    const mainTop = main.getBoundingClientRect().top + window.scrollY;
    const stops = [...main.querySelectorAll('.chapter .slate, .get .slate')].map(
      (slate) => Math.round(slate.getBoundingClientRect().top + window.scrollY - mainTop + 38),
    );
    if (stops.length < 2) return;

    const top = stops[0] - 72;
    const bottom = stops[stops.length - 1] + 150;
    const height = main.offsetHeight;

    svg = svgEl('svg', { class: 'spine', width: 44, height, viewBox: `0 0 44 ${height}`, 'aria-hidden': 'true', focusable: 'false' });
    const route = `M22 ${top}V${bottom}`;
    svg.append(svgEl('path', { class: 'track', d: route }));
    for (const y of stops) svg.append(svgEl('path', { class: 'track', d: `M22 ${y}h8` }));

    drawn = svgEl('path', { class: 'drawn', d: route });
    drawn.style.strokeDasharray = String(bottom - top);
    svg.append(drawn);

    junctions = stops.map((y) => {
      const dot = svgEl('circle', { class: 'junction', cx: 35, cy: y, r: 5 });
      svg.append(dot);
      return { dot, y };
    });

    svg.append(svgEl('path', { class: 'head', d: `M17.5 ${bottom - 9}h9l-4.5 9z` }));
    main.prepend(svg);
    span = { origin: mainTop, top: mainTop + top, bottom: mainTop + bottom };
    update();
  }

  function update() {
    if (!drawn) return;
    // Two thirds down the viewport: the line arrives at a chapter at about the moment you start
    // reading it, rather than after you already have.
    const here = window.scrollY + window.innerHeight * 0.66;
    const total = span.bottom - span.top;
    const progress = Math.min(1, Math.max(0, (here - span.top) / total));
    drawn.style.strokeDashoffset = String(total * (1 - progress));
    for (const { dot, y } of junctions) {
      dot.classList.toggle('passed', here >= span.origin + y);
    }
  }

  let queued = false;
  const onScroll = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      update();
    });
  };

  build();
  window.addEventListener('scroll', onScroll, { passive: true });
  if ('ResizeObserver' in window) new ResizeObserver(build).observe(main);
  wide.addEventListener?.('change', build);
}

/* ── Masthead ───────────────────────────────────────────────────────────────────────────── */

function setUpMasthead() {
  const masthead = document.getElementById('masthead');
  if (!masthead) return;
  const onScroll = () => {
    masthead.dataset.stuck = String(window.scrollY > 12);
  };
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });
}

/* ── The demo ───────────────────────────────────────────────────────────────────────────── */

const CAPTIONS = {
  draw: 'Press a letter and the shape lands under the cursor. Drag out of its edge and Draft Canvas offers what usually comes next; <kbd>Tab</kbd> accepts it. Nothing here is typed into a dialog first.',
  compose: 'Clear the sketch, ask the command palette for a pattern, and a whole CQRS architecture arrives laid out and connected — with its flows already built, ready to present.',
  present: 'Presenting a flow, one step at a time. Each step brings the notes and the code attached to it, and everything outside the flow dims rather than disappearing.',
  inside: '<kbd>⌘↓</kbd> opens the inside of a shape: a canvas of its own, for the detail the overview should not be carrying. The depth map along the top says where you are.',
};

function setUpDemo() {
  const tabs = [...document.querySelectorAll('.demo-tab')];
  const video = document.getElementById('demo-video');
  const caption = document.getElementById('demo-caption');
  const panel = document.getElementById('demo-panel');
  if (!tabs.length || !video) return;

  let loaded = false;

  /** Swapping `src` on a <video> that has never loaded is free; on one that has, it is one request
   *  for a file of a few hundred kilobytes. Either way nothing is fetched until this is called. */
  function load(clip, { play }) {
    video.poster = `./clips/${clip}.jpg`;
    video.src = `./clips/${clip}.mp4`;
    loaded = true;
    if (!play) return;
    // Autoplay can be refused — a data-saver setting, a browser policy, a user preference. The
    // poster and the controls are already on screen, so a refusal needs no handling beyond not
    // throwing.
    video.play().catch(() => {});
  }

  function select(tab, { focus = true } = {}) {
    for (const other of tabs) {
      const chosen = other === tab;
      other.setAttribute('aria-selected', String(chosen));
      other.tabIndex = chosen ? 0 : -1;
    }
    panel?.setAttribute('aria-labelledby', tab.id);
    if (caption) caption.innerHTML = CAPTIONS[tab.dataset.clip] ?? '';
    load(tab.dataset.clip, { play: !reduceMotion.matches });
    if (focus) tab.focus();
  }

  for (const tab of tabs) {
    tab.addEventListener('click', () => select(tab, { focus: false }));
    tab.addEventListener('keydown', (event) => {
      const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (!step) return;
      event.preventDefault();
      select(tabs[(tabs.indexOf(tab) + step + tabs.length) % tabs.length]);
    });
  }

  // Nothing is downloaded until the demo is actually on screen, and on a connection the visitor has
  // asked to go easy on, not even then — they get the poster and a play button like anyone who
  // would rather decide for themselves.
  const thrifty = navigator.connection?.saveData === true;
  if (!('IntersectionObserver' in window)) {
    load('draw', { play: false });
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting || loaded) continue;
        load('draw', { play: !reduceMotion.matches && !thrifty });
        observer.disconnect();
      }
    },
    { threshold: 0.25 },
  );
  observer.observe(video);
}

/* ── The old service worker ─────────────────────────────────────────────────────────────── */

/**
 * Takes the editor's former registration out of the picture, from the page's side.
 *
 * The worker that used to live at this address answered *every* navigation under it with the
 * precached editor shell, so it would go on serving the old app at the address this page now
 * occupies. `sw.js` in this site's own output is what normally retires it, during the browser's
 * update check; this is the second half of the same job, for a visit that got here before that
 * happened.
 *
 * It is written to be incapable of touching anything else. acltabontabon.com is one origin shared
 * with other projects, so there is no blanket sweep here: the only registration considered is the
 * one whose scope is exactly this page's own directory, and the only caches deleted are the ones
 * whose names contain that scope — which is how Workbox names them and how nothing else is named.
 * No IndexedDB is opened, no storage key is read, nothing anyone has drawn is anywhere near this.
 */
async function retireFormerWorker() {
  if (!('serviceWorker' in navigator)) return;
  const here = new URL('./', window.location.href).href;

  try {
    for (const registration of await navigator.serviceWorker.getRegistrations()) {
      if (registration.scope !== here) continue; // the editor's own worker is at ./editor/ — leave it
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.includes(here))
          .map((name) => caches.delete(name).catch(() => false)),
      );
      await registration.unregister();
    }
  } catch {
    // Unsupported, or storage is blocked. The page is already the right one; this was only tidying.
  }
}

/* ── The notice for people who came here for the editor ─────────────────────────────────── */

const DISMISSED = 'draft-canvas-site.moved-notice';

/**
 * Has this browser been used to draw?
 *
 * A preference key is the reliable signal: the app writes `draft-canvas.personality` and
 * `draft-canvas.last-seen-product-release` the first time it runs, it is synchronous, and it works
 * everywhere. `indexedDB.databases()` is the stronger signal but Firefox does not implement it, so
 * it only ever corroborates. Neither opens a database or reads a single thing anyone has drawn.
 */
function hasPreferences() {
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      if (localStorage.key(index)?.startsWith('draft-canvas.')) return true;
    }
  } catch {
    // Storage blocked (a private window, third-party restrictions). Treat as a first visit.
  }
  return false;
}

async function hasDiagrams() {
  try {
    if (typeof indexedDB.databases !== 'function') return false;
    return (await indexedDB.databases()).some((database) => database.name === 'draft-canvas');
  } catch {
    return false;
  }
}

async function setUpReturningVisitor() {
  const notice = document.getElementById('moved');
  const dismiss = document.getElementById('moved-dismiss');
  const label = document.getElementById('hero-cta-label');
  const note = document.getElementById('hero-cta-note');

  let dismissed = false;
  try {
    dismissed = localStorage.getItem(DISMISSED) === 'yes';
  } catch {
    // Not readable; show it. A notice shown twice is better than a bookmark that leads nowhere.
  }

  if (!(hasPreferences() || (await hasDiagrams()))) return;

  // Whether or not they dismiss the notice, the button they are most likely to want is the one
  // back to their own work.
  if (label) label.textContent = 'Open your diagrams';
  if (note) note.textContent = 'where you left them';

  if (dismissed || !notice) return;
  notice.hidden = false;

  dismiss?.addEventListener('click', () => {
    notice.hidden = true;
    try {
      localStorage.setItem(DISMISSED, 'yes');
    } catch {
      // Cannot remember; it will be shown again next time. Harmless.
    }
  });
}

/* ── Go ─────────────────────────────────────────────────────────────────────────────────── */

setUpReveal();
setUpSpine();
setUpMasthead();
setUpDemo();
setUpDownloads();
void retireFormerWorker();
void setUpReturningVisitor();
