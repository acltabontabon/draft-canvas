import { Button } from '../../../ui/common/Button';
import { Icon, type IconName } from '../../../ui/common/Icon';
import { desktopStore } from '../../store';
import { canCheck, describeUpdate, updateStatusLine } from '../../updates';
import { useDesktopController, useDesktopState } from '../../useDesktop';
import { ChoiceRow, SettingsPage, SettingsSection } from './layout';

type Tone = 'idle' | 'busy' | 'ok' | 'news' | 'error';

const GLYPH: Record<Tone, IconName> = { idle: 'refresh', busy: 'refresh', ok: 'check', news: 'export', error: 'alert' };

/** Settings → Updates: where things stand, a way to look now, and the daily check. */
export function UpdateSettings() {
  const { update, settings } = useDesktopState();
  const controller = useDesktopController();
  const view = describeUpdate(update);
  const phase = update?.state.phase;
  const tone: Tone = update?.error
    ? 'error'
    : phase === 'checking' || phase === 'downloading' || phase === 'installing'
      ? 'busy'
      : phase === 'up-to-date'
        ? 'ok'
        : phase === 'available' || phase === 'ready'
          ? 'news'
          : 'idle';

  return (
    <SettingsPage title="Updates">
      <div className="dc-prefs-update" data-tone={tone}>
        <span className="dc-prefs-update-glyph" aria-hidden="true">
          <Icon name={GLYPH[tone]} size={18} />
        </span>
        <div className="dc-prefs-update-text" role="status">
          <span className="dc-prefs-update-version">{update ? `Draft Canvas ${update.currentVersion}` : 'Draft Canvas'}</span>
          <span className="dc-prefs-update-line">{updateStatusLine(update)}</span>
        </div>
        {view.version ? (
          <Button variant="solid" onClick={() => desktopStore.update({ settingsOpen: false, updateOpen: true })}>
            Show update
          </Button>
        ) : (
          <Button className="dc-prefs-outline" disabled={!canCheck(update)} onClick={() => void controller.checkForUpdate()}>
            {phase === 'checking' ? 'Checking…' : 'Check for updates'}
          </Button>
        )}
      </div>
      <SettingsSection title="Automatic checks">
        <ChoiceRow
          type="checkbox"
          label="Check for updates automatically"
          description="Once a day, and only to look. Nothing is downloaded or installed until you say so."
          checked={settings.autoCheckUpdates}
          onChange={(event) => void controller.setAutoCheckUpdates(event.target.checked)}
        />
      </SettingsSection>
    </SettingsPage>
  );
}
