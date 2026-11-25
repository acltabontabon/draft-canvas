/**
 * Every way into Canvas Evolution — the status, the palette, menus, the keyboard — goes through
 * here, so each entry point behaves the same and is guarded the same way.
 */
import { captureNow, dismissHistoryNote, historyService } from '../store/evolution/bridge';
import type { Command } from './types';
import { useEvolutionStore } from '../store/evolution/evolutionStore';
import { closeLens, loadTimeline } from '../store/evolution/historyView';

/** Whether history is recording or readable for the open diagram. */
export function historyAvailable(): boolean {
  const { capture, repoId } = useEvolutionStore.getState();
  return repoId !== null || capture.kind === 'pending' || capture.kind === 'capturing' || capture.kind === 'up-to-date';
}

/** Opens the timeline (reading the newest revisions) or closes it, and with it any revision on screen. */
export function setTimelineOpen(open: boolean): void {
  useEvolutionStore.setState({ timelineOpen: open, detailsOpen: false });
  if (open) void loadTimeline();
  else closeLens();
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

/** History in ⌘K: the timeline, recording now, and history's settings. */
export function historyCommands(): Command[] {
  const { timelineOpen, capture, repoId } = useEvolutionStore.getState();
  const commands: Command[] = [];
  if (repoId || capture.kind === 'pending' || capture.kind === 'up-to-date' || capture.kind === 'capturing') {
    commands.push({
      id: 'history-timeline',
      title: timelineOpen ? 'Close the timeline' : 'Show the timeline',
      group: 'view',
      hint: 'How this diagram evolved',
      keywords: ['history', 'timeline', 'versions', 'revisions', 'evolution', 'past', 'earlier', 'git', 'time travel'],
      run: () => toggleTimeline(),
    });
  }
  if (capture.kind === 'pending' || capture.kind === 'failed') {
    commands.push({
      id: 'history-capture',
      title: 'Add to history now',
      group: 'view',
      keywords: ['history', 'checkpoint', 'snapshot', 'commit', 'revision', 'save version'],
      run: () => captureRevisionNow(),
    });
  }
  commands.push({
    id: 'history-settings',
    title: 'History settings…',
    group: 'view',
    keywords: ['history', 'timeline', 'git', 'export history', 'remove history', 'privacy'],
    run: () => openHistorySettings(true),
  });
  return commands;
}
