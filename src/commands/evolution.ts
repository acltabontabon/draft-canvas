/**
 * Every way into Canvas Evolution — the status, the palette, menus, the keyboard — goes through
 * here, so each entry point behaves the same and is guarded the same way.
 */
import { captureNow, dismissHistoryNote, historyService } from '../store/evolution/bridge';
import { useEvolutionStore } from '../store/evolution/evolutionStore';

/** Whether history is recording or readable for the open diagram. */
export function historyAvailable(): boolean {
  const { capture, repoId } = useEvolutionStore.getState();
  return repoId !== null || capture.kind === 'pending' || capture.kind === 'capturing' || capture.kind === 'up-to-date';
}

export function setTimelineOpen(open: boolean): void {
  useEvolutionStore.setState({ timelineOpen: open, detailsOpen: false });
}

export function toggleTimeline(): void {
  setTimelineOpen(!useEvolutionStore.getState().timelineOpen);
}

export function setHistoryDetailsOpen(open: boolean): void {
  useEvolutionStore.setState({ detailsOpen: open });
}

export function openHistorySettings(open = true): void {
  useEvolutionStore.setState({ settingsOpen: open, detailsOpen: false });
}

export function captureRevisionNow(): void {
  captureNow();
}

export function answerHistoryIdentity(continueHistory: boolean): void {
  void historyService().answerIdentity(continueHistory);
}

export function acknowledgeHistoryNote(): void {
  dismissHistoryNote();
}
