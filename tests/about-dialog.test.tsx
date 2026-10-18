import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { PRODUCT } from '../src/product';
import { AboutDialog } from '../src/ui/common/AboutDialog';
import { useUiStore } from '../src/store/uiStore';

describe('AboutDialog credits', () => {
  beforeEach(() => {
    useUiStore.setState({ aboutOpen: true, updateReady: false });
  });

  it('renders nothing when closed', () => {
    useUiStore.setState({ aboutOpen: false });
    const { container } = render(<AboutDialog />);
    expect(container).toBeEmptyDOMElement();
  });

  it('keeps bundled licences accessible among the credits', () => {
    render(<AboutDialog />);
    const link = screen.getByRole('link', { name: /Licences/i });
    expect(link).toHaveAttribute('href', './THIRD_PARTY_LICENSES.txt');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });

  it('leaves donation links out of About', () => {
    const { container } = render(<AboutDialog />);
    expect(container.querySelector(`a[href="${PRODUCT.links.kofi}"]`)).toBeNull();
  });
});
