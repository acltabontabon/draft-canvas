import { setUpDownloads } from './downloads.js';
import { setUpGallery } from './gallery.js';
import { animateOverviewInk } from './pencil.js';

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

function setUpDownloadSheet() {
  const dialog = document.getElementById('download');
  if (!(dialog instanceof HTMLDialogElement) || typeof dialog.showModal !== 'function') return;

  const open = () => {
    if (dialog.open) return;
    dialog.showModal();
    // The row the visitor most likely wants is first (see downloads.js); start there.
    dialog.querySelector('#targets a')?.focus({ preventScroll: true });
  };

  dialog.addEventListener('close', () => {
    if (location.hash === '#download') history.replaceState(null, '', location.pathname + location.search);
  });

  for (const trigger of document.querySelectorAll('[data-download]')) {
    trigger.addEventListener('click', (event) => {
      event.preventDefault();
      open();
    });
  }

  dialog.querySelector('[data-close]')?.addEventListener('click', () => dialog.close());
  // A click on the backdrop lands on the <dialog> itself; the sheet inside fills the dialog box.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });

  // A shared link to the downloads opens them.
  if (location.hash === '#download') open();
  window.addEventListener('hashchange', () => {
    if (location.hash === '#download') open();
  });
}

function animateClosingCanvas() {
  if (!matchMedia('(prefers-reduced-motion: no-preference)').matches || !('IntersectionObserver' in window)) return;
  const closing = document.getElementById('closing');
  const observer = new IntersectionObserver(([entry]) => {
    if (entry.intersectionRatio < 0.35) return;
    closing.dataset.drawn = '';
    observer.disconnect();
  }, { threshold: 0.35 });
  observer.observe(closing);
}

setUpDownloads();
setUpDownloadSheet();
setUpCopyButtons();
animateOverviewInk();
setUpGallery();
animateClosingCanvas();
