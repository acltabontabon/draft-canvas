import { PRODUCT } from '../../product';
import { useUiStore } from '../../store/uiStore';
import { Icon } from './Icon';
import { Modal } from './Modal';

/**
 * The product's identity, not its documentation.
 *
 * Reuses the same node-and-connector mark as the favicon (`index.html`) so
 * the "brand" is one shape defined twice, not two shapes that happen to
 * agree today.
 */
function Mark() {
  return (
    <svg className="dc-about-mark" viewBox="0 0 32 32" width="22" height="22" aria-hidden="true">
      <rect x="6" y="8" width="11" height="7" rx="2" className="dc-about-mark-a" />
      <rect x="15" y="18" width="11" height="7" rx="2" className="dc-about-mark-b" />
      <path d="M11.5 15.5v3.5h4" className="dc-about-mark-a" />
    </svg>
  );
}

export function AboutDialog() {
  const open = useUiStore((state) => state.aboutOpen);
  const setOpen = useUiStore((state) => state.setAboutOpen);
  const updateReady = useUiStore((state) => state.updateReady);
  const activateUpdate = useUiStore((state) => state.activateUpdate);
  if (!open) return null;

  return (
    <Modal title="About" width={380} onClose={() => setOpen(false)}>
      <div className="dc-about">
        <div className="dc-about-brand">
          <Mark />
          <h3 className="dc-about-name">{PRODUCT.name}</h3>
        </div>

        <p className="dc-about-tagline">{PRODUCT.tagline}</p>
        <p className="dc-muted dc-about-desc">{PRODUCT.description}</p>
        <p className="dc-muted dc-about-privacy">{PRODUCT.privacy}</p>

        <div className="dc-about-tags">
          {updateReady ? (
            <button
              type="button"
              className="dc-about-update"
              onClick={activateUpdate}
              title="Reload to finish updating"
            >
              v{PRODUCT.version} · Update ready ↑
            </button>
          ) : (
            <code>v{PRODUCT.version}</code>
          )}
          <span className="dc-dot" />
          <code>Local-first</code>
        </div>

        <div className="dc-about-signature">
          <span>
            Built by <strong>{PRODUCT.author}</strong>
          </span>
          <div className="dc-about-links">
            <a
              className="dc-about-link"
              href={PRODUCT.links.github}
              target="_blank"
              rel="noreferrer"
              aria-label="GitHub"
              title="GitHub"
            >
              <Icon name="github" size={15} />
            </a>
            <a
              className="dc-about-link"
              href={PRODUCT.links.linkedin}
              target="_blank"
              rel="noreferrer"
              aria-label="LinkedIn"
              title="LinkedIn"
            >
              <Icon name="linkedin" size={15} />
            </a>
            <a
              className="dc-about-link"
              href={PRODUCT.links.website}
              target="_blank"
              rel="noreferrer"
              aria-label="Personal site"
              title="Personal site"
            >
              <Icon name="globe" size={15} />
            </a>
            <a
              className="dc-about-link"
              href={`mailto:${PRODUCT.links.email}`}
              aria-label="Email"
              title="Email"
            >
              <Icon name="mail" size={15} />
            </a>
          </div>
        </div>

        <details className="dc-about-support">
          <summary>♥ Support Draft Canvas</summary>
          <div className="dc-about-support-body">
            <p className="dc-muted">
              Draft Canvas is free and independently built. If it saved a meeting, explained an
              architecture, or kept you from opening something heavier, you can optionally support
              its development.
            </p>
            <a
              className="dc-support-link"
              href={PRODUCT.links.kofi}
              target="_blank"
              rel="noreferrer"
              aria-label="Support Draft Canvas on Ko-fi (opens in a new tab)"
            >
              ☕ Support on Ko-fi ↗
            </a>
            <p className="dc-muted dc-support-note">
              No perks, no paywalls — coffee accepted, architecture emergencies also accepted.
            </p>
          </div>
        </details>
      </div>
    </Modal>
  );
}
