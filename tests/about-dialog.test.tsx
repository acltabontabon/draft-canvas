import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { PRODUCT } from '../src/product';
import { AboutDialog } from '../src/ui/common/AboutDialog';
import { useUiStore } from '../src/store/uiStore';

/**
 * Phase 10 — Support Draft Canvas. A single human footnote inside the
 * existing About dialog: a plain external Ko-fi link, visible immediately
 * (no expand/collapse, no explanatory paragraph), not a payment integration.
 */
describe('AboutDialog support link', () => {
  beforeEach(() => {
    useUiStore.setState({ aboutOpen: true, updateReady: false });
  });

  it('renders nothing when closed', () => {
    useUiStore.setState({ aboutOpen: false });
    const { container } = render(<AboutDialog />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a Ko-fi link, opened externally, with no click needed to reveal it', () => {
    render(<AboutDialog />);
    const link = screen.getByRole('link', { name: /Buy the builder a coffee/i });
    expect(link).toHaveAttribute('href', PRODUCT.links.kofi);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });

  it('reuses the existing signature-link pattern, not a payment SDK', () => {
    // No script, iframe, or embed is introduced for this feature — it is exactly
    // one anchor, same shape as the GitHub/LinkedIn/website links above it.
    const { container } = render(<AboutDialog />);
    expect(container.querySelectorAll('iframe, script, embed')).toHaveLength(0);
  });
});
