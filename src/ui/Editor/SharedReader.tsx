import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useReactFlow, useStore } from '@xyflow/react';
import { effectiveConnectorText } from '../../document/edgeSemantics';
import { displayNameFor } from '../../document/factory';
import { hasInside, pathKey } from '../../depth/tree';
import { collectRooms } from '../../export/rooms';
import { readerAttachments, type ReaderContextItem } from '../../share/context';
import type { ElementTarget } from '../../openPoints/locate';
import { isActivatableTarget, isEditableTarget } from '../../lib/isEditableTarget';
import { motionMs } from '../../lib/motion';
import { PRODUCT } from '../../product';
import { describeFlowStep } from '../../presentation/flowChrome';
import { nodeIndex } from '../../store/selectors';
import { resolveFlowSteps, type FlowPlaybackController, type FlowPlaybackStep } from '../../presentation/useFlowPlayback';
import { useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import type { DocumentSession } from '../../store/useDocumentSession';
import { ReadOnlyCode } from '../../canvas/AttachmentPresentation';
import { Button } from '../common/Button';
import { BrandMark } from '../common/BrandMark';
import { Icon } from '../common/Icon';
import { navigateToRoom } from './depthNavigation';
import { SharedReaderAttachments, type ReaderAttachmentSelection } from './SharedReaderAttachments';
import { SharedReaderWalkthrough } from './SharedReaderWalkthrough';

/** Reader chrome around the editor's real Canvas, shapes, connectors and playback controller. */
export function SharedReader({ session, playback, children }: {
  session: DocumentSession; playback: FlowPlaybackController; children: ReactNode;
}) {
  const document = useEditorStore((state) => state.document);
  const outer = useEditorStore((state) => state.outer);
  const path = useEditorStore((state) => state.path);
  const selection = useEditorStore((state) => state.selection);
  const selectedFlowId = useEditorStore((state) => state.selectedFlowId);
  // Shared diagrams never change, so the store's outer snapshot is also the complete room map.
  // All traversal still goes through the depth helpers used by collectRooms.
  const rooms = useMemo(() => collectRooms(outer ?? document), [outer, document]);
  const attachments = useMemo(() => readerAttachments(outer ?? document), [outer, document]);
  const { fitView, zoomIn, zoomOut } = useReactFlow();
  const zoom = useStore((state) => Math.round(state.transform[2] * 100));
  const viewWidth = useStore((state) => state.width);
  const viewHeight = useStore((state) => state.height);
  const [contentsOpen, setContentsOpen] = useState(false);
  const [elementsOpen, setElementsOpen] = useState(false);
  const attachmentScope = `${pathKey(path)}:${playback.active ? `${playback.flow?.id}:${playback.stage}:${playback.step}` : 'idle'}`;
  const [attachmentChoice, setAttachmentChoice] = useState<{ scope: string; value: ReaderAttachmentSelection | null } | null>(null);
  const attachmentTrigger = useRef<HTMLElement | null>(null);
  const contentsId = useId();
  const pendingStep = useRef<{ flowId: string; step: number } | null>(null);
  const chosen = playback.flow ?? playback.flows.find((flow) => flow.id === selectedFlowId) ?? playback.flows[0];
  const fitPadding = 0.08;
  const steps = useMemo(() => chosen ? resolveFlowSteps(chosen, document.edges, document.nodes) : [], [chosen, document.edges, document.nodes]);
  const nodesById = useMemo(() => nodeIndex(document.nodes), [document.nodes]);
  const stories = useMemo(() => steps.map((step) => describeFlowStep(step, nodesById)), [steps, nodesById]);
  const node = selection.nodes.length === 1 ? document.nodes.find((entry) => entry.id === selection.nodes[0]) : undefined;
  const edge = selection.edges.length === 1 ? document.edges.find((entry) => entry.id === selection.edges[0]) : undefined;
  const { flow: liveFlow, steps: liveSteps, goTo } = playback;
  const playbackActive = playback.active;

  // A step's default detail is derived; a reader's explicit choice wins for that step only.
  const stepAttachment = attachmentForStep(playback.current, attachments, path);
  const attachment = attachmentChoice?.scope === attachmentScope ? attachmentChoice.value : stepAttachment;
  const setAttachment = (value: ReaderAttachmentSelection | null) => {
    const state = useEditorStore.getState();
    const flow = state.flowPlayback;
    const scope = `${pathKey(state.path)}:${flow.active ? `${flow.flowId}:${flow.stage ?? 'step'}:${flow.step}` : 'idle'}`;
    setAttachmentChoice({ scope, value });
  };
  const closeAttachment = () => { setAttachment(null); attachmentTrigger.current?.focus(); };

  useEffect(() => {
    if (playbackActive || viewWidth <= 0 || viewHeight <= 0) return;
    if (useUiStore.getState().presentation.framing === 'manual') return;
    void fitView({ padding: fitPadding, duration: 0 });
  }, [playbackActive, viewWidth, viewHeight, path, fitPadding, fitView]);

  useEffect(() => {
    const pending = pendingStep.current;
    if (!pending || liveFlow?.id !== pending.flowId || liveSteps.length === 0) return;
    pendingStep.current = null;
    goTo(pending.step);
  }, [liveFlow?.id, liveSteps, goTo]);

  const fit = () => {
    if (playback.active) playback.overview();
    else {
      useUiStore.getState().setPresentation({ framing: 'guided' });
      void fitView({ padding: fitPadding, duration: motionMs(240) });
    }
  };
  const changeZoom = (direction: 'in' | 'out') => {
    useUiStore.getState().setPresentation({ framing: 'manual' });
    void (direction === 'in' ? zoomIn : zoomOut)({ duration: motionMs(160) });
  };
  const next = () => {
    if ((!playback.active || playback.stage === 'closing') && chosen) jump(1);
    else playback.next();
  };
  const previous = () => playback.previous();
  const jump = (step: number) => {
    if (!chosen) return;
    if (!playback.active || playback.flow?.id !== chosen.id) {
      pendingStep.current = { flowId: chosen.id, step };
      playback.pickFlow(chosen.id);
    } else playback.goTo(step);
  };
  const visit = async (roomPath: readonly string[]) => {
    pendingStep.current = null;
    setAttachment(null);
    playback.stop();
    await navigateToRoom(roomPath);
    useEditorStore.getState().setMode('present');
    setContentsOpen(false);
  };
  const revealAttachment = async (item: ReaderContextItem, target: ElementTarget, reveal = false) => {
    const active = window.document.activeElement;
    if (active instanceof HTMLElement && !active.closest('.dc-reader-attachment-card')) attachmentTrigger.current = active;
    const changedRoom = pathKey(target.path) !== pathKey(useEditorStore.getState().path);
    if (changedRoom) await visit(target.path);
    const editor = useEditorStore.getState();
    const edge = target.kind === 'edge' ? editor.document.edges.find((entry) => entry.id === target.id) : undefined;
    editor.setSelection({ nodes: [], edges: [] });
    setAttachment({ id: item.id, target });
    if (!reveal && !changedRoom) return;
    const ids = edge ? [edge.source, edge.target] : target.kind === 'node' ? [target.id] : [];
    useUiStore.getState().setPresentation({ framing: 'manual' });
    requestAnimationFrame(() => { void fitView({ nodes: ids.map((id) => ({ id })), padding: 0.65, maxZoom: 1, duration: motionMs(240) }); });
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeAttachment();
        setContentsOpen(false);
        useEditorStore.getState().setSelection({ nodes: [], edges: [] });
        return;
      }
      if (isEditableTarget(event.target) || isActivatableTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'ArrowRight' && chosen) { event.preventDefault(); next(); }
      else if (event.key === 'ArrowLeft' && playback.active) { event.preventDefault(); previous(); }
      else if (event.key === ' ' && chosen) { event.preventDefault(); next(); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const currentRoom = rooms.find((room) => pathKey(room.path) === pathKey(path));
  const detailTitle = node ? displayNameFor(node) : edge ? effectiveConnectorText(edge) || 'Connector' : '';
  return (
    <div className="dc-editor dc-shared-reader" data-mode="present" data-reading-mode={chosen ? 'guided' : 'focus'} data-contents={contentsOpen || undefined}>
      <header className="dc-reader-header">
        <span className="dc-reader-brand"><BrandMark />{PRODUCT.name}</span>
        <div className="dc-reader-header-actions"><Button className="dc-reader-toggle" icon="alignLeft" active={contentsOpen} aria-expanded={contentsOpen} aria-controls={contentsId} onClick={() => setContentsOpen(!contentsOpen)}>Contents</Button>{attachments.length > 0 && <Button icon="file" active={attachment !== null} aria-expanded={attachment !== null} onClick={() => {
          if (attachment) { setAttachment(null); return; }
          const first = attachments.find((item) => item.targets.some((target) => pathKey(target.path) === pathKey(path))) ?? attachments[0]!;
          const target = first.targets.find((target) => pathKey(target.path) === pathKey(path)) ?? first.targets[0];
          if (target) void revealAttachment(first, target, true);
        }}>Attachments</Button>}{session.sharedLink && <Button variant="quiet" icon="lock" onClick={session.sharedLink.lock}>Lock</Button>}<Button variant="quiet" icon="close" aria-label="Close shared diagram" onClick={() => void session.closeDocument()} /></div>
      </header>
      <div className="dc-reader-body">
        <aside className="dc-reader-sidebar" id={contentsId} aria-label="Diagram contents">
          <header className="dc-reader-sidebar-heading"><h2 className="dc-reader-label">Explore</h2><Button className="dc-reader-sidebar-close" icon="close" variant="quiet" aria-label="Close contents" onClick={() => setContentsOpen(false)} /></header>
          <nav className="dc-reader-levels" aria-label="Diagram levels">{rooms.map((room) => <button key={pathKey(room.path)} type="button" aria-current={pathKey(room.path) === pathKey(path) ? 'location' : undefined} style={{ paddingInlineStart: 10 + Math.min(room.path.length, 6) * 12 }} onClick={() => void visit(room.path)}><Icon name={room.path.length ? 'forward' : 'overview'} size={14} /><span>{room.owners.at(-1) ? displayNameFor(room.owners.at(-1)!) : 'Diagram overview'}</span></button>)}</nav>
          <button type="button" className="dc-reader-browse" aria-expanded={elementsOpen} onClick={() => setElementsOpen(!elementsOpen)}>Browse shapes <Icon name={elementsOpen ? 'up' : 'down'} size={12} /></button>
          {elementsOpen && <ul className="dc-reader-elements">{document.nodes.map((entry) => <li key={entry.id}><button type="button" onClick={() => useEditorStore.getState().setSelection({ nodes: [entry.id], edges: [] })}>{displayNameFor(entry)}</button></li>)}</ul>}
        </aside>
        <main className="dc-reader-main" onPointerDown={() => { if (contentsOpen) setContentsOpen(false); }}>
          <section className="dc-reader-heading" aria-label={chosen ? 'Guided reader' : 'Focus view'}><div><p className="dc-reader-eyebrow">Shared diagram<span aria-hidden="true"> / </span><span>{chosen ? 'Guided reader' : 'Focus view'}</span></p><h1>{document.metadata.title || 'Untitled diagram'}</h1>{path.length > 0 && <nav aria-label="Current level"><button type="button" onClick={() => void visit([])}>Overview</button>{path.length > 0 && <span> / {currentRoom?.owners.map(displayNameFor).join(' / ')}</span>}</nav>}</div><span className="dc-reader-view-only"><Icon name="present" size={14} />View only</span></section>
          <div className="dc-reader-canvas dc-editor-canvas">
            {children}
            {document.nodes.length === 0 && <p className="dc-reader-empty">This shared diagram has no shapes.</p>}
            <div className="dc-reader-camera"><Button icon="overview" aria-label="Fit diagram" onClick={fit} /><Button aria-label="Zoom out" onClick={() => changeZoom('out')}>−</Button><span>{zoom}%</span><Button icon="plus" aria-label="Zoom in" onClick={() => changeZoom('in')} /></div>
          </div>
          <SharedReaderAttachments items={attachments} selected={attachment} onSelect={(item, target, reveal) => void revealAttachment(item, target, reveal)} onClose={closeAttachment} />
          {chosen && <SharedReaderWalkthrough key={chosen.id} flow={chosen} stories={stories} playback={playback} availableHeight={viewHeight} onJump={jump} onNext={next} onPrevious={previous} />}
          {(node || edge) && <section className="dc-reader-details" aria-label="Element details"><div><h2>{detailTitle}</h2>{node?.technology && <p className="dc-reader-muted">{node.technology}</p>}<p>{node ? node.description || ((node.type === 'note' || node.type === 'text') ? node.text : '') : edge?.label || effectiveConnectorText(edge!)}</p>{node?.code && <ReadOnlyCode code={node.code} language={node.language ?? 'plaintext'} />}</div><div>{node && hasInside(node) && <Button icon="forward" onClick={() => void visit([...path, node.id])}>Look inside</Button>}<Button icon="close" variant="quiet" aria-label="Close details" onClick={() => useEditorStore.getState().setSelection({ nodes: [], edges: [] })} /></div></section>}
        </main>
      </div>
      <footer className="dc-reader-footer"><span>Shared snapshot · changes to the original are not synced</span><span>{session.sharedLink ? <><Icon name="lock" size={12} />Passphrase protected</> : 'Made with Draft Canvas'}</span></footer>
    </div>
  );
}

function attachmentForStep(step: FlowPlaybackStep | null, attachments: ReaderContextItem[], path: readonly string[]): ReaderAttachmentSelection | null {
  if (!step) return null;
  const candidates = [
    ...step.edges.map((edge) => ({ kind: 'edge', id: edge.id })),
    ...step.edges.map((edge) => ({ kind: 'node', id: edge.target })),
    ...step.extraNodes.map((node) => ({ kind: 'node', id: node.id })),
    ...step.edges.map((edge) => ({ kind: 'node', id: edge.source })),
  ];
  for (const candidate of candidates) {
    const item = attachments.find((entry) => !entry.point?.resolved && entry.targets.some((target) => target.id === candidate.id && target.kind === candidate.kind && pathKey(target.path) === pathKey(path)));
    const target = item?.targets.find((target) => target.id === candidate.id && target.kind === candidate.kind);
    if (item && target) return { id: item.id, target };
  }
  return null;
}
