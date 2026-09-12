import { useEffect, useRef, useState, type RefObject } from 'react';
import { formatReleaseDate, formatReleaseDateCompact } from '../../lib/date';
import { versionKind } from '../../lib/semver';
import { PRODUCT } from '../../product';
import {
  applicableReleases,
  groupReleasesByYear,
  hasUnreadRelease,
  type ProductRelease,
  type ProductReleaseHighlight,
} from '../../releases/productReleases';
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
    <svg className="dc-about-mark" viewBox="0 0 32 32" width="26" height="26" aria-hidden="true">
      <rect x="6" y="8" width="11" height="7" rx="2" className="dc-about-mark-a" />
      <rect x="15" y="18" width="11" height="7" rx="2" className="dc-about-mark-b" />
      <path d="M11.5 15.5v3.5h4" className="dc-about-mark-a" />
    </svg>
  );
}

function ReleaseHighlights({ highlights }: { highlights: ProductReleaseHighlight[] }) {
  return (
    <ul className="dc-whats-new-highlights">
      {highlights.map((highlight) => (
        <li key={highlight.title}>
          {highlight.description ? (
            <>
              <strong>{highlight.title}</strong>
              <p>{highlight.description}</p>
            </>
          ) : (
            <p className="dc-whats-new-highlight-compact">– {highlight.title}</p>
          )}
        </li>
      ))}
    </ul>
  );
}

/** A single dense, clickable metadata row — never the release's own body. Shared by the quick
 *  "Previous releases" list (What's New) and the full index (Release History) so both browse the
 *  same way: pick a version, land on its detail. */
function ReleaseRow({
  release,
  isCurrent,
  onSelect,
}: {
  release: ProductRelease;
  isCurrent: boolean;
  onSelect: () => void;
}) {
  return (
    <button type="button" className={`dc-release-row dc-release-row--${versionKind(release.version)}`} onClick={onSelect}>
      <span className="dc-release-row-version">
        v{release.version}
        {isCurrent && <span className="dc-release-row-current"> · Current</span>}
      </span>
      {release.date && <span className="dc-release-row-date">{formatReleaseDateCompact(release.date)}</span>}
    </button>
  );
}

function WhatsNewView({
  releases,
  headingRef,
  onOpenHistory,
  onOpenDetail,
}: {
  releases: ProductRelease[];
  headingRef: RefObject<HTMLHeadingElement | null>;
  onOpenHistory: () => void;
  onOpenDetail: (version: string) => void;
}) {
  const [latest, ...rest] = releases;
  const recent = rest.slice(0, 3);

  if (!latest) {
    return (
      <div className="dc-whats-new dc-view-enter">
        <h3 className="dc-whats-new-version-heading" ref={headingRef} tabIndex={-1}>
          What's New
        </h3>
        <p className="dc-about-sub">Nothing curated for this version yet.</p>
      </div>
    );
  }

  return (
    <div className="dc-whats-new dc-view-enter">
      <h3 className="dc-whats-new-version-heading" ref={headingRef} tabIndex={-1}>
        v{latest.version}
      </h3>
      {latest.date && <p className="dc-whats-new-date-full">{formatReleaseDate(latest.date, 'long')}</p>}
      {latest.summary && <p className="dc-whats-new-summary">{latest.summary}</p>}
      <ReleaseHighlights highlights={latest.highlights} />

      {recent.length > 0 && (
        <div className="dc-whats-new-recent">
          <h4 className="dc-about-section-title">Previous releases</h4>
          <div className="dc-release-rows">
            {recent.map((release) => (
              <ReleaseRow key={release.version} release={release} isCurrent={false} onSelect={() => onOpenDetail(release.version)} />
            ))}
          </div>
          <button type="button" className="dc-whats-new-history-link" onClick={onOpenHistory}>
            View release history →
          </button>
        </div>
      )}
    </div>
  );
}

function HistoryView({
  releases,
  headingRef,
  onSelect,
}: {
  releases: ProductRelease[];
  headingRef: RefObject<HTMLHeadingElement | null>;
  onSelect: (version: string) => void;
}) {
  const groups = groupReleasesByYear(releases);
  const showYears = groups.length > 1;
  const currentVersion = releases[0]?.version;

  return (
    <div className="dc-history dc-view-enter">
      <h3 className="dc-history-title" ref={headingRef} tabIndex={-1}>
        Browse previous releases
      </h3>

      {groups.map((group) => (
        <div key={group.year ?? 'undated'} className="dc-history-group">
          {showYears && <h4 className="dc-about-section-title">{group.year ?? '—'}</h4>}
          <div className="dc-release-rows">
            {group.releases.map((release) => (
              <ReleaseRow
                key={release.version}
                release={release}
                isCurrent={release.version === currentVersion}
                onSelect={() => onSelect(release.version)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function DetailView({ release, headingRef }: { release: ProductRelease | undefined; headingRef: RefObject<HTMLHeadingElement | null> }) {
  if (!release) {
    return (
      <div className="dc-whats-new dc-view-enter">
        <h3 className="dc-whats-new-version-heading" ref={headingRef} tabIndex={-1}>
          Release not found
        </h3>
      </div>
    );
  }
  return (
    <div className="dc-whats-new dc-view-enter">
      <h3 className="dc-whats-new-version-heading" ref={headingRef} tabIndex={-1}>
        v{release.version}
      </h3>
      {release.date && <p className="dc-whats-new-date-full">{formatReleaseDate(release.date, 'long')}</p>}
      {release.summary && <p className="dc-whats-new-summary">{release.summary}</p>}
      <ReleaseHighlights highlights={release.highlights} />
    </div>
  );
}

type View =
  | { kind: 'about' }
  | { kind: 'whats-new' }
  | { kind: 'history' }
  | { kind: 'detail'; version: string; from: 'whats-new' | 'history' };

export function AboutDialog() {
  const open = useUiStore((state) => state.aboutOpen);
  // Mounted only while open, so every open starts on About rather than on whatever release the
  // last visit drilled into.
  return open ? <AboutDialogBody /> : null;
}

function AboutDialogBody() {
  const setOpen = useUiStore((state) => state.setAboutOpen);
  const updateReady = useUiStore((state) => state.updateReady);
  const activateUpdate = useUiStore((state) => state.activateUpdate);
  const lastSeenProductRelease = useUiStore((state) => state.lastSeenProductRelease);
  const markProductReleaseSeen = useUiStore((state) => state.markProductReleaseSeen);

  const [view, setView] = useState<View>({ kind: 'about' });
  const isFirstRender = useRef(true);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const releases = applicableReleases(PRODUCT.version);
  const unread = hasUnreadRelease(lastSeenProductRelease, releases);
  const viewKey = view.kind === 'detail' ? `detail:${view.version}` : view.kind;

  // Skipped on mount — `Modal` already puts focus on the panel itself when it first opens. Fires
  // on every deliberate view change (either direction), landing on that view's own heading —
  // simple and consistent rather than trying to remember exactly which control led here.
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [viewKey]);

  const openWhatsNew = () => {
    setView({ kind: 'whats-new' });
    markProductReleaseSeen();
  };

  const isWide = view.kind !== 'about';
  const modalTitle = view.kind === 'about' ? 'About' : view.kind === 'whats-new' ? "What's New" : 'Release History';
  const backLabel =
    view.kind === 'whats-new'
      ? 'Back to About'
      : view.kind === 'history'
        ? "Back to What's New"
        : view.kind === 'detail' && view.from === 'history'
          ? 'Back to Release History'
          : "Back to What's New";
  const onBack =
    view.kind === 'about'
      ? undefined
      : view.kind === 'whats-new'
        ? () => setView({ kind: 'about' })
        : view.kind === 'history'
          ? () => setView({ kind: 'whats-new' })
          : () => setView(view.from === 'history' ? { kind: 'history' } : { kind: 'whats-new' });

  return (
    <Modal
      title={modalTitle}
      width={isWide ? 600 : 380}
      onClose={() => setOpen(false)}
      className={isWide ? 'dc-modal-about dc-modal-wide' : 'dc-modal-about'}
      onBack={onBack}
      backLabel={backLabel}
    >
      {view.kind === 'about' && (
        <div className="dc-about dc-view-enter">
          <div className="dc-about-brand">
            <Mark />
            <h3 className="dc-about-name" ref={headingRef} tabIndex={-1}>
              {PRODUCT.name}
            </h3>
          </div>

          <p className="dc-about-tagline">{PRODUCT.tagline}</p>
          <p className="dc-about-sub">{PRODUCT.pitch}</p>

          <div className="dc-about-version-row">
            <span className="dc-about-version" aria-label={`Version ${PRODUCT.version}`}>
              v{PRODUCT.version}
            </span>
            {updateReady ? (
              <button
                type="button"
                className="dc-about-version-action dc-about-version-action--update"
                onClick={activateUpdate}
                title="Reload to finish updating"
              >
                Update ready ↑
              </button>
            ) : (
              <button type="button" className="dc-about-version-action" onClick={openWhatsNew}>
                {unread && <span className="dc-release-dot" aria-hidden="true" />}
                What's New
                {unread && <span className="dc-sr-only"> — new</span>}
                {' →'}
              </button>
            )}
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

          <a
            className="dc-about-support"
            href={PRODUCT.links.kofi}
            target="_blank"
            rel="noreferrer"
            title="If Draft Canvas helped, you can optionally support its development."
            aria-label="Buy the builder a coffee on Ko-fi (opens in a new tab)"
          >
            ☕ Buy the builder a coffee ↗
          </a>
        </div>
      )}

      {view.kind === 'whats-new' && (
        <WhatsNewView
          releases={releases}
          headingRef={headingRef}
          onOpenHistory={() => setView({ kind: 'history' })}
          onOpenDetail={(version) => setView({ kind: 'detail', version, from: 'whats-new' })}
        />
      )}

      {view.kind === 'history' && (
        <HistoryView releases={releases} headingRef={headingRef} onSelect={(version) => setView({ kind: 'detail', version, from: 'history' })} />
      )}

      {view.kind === 'detail' && (
        <DetailView release={releases.find((release) => release.version === view.version)} headingRef={headingRef} />
      )}
    </Modal>
  );
}
