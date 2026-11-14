import catalog from './docs-search-data.js';

const docsRoot = new URL('./docs/', import.meta.url);
const dialog = document.querySelector('.docs-search-dialog');
const trigger = document.querySelector('.docs-search-trigger');
const search = document.querySelector('.doc-search');
const input = search.querySelector('input');
const results = document.querySelector('#docs-results');
const status = results.querySelector('[role="status"]');
const list = results.querySelector('ul');
const limit = 10;

const normalize = (value) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const searchable = catalog.map((entry) => ({
  ...entry,
  heading: normalize(entry.section || entry.title),
  guide: normalize(entry.title),
  body: normalize(entry.content),
}));

function resultItem(entry) {
  const item = document.createElement('li');
  const link = document.createElement('a');
  const title = document.createElement('strong');
  link.href = new URL(entry.href, docsRoot);
  title.textContent = entry.section || entry.title;
  link.append(title);
  if (entry.section) {
    const guide = document.createElement('span');
    guide.textContent = entry.title;
    link.append(guide);
  }
  item.append(link);
  return item;
}

function updateResults() {
  const query = normalize(input.value);
  results.hidden = !query;
  if (!query) {
    status.textContent = '';
    list.replaceChildren();
    return;
  }

  const terms = [...new Set(query.split(' '))];
  const matches = [];
  for (const entry of searchable) {
    let score = entry.heading.includes(query) ? 12 : 0;
    let hits = 0;
    for (const term of terms) {
      const weight = entry.heading.includes(term) ? 6 : entry.guide.includes(term) ? 2 : entry.body.includes(term) ? 1 : 0;
      hits += Number(weight > 0);
      score += weight;
    }
    if (hits === terms.length) matches.push({ entry, score });
  }
  matches.sort((a, b) => b.score - a.score || Number(Boolean(a.entry.section)) - Number(Boolean(b.entry.section)));

  status.textContent = matches.length > limit ? `Showing ${limit} of ${matches.length} results`
    : matches.length === 1 ? '1 result' : matches.length ? `${matches.length} results` : 'No results. Try a different term.';
  list.replaceChildren(...matches.slice(0, limit).map(({ entry }) => resultItem(entry)));
}

search.hidden = false;
input.addEventListener('input', updateResults);
input.addEventListener('keydown', (event) => {
  if (event.isComposing) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    dialog.close();
  }
  if (event.key === 'Enter') list.querySelector('a')?.click();
});

trigger.hidden = false;
trigger.addEventListener('click', () => {
  // WebKit may leave the button unfocused on click. The dialog restores the opener's focus.
  trigger.focus({ preventScroll: true });
  dialog.showModal();
  input.focus();
  input.select();
});
dialog.querySelector('.docs-search-close').addEventListener('click', () => dialog.close());
list.addEventListener('click', (event) => {
  if (event.target.closest('a') && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) dialog.close();
});
