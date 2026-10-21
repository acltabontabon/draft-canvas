import { useEffect, useLayoutEffect, useRef } from 'react';
import { hostKind } from '../../host/hostInfo';
import { count } from '../../lib/plural';
import { receiveDiagrams, receivesHandoff, type ReceiverHost } from '../../storage/handoff';
import { useUiStore } from '../../store/uiStore';
import type { DocumentSession } from '../../store/useDocumentSession';

/**
 * The new address's half of the move (`storage/handoff.ts`): when the old address opened this tab
 * to bring its Library over, take it in once storage is open, then show it and say so.
 *
 * `receiveDiagrams` hands every call on a page the same promise, so StrictMode's second effect run
 * neither restores twice nor loses the outcome — it is simply the run that reports it.
 */
export function useHandoffReceiver(session: DocumentSession): void {
  const latest = useRef(session);
  useLayoutEffect(() => {
    latest.current = session;
  });
  const repository = session.repository;

  useEffect(() => {
    if (__DESKTOP__ || hostKind() !== null || !repository) return;
    const host = window as unknown as ReceiverHost;
    if (!receivesHandoff(host)) return;
    let cancelled = false;
    void receiveDiagrams({ repository, host }).then(async (outcome) => {
      if (cancelled) return;
      const { notify } = useUiStore.getState();
      if (outcome.kind === 'failed') {
        notify(`Your diagrams couldn’t be moved in: ${outcome.message} Back up at the old address and use Restore here instead.`, 'error');
        return;
      }
      if (outcome.kind !== 'received') return;
      const { restored, renamed, skipped } = outcome.result;
      await latest.current.refreshProjects().catch(() => {});
      await latest.current.refreshLibrary().catch(() => {});
      if (restored === 0) {
        notify(skipped.length ? 'None of your diagrams could be read here. Back up at the old address and use Restore instead.' : 'Welcome to the new home. There were no diagrams to bring over.', skipped.length ? 'error' : 'info');
        return;
      }
      const copies = renamed ? ` (${renamed} as ${renamed === 1 ? 'a copy' : 'copies'})` : '';
      const unread = skipped.length ? ` ${count(skipped.length, 'file')} couldn’t be read.` : '';
      notify(`Welcome to the new home — ${count(restored, 'diagram')} moved in${copies}.${unread}`);
    });
    return () => {
      cancelled = true;
    };
  }, [repository]);
}
