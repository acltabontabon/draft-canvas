import { PRODUCT } from '../../product';
import { useUiStore } from '../../store/uiStore';
import { BrandMark } from '../common/BrandMark';
import { Icon } from '../common/Icon';
import { useUnreadReleaseNotes } from '../common/useUnreadReleaseNotes';
import './library-theme.css';

/**
 * The product's name, its mark, and the way into About — the one row every state of the home
 * screen shares, so nothing jumps when the first canvas turns first-run into a library.
 */
export function LibraryBrand() {
  const setAboutOpen = useUiStore((state) => state.setAboutOpen);
  const updateReady = useUiStore((state) => state.updateReady);
  const hasUnreadNotes = useUnreadReleaseNotes();
  const aboutLabel = updateReady
    ? 'About Draft Canvas — update ready'
    : hasUnreadNotes
      ? "About Draft Canvas — what's new"
      : 'About Draft Canvas';

  return (
    <div className="dc-brand">
      <BrandMark />
      <h1>{PRODUCT.name}</h1>
      <span className="dc-badge-anchor">
        <button
          type="button"
          className="dc-brand-about"
          onClick={() => setAboutOpen(true)}
          aria-label={aboutLabel}
          title={aboutLabel}
        >
          <Icon name="info" size={14} />
        </button>
        {updateReady ? (
          <span className="dc-update-dot" aria-hidden="true" />
        ) : (
          hasUnreadNotes && <span className="dc-new-dot" aria-hidden="true" />
        )}
      </span>
    </div>
  );
}
