import { createContext, useCallback, useContext, useEffect, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import type { TrafficAnalysis } from '../traffic';
import type { recoveryPlan } from '../traffic/recovery';

type Replay = { id: string; analysis: TrafficAnalysis; plan: NonNullable<ReturnType<typeof recoveryPlan>>; count: number | null };
type ReplayContext = {
  replay: Replay | null;
  setReplay: Dispatch<SetStateAction<Replay | null>>;
  clearReplay: () => void;
  revision: number;
};
const Context = createContext<ReplayContext | null>(null);

/** Shared only by Traffic's canvas readings and edge controls. Never document or undo state. */
export function TrafficReplayProvider({ active, children }: { active: boolean; children: ReactNode }) {
  const [replay, setReplay] = useState<Replay | null>(null);
  const [revision, setRevision] = useState(0);
  const clearReplay = useCallback(() => {
    setReplay(null);
    setRevision((value) => value + 1);
  }, []);
  useEffect(() => {
    // The provider also encloses the viewport, so it stays mounted when Traffic closes.
    // oxlint-disable-next-line react/set-state-in-effect
    if (!active) clearReplay();
  }, [active, clearReplay]);
  const value = useMemo(() => ({ replay, setReplay, clearReplay, revision }), [replay, clearReplay, revision]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useTrafficReplay() {
  const value = useContext(Context);
  if (!value) throw new Error('Traffic replay requires its provider');
  return value;
}
