import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react';
import { STAGE_TEXT } from '../../agent/progress';
import { createDocument } from '../../document/factory';
import { renderDocumentSvg } from '../../render/svg/document';
import { Button } from '../../ui/common/Button';
import { usePersonality } from '../../ui/personality/usePersonality';
import { useTheme } from '../../ui/theme/useTheme';
import { agentActivity, type AgentOp } from '../agentActivity';
import { useDesktopController } from '../useDesktop';

/**
 * What AI agents are doing, where the person can see it (desktop only): a line per request that is
 * taking a moment — what stage it is really at, with Cancel while cancelling still changes nothing —
 * and, for a new diagram (or one that isn't open), the generation view: the diagram as it is being
 * arranged, drawn by the same renderer an export uses, clearly marked as not yet saved.
 *
 * Never shown for a request that finishes quickly (`SHOW_AFTER_MS`), never steals focus, and never
 * part of any document: closing the view, cancelling, or the request ending in any way leaves no trace.
 */
export function AgentActivity() {
  const ops = useSyncExternalStore(agentActivity.subscribe, agentActivity.snapshot);
  const shown = ops.filter((op) => op.shown);
  const watching = ops.find((op) => op.watching && op.target !== 'open');
  if (!shown.length && !watching) return null;
  return (
    <>
      {watching && <GenerationView op={watching} />}
      {shown.length > 0 && (
        <div className="dc-agent-activity" role="status" aria-live="polite">
          {shown.map((op) => (
            <ActivityLine key={op.id} op={op} />
          ))}
        </div>
      )}
    </>
  );
}

function stageLine(op: AgentOp): string {
  if (op.cancelling) return 'Cancelling…';
  if (op.applying) return op.tool === 'create_diagram' ? 'Saving…' : 'Applying…';
  return `${STAGE_TEXT[op.stage]}…`;
}

function ActivityLine({ op }: { op: AgentOp }) {
  const controller = useDesktopController();
  const verb = op.tool === 'create_diagram' ? 'Drawing' : 'Updating';
  return (
    <div className="dc-agent-activity-line" data-phase={op.applying ? 'applying' : op.cancelling ? 'cancelling' : 'working'}>
      <span className="dc-agent-activity-dot" aria-hidden="true" />
      <span className="dc-agent-activity-text">
        <span className="dc-agent-activity-who">AI agent</span> {verb} “{op.title}” — {stageLine(op)}
      </span>
      {op.target !== 'open' && !op.watching && (
        <Button variant="quiet" onClick={() => agentActivity.watch(op.id, true)}>
          Show
        </Button>
      )}
      {!op.applying && !op.cancelling && (
        <Button variant="quiet" onClick={() => void controller.cancelAgentRequest(op.id)}>
          Cancel
        </Button>
      )}
    </div>
  );
}

interface Camera {
  x: number;
  y: number;
  scale: number;
}

const FIT_PAD = 32;

/**
 * A new diagram (or a closed one) as the agent arranges it. Framed once when the first arrangement
 * arrives; after that the camera is the person's — pan by dragging, zoom with the wheel — unless they
 * turn Follow on, which frames every new arrangement.
 */
function GenerationView({ op }: { op: AgentOp }) {
  const controller = useDesktopController();
  const { name: themeName } = useTheme();
  const { preset } = usePersonality();
  const stageRef = useRef<HTMLDivElement>(null);
  const [camera, setCamera] = useState<Camera | null>(null);
  const drag = useRef<{ x: number; y: number; from: Camera } | null>(null);

  const rendered = useMemo(() => {
    if (!op.candidate) return null;
    const document = { ...createDocument(op.title), nodes: op.candidate.nodes, edges: op.candidate.edges, flows: op.candidate.flows };
    try {
      return renderDocumentSvg(document, { theme: themeName, preset, transparent: true });
    } catch {
      return null;
    }
  }, [op.candidate, op.title, themeName, preset]);
  const src = useMemo(() => (rendered ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(rendered.svg)}` : null), [rendered]);

  const fit = (): Camera | null => {
    const box = stageRef.current?.getBoundingClientRect();
    if (!rendered || !box || box.width <= 0) return null;
    const scale = Math.min(1, (box.width - FIT_PAD * 2) / rendered.width, (box.height - FIT_PAD * 2) / rendered.height);
    return { scale, x: (box.width - rendered.width * scale) / 2, y: (box.height - rendered.height * scale) / 2 };
  };
  // Framed on the first arrangement, and on every one while following. Otherwise the zoom stays the
  // person's, and a new arrangement of another size keeps its middle where the last one's was — it
  // grows or shrinks in place instead of sliding off one edge.
  const lastSize = useRef<{ width: number; height: number } | null>(null);
  useEffect(() => {
    if (!rendered) return;
    const before = lastSize.current;
    lastSize.current = { width: rendered.width, height: rendered.height };
    if (camera === null || op.follow) {
      setCamera(fit());
      return;
    }
    if (before) {
      setCamera({ ...camera, x: camera.x + ((before.width - rendered.width) * camera.scale) / 2, y: camera.y + ((before.height - rendered.height) * camera.scale) / 2 });
    }
    // `camera` is read, not tracked: this runs for new arrangements only.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [rendered, op.follow]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!camera) return;
    drag.current = { x: event.clientX, y: event.clientY, from: camera };
    event.currentTarget.setPointerCapture(event.pointerId);
    if (op.follow) agentActivity.follow(op.id, false);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const from = drag.current;
    if (!from) return;
    setCamera({ ...from.from, x: from.from.x + event.clientX - from.x, y: from.from.y + event.clientY - from.y });
  };
  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (!camera) return;
    const box = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - box.left;
    const py = event.clientY - box.top;
    const scale = Math.min(3, Math.max(0.1, camera.scale * Math.exp(-event.deltaY * 0.0015)));
    const k = scale / camera.scale;
    setCamera({ scale, x: px - (px - camera.x) * k, y: py - (py - camera.y) * k });
    if (op.follow) agentActivity.follow(op.id, false);
  };

  return (
    <section className="dc-agent-generation" aria-label={`AI agent drawing ${op.title}`}>
      <header className="dc-agent-generation-head">
        <div className="dc-agent-generation-titles">
          <span className="dc-agent-generation-badge">Not saved yet</span>
          <h2 className="dc-agent-generation-title">{op.title}</h2>
          <span className="dc-muted">{stageLine(op)}</span>
        </div>
        <div className="dc-agent-generation-actions">
          <Button variant="quiet" aria-pressed={op.follow} onClick={() => agentActivity.follow(op.id, !op.follow)}>
            {op.follow ? 'Following' : 'Follow'}
          </Button>
          <Button variant="quiet" onClick={() => setCamera(fit())} disabled={!rendered}>
            Fit
          </Button>
          {!op.applying && !op.cancelling && (
            <Button variant="quiet" onClick={() => void controller.cancelAgentRequest(op.id)}>
              Cancel
            </Button>
          )}
          <Button variant="quiet" onClick={() => agentActivity.watch(op.id, false)}>
            Hide
          </Button>
        </div>
      </header>
      <div
        ref={stageRef}
        className="dc-agent-generation-stage"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => void (drag.current = null)}
        onPointerCancel={() => void (drag.current = null)}
        onWheel={onWheel}
      >
        {src && camera && rendered ? (
          <img
            className="dc-agent-generation-image"
            src={src}
            alt=""
            draggable={false}
            width={rendered.width}
            height={rendered.height}
            style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})` }}
          />
        ) : (
          <p className="dc-agent-generation-waiting dc-muted">{stageLine(op)}</p>
        )}
      </div>
    </section>
  );
}
