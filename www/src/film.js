/**
 * The film: the second and last room of the page.
 *
 * It fills the window and starts when it is most of what the visitor can see. A browser only lets a video
 * start with sound after the visitor has done something on the page, so it is tried with sound first and,
 * if that is refused, started silent with captions and a plain "Sound on" button. It pauses when scrolled
 * away and resumes on return, unless the visitor paused it themselves. The dashes are its parts (the
 * editor's own presentation bar, borrowed): they fill as it plays and a press jumps there. So does the
 * timecode beside each feature at the top of the page. When it ends, the screen says so and points back up to the ways in.
 * Nothing is fetched until the room is near, and nothing starts by itself for a visitor who asked for
 * less motion.
 */
const clock = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

export function setUpFilm() {
  const room = document.getElementById('film');
  const stage = room?.querySelector('[data-film]');
  if (!stage) return;
  const film = stage.querySelector('.film-video');
  const toggle = stage.querySelector('.film-toggle');
  const sound = stage.querySelector('.film-sound');
  const soundLabel = stage.querySelector('[data-film-sound-label]');
  const full = stage.querySelector('.film-full');
  const now = stage.querySelector('[data-film-now]');
  const end = stage.querySelector('.film-end');
  const names = stage.dataset.filmSteps.split('|');
  const steps = [...stage.querySelectorAll('[data-film-step]')].map((button, index) => ({
    button, fill: button.firstElementChild, at: Number(button.dataset.filmStep), name: names[index],
  }));
  const calm = !matchMedia('(prefers-reduced-motion: no-preference)').matches;
  let held = false; // paused by the visitor: scrolling back does not restart it
  let inView = false;

  const captions = () => { for (const track of film.textTracks) track.mode = film.muted ? 'showing' : 'hidden'; };
  const reflectSound = () => {
    sound.setAttribute('aria-pressed', String(!film.muted));
    soundLabel.textContent = film.muted ? 'Sound on' : 'Sound';
    sound.setAttribute('aria-label', film.muted ? 'Turn the sound on' : 'Turn the sound off');
    if (film.muted) stage.dataset.muted = ''; else delete stage.dataset.muted;
    captions();
  };
  const setState = (state) => {
    stage.dataset.state = state;
    toggle.setAttribute('aria-label', state === 'playing' ? 'Pause the film' : 'Play the film');
  };

  /** With sound if the browser allows it; silently, with captions, if it does not. */
  const play = async (byItself = false) => {
    end.hidden = true;
    try { await film.play(); } catch (error) {
      if (error.name !== 'NotAllowedError' || film.muted || held || (byItself && !inView)) return;
      film.muted = true;
      try { await film.play(); } catch { /* not allowed to play at all: the play mark stays */ }
    }
    reflectSound();
    // Starting takes a moment. If it started by itself and the visitor has scrolled away meanwhile, it
    // must not be left playing out of sight (WebKit resolves the start late enough for this to happen).
    if (byItself && !inView) film.pause();
  };
  const seek = (at) => {
    const go = () => { film.currentTime = at; };
    if (film.readyState >= 1) go();
    else { film.addEventListener('loadedmetadata', go, { once: true }); film.load(); }
  };

  film.addEventListener('play', () => setState('playing'));
  film.addEventListener('pause', () => { if (!film.ended) setState('paused'); });
  film.addEventListener('ended', () => {
    const hadFocus = stage.contains(document.activeElement);
    setState('ended');
    end.hidden = false;
    if (document.fullscreenElement === stage) void document.exitFullscreen();
    if (hadFocus) end.querySelector('.film-replay').focus({ preventScroll: true });
  });

  toggle.addEventListener('click', () => {
    if (film.paused) { held = false; void play(); }
    else { held = true; film.pause(); }
  });
  sound.addEventListener('click', () => { film.muted = !film.muted; reflectSound(); });
  end.querySelector('.film-replay').addEventListener('click', () => { held = false; seek(0); void play(); toggle.focus({ preventScroll: true }); });
  for (const step of steps) step.button.addEventListener('click', () => { held = false; seek(step.at); void play(); });
  // A timecode anywhere on the page goes to the film and starts it there.
  for (const link of document.querySelectorAll('[data-film-jump]')) {
    link.addEventListener('click', () => { held = false; seek(Number(link.dataset.filmJump)); void play(); });
  }

  if (stage.requestFullscreen) {
    full.hidden = false;
    full.addEventListener('click', () => void (document.fullscreenElement ? document.exitFullscreen() : stage.requestFullscreen()));
  }

  const paint = () => {
    const t = film.currentTime;
    const total = film.duration || 122.7;
    let current = 0;
    steps.forEach((step, index) => {
      const next = steps[index + 1]?.at ?? total;
      step.fill.style.setProperty('--film-fill', Math.min(1, Math.max(0, (t - step.at) / (next - step.at))).toFixed(3));
      if (t >= step.at) current = index;
    });
    steps.forEach((step, index) => { if (index === current) step.button.setAttribute('aria-current', 'step'); else step.button.removeAttribute('aria-current'); });
    now.textContent = `${clock(t)} / ${clock(total)}`;
  };
  film.addEventListener('timeupdate', paint);
  film.addEventListener('seeked', paint);
  reflectSound();
  film.controls = false;

  if (!('IntersectionObserver' in window)) return;
  new IntersectionObserver(([entry]) => {
    inView = entry.intersectionRatio >= 0.6;
    if (inView) { if (!calm && !held && film.paused && !film.ended) void play(true); }
    else film.pause();
  }, { threshold: [0, 0.6, 1] }).observe(stage);
}
