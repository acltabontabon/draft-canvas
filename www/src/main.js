/**
 * The site's behaviour, all of it optional.
 *
 * Every section reads, and every link works, with this file blocked: the hero draws itself in CSS,
 * the reveal only hides what it is about to show (and only when scripting is on, see styles.css),
 * the reel falls back to an ordinary player on its first clip with all six features listed beside
 * it, the download rows are real links in the HTML before anything here runs, and the notice for
 * returning visitors is the only thing that is not in the markup at all — because it should not be
 * shown to someone arriving for the first time.
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
   * *entirely* within one frame never reports as intersecting — a jump to `#get`, an End key, a
   * restored scroll position on reload. The element would then sit at opacity 0 for as long as the
   * page is open, which is a section of the page silently missing rather than a missing animation.
   * This sweeps up anything the viewport has already passed, and takes itself off the moment there
   * is nothing left to reveal.
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

/* ── The reel ───────────────────────────────────────────────────────────────────────────── */

/** How long the one still in the reel stays up, against clips that run eight to twenty seconds. */
const STILL_MS = 7000;

/**
 * Six features, one frame. Each clip plays to its end and hands over to the next, and the hairline
 * above the chosen feature fills as it goes — a reel you can watch without touching, or step through
 * by choosing a feature.
 *
 * It only runs while it is on screen and the tab is visible, nothing is downloaded until it has been
 * on screen at all, and it never starts on its own for someone who has asked for less motion or less
 * data: they get the poster, the list, and a play button. The button is always there, because
 * anything that moves by itself for more than a few seconds has to be stoppable.
 */
function setUpReel() {
  const tabs = [...document.querySelectorAll('.reel-tab')];
  const stage = document.getElementById('reel-stage');
  const video = document.getElementById('reel-video');
  const still = document.getElementById('reel-still');
  const caption = document.getElementById('reel-caption');
  const figure = document.getElementById('reel-fig');
  const toggle = document.getElementById('reel-toggle');
  if (!tabs.length || !stage || !video || !still || !toggle) return;

  video.controls = false;
  toggle.hidden = false;

  let current = 0;
  let running = !reduceMotion.matches && navigator.connection?.saveData !== true;
  let onScreen = !('IntersectionObserver' in window);
  let stillElapsed = 0;
  let lastTick = 0;
  let frame = 0;

  const isStill = (tab) => 'still' in tab.dataset;
  const live = () => running && onScreen && !document.hidden;

  function tick(now) {
    const tab = tabs[current];
    let progress = 0;
    if (isStill(tab)) {
      stillElapsed += now - lastTick;
      progress = stillElapsed / STILL_MS;
      if (progress >= 1) {
        show(current + 1);
        return;
      }
    } else if (video.duration) {
      progress = video.currentTime / video.duration;
    }
    lastTick = now;
    tab.style.setProperty('--p', String(Math.min(1, progress)));
    frame = requestAnimationFrame(tick);
  }

  function sync() {
    if (!isStill(tabs[current])) {
      // Autoplay can be refused — a browser policy, a power setting. The poster is already up, and
      // the toggle still works, so a refusal needs nothing beyond not throwing.
      if (live()) video.play().catch(() => {});
      else video.pause();
    }
    toggle.dataset.state = running ? 'playing' : 'paused';
    toggle.setAttribute('aria-label', running ? 'Pause the reel' : 'Play the reel');
    cancelAnimationFrame(frame);
    if (live()) {
      lastTick = performance.now();
      frame = requestAnimationFrame(tick);
    }
  }

  function show(index, { focus = false } = {}) {
    current = (index + tabs.length) % tabs.length;
    const tab = tabs[current];
    tabs.forEach((other, position) => {
      const chosen = position === current;
      other.setAttribute('aria-selected', String(chosen));
      other.tabIndex = chosen ? 0 : -1;
      other.style.removeProperty('--p');
    });
    // Running, the playhead starts empty; held, the chosen feature's hairline is simply drawn.
    if (running) tab.style.setProperty('--p', '0');
    stage.setAttribute('aria-labelledby', tab.id);
    if (caption) caption.textContent = tab.dataset.caption ?? '';
    if (figure) figure.textContent = `Fig. ${String(current + 1).padStart(2, '0')}`;
    stillElapsed = 0;

    if (isStill(tab)) {
      video.pause();
      video.hidden = true;
      if (still.getAttribute('src') !== tab.dataset.still) still.src = tab.dataset.still;
      still.alt = tab.dataset.caption ?? '';
      still.hidden = false;
    } else {
      still.hidden = true;
      video.hidden = false;
      if (video.getAttribute('src') !== tab.dataset.video) {
        video.poster = tab.dataset.poster ?? '';
        video.src = tab.dataset.video;
      } else if (video.readyState > 0) {
        video.currentTime = 0;
      }
    }
    if (focus) tab.focus();
    sync();
  }

  video.addEventListener('ended', () => {
    if (running) show(current + 1);
  });

  tabs.forEach((tab, position) => {
    tab.addEventListener('click', () => show(position));
    tab.addEventListener('keydown', (event) => {
      const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
      const to = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : step ? position + step : null;
      if (to === null) return;
      event.preventDefault();
      show(to, { focus: true });
    });
  });

  toggle.addEventListener('click', () => {
    running = !running;
    if (running) tabs[current].style.setProperty('--p', String(isStill(tabs[current]) ? stillElapsed / STILL_MS : 0));
    sync();
  });

  document.addEventListener('visibilitychange', sync);

  // `#export`, `#agents` and the rest are the features' own addresses: arriving at one, or following
  // a link to one, opens it. The browser would scroll the tab itself to the top of the window and
  // leave the frame showing it above the fold, so the whole reel is brought into view instead.
  const reel = stage.closest('.reel') ?? stage;
  const fromHash = () => tabs.findIndex((tab) => `#${tab.id}` === window.location.hash);
  const opened = (smooth) =>
    reel.scrollIntoView({
      // Centred where it fits with room to spare; on a phone, where it is stacked taller than the
      // window, from the top, so the frame comes first.
      block: reel.offsetHeight < window.innerHeight - 140 ? 'center' : 'start',
      behavior: smooth && !reduceMotion.matches ? 'smooth' : 'auto',
    });
  window.addEventListener('hashchange', () => {
    const index = fromHash();
    if (index < 0) return;
    show(index);
    opened(true);
  });

  if ('IntersectionObserver' in window) {
    new IntersectionObserver(
      (entries) => {
        onScreen = entries.some((entry) => entry.isIntersecting);
        sync();
      },
      { threshold: 0.35 },
    ).observe(stage);
  }

  const arrivedAt = fromHash();
  show(Math.max(0, arrivedAt));
  if (arrivedAt >= 0) {
    // After the browser's own jump to the fragment, which it makes once the page has loaded.
    const settle = () => requestAnimationFrame(() => opened(false));
    if (document.readyState === 'complete') settle();
    else window.addEventListener('load', settle, { once: true });
  }
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
setUpMasthead();
setUpReel();
setUpDownloads();
void retireFormerWorker();
void setUpReturningVisitor();
