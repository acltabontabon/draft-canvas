import { useEffect, useState } from 'react';
import type { DocumentStyle, HandPreset } from '../../document/style';
import { GALLERY_PAGE, stylePackFile, type GalleryStyle } from '../../gallery';
import type { ThemeName } from '../../render/theme/tokens';
import { MAX_PROFILES } from '../../storage/styleProfiles';
import { useGalleryStore } from '../../store/galleryStore';
import { useStyleStore } from '../../store/styleStore';
import { useUiStore } from '../../store/uiStore';
import { Button } from '../common/Button';
import { Icon } from '../common/Icon';
import { SettingsSection } from './layout';
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

  // The copy already on this device, and a fresh one when it is a day old. Never before consent.
  useEffect(() => {
    if (enabled) void useGalleryStore.getState().load();
  }, [enabled]);

  if (!enabled) {
    return (
      <SettingsSection
        title="Style packs"
        description="Ready-made styles from the Draft Canvas starters gallery. Loading reads that public gallery from GitHub, the same one Starters uses; nothing about your diagrams is sent."
      >
        <div className="dc-prefs-pack-actions">
          <Button variant="quiet" className="dc-prefs-outline" icon="export" onClick={() => void useGalleryStore.getState().enable()}>
            Load style packs
          </Button>
        </div>
      </SettingsSection>
    );
  }

  const busy = status !== 'idle';
  return (
    <SettingsSection title="Style packs" description="Ready-made styles from the starters gallery. Adding one makes it a style of your own, to change as you like." busy={busy}>
      {failure && (
        <p className="dc-prefs-note" data-tone="error" role="alert">
          <Icon name="alert" size={14} />
          <span>{FAILURES[failure]}</span>
        </p>
      )}
      {packs && packs.length > 0 ? (
        <ul className="dc-prefs-packs">
          {packs.map((pack) => (
            <PackRow key={pack.id} pack={pack} theme={theme} onAdded={onAdded} />
          ))}
        </ul>
      ) : (
        <p className="dc-prefs-empty">{busy ? 'Loading style packs…' : 'The gallery has no style packs yet.'}</p>
      )}
      <div className="dc-prefs-pack-actions">
        <Button variant="quiet" className="dc-prefs-outline" icon="refresh" disabled={busy} onClick={() => void useGalleryStore.getState().refresh()}>
          {status === 'refreshing' ? 'Refreshing…' : 'Refresh'}
        </Button>
        <a className="dc-prefs-link" href={`${GALLERY_PAGE}/tree/main/styles`} target="_blank" rel="noreferrer noopener">
          View on GitHub
        </a>
      </div>
    </SettingsSection>
  );
}

function PackRow({ pack, theme, onAdded }: { pack: GalleryStyle; theme: ThemeName; onAdded: (hand: HandPreset) => void }) {
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
    <li className="dc-prefs-pack">
      <div className="dc-prefs-pack-picture">{style ? <StylePreview style={style} theme={theme} size="row" label={`${pack.name}, drawn`} /> : null}</div>
      <div className="dc-prefs-row-text">
        <span className="dc-prefs-label">{pack.name}</span>
        <span className="dc-prefs-description">{pack.summary}</span>
        {credit && <span className="dc-prefs-detail">{credit}</span>}
      </div>
      <Button
        variant="quiet"
        className="dc-prefs-outline"
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
        {!style ? 'Not downloaded' : added ? 'Added' : 'Add'}
      </Button>
    </li>
  );
}
