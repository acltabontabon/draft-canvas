import { useStore } from '@xyflow/react';

/**
 * Which of this shape's handles a connection in flight starts at and would validly land on, as
 * `from|to` (either side empty), or `''` when it is in none: a string, so the shape re-renders only
 * when its own answer changes, and never while nothing is being connected.
 */
export function useConnectingHandles(nodeId: string): { from: string | null; to: string | null } {
  const key = useStore((state) => {
    const { fromHandle, toHandle, isValid } = state.connection;
    if (!fromHandle) return '';
    const from = fromHandle.nodeId === nodeId ? (fromHandle.id ?? '') : '';
    const to = isValid && toHandle?.nodeId === nodeId ? (toHandle.id ?? '') : '';
    return from || to ? `${from}|${to}` : '';
  });
  if (!key) return NOT_CONNECTING;
  const [from, to] = key.split('|');
  return { from: from || null, to: to || null };
}

const NOT_CONNECTING = { from: null, to: null };
