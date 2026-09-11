import { PRODUCT } from '../../product';
import { applicableReleases, hasUnreadRelease } from '../../releases/productReleases';
import { useUiStore } from '../../store/uiStore';
import { Icon } from '../common/Icon';

/**
 * The product's name, its mark, and the way into About — the one row every state of the home
 * screen shares, so nothing jumps when the first canvas turns first-run into a library.
 *
 * The mark is the favicon's own drawing (two boxes, one elbow connector) without its tile: the
 * smallest diagram Draft Canvas can draw, and so the most honest logo it could have.
 */
export function LibraryBrand() {
  const setAboutOpen = useUiStore((state) => state.setAboutOpen);
  const updateReady = useUiStore((state) => state.updateReady);
  const lastSeenProductRelease = useUiStore((state) => state.lastSeenProductRelease);
  const hasUnreadNotes = hasUnreadRelease(lastSeenProductRelease, applicableReleases(PRODUCT.version));
  const aboutLabel = updateReady
    ? 'About Draft Canvas — update ready'
    : hasUnreadNotes
      ? "About Draft Canvas — what's new"
      : 'About Draft Canvas';

  return (
    <div className="dc-brand">
      <svg className="dc-brand-mark" viewBox="4 6 24 21" width="22" height="19" aria-hidden="true" focusable="false">
        <rect className="dc-brand-mark-lead" x="6" y="8" width="11" height="7" rx="2" />
        <rect className="dc-brand-mark-follow" x="15" y="18" width="11" height="7" rx="2" />
        <path className="dc-brand-mark-edge" d="M11.5 15.5v3.5h3.5" />
      </svg>
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
