import evidence from '../../docs/media/releases/v1.14.0/source-evidence.png';

const MOMENTS = {
  present: { src: `${import.meta.env.BASE_URL}clips/present.mp4`, label: 'A request, its notes, and the code behind it.', theme: 'light' },
  nodi: { src: `${import.meta.env.BASE_URL}clips/nodi-review.mp4`, label: 'Reason about the design. Review the proposed change.', theme: 'dark' },
  inside: { src: `${import.meta.env.BASE_URL}clips/inside.mp4`, label: 'From the system into its components.', theme: 'light' },
  evidence: { src: evidence, label: 'Source references: observed facts and explicit assumptions.', theme: 'dark', still: true },
  collaboration: { src: `${import.meta.env.BASE_URL}clips/collaboration-paired.mp4`, label: 'One live canvas. Both sides of the conversation.', theme: 'light' },
  points: { src: `${import.meta.env.BASE_URL}clips/open-points.mp4`, label: 'Add a question to Orders API. Keep it attached and ready for review.', theme: 'dark' },
};

// Scroll selects chapters; native playback preserves every frame at a readable pace.
export function setUpRecordedStory(story, reduced) {
  const videos = [...story.querySelectorAll('.recorded-layer')];
  const still = story.querySelector('.recorded-still');
  const label = story.querySelector('.recording-moment');
  const type = story.querySelector('.recording-label');
  const fallback = story.querySelector('.recording-fallback');
  const paper = story.querySelector('.recorded-paper');
  const art = story.querySelector('.recorded-art');
  const participants = document.createElement('div');
  participants.className = 'collaboration-participants';
  participants.innerHTML = '<span>Alex · host</span><span>Cris · teammate</span>';
  paper.append(participants);
  const separator = document.createElement('div');
  separator.className = 'collaboration-separator';
  separator.setAttribute('aria-hidden', 'true');
  separator.innerHTML = `<svg viewBox="0 0 40 320" preserveAspectRatio="none" fill="none">
    <path d="M20 3 C16 48 24 86 19 133 M21 187 C16 223 23 269 19 317"/>
    <path class="pencil-echo" d="M23 9 Q20 75 22 125 M17 197 Q20 260 16 309"/>
    <path d="M5 154 Q20 151 35 153 M6 153 L11 148 M5 154 L11 158 M35 153 L29 148 M35 153 L29 159"/>
  </svg><span>live</span>`;
  paper.append(separator);
  const depth = story.querySelector('.depth-guide');
  const overview = depth.querySelector('button');
  const location = depth.querySelector('.depth-location');
  const clamp = (value) => Math.max(0, Math.min(1, value));
  function drawDepth(video) {
    if (requested === 'collaboration') {
      const time = video.currentTime;
      const caption = time < 2 ? 'Alex shares the session. Cris opens the invitation.'
        : time < 4 ? 'Cris asks to join. Alex decides who comes in.'
          : time < 9.6 ? 'Watch Cris edit on the right, with Alex’s canvas alongside.'
            : time < 17.4 ? 'The name and position update on Alex’s canvas too.'
              : time < 19.4 ? 'Alex ends the session for everyone.'
                : 'Cris’s live session ends. Alex keeps the updated canvas.';
      if (label.textContent !== caption) label.textContent = caption;
      return;
    }
    if (requested !== 'inside') return;
    // Follow the decoded frame, not the requested scroll time, so the map never leads the camera.
    const time = video.currentTime;
    const entered = clamp((time - 3.5) / 2);
    const returned = clamp((time - 20.3) / 2);
    const amount = entered * (1 - returned);
    setDepth(amount);
  }
  function setDepth(amount) {
    depth.style.setProperty('--depth-enter', String(amount));
    depth.dataset.level = amount > .5 ? 'components' : 'overview';
    overview.setAttribute('aria-current', amount > .5 ? 'false' : 'location');
    location.textContent = amount > .5 ? 'YOU ARE HERE · COMPONENTS' : 'YOU ARE HERE · OVERVIEW';
  }
  let active = -1;
  let requested = '';
  let generation = 0;
  let settled = false;
  let pausedByReader = false;
  let motionFrame = 0;
  let stall = 0;
  let arrival = 0;
  const controls = document.createElement('div');
  controls.className = 'recording-controls';
  controls.innerHTML = '<button type="button" data-play-demo>Pause demo</button><button type="button" data-replay-demo>Replay ↺</button>';
  art.append(controls);
  const playButton = controls.querySelector('[data-play-demo]');
  let returnToOverview = false;
  let folding = null;
  function cancelFold() {
    if (folding) {
      cancelAnimationFrame(folding.frame);
      folding.canvas.remove();
      folding = null;
    }
    delete paper.dataset.returning;
    paper.style.removeProperty('--return-progress');
  }
  function startFold() {
    const fold = folding;
    if (!fold || fold.started) return;
    fold.started = true;
    const start = performance.now();
    function animate(now) {
      if (folding !== fold) return;
      const t = clamp((now - start) / 1250);
      const eased = t * t * (3 - 2 * t);
      paper.style.setProperty('--return-progress', String(eased));
      setDepth(fold.depth * (1 - eased));
      if (t < 1) fold.frame = requestAnimationFrame(animate);
      else { cancelFold(); setDepth(0); }
    }
    fold.frame = requestAnimationFrame(animate);
  }
  videos.forEach((video) => { video.muted = true; });
  function seek(video) {
    if (!Number.isFinite(video.duration) || video.seeking || video.dataset.chapter !== requested) return;
    const fraction = returnToOverview ? 1 : reduced.matches ? .55 : 0;
    const end = Math.min(video.duration - .3, MOMENTS[requested]?.end ?? Infinity);
    const target = .2 + fraction * Math.max(0, end - .2);
    if (Math.abs(video.currentTime - target) > .09) video.currentTime = target;
  }
  videos.forEach((video) => video.addEventListener('seeked', () => {
    if (videos[active] === video && video.dataset.chapter === requested && !MOMENTS[requested]?.still) {
      if (folding) startFold();
      else drawDepth(video);
      syncPlayback();
    }
  }));
  function syncPlayback() {
    const video = videos[active];
    const canPlay = video && video.dataset.chapter === requested && !MOMENTS[requested]?.still
      && settled && !pausedByReader && !returnToOverview && !folding && !reduced.matches
      && !document.hidden && !art.hasAttribute('data-loading') && !video.ended;
    videos.forEach((layer) => { if (layer !== video || !canPlay) layer.pause(); });
    playButton.textContent = video?.ended ? 'Play again' : canPlay ? 'Pause demo' : 'Play demo';
    if (canPlay) video.playbackRate = .8;
    if (canPlay && video.paused) video.play().catch((error) => {
      if (error.name === 'AbortError') return;
      if (videos[active] === video && video.dataset.chapter === requested) {
        pausedByReader = true;
        playButton.textContent = 'Play demo';
      }
    });
    cancelAnimationFrame(motionFrame);
    if (canPlay) {
      const follow = () => {
        if (video.paused || video.ended) return;
        drawDepth(video);
        motionFrame = requestAnimationFrame(follow);
      };
      motionFrame = requestAnimationFrame(follow);
    }
  }
  function replay() {
    const video = videos[active];
    if (!video || video.dataset.chapter !== requested) return;
    cancelFold();
    returnToOverview = false;
    pausedByReader = false;
    video.currentTime = .2;
    syncPlayback();
  }
  playButton.addEventListener('click', () => {
    const video = videos[active];
    if (video?.ended || returnToOverview) { replay(); return; }
    pausedByReader = !video?.paused;
    syncPlayback();
  });
  controls.querySelector('[data-replay-demo]').addEventListener('click', replay);
  videos.forEach((video) => video.addEventListener('ended', syncPlayback));
  document.addEventListener('visibilitychange', syncPlayback);
  function select(name) {
    cancelFold();
    requested = name;
    returnToOverview = false;
    pausedByReader = false;
    videos.forEach((video) => video.pause());
    cancelAnimationFrame(motionFrame);
    clearTimeout(stall);
    clearTimeout(arrival);
    delete art.dataset.arriving;
    art.dataset.loading = '';
    depth.hidden = true;
    videos.forEach((video) => { video.onseeked = null; });
    const item = MOMENTS[name];
    const run = ++generation;
    fallback.hidden = true;
    const fail = () => {
      if (run !== generation) return;
      clearTimeout(stall);
      delete art.dataset.loading;
      fallback.hidden = false;
      videos.forEach((layer) => layer.classList.remove('is-current'));
      still.hidden = true;
    };
    // The sketch never stands in indefinitely: a stalled clip offers a retry instead.
    stall = setTimeout(() => { if (art.hasAttribute('data-loading')) fail(); }, 15000);
    const ready = () => {
      clearTimeout(stall);
      fallback.hidden = true;
      delete art.dataset.loading;
      // Restart the ink-in even when the previous chapter's has not yet been cleared.
      void art.offsetWidth;
      art.dataset.arriving = '';
      arrival = setTimeout(() => { if (run === generation) delete art.dataset.arriving; }, 900);
      depth.hidden = name !== 'inside';
      label.textContent = item.label;
      type.textContent = item.still ? 'ACTUAL EDITOR CAPTURE' : 'ACTUAL EDITOR · TAKE A MOMENT TO WATCH';
      controls.hidden = item.still || reduced.matches;
      paper.dataset.kind = item.still ? 'capture' : 'recording';
      paper.dataset.moment = name;
    };
    if (item.still) {
      const next = new Image();
      next.onload = () => {
        if (run !== generation) return;
        still.src = item.src;
        still.alt = item.label;
        still.dataset.theme = item.theme;
        still.hidden = false;
        videos.forEach((video) => video.classList.remove('is-current'));
        ready();
      };
      next.onerror = fail;
      next.src = item.src;
      return;
    }
    const index = active === 0 ? 1 : 0;
    const video = videos[index];
    video.onloadeddata = () => {
      if (run !== generation) return;
      const commit = () => {
        if (run !== generation) return;
        video.onseeked = null;
        active = index;
        still.hidden = true;
        videos.forEach((layer, i) => layer.classList.toggle('is-current', i === index));
        ready();
        drawDepth(video);
        syncPlayback();
      };
      // Publish only the requested, decoded frame; never flash another chapter's frame.
      video.onseeked = commit;
      seek(video);
      if (!video.seeking) commit();
    };
    video.onerror = fail;
    video.dataset.chapter = name;
    video.dataset.theme = item.theme;
    video.src = item.src;
    video.defaultPlaybackRate = .8;
    video.playbackRate = .8;
    video.preload = 'auto';
    video.load();
  }
  overview.addEventListener('click', () => {
    if (requested !== 'inside' || active < 0 || returnToOverview) return;
    const video = videos[active];
    if (video.readyState < 2 || video.seeking) return;
    returnToOverview = true;
    video.pause();
    cancelAnimationFrame(motionFrame);
    if (!reduced.matches && depth.dataset.level === 'components') {
      // Preserve the current component drawing while the overview frame decodes underneath it.
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.className = 'recorded-return';
      canvas.dataset.theme = 'light';
      canvas.setAttribute('aria-hidden', 'true');
      const context = canvas.getContext('2d');
      if (context) {
        context.drawImage(video, 0, 0);
        paper.append(canvas);
        folding = { canvas, frame: 0, started: false, depth: Number(depth.style.getPropertyValue('--depth-enter')) };
        paper.dataset.returning = '';
        paper.style.setProperty('--return-progress', '0');
      }
    }
    seek(video);
  });
  story.querySelector('[data-retry-recording]').addEventListener('click', () => select(requested || 'present'));
  return (name, visible, inReadingPosition) => {
    settled = visible && inReadingPosition;
    if (!visible) { syncPlayback(); return; }
    if (requested !== name) select(name);
    else syncPlayback();
    controls.hidden = !!MOMENTS[name].still || reduced.matches;
    // Captures stay still rather than pretending to be footage as the wheel moves.
    paper.style.setProperty('--capture-reveal', '1');
    paper.style.setProperty('--capture-pan', '0');
  };
}
