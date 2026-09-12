import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { PRODUCT } from '../src/product';
import { applicableReleases, PRODUCT_RELEASES } from '../src/releases/productReleases';
import { useUiStore } from '../src/store/uiStore';
import { AboutDialog } from '../src/ui/common/AboutDialog';

/**
 * About → What's New → Release History → Release Detail: one modal, four internal views, never
 * a modal on a modal. `back` is a fixed hierarchy (Detail → History → What's New → About)
 * regardless of how a view was entered — these tests drive it the way a keyboard user would.
 */
describe('AboutDialog — What\'s New', () => {
  beforeEach(() => {
    useUiStore.setState({
      aboutOpen: true,
      updateReady: false,
      lastSeenProductRelease: '0.1.0', // old enough that the current version's notes are unread
    });
  });

  it('shows a "What\'s New" action in the version row when no update is pending', () => {
    render(<AboutDialog />);
    expect(screen.getByRole('button', { name: /What's New/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Update ready/i })).not.toBeInTheDocument();
  });

  it('shows "Update ready" instead of "What\'s New" when an update is staged — never both', () => {
    useUiStore.setState({ updateReady: true });
    render(<AboutDialog />);
    expect(screen.getByRole('button', { name: /Update ready/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /What's New/i })).not.toBeInTheDocument();
  });

  it('opening What\'s New leads with the current release, not CHANGELOG.md, and never a future one', async () => {
    const user = userEvent.setup();
    render(<AboutDialog />);
    await user.click(screen.getByRole('button', { name: /What's New/i }));

    expect(screen.getByRole('heading', { name: `v${PRODUCT.version}` })).toBeInTheDocument();

    // A release curated ahead of shipping must never surface. Asserted against the catalog
    // itself rather than a hard-coded version, so this can't quietly expire the way pinning it
    // to the then-unreleased 1.0.0 did.
    const shown = applicableReleases(PRODUCT.version);
    for (const release of PRODUCT_RELEASES) {
      if (shown.some((r) => r.version === release.version)) continue;
      expect(screen.queryByText(`v${release.version}`)).not.toBeInTheDocument();
    }
  });

  it('moves focus to the current release heading when opening What\'s New', async () => {
    const user = userEvent.setup();
    render(<AboutDialog />);
    await user.click(screen.getByRole('button', { name: /What's New/i }));
    expect(screen.getByRole('heading', { name: `v${PRODUCT.version}` })).toHaveFocus();
  });

  it('marks the release as seen on open, clearing the unread state', async () => {
    const user = userEvent.setup();
    render(<AboutDialog />);
    await user.click(screen.getByRole('button', { name: /What's New/i }));
    expect(useUiStore.getState().lastSeenProductRelease).toBe(PRODUCT.version);
  });

  it('does not render an accordion anywhere — no <details> in the modal', async () => {
    const user = userEvent.setup();
    const { container } = render(<AboutDialog />);
    await user.click(screen.getByRole('button', { name: /What's New/i }));
    expect(container.querySelectorAll('details')).toHaveLength(0);
  });

  it('"Back" (in the modal header) returns to About and focuses its heading', async () => {
    const user = userEvent.setup();
    render(<AboutDialog />);
    await user.click(screen.getByRole('button', { name: /What's New/i }));
    await user.click(screen.getByRole('button', { name: 'Back to About' }));

    expect(screen.getByText(PRODUCT.tagline)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: PRODUCT.name })).toHaveFocus();
  });

  it('Escape closes the whole dialog from inside What\'s New, rather than navigating back', async () => {
    const user = userEvent.setup();
    render(<AboutDialog />);
    await user.click(screen.getByRole('button', { name: /What's New/i }));
    await user.keyboard('{Escape}');
    expect(useUiStore.getState().aboutOpen).toBe(false);
  });

  it('shows up to 3 previous releases as plain rows, plus a link to the full history', async () => {
    const user = userEvent.setup();
    render(<AboutDialog />);
    await user.click(screen.getByRole('button', { name: /What's New/i }));

    const recent = applicableReleases(PRODUCT.version).slice(1, 4);
    for (const release of recent) {
      expect(screen.getByRole('button', { name: new RegExp(`v${release.version.replace(/\./g, '\\.')}`) })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: /View release history/i })).toBeInTheDocument();
  });

  it('selecting a recent release row jumps straight to its detail view, not an inline expansion', async () => {
    const user = userEvent.setup();
    render(<AboutDialog />);
    await user.click(screen.getByRole('button', { name: /What's New/i }));

    const recent = applicableReleases(PRODUCT.version)[1]!;
    await user.click(screen.getByRole('button', { name: new RegExp(`v${recent.version.replace(/\./g, '\\.')}`) }));

    expect(screen.getByRole('heading', { name: `v${recent.version}` })).toBeInTheDocument();
    expect(screen.getByText(recent.highlights[0]!.title, { exact: false })).toBeInTheDocument();
  });

  it('a release reached directly from What\'s New still backs up into Release History, not What\'s New', async () => {
    const user = userEvent.setup();
    render(<AboutDialog />);
    await user.click(screen.getByRole('button', { name: /What's New/i }));

    const recent = applicableReleases(PRODUCT.version)[1]!;
    await user.click(screen.getByRole('button', { name: new RegExp(`v${recent.version.replace(/\./g, '\\.')}`) }));
    await user.click(screen.getByRole('button', { name: 'Back to Release History' }));

    expect(screen.getByRole('button', { name: new RegExp(`v${recent.version.replace(/\./g, '\\.')}`) })).toBeInTheDocument();
  });

  it('"View release history" opens a dense index of every applicable release', async () => {
    const user = userEvent.setup();
    render(<AboutDialog />);
    await user.click(screen.getByRole('button', { name: /What's New/i }));
    await user.click(screen.getByRole('button', { name: /View release history/i }));

    const all = applicableReleases(PRODUCT.version);
    for (const release of all) {
      expect(screen.getByRole('button', { name: new RegExp(`v${release.version.replace(/\./g, '\\.')}`) })).toBeInTheDocument();
    }
    // The newest release is the one actually installed/represented — one restrained indicator.
    const currentRow = screen.getByRole('button', { name: new RegExp(`v${all[0]!.version.replace(/\./g, '\\.')}.*Current`) });
    expect(currentRow).toBeInTheDocument();
  });

  it('selecting a release from history shows its detail, and back returns to history', async () => {
    const user = userEvent.setup();
    render(<AboutDialog />);
    await user.click(screen.getByRole('button', { name: /What's New/i }));
    await user.click(screen.getByRole('button', { name: /View release history/i }));

    const target = applicableReleases(PRODUCT.version).at(-1)!; // the oldest one, only reachable via history
    await user.click(screen.getByRole('button', { name: new RegExp(`v${target.version.replace(/\./g, '\\.')}`) }));
    expect(screen.getByRole('heading', { name: `v${target.version}` })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Back to Release History' }));
    expect(screen.getByRole('heading', { name: /Browse previous releases/i })).toBeInTheDocument();
  });

  it('Release History groups by year only once more than one year is present', async () => {
    const user = userEvent.setup();
    render(<AboutDialog />);
    await user.click(screen.getByRole('button', { name: /What's New/i }));
    await user.click(screen.getByRole('button', { name: /View release history/i }));

    // Every curated release currently ships in 2026 — a single year heading would be pure noise.
    expect(screen.queryByRole('heading', { name: '2026' })).not.toBeInTheDocument();
  });

  it('the modal widens for What\'s New/History/Detail and stays compact for About', async () => {
    const user = userEvent.setup();
    const { container } = render(<AboutDialog />);
    const panel = () => container.querySelector<HTMLElement>('.dc-modal')!;
    expect(panel().style.width).toBe('380px');

    await user.click(screen.getByRole('button', { name: /What's New/i }));
    expect(panel().style.width).toBe('600px');

    await user.click(screen.getByRole('button', { name: /View release history/i }));
    expect(panel().style.width).toBe('600px');
  });

  it('a patch release with description-less highlights renders as compact lines, not empty bodies', async () => {
    const user = userEvent.setup();
    const patch = applicableReleases(PRODUCT.version).find((release) => release.highlights.some((h) => !h.description));
    if (!patch) return; // nothing to exercise if the catalog ever stops carrying a compact release

    render(<AboutDialog />);
    await user.click(screen.getByRole('button', { name: /What's New/i }));
    await user.click(screen.getByRole('button', { name: /View release history/i }));
    await user.click(screen.getByRole('button', { name: new RegExp(`v${patch.version.replace(/\./g, '\\.')}`) }));

    const compactHighlight = patch.highlights.find((h) => !h.description)!;
    expect(screen.getByText(compactHighlight.title, { exact: false })).toBeInTheDocument();
  });
});

describe('AboutDialog navigation labels stay oriented', () => {
  beforeEach(() => {
    useUiStore.setState({ aboutOpen: true, updateReady: false, lastSeenProductRelease: PRODUCT.version });
  });

  it('the dialog\'s accessible name tracks the current view', async () => {
    const user = userEvent.setup();
    render(<AboutDialog />);
    expect(screen.getByRole('dialog', { name: 'About' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /What's New/i }));
    expect(screen.getByRole('dialog', { name: "What's New" })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /View release history/i }));
    expect(screen.getByRole('dialog', { name: 'Release History' })).toBeInTheDocument();
  });

  it('does not repeat the section name as a second, content-level heading', async () => {
    const user = userEvent.setup();
    render(<AboutDialog />);
    await user.click(screen.getByRole('button', { name: /What's New/i }));
    const dialog = screen.getByRole('dialog');
    // Exactly one — the modal's own chrome title (h2). The content heading is the version itself.
    expect(within(dialog).getAllByRole('heading', { name: "What's New" })).toHaveLength(1);
  });
});
