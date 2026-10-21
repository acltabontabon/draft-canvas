/**
 * The site's behaviour, all of it optional.
 *
 * Every section reads, and every link works, with this file blocked: the hero draws itself in CSS,
 * the reveal only hides what it is about to show (and only when scripting is on, see styles.css),
 * the reel falls back to an ordinary player on its first clip with all six features listed beside
 * it, the download rows are real links in the HTML before anything here runs, and the last sheet
 * is simply finished.
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

/* ── The last sheet ─────────────────────────────────────────────────────────────────────── */

/**
 * Plays a `[data-stage]` sheet once, when most of a screen of it is showing.
 *
 * Only a sheet still below the fold is held back: one already on screen when the page opens is left
 * finished rather than blanked and replayed. Like the reveal, a sheet the viewport skips past in a
 * single frame never reports as intersecting, so a scroll check plays anything already passed.
 */
function setUpStages() {
  if (reduceMotion.matches || !('IntersectionObserver' in window)) return;

  for (const stage of document.querySelectorAll('[data-stage]')) {
    if (stage.getBoundingClientRect().top < window.innerHeight) continue;
    stage.dataset.stage = 'waiting';

    const play = () => {
      stage.dataset.stage = 'play';
      observer.disconnect();
      window.removeEventListener('scroll', onScroll);
    };
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) play();
      },
      { threshold: 0.4 },
    );
    const onScroll = () => {
      if (stage.getBoundingClientRect().top < window.innerHeight * 0.3) play();
    };

    observer.observe(stage);
    window.addEventListener('scroll', onScroll, { passive: true });
  }
}

/* ── Copy buttons ───────────────────────────────────────────────────────────────────────── */

/** Each stays hidden where there is no clipboard to write to; what it copies is selectable text. */
function setUpCopyButtons() {
  if (!navigator.clipboard?.writeText) return;

  for (const button of document.querySelectorAll('[data-copy]')) {
    const source = document.getElementById(button.dataset.copy);
    const label = button.querySelector('.copy-label');
    if (!source || !label) continue;

    button.hidden = false;
    let reset = 0;
    button.addEventListener('click', async () => {
      // One line per line, exactly as it reads on the page.
      const text = source.textContent
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .join('\n');
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        return;
      }
      button.dataset.copied = '';
      label.textContent = 'Copied';
      clearTimeout(reset);
      reset = setTimeout(() => {
        delete button.dataset.copied;
        label.textContent = 'Copy';
      }, 1800);
    });
  }
}

/* ── The download sheet ─────────────────────────────────────────────────────────────────── */

/**
 * Without this, the download buttons are links to the downloads further down the page. With it,
 * they open the same markup as a modal: the browser's own <dialog> traps focus, closes on Escape,
 * makes the page behind it inert and hands focus back to the button that opened it.
 */
function setUpDownloadSheet() {
  const dialog = document.getElementById('download');
  if (!(dialog instanceof HTMLDialogElement) || typeof dialog.showModal !== 'function') return;

  document.documentElement.dataset.downloadSheet = '';

  const open = () => {
    if (dialog.open) return;
    delete dialog.dataset.closing;
    dialog.showModal();
    // The row the visitor most likely wants is first (see downloads.js); start there.
    dialog.querySelector('#targets a')?.focus({ preventScroll: true });
  };

  const finish = () => {
    delete dialog.dataset.closing;
    dialog.close();
    if (location.hash === '#download') history.replaceState(null, '', location.pathname + location.search);
  };

  const close = () => {
    if (!dialog.open || 'closing' in dialog.dataset) return;
    if (reduceMotion.matches) return finish();
    dialog.dataset.closing = '';
    // A fallback in case the exit animation never runs, which would leave the sheet stuck open.
    const timer = setTimeout(finish, 400);
    dialog.addEventListener(
      'animationend',
      () => {
        clearTimeout(timer);
        finish();
      },
      { once: true },
    );
  };

  for (const trigger of document.querySelectorAll('[data-download]')) {
    trigger.addEventListener('click', (event) => {
      event.preventDefault();
      open();
    });
  }

  dialog.querySelector('[data-close]')?.addEventListener('click', close);
  // A click on the backdrop lands on the <dialog> itself; the sheet inside fills the dialog box.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) close();
  });
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });

  // A shared link to the downloads opens them.
  if (location.hash === '#download') open();
  window.addEventListener('hashchange', () => {
    if (location.hash === '#download') open();
  });
}

/* ── Go ─────────────────────────────────────────────────────────────────────────────────── */

setUpReveal();
setUpStages();
setUpMasthead();
setUpReel();
setUpDownloads();
setUpDownloadSheet();
setUpCopyButtons();
