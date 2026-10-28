import { setUpDownloads } from './downloads.js';
import { setUpStudio } from './studio.js';

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

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

setUpDownloads();
setUpDownloadSheet();
setUpCopyButtons();
setUpStudio();
