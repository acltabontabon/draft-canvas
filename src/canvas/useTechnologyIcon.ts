import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { DraftNode } from '../document/types';
import { logDiagnostic } from '../lib/diagnostics';
import { loadTechnologyIcon, loadTechnologyIcons, subscribeTechnologyIcon, technologiesIn, technologyIcon } from '../nodes/technology';

/** Only a node's own icon can invalidate its display list. Loading never touches document/history
 * or React Flow's measurements: the neutral placeholder and logo share the same small extent. */
export function useTechnologyIcon(technology: string | undefined) {
  const subscribe = useCallback((listener: () => void) => subscribeTechnologyIcon(technology, listener), [technology]);
  const snapshot = useCallback(() => technologyIcon(technology), [technology]);
  const icon = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    void loadTechnologyIcon(technology).catch((error) => logDiagnostic(error, { operation: 'load-technology-icon' }));
  }, [technology]);
  return icon;
}

/**
 * A sequence draws a logo for each participant, so it waits on several at once. `key` is their
 * technologies joined by a line break — a string, so an unchanged sequence subscribes to nothing
 * new. The number only says "draw again"; it is never read.
 */
export function useTechnologyRevision(key: string): number {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!key) return;
    const values = [...new Set(key.split('\n'))];
    const unsubscribe = values.map((value) => subscribeTechnologyIcon(value, () => setRevision((current) => current + 1)));
    void Promise.all(values.map(loadTechnologyIcon))
      .then(() => setRevision((current) => current + 1))
      .catch((error) => logDiagnostic(error, { operation: 'load-technology-icons' }));
    return () => { for (const stop of unsubscribe) stop(); };
  }, [key]);
  return revision;
}

/** Whole-scene thumbnails subscribe once per distinct technology, not once per store update. */
export function useTechnologyIcons(nodes: readonly DraftNode[] | undefined): number {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!nodes) return;
    const values = technologiesIn(nodes);
    const unsubscribe = [...values].map((value) => subscribeTechnologyIcon(value, () => setRevision((revision) => revision + 1)));
    void loadTechnologyIcons(nodes).catch((error) => logDiagnostic(error, { operation: 'load-technology-icons' }));
    return () => { for (const stop of unsubscribe) stop(); };
  }, [nodes]);
  return revision;
}
