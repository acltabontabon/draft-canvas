import { useContext, useEffect, useId, useState } from 'react';
import type { DocumentStyle, HandPreset } from '../../document/style';
import { GALLERY_PAGE, stylePackFile, type GalleryStyle } from '../../gallery';
import type { ThemeName } from '../../render/theme/tokens';
import { MAX_PROFILES } from '../../storage/styleProfiles';
import { useGalleryStore } from '../../store/galleryStore';
import { useStyleStore } from '../../store/styleStore';
import { useUiStore } from '../../store/uiStore';
import { Button } from '../common/Button';
import { Icon } from '../common/Icon';
import { CompactPrefs, Hint, SettingsSection } from './layout';
import { SectionHeadingLevel } from './sectionHeading';
import { StylePreview } from './StylePreview';

const FAILURES = {
  offline: 'The gallery couldn’t be reached. Check your connection and refresh.',
  newer: 'The gallery needs a newer Draft Canvas. Update to see its latest styles.',
  invalid: 'The gallery sent something that couldn’t be read. Try again later.',
} as const;

/**
 * Style packs: ready-made styles from the public starters gallery, to add to one's own.
 *
 * The same gallery, the same consent and the same checks as Starters: nothing is read from GitHub
 * until the person chooses to load it, each pack must hash to what the catalog says, and what is
 * added is whatever a style file is allowed to hold once checked, never the file as it arrived. A
 * pack that is added becomes a style of the person's own: theirs to change, and no link back.
 */
export function StylePacks({ theme, onAdded }: { theme: ThemeName; onAdded: (hand: HandPreset) => void }) {
  const enabled = useGalleryStore((state) => state.enabled);
  const status = useGalleryStore((state) => state.status);
  const failure = useGalleryStore((state) => state.failure);
  const packs = useGalleryStore((state) => state.snapshot?.styles);
  const id = useId();
  const compact = useContext(CompactPrefs);
  const Heading = useContext(SectionHeadingLevel) === 3 ? 'h3' : 'h4';

  // The copy already on this device, and a fresh one when it is a day old. Never before consent.
  useEffect(() => {
    if (enabled) void useGalleryStore.getState().load();
  }, [enabled]);

  if (!enabled) {
    return (
      <SettingsSection
        title="Style packs"
        description="Ready-made styles from the public starters gallery on GitHub. Nothing about your diagrams is sent."
      >
        <div className="dc-look-invite">
          <span className="dc-look-invite-art" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <Button variant="solid" icon="export" onClick={() => void useGalleryStore.getState().enable()}>
            Load style packs
          </Button>
        </div>
      </SettingsSection>
    );
  }

  const busy = status !== 'idle';
  const some = packs !== undefined && packs.length > 0;
  return (
    <section className="dc-prefs-section" aria-labelledby={`${id}-title`} aria-busy={busy || undefined}>
      {/* The heading, and beside it the two small things to do with the whole list. */}
      <div className="dc-look-section-head">
        <Heading id={`${id}-title`} className="dc-prefs-section-title">
          Style packs
        </Heading>
        {compact && <Hint about="Style packs">Ready-made styles from the starters gallery. Adding one makes it yours to change.</Hint>}
        <span className="dc-look-section-space" />
        <a className="dc-prefs-link" href={`${GALLERY_PAGE}/tree/main/styles`} target="_blank" rel="noreferrer noopener">
          GitHub
        </a>
        <Button variant="quiet" className="dc-look-section-action" icon="refresh" disabled={busy} aria-label={status === 'refreshing' ? 'Refreshing style packs' : 'Refresh style packs'} title="Refresh" onClick={() => void useGalleryStore.getState().refresh()} />
      </div>
      <p className={compact ? 'dc-sr-only' : 'dc-prefs-section-description'}>Ready-made styles. Adding one makes it yours to change.</p>
      {failure && (
        <p className="dc-prefs-note" data-tone="error" role="alert">
          <Icon name="alert" size={14} />
          <span>{FAILURES[failure]}</span>
        </p>
      )}
      {some ? (
        <ul className="dc-prefs-packs">
          {packs.map((pack) => (
            <PackRow key={pack.id} pack={pack} theme={theme} onAdded={onAdded} />
          ))}
        </ul>
      ) : (
        <p className="dc-look-status" data-quiet="">
          <span>{busy ? 'Loading style packs…' : 'None in the gallery yet.'}</span>
        </p>
      )}
    </section>
  );
}

function PackRow({ pack, theme, onAdded }: { pack: GalleryStyle; theme: ThemeName; onAdded: (hand: HandPreset) => void }) {
  const compact = useContext(CompactPrefs);
  const notify = useUiStore((state) => state.notify);
  const [style, setStyle] = useState<DocumentStyle | null>(null);
  // Added already when one of the person's styles is this pack, unchanged.
  const added = useStyleStore((state) => style !== null && state.profiles.some((profile) => JSON.stringify(profile.style) === JSON.stringify(style)));

  useEffect(() => {
    let live = true;
    if (pack.availability === 'ready') void stylePackFile(pack).then((file) => live && setStyle(file?.style ?? null));
    else setStyle(null);
    return () => {
      live = false;
    };
  }, [pack]);

  const credit = [pack.author ? `By ${pack.author}` : '', pack.licence].filter(Boolean).join(' · ');
  return (
    <li className="dc-prefs-pack" data-added={added ? '' : undefined} title={[pack.summary, credit].filter(Boolean).join('. ')}>
      <div className="dc-prefs-pack-picture">{style ? <StylePreview style={style} theme={theme} size="card" label={`${pack.name}, drawn`} /> : <span className="dc-prefs-pack-wait" aria-hidden="true" />}</div>
      <div className="dc-prefs-pack-body">
        {/* The picture says what it is; its summary and credit are a hover away (`title`), not on the card. */}
        <span className="dc-prefs-label">{pack.name}</span>
        <Button
          variant="quiet"
          className="dc-prefs-outline dc-prefs-pack-add"
          icon={added ? 'check' : 'plus'}
          disabled={!style || added}
          aria-label={added ? `${pack.name} is in your styles` : `Add ${pack.name} to my styles`}
          onClick={() => {
            if (!style) return;
            const id = useStyleStore.getState().add(pack.name, style);
            if (!id) {
              notify(`This device keeps up to ${MAX_PROFILES} styles. Delete one to make another.`, 'error');
              return;
            }
            onAdded(style.hand.base);
            notify(`“${pack.name}” is now your style.`);
          }}
        >
          {/* Beside the canvas the card is narrow: the plus says it, and the name keeps its room. */}
          {compact ? null : !style ? 'Not downloaded' : added ? 'Added' : 'Add'}
        </Button>
      </div>
    </li>
  );
}
