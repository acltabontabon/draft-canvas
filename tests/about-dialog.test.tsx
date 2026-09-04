import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { PRODUCT } from '../src/product';
import { AboutDialog } from '../src/ui/common/AboutDialog';
import { useUiStore } from '../src/store/uiStore';

/**
 * Phase 10 — Support Draft Canvas. The support entry is a single collapsed
 * `<details>` inside the existing About dialog: invisible weight until someone
 * deliberately opens it, and its one action is a plain external Ko-fi link,
 * not a payment integration.
 */
describe('AboutDialog support entry', () => {
  beforeEach(() => {
    useUiStore.setState({ aboutOpen: true, updateReady: false });
  });

  it('renders nothing when closed', () => {
    useUiStore.setState({ aboutOpen: false });
    const { container } = render(<AboutDialog />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a collapsed support disclosure that is not open by default', () => {
    render(<AboutDialog />);
    const details = screen.getByText('♥ Support Draft Canvas').closest('details');
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute('open');
  });

  it('reveals a Ko-fi link, opened externally, once expanded', () => {
    render(<AboutDialog />);
    fireEvent.click(screen.getByText('♥ Support Draft Canvas'));

    const link = screen.getByRole('link', { name: /Support Draft Canvas on Ko-fi/i });
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
