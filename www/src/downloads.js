/**
 * Which desktop download to point at first.
 *
 * The download rows themselves live in index.html, with their URLs built at build time from the
 * app's own package.json version (see `versionInHtml` in vite.config.js). That is deliberate: they
 * are real links in the shipped HTML, so they work with scripting off, and a release updates them
 * by being cut rather than by anyone editing this file. Nothing here invents a URL.
 *
 * All this module does is guess which row the visitor probably wants and move it to the top. It is
 * never more than a guess, every row stays visible and clickable, and being wrong costs one glance.
 */

/**
 * In the order someone scanning the list would want them, and the order they appear in the markup.
 *
 * A browser will say it is on a Mac. It will not reliably say whether that Mac is Apple silicon or
 * Intel — and it does not matter here, because there is no Intel build to offer: the row says
 * "Apple silicon" in words rather than implying it covers every Mac.
 */
const TARGETS = [
  { slug: 'macos-arm64', match: /Mac|iPhone|iPad/i },
  { slug: 'windows-x64', match: /Win/i },
];

function platformString() {
  const data = navigator.userAgentData;
  return `${data?.platform ?? ''} ${navigator.platform ?? ''} ${navigator.userAgent}`;
}

/** The slug this visitor most likely wants, or null when nothing matches — a desktop Linux user,
 *  say, for whom neither installer is right and reordering would be a lie. */
export function likelyTarget() {
  const platform = platformString();
  return TARGETS.find((target) => target.match.test(platform))?.slug ?? null;
}

export function setUpDownloads() {
  const list = document.getElementById('targets');
  if (!list) return;

  const slug = likelyTarget();
  if (!slug) return;

  const row = list.querySelector(`a[data-slug="${slug}"]`)?.closest('li');
  if (!row) return;

  row.querySelector('a')?.setAttribute('aria-current', 'true');
  list.prepend(row);
}
