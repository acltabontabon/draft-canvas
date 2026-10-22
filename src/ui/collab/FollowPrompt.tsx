import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { findFlow } from '../../document/flow';
import { useCollabStore } from '../../store/collabStore';
import { useEditorStore } from '../../store/editorStore';
import { Icon } from '../common/Icon';
import { PeerBadge } from './PeerBadge';
import { presenterOf } from './presence/model';
import '../../styles/presence.css';

/**
 * The offer to follow a presenter, for a collaborator: a small pill at the foot of the canvas the
 * moment the owner starts presenting — never a dialog, never a camera taken without asking. Follow
 * puts their room and camera on the presenter's (`useFollowPresenter`) and frames the canvas in the
 * presenter's colour; Stop, or simply panning, hands the camera back. Not now folds the offer to the
 * presenter's badge, still one click from following. Gone when the presentation ends.
 *
 * Mounted over the canvas by `Canvas`. Its state is the session's (`collabStore.following`) or its
 * own, never the document's.
 */
export function FollowPrompt() {
  const { offered, following } = useCollabStore(
    useShallow((state) => ({
      offered: state.role === 'guest' && state.status !== 'ended' && state.presenter !== null,
      following: state.following,
    })),
  );
  // A fresh body per presentation, so "Not now" lasts exactly as long as the one it answered.
  return offered ? <FollowPromptBody following={following} /> : null;
}

function FollowPromptBody({ following }: { following: boolean }) {
  const [folded, setFolded] = useState(false);
  const presenter = useCollabStore((state) => presenterOf(state.peers));
  const flowId = useCollabStore((state) => state.presenter?.flowId ?? null);
  const step = useCollabStore((state) => state.presenter?.step ?? null);
  const flowTitle = useEditorStore((state) => (flowId ? findFlow(state.document, flowId)?.title.trim() || null : null));

  const name = presenter?.name || 'The owner';
  const color = presenter ? presenter.color % 8 : 0;
  const follow = () => useCollabStore.setState({ following: true });
  const stop = () => useCollabStore.setState({ following: false });
  const where = flowTitle ? (step !== null ? `${flowTitle} · step ${step + 1}` : flowTitle) : null;

  if (folded && !following) {
    return (
      <div className="dc-follow" data-peer-color={color} data-folded="true">
        <button type="button" className="dc-follow-quiet dc-follow-unfold" onClick={follow} title={`Follow ${name}`} aria-label={`Follow ${name}`}>
          <span className="dc-follow-badge">
            <PeerBadge name={name} color={color} size="small" />
          </span>
          Follow
        </button>
      </div>
    );
  }

  return (
    <>
      {following && <div className="dc-follow-frame" data-peer-color={color} aria-hidden="true" />}
      <div className="dc-follow" data-peer-color={color} data-following={following ? 'true' : undefined}>
        <span className="dc-follow-badge">
          <PeerBadge name={name} color={color} size="small" />
        </span>
        <span className="dc-follow-text" aria-live="polite">
          <span className="dc-follow-title">{following ? `Following ${name}` : `${name} is presenting`}</span>
          {where && <span className="dc-follow-detail">{where}</span>}
        </span>
        <span className="dc-follow-actions">
          {following ? (
            <button type="button" className="dc-follow-quiet" onClick={stop}>
              Stop following
            </button>
          ) : (
            <>
              <button type="button" className="dc-follow-primary" onClick={follow}>
                Follow
              </button>
              <button type="button" className="dc-follow-quiet dc-follow-close" onClick={() => setFolded(true)} aria-label="Not now" title="Not now">
                <Icon name="close" size={14} />
              </button>
            </>
          )}
        </span>
      </div>
    </>
  );
}
