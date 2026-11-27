import { useEffect } from 'react';
import { openHistorySettings } from '../../../commands/evolution';
import { hostKind } from '../../../host/hostInfo';
import { useEvolutionStore } from '../../../store/evolution/evolutionStore';
import { HistorySettings } from '../../settings/HistorySettings';
import { SettingsDialog, type SettingsCategory } from '../../settings/SettingsDialog';

const CATEGORIES: readonly [SettingsCategory<'history'>] = [{ id: 'history', label: 'History', icon: 'timeline', Page: HistorySettings }];

/**
 * Settings → History, where it is opened from the editor. The web has no Settings window of its own,
 * so it shows this page alone; the desktop app opens its own Settings at History instead.
 */
export function HistorySettingsDialog() {
  const open = useEvolutionStore((state) => state.settingsOpen);
  const desktop = __DESKTOP__ && hostKind() === 'desktop';

  useEffect(() => {
    if (!open || !desktop) return;
    openHistorySettings(false);
    void import('../../../desktop/store').then(({ desktopStore }) => desktopStore.update({ settingsOpen: true, settingsCategory: 'history' }));
  }, [open, desktop]);

  if (!open || desktop) return null;
  return <SettingsDialog categories={CATEGORIES} current="history" onSelect={() => {}} onClose={() => openHistorySettings(false)} />;
}
