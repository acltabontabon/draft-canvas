export function playExhibitBrief(figure, onComplete) {
  const brief = figure.querySelector('.exhibit-brief').cloneNode(true);
  brief.className = 'canvas-brief';
  // The footer already provides this text to assistive technology.
  brief.setAttribute('aria-hidden', 'true');
  brief.querySelector('[id]').removeAttribute('id');
  figure.append(brief);

  const duration = 2800;
  const animation = brief.animate([
    { opacity: 0, transform: 'translateY(6px)' },
    { opacity: 1, transform: 'none', offset: 0.12 },
    { opacity: 1, transform: 'none', offset: 0.89 },
    { opacity: 0, transform: 'translateY(-4px)' },
  ], { duration, fill: 'both' });

  function cancel() {
    animation.cancel();
    brief.remove();
  }
  void animation.finished.then(() => {
    cancel();
    onComplete();
  }, () => {});
  return cancel;
}
