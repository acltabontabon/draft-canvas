import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react';
import { useReactFlow, useStoreApi, useStore as useReactFlowStore } from '@xyflow/react';
import { useShallow } from 'zustand/react/shallow';
import { Icon } from '../../ui/common/Icon';
import { SegmentedControl } from '../../ui/common/SegmentedControl';
import { MOD_SYMBOL } from '../../lib/platform';
import { readPreference, writePreference } from '../../lib/preferences';
import { walkGraphs } from '../../depth/tree';
import { boundsOf } from '../../document/geometry';
import type { DraftDocument, DraftEdge, DraftNode } from '../../document/types';
import { useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import type { AgentInfo, ApplyMode, PromptRequest, Proposal } from '../api';
import { companion, newTokens, numberedBlocks, replyBlocks, replyOf, replyPoints, spentOn, stepText, stopMessage, tokenCount, type ReplyEntry, type Spent, type Turn } from '../companion';
import { useDesktopController, useDesktopState } from '../useDesktop';
import { Mascot } from './mascot/Mascot';
import type { Mood } from './mascot/pixels';
import { chipPlace, revealViewport } from './chipPlace';
import { diagramLines, openers, restingLine, seedOf, snagOf, type SnagStep } from './nodiLines';
import { PointPins } from './PointPins';
import { ProposalHistory } from './ProposalHistory';
import { countsLabel, useProposalReview } from './useProposalReview';

const APPLY_KEY = 'companion.apply';
/** The agent the person picked, when more than one can run (`AgentKind`). */
const AGENT_KEY = 'companion.agent';
const UNDO = `${MOD_SYMBOL}Z`;
/** The open companion's width and margins (`desktop.css`), kept clear when a change is framed. */
const RESERVED_WIDTH = 400 + 16 + 24;

/** How long a part Nodi's reply names flashes once it is brought into view (`search.ts`'s jump). */
const PART_FLASH_MS = 900;
let partFlash: ReturnType<typeof setTimeout> | null = null;

/** What the reply's points and part chips need to light the canvas, shared down the reply's text. */
interface Pointing {
  /** Every part's name, in every view of the diagram: a reply may name parts of another view. */
  names: ReadonlyMap<string, string>;
  /** The parts of the view on screen: only these are pinned, lit and brought into view. */
  here: ReadonlySet<string>;
  /** The point lit now, in the bubble and on its pin. */
  hot: number | null;
  /** Light a point and the parts given (or one part), or put them out with null and none. */
  pointAt: (point: number | null, parts: readonly string[]) => void;
  /** Bring a part into view, flashing it. */
  reveal: (id: string) => void;
}

const PointingContext = createContext<Pointing | null>(null);

/**
 * Every part's name as the reply's chips and pins say it: a shape's first line, a connector's label,
 * else where it runs. From every view of the file, so a reply about the parts inside a shape (or about
 * the shape itself, read from inside it) names them rather than showing their ids; the view on screen
 * last, as it is now (the file it came from may not have its latest edits yet).
 */
function partNamesOf(file: DraftDocument, view: DraftDocument): Map<string, string> {
  const names = new Map<string, string>();
  const line = (text: string | undefined) => text?.split('\n')[0]?.trim().slice(0, 48) || undefined;
  const add = (nodes: readonly DraftNode[], edges: readonly DraftEdge[]) => {
    for (const node of nodes) names.set(node.id, line(node.text) ?? (node.type === 'group' ? 'Boundary' : 'Shape'));
    for (const edge of edges) names.set(edge.id, line(edge.label) ?? `${names.get(edge.source) ?? '?'} → ${names.get(edge.target) ?? '?'}`);
  };
  walkGraphs(file, (graph) => add(graph.nodes, graph.edges));
  add(view.nodes, view.edges);
  return names;
}

/** The latest turn's points, once it has finished: not for a turn whose proposal is up, where the
 *  change on the canvas is the answer. */
function pointsOf(turn: Turn | null, here: ReadonlySet<string>) {
  const reply = turn && turn.stop !== null && !turn.proposalId ? replyOf(turn) : '';
  return reply ? replyPoints(numberedBlocks(replyBlocks(reply), (id) => here.has(id))) : [];
}

/** Diagrams Nodi has greeted this app run: the greeting pops up once on arrival, then on hover. */
const greeted = new Set<string>();
/** The latest finished turn the person has had open, by diagram: one finished since is news. */
const seenRun = new Map<string, string>();
/** How long the arrival greeting stays before Nodi goes quiet. */
const PEEK_MS = 5000;
/** Nodi's walk on (`desktop.css`'s `dc-nodi-arrive`). */
const ARRIVAL_MS = 1400;
/** How long the bubble lingers once nothing keeps it up, plus its exit (`desktop.css`'s `.dc-companion-say`). */
const SAY_GONE_MS = 2500 + 200;

/** Asked once per app run: finding the agent can start a login shell. */
let agentsOnce: Promise<AgentInfo[]> | null = null;

function applyMode(): ApplyMode {
  return readPreference(APPLY_KEY) === 'direct' ? 'direct' : 'proposal';
}


/** What a prompt is about, as the person sees it: one shape's name, or how many things. */
function aboutOf(nodes: string[], edges: string[], names: Map<string, string>): string | null {
  const count = nodes.length + edges.length;
  if (count === 0) return null;
  if (count === 1 && nodes.length === 1) return names.get(nodes[0]!) || 'the selected shape';
  if (edges.length === 0) return `${nodes.length} shapes`;
  return `${count} selected items`;
}

/**
 * The agent companion (desktop only): a mascot resting at the canvas's bottom-right that, opened,
 * becomes a composer for a prompt to the person's own coding agent, with the conversation above it.
 * The agent works on this diagram through Draft Canvas's tools; its progress and reply come in as the
 * shell reports them (`companion.ts`). Nothing here is saved with the diagram.
 */
/** One empty list, so a diagram with no conversation keeps the same `turns` across renders. */
const NO_TURNS: readonly Turn[] = [];

export function Companion() {
  const controller = useDesktopController();
  const diagramId = useEditorStore((s) => s.document.metadata.id);
  const room = useEditorStore((s) => s.path);
  const selection = useEditorStore(useShallow((s) => ({ nodes: s.selection.nodes, edges: s.selection.edges })));
  // Names are read when the selection changes, not on every store update.
  const names = useMemo(() => {
    const out = new Map<string, string>();
    if (selection.nodes.length !== 1) return out;
    const node = useEditorStore.getState().document.nodes.find((n) => n.id === selection.nodes[0]);
    const name = node?.text?.split('\n')[0]?.trim().slice(0, 40);
    if (name) out.set(node!.id, name);
    return out;
  }, [selection.nodes]);
  const open = useUiStore((s) => s.companionOpen);
  const setOpen = useUiStore((s) => s.setCompanionOpen);
  const yielded = useUiStore((s) => s.proposalPanelOpen || s.openPointsPanelOpen);
  const openProposal = useUiStore((s) => s.setProposalPanelOpen);
  const review = (id: string) => openProposal(true, id);
  const proposalPanelOpen = useUiStore((s) => s.proposalPanelOpen);
  const { doc, agent: access } = useDesktopState();
  const conversations = useSyncExternalStore(companion.subscribe, companion.snapshot);
  const turns = conversations.get(diagramId)?.turns ?? NO_TURNS;
  const last = turns.at(-1) ?? null;
  const running = last !== null && last.stop === null;

  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const [draft, setDraft] = useState('');
  // The selection the person left out, by its ids: only that one. Choosing something else asks about
  // it again, rather than a switch staying off for every later selection.
  const [leftOut, setLeftOut] = useState<string | null>(null);
  const [mode, setMode] = useState<ApplyMode>(applyMode);
  const input = useRef<HTMLInputElement>(null);
  // A long conversation folds what came before its last turns; a short one is shown whole.
  const [showEarlier, setShowEarlier] = useState(false);
  const thread = useRef<HTMLElement>(null);
  const expanded = open && !yielded;

  // Asked from the start, not on opening: Nodi only shows up when there is an agent for it to run.
  useEffect(() => {
    if (agents) return;
    agentsOnce ??= controller.companionAgents().catch(() => []);
    let live = true;
    void agentsOnce.then((found) => live && setAgents(found));
    return () => {
      live = false;
    };
  }, [agents, controller]);

  useEffect(() => {
    if (expanded) input.current?.focus();
  }, [expanded]);
  // While Nodi can't take a message, the first thing that fixes that has the focus the composer
  // would: whenever it appears, which may be after opening (once the shell says access is off).
  const focusStep = useCallback((step: HTMLButtonElement | null) => step?.focus(), []);

  // Asked again whenever Nodi opens: access is switched in Settings, or by another window of the app.
  useEffect(() => {
    if (expanded) void controller.refreshAgent();
  }, [expanded, controller]);

  // The thread reads downward to the newest, so it opens (and stays) at the bottom.
  useEffect(() => {
    const box = thread.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [turns]);

  // The review panel may have accepted or rejected the companion's proposal.
  useEffect(() => {
    if (!proposalPanelOpen) void controller.refreshCompanionProposals();
  }, [proposalPanelOpen, controller]);

  // The agent the person chose, else the first one installed. Every agent-specific word comes from
  // the shell (`AgentInfo.name`), so another agent needs no change here.
  const [preferred, setPreferred] = useState(() => readPreference(AGENT_KEY));
  const agent = agents?.find((a) => a.agent === preferred && a.availability !== 'missing') ?? agents?.find((a) => a.availability === 'installed') ?? agents?.[0] ?? null;
  // With more than one on this computer, the footer's agent name switches to the next.
  const usable = agents?.filter((a) => a.availability !== 'missing') ?? [];
  const nextAgent = usable.length > 1 && agent ? usable[(usable.indexOf(agent) + 1) % usable.length]! : null;
  const switchAgent = () => {
    if (!nextAgent) return;
    writePreference(AGENT_KEY, nextAgent.agent);
    setPreferred(nextAgent.agent);
  };
  // Continue in Terminal: the line is copied, and the box says so for a moment.
  const [continued, setContinued] = useState<'copied' | 'failed' | null>(null);
  const continueInTerminal = async () => {
    const line = agent ? await controller.companionContinue(diagramId, agent.agent) : null;
    const ok = line !== null && (await useEditorStore.getState().copyText(line));
    setContinued(ok ? 'copied' : 'failed');
    window.setTimeout(() => setContinued(null), 4000);
  };
  const agentName = agent?.name ?? 'your agent';
  // Why Nodi can't take a message yet, with the next steps it offers in place of the composer.
  const blocker = useMemo(
    () => snagOf({ doc: doc.kind, readOnly: doc.kind === 'file' && doc.readOnly, access: access ? access.enabled : null, agentsKnown: agents !== null, agent }),
    [doc, access, agents, agent],
  );
  // A conversation to show (rather than a greeting or what is in the way), and how much of its
  // beginning is folded: past two turns, the earlier ones wait behind one line.
  const talking = turns.length > 0 && !blocker;
  const folded = !showEarlier && turns.length > 2 ? turns.length - 2 : 0;
  // The command a step copied, and whether it reached the clipboard: said under the steps.
  const [copied, setCopied] = useState<{ command: string; ok: boolean } | null>(null);
  const copiedNow = copied && blocker?.steps.some((step) => step.kind === 'copy' && step.command === copied.command) ? copied : null;
  // Each through the app's own path: the same Save dialog, Settings page and clipboard as elsewhere.
  const runStep = (step: SnagStep) => {
    if (step.kind === 'save') void controller.save();
    else if (step.kind === 'save-copy') void controller.saveAs();
    else if (step.kind === 'settings') controller.openAgentSettings();
    else void useEditorStore.getState().copyText(step.command).then((ok) => setCopied({ command: step.command, ok }));
  };

  const mood: Mood = blocker
    ? 'asleep'
    : running
      ? 'working'
      : last?.proposalId
        ? 'waiting'
        : last?.outcome === 'accepted' || (last?.stop?.kind === 'end-turn' && last.outcome === null)
          ? 'happy'
          : 'idle';
  const hasSelection = selection.nodes.length + selection.edges.length > 0;
  const selectionKey = `${selection.nodes.join(',')}|${selection.edges.join(',')}`;
  const includeSelection = leftOut !== selectionKey;
  const selected = hasSelection ? aboutOf(selection.nodes, selection.edges, names) : null;
  const about = includeSelection ? selected : null;
  const showsCost = /api/i.test(agent?.signIn.method ?? '');
  const spent = spentOn(conversations.get(diagramId));

  const send = (text = draft) => {
    const prompt = text.trim();
    if (!prompt || running || blocker) return;
    const scoped = includeSelection && hasSelection;
    const request: PromptRequest = {
      runId: crypto.randomUUID(),
      diagramId,
      text: prompt,
      selection: scoped ? { nodes: selection.nodes, edges: selection.edges } : null,
      room: [...room],
      agent: agent?.agent ?? 'claude-code',
      mode,
    };
    setDraft('');
    void controller.companionSend(request, scoped ? about : null);
  };

  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      send();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
    }
  };

  const toggleMode = () => {
    const next = mode === 'proposal' ? 'direct' : 'proposal';
    writePreference(APPLY_KEY, next);
    setMode(next);
  };

  // The parts the latest reply points at: named in its text, pinned by number on the canvas, and lit
  // on both together.
  const docNodes = useEditorStore((s) => s.document.nodes);
  const docEdges = useEditorStore((s) => s.document.edges);
  const view = useEditorStore((s) => s.document);
  const outerFile = useEditorStore((s) => s.outer);
  const partNames = useMemo(() => partNamesOf(outerFile ?? view, view), [outerFile, view]);
  const partsHere = useMemo(() => new Set([...docNodes.map((n) => n.id), ...docEdges.map((e) => e.id)]), [docNodes, docEdges]);
  // What Nodi can say about this very diagram: its queues, stores, crons and loose ends, by name.
  const flowCount = useEditorStore((s) => s.document.flows.length);
  const openPointCount = useEditorStore((s) => s.document.openPoints?.filter((p) => !p.resolved).length ?? 0);
  const aboutDiagram = useMemo(() => diagramLines(docNodes, docEdges, flowCount, openPointCount), [docNodes, docEdges, flowCount, openPointCount]);
  const points = useMemo(() => pointsOf(turns.at(-1) ?? null, partsHere), [turns, partsHere]);
  const [hot, setHot] = useState<number | null>(null);
  const setPointedIds = useUiStore((s) => s.setPointedIds);
  const { setViewport } = useReactFlow();
  const flowStore = useStoreApi();
  const pointAt = useCallback(
    (point: number | null, parts: readonly string[]) => {
      setHot(point);
      setPointedIds(parts.length ? new Set(parts) : null);
    },
    [setPointedIds],
  );
  useEffect(() => () => setPointedIds(null), [setPointedIds]);
  const pointing = useMemo<Pointing>(
    () => ({
      names: partNames,
      here: partsHere,
      hot,
      pointAt,
      reveal: (id) => {
        const { nodes, edges } = useEditorStore.getState().document;
        const edge = edges.find((e) => e.id === id);
        const bounds = boundsOf(nodes.filter((n) => (edge ? n.id === edge.source || n.id === edge.target : n.id === id)));
        const { transform, width, height } = flowStore.getState();
        const viewport = revealViewport(bounds, transform, { width: width - RESERVED_WIDTH, height });
        if (viewport) void setViewport(viewport, { duration: 320 });
        const ui = useUiStore.getState();
        if (partFlash) clearTimeout(partFlash);
        ui.setJumpFlashId(id);
        partFlash = setTimeout(() => {
          partFlash = null;
          if (useUiStore.getState().jumpFlashId === id) useUiStore.getState().setJumpFlashId(null);
        }, PART_FLASH_MS);
      },
    }),
    [partNames, partsHere, hot, pointAt, flowStore, setViewport],
  );
  const pins =
    expanded && !blocker && points.length > 0 ? (
      <PointPins
        points={points}
        hot={hot}
        names={partNames}
        onHot={(point) => pointAt(point, point === null ? [] : (points.find((p) => p.point === point)?.parts ?? []))}
        onOpen={(point) => {
          // The conversation is brought to its point.
          requestAnimationFrame(() => thread.current?.querySelector(`[data-point="${point}"]`)?.scrollIntoView({ block: 'center' }));
        }}
      />
    ) : null;

  // The proposal itself is reviewed on the canvas, beside the change (`ProposalOnCanvas`).
  const chip = last?.proposalId ? <ProposalOnCanvas key={last.proposalId} runId={last.runId} proposalId={last.proposalId} onDetails={review} /> : null;

  // At rest, Nodi speaks up: once on arrival, on hover, and for as long as there is news.
  const [hovered, setHovered] = useState(false);
  // Each time Nodi pipes up on a hover, a new line from its repertoire: only once the last one has
  // gone, so coming back while it lingers never swaps the line being read.
  const [visits, setVisits] = useState(0);
  const leftAt = useRef(0);
  // On a diagram's first opening this app run, Nodi walks on from the canvas's edge, then greets.
  const [arriving, setArriving] = useState(() => !greeted.has(diagramId) && !prefersReducedMotion());
  const [peeking, setPeeking] = useState(() => !greeted.has(diagramId));
  useEffect(() => {
    greeted.add(diagramId);
  }, [diagramId]);
  useEffect(() => {
    if (!arriving) return;
    // Ends with the walk's animation; this is only for a walk that never gets to play (a hidden window).
    const timer = setTimeout(() => setArriving(false), ARRIVAL_MS + 800);
    return () => clearTimeout(timer);
  }, [arriving]);
  useEffect(() => {
    if (!peeking || arriving) return;
    const timer = setTimeout(() => setPeeking(false), PEEK_MS);
    return () => clearTimeout(timer);
  }, [peeking, arriving]);
  // Seen once it is open after it finished: one asked about and left to run is still news when done.
  useEffect(() => {
    if (expanded && last && last.stop !== null) seenRun.set(diagramId, last.runId);
  }, [expanded, last, diagramId]);
  const resting = restingLine({
    blocked: blocker !== null,
    snag: blocker?.rest,
    working: running ? (last.steps.length ? stepText(last.steps.at(-1)!.tool) : 'Thinking') : null,
    waiting: Boolean(last?.proposalId),
    unseen: Boolean(last && last.stop !== null && !expanded && seenRun.get(diagramId) !== last.runId),
    // What the message would be about: the selection, unless the person left it out.
    selected: about,
    seed: seedOf(diagramId) + visits,
    diagram: aboutDiagram,
    runSeed: seedOf(last?.runId ?? diagramId),
  });
  // Opened from rest: the pointer was over the bubble, which goes from under it without a leave, so
  // the hover is put down here or Nodi would keep talking after the conversation closes.
  const openFromRest = () => {
    setHovered(false);
    setOpen(true);
  };

  // The review and open-points panels sit in the same corner: the companion makes way for them. And
  // with no agent on this computer (or until that is known) there is no Nodi: nothing it could run.
  if (yielded || !agents?.some((a) => a.availability !== 'missing')) return null;

  if (!expanded) {
    return (
      <>
        {chip}
        <div
          className="dc-companion"
          data-open="false"
          data-arriving={arriving ? 'true' : undefined}
          onAnimationEnd={(event) => {
            if (event.animationName === 'dc-nodi-arrive') setArriving(false);
          }}
          // The pointer only: focus is handed back here when the conversation closes, and a bubble
          // kept up by it stayed under a pointer long gone. News is said without either.
          onMouseEnter={() => {
            setHovered(true);
            if (!resting.stays && !peeking && performance.now() - leftAt.current > SAY_GONE_MS) setVisits((n) => n + 1);
          }}
          onMouseLeave={() => {
            setHovered(false);
            leftAt.current = performance.now();
          }}
        >
          {/* Nodi says the one thing worth knowing, and the bubble is the way in. Kept mounted: it
              lingers a moment after the pointer leaves, then goes (`desktop.css`), so a line isn't
              snatched away mid-read. */}
          {!arriving && (
            <button
              type="button"
              className="dc-companion-say"
              data-tone={resting.tone}
              data-shown={resting.stays || peeking || hovered ? 'true' : undefined}
              aria-label={`Nodi: ${resting.text} ${resting.hint}`}
              onClick={openFromRest}
            >
              {/* Who is talking, as a game's dialogue box says it: a nameplate on the box's edge. */}
              <span className="dc-companion-say-name" aria-hidden="true">
                Nodi
              </span>
              <Typed key={resting.text} text={resting.text} />
              <span className="dc-companion-say-hint" aria-hidden="true">
                {resting.hint}
              </span>
            </button>
          )}
          <button type="button" className="dc-companion-mascot" aria-label="Open Nodi" onClick={openFromRest}>
            <Mascot mood={arriving ? 'walking' : mood} />
          </button>
        </div>
      </>
    );
  }

  return (
    <PointingContext.Provider value={pointing}>
      {chip}
      {pins}
    <div className="dc-companion" data-open="true">
      <div className="dc-companion-presence">
        <button type="button" className="dc-companion-mascot" aria-label="Hide Nodi" onClick={() => setOpen(false)}>
          <Mascot mood={mood} />
        </button>
        {/* One surface: the bubble is the conversation, whole while it is short, its earlier turns
            folded once it is long. Its two actions sit on its top edge, opposite the nameplate. */}
        <div className="dc-companion-speech" role={talking ? undefined : 'status'} data-expanded={talking ? 'true' : undefined}>
          <span className="dc-companion-say-name" aria-hidden="true">
            Nodi
          </span>
          {/* Once the agent has answered and while it isn't working: before that there is nothing to
              start over or carry on, and two disabled icons only drew the eye. */}
          {talking && !running && (
            <span className="dc-companion-speech-tools">
              <button type="button" aria-label="New conversation" title="New conversation" onClick={() => void controller.companionForget(diagramId)}>
                <Icon name="pencil" />
              </button>
              <button
                type="button"
                aria-label="Continue in Terminal"
                title={`Continue in Terminal: copies a command that reopens this conversation in ${agentName}`}
                onClick={() => void continueInTerminal()}
              >
                <span className="dc-companion-prompt" aria-hidden="true">
                  &gt;_
                </span>
              </button>
            </span>
          )}
          {blocker ? (
            // What is in the way, in Nodi's words, and the way past it as the person's replies.
            <>
              <Typed key={blocker.line} text={blocker.line} />
              {blocker.steps.length > 0 && (
                <ul
                  className="dc-companion-options"
                  aria-label="What to do next"
                  onKeyDown={(event) => {
                    if (event.key !== 'Escape') return;
                    event.preventDefault();
                    setOpen(false);
                  }}
                >
                  {blocker.steps.map((step, i) => (
                    <li key={step.label}>
                      <button type="button" ref={i === 0 ? focusStep : undefined} onClick={() => runStep(step)}>
                        {step.label}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {copiedNow && (
                <p className="dc-companion-hint">
                  {copiedNow.ok ? `Copied “${copiedNow.command}”. Paste it into Terminal, boss.` : `Couldn’t copy it, boss. Type “${copiedNow.command}” into Terminal instead.`}
                </p>
              )}
            </>
          ) : talking ? (
            <>
              <section className="dc-companion-thread" aria-label={`Conversation with ${agentName}`} ref={thread}>
                {folded > 0 && (
                  <button type="button" className="dc-companion-earlier" onClick={() => setShowEarlier(true)}>
                    {folded === 1 ? '1 earlier turn' : `${folded} earlier turns`}
                  </button>
                )}
                {turns.slice(folded).map((turn) => (
                  <TurnView key={turn.runId} turn={turn} pinned={turn === last} />
                ))}
              </section>
              {continued && (
                <p className="dc-companion-hint" role="status">
                  {continued === 'copied' ? 'Copied. Paste it into Terminal, boss.' : 'Couldn’t copy it, boss.'}
                </p>
              )}
            </>
          ) : (
            // Nodi carries on the line it said at rest, and offers the person's replies the way a
            // game's dialogue does: in their words, with a plain question behind each for the agent.
            <>
              <Typed key={resting.text} text={resting.text} />
              <ul className="dc-companion-options" aria-label="Ask Nodi">
                {openers(about, seedOf(diagramId) + visits).map((option) => (
                  <li key={option.label}>
                    <button type="button" onClick={() => send(option.prompt)}>
                      {option.label}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>


      {/* Nothing to type into while Nodi can't take a message: the box above says what to do instead.
          A run already going (access switched off mid-way) keeps its Stop. */}
      {(!blocker || running) && (
      <>
      <div className="dc-companion-composer">
        {/* What the message is about is the chip itself: the selection, with × to ask about the whole
            view instead, and back with a click. Nothing selected, nothing to choose: no control. */}
        {selected &&
          (includeSelection ? (
            <span className="dc-companion-chip">
              <span className="dc-companion-chip-name">{selected}</span>
              <button type="button" aria-label="Ask about the whole view instead" title="Ask about the whole view instead" onClick={() => setLeftOut(selectionKey)}>
                <Icon name="close" />
              </button>
            </span>
          ) : (
            <button type="button" className="dc-companion-chip" data-off="true" aria-label={`Ask about ${selected}`} title="Ask about the selection" onClick={() => setLeftOut(null)}>
              <Icon name="plus" />
              <span className="dc-companion-chip-name">{selected}</span>
            </button>
          ))}
        <label className="dc-sr-only" htmlFor="dc-companion-input">
          Message {agentName}
        </label>
        <input
          id="dc-companion-input"
          ref={input}
          type="text"
          autoComplete="off"
          spellCheck
          value={draft}
          // Short beside a chip, so it reads whole.
          placeholder={about ? 'Ask about this…' : selected ? 'Ask about the whole view…' : `Ask ${agentName} about this diagram…`}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKey}
        />
        {running ? (
          <button type="button" className="dc-companion-stop" aria-label="Stop" title="Stop" onClick={() => void controller.companionCancel(last.runId)}>
            <span aria-hidden="true" />
          </button>
        ) : (
          <button
            type="button"
            className="dc-companion-send"
            aria-label="Send"
            title="Send (Enter)"
            disabled={!draft.trim()}
            onClick={() => send()}
          >
            <Icon name="up" />
          </button>
        )}
      </div>
      <div className="dc-companion-footer">
        <span title="It works through Draft Canvas’s diagram tools, and nothing else on this computer.">
          via{' '}
          {nextAgent ? (
            <button type="button" className="dc-companion-link dc-companion-agent" disabled={running} title={`Switch to ${nextAgent.name}`} onClick={switchAgent}>
              {agent?.name}
            </button>
          ) : (
            (agent?.name ?? 'your agent')
          )}
        </span>
        <span aria-hidden="true">·</span>
        <button type="button" className="dc-companion-link" onClick={toggleMode} title="How the agent’s changes reach the diagram: click to switch">
          {mode === 'proposal' ? 'Review changes first' : 'Apply changes directly'}
        </button>
        {spent && (
          <>
            <span aria-hidden="true">·</span>
            <SpentLine spent={spent} showsCost={showsCost} />
          </>
        )}
      </div>
      </>
      )}
    </div>
    </PointingContext.Provider>
  );
}

/** What the mascot says about the latest turn: the step it is on, then its reply as it streams in. */
function TurnView({ turn, pinned }: { turn: Turn; pinned: boolean }) {
  const reply = replyOf(turn);
  const stopped = stopMessage(turn.stop);
  return (
    <article className="dc-companion-turn">
      <div className="dc-companion-you">
        {turn.about && <span className="dc-companion-about">About {turn.about}</span>}
        <p>{turn.prompt}</p>
      </div>
      {turn.steps.length > 0 && (
        <ol className="dc-companion-steps">
          {turn.steps.map((step) => (
            <li key={step.id} data-status={step.status}>
              <span className="dc-companion-step-mark" aria-hidden="true">
                {step.status === 'completed' ? <Icon name="check" /> : step.status === 'failed' ? <Icon name="close" /> : <span className="dc-companion-spinner" />}
              </span>
              <span>{stepText(step.tool)}</span>
              {step.error && <span className="dc-companion-step-error">{step.error}</span>}
            </li>
          ))}
        </ol>
      )}
      {turn.stop === null && turn.steps.length === 0 && <p className="dc-companion-now">Thinking…</p>}
      {reply && <ReplyText text={reply} pinned={pinned} />}
      {stopped && <p className="dc-companion-stopped">{stopped}</p>}
      {turn.proposalId && <p className="dc-companion-hint">The change is shown on the canvas: accept or reject it there.</p>}
      {turn.outcome === 'accepted' && (
        <p className="dc-companion-outcome">
          <Icon name="check" /> Added to the diagram. {UNDO} undoes it.
        </p>
      )}
      {turn.outcome === 'rejected' && <p className="dc-companion-stopped">Rejected. The diagram is unchanged.</p>}
    </article>
  );
}

/** What the conversation has used so far, beside its links: the person's own plan or key pays for it,
 *  so they see it as it adds up. A dollar figure only with an API key, where it is what is billed. */
function SpentLine({ spent, showsCost }: { spent: Spent; showsCost: boolean }) {
  const { cached } = spent.usage;
  const fresh = tokenCount(newTokens(spent.usage));
  const cost = showsCost && spent.costMicroUsd !== null ? dollars(spent.costMicroUsd) : null;
  const turns = spent.turns === 1 ? '1 turn' : `${spent.turns} turns`;
  // One line for the conversation, under the message box; a per-turn line in the bubble only said it
  // again. What it leaves out, the cached re-reads, is told here as what it is: discounted, not free.
  const detail =
    `This conversation so far: ${fresh} new tokens over ${turns}.` +
    (cached > 0
      ? ` The agent also re-sent ${tokenCount(cached)} tokens it had already read (its instructions, the tools, the diagram), served from its provider's cache. Those are billed at a discount (about a tenth of the usual price with Claude), not free, and still count toward a plan's usage.`
      : ''); 
  return (
    <span className="dc-companion-spent" title={detail}>
      <span className="dc-sr-only">{detail}</span>
      <span aria-hidden="true">
        {fresh} new tokens so far{cost ? ` · ${cost}` : ''}
      </span>
    </span>
  );
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

/** A line typed out the way a game character talks, a letter at a time; all at once under reduced
 *  motion. The whole line is laid out underneath, so the bubble doesn't grow as it types. */
function Typed({ text }: { text: string }) {
  const [shown, setShown] = useState(() => (prefersReducedMotion() ? text.length : 0));
  useEffect(() => {
    if (shown >= text.length) return;
    const timer = setTimeout(() => setShown((n) => n + 1), 26);
    return () => clearTimeout(timer);
  }, [shown, text]);
  return (
    <span className="dc-companion-typed">
      <span className="dc-companion-typed-full">{text}</span>
      <span className="dc-companion-typed-live">{text.slice(0, shown)}</span>
    </span>
  );
}

function dollars(micro: number): string {
  return `$${(micro / 1_000_000).toFixed(2)}`;
}

/**
 * The turn's proposal, reviewed on the canvas beside the change itself: the dashed ghost shows what
 * it adds and alters, and this chip, anchored to it, says what it is and takes Accept or Reject. The
 * same review as the panel's (`useProposalReview`); the panel keeps the full detail and the rarer
 * recovery cases. The canvas stays the subject; the companion only points at it.
 */
function ProposalOnCanvas({ runId, proposalId, onDetails }: { runId: string; proposalId: string; onDetails: (id: string) => void }) {
  const controller = useDesktopController();
  const [proposal, setProposal] = useState<Proposal | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => void controller.getProposal(proposalId).then((found) => live && setProposal(found));
    load();
    const stop = controller.onProposalsChanged(load);
    return () => {
      live = false;
      stop();
    };
  }, [controller, proposalId]);
  if (!proposal) return null;
  return (
    <ProposalChip
      proposal={proposal}
      onChanged={(record) => {
        if (record) setProposal(record);
        if (record?.status === 'accepted') companion.resolve(runId, 'accepted');
        else if (record?.status === 'rejected' || record?.status === 'dismissed') companion.resolve(runId, 'rejected');
        else void controller.getProposal(proposalId).then(setProposal);
      }}
      onDetails={() => onDetails(proposalId)}
    />
  );
}

function ProposalChip({ proposal, onChanged, onDetails }: { proposal: Proposal; onChanged: (record?: Proposal) => void; onDetails: () => void }) {
  const review = useProposalReview(proposal, onChanged, 'companion');
  const { busy, checking, conflicts, dryRunProblem, error, alreadyApplied, recoveringAccept, bounds } = review;
  const { setViewport } = useReactFlow();
  const viewWidth = useReactFlowStore((state) => state.width);
  const viewHeight = useReactFlowStore((state) => state.height);
  const tx = useReactFlowStore((state) => state.transform[0]);
  const ty = useReactFlowStore((state) => state.transform[1]);
  const zoom = useReactFlowStore((state) => state.transform[2]);
  const previewVisible = useUiStore((state) => (state.proposalPreview?.proposalId === proposal.proposalId ? state.proposalPreview.visible : true));
  const setPreviewVisible = useUiStore((state) => state.setProposalPreviewVisible);
  // Brought into the canvas left of the companion, where the dashed change can be seen, moving the
  // camera no more than that takes: not at all if it is already there, otherwise just far enough, at
  // the person's own zoom (out only if it wouldn't fit), so what it connects to stays in view.
  const show = () => {
    const viewport = revealViewport(bounds, [tx, ty, zoom], { width: viewWidth - RESERVED_WIDTH, height: viewHeight });
    if (viewport) void setViewport(viewport, { duration: 320 });
  };
  // Once, when the change is first worked out: it is what the person is waiting to see. After that the
  // camera is theirs, and Show me brings it back.
  const framed = useRef(false);
  useEffect(() => {
    if (!bounds || framed.current) return;
    framed.current = true;
    show();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- framed once, on the first bounds
  }, [bounds]);
  if (proposal.status !== 'pending' && proposal.status !== 'accepting') return null;
  // An interrupted accept has the panel's fuller explanation and choices.
  const unusual = alreadyApplied || recoveringAccept;
  const problem = dryRunProblem ?? (conflicts.length > 0 ? 'Something this change is about has moved on since. Ask the agent to revise it.' : null);
  const place = chipPlace(bounds, [tx, ty, zoom], { width: viewWidth, height: viewHeight });
  return (
    <section className="dc-companion-review" aria-label="Proposed change" style={{ left: place.left, top: place.top }} data-anchored={bounds ? 'true' : undefined}>
      <div className="dc-companion-review-head">
        <span className="dc-companion-review-mascot" aria-hidden="true">
          <Mascot mood="waiting" scale={1} />
        </span>
        <strong>Proposed change</strong>
        <span>{countsLabel(proposal.counts)}</span>
      </div>
      {proposal.summary && <p className="dc-companion-review-summary">{proposal.summary}</p>}
      <ProposalHistory proposal={proposal} />
      {/* Lift the sheet and lay it back: the diagram as it is, or as the change would leave it. */}
      {bounds && (
        <SegmentedControl
          name={`compare-${proposal.proposalId}`}
          legend="Show"
          value={previewVisible ? 'proposed' : 'now'}
          options={[
            { value: 'now', label: 'Now' },
            { value: 'proposed', label: 'Proposed' },
          ]}
          onChange={(value) => setPreviewVisible(value === 'proposed')}
        />
      )}
      {checking && <p className="dc-companion-review-note">Checking it against the diagram…</p>}
      {problem && <p className="dc-companion-review-problem">{problem}</p>}
      {error && (
        <p className="dc-companion-review-problem" role="alert">
          {error}
        </p>
      )}
      <div className="dc-companion-review-actions">
        {unusual ? (
          <button type="button" className="dc-button dc-button-solid" onClick={onDetails}>
            Open in the review panel
          </button>
        ) : (
          <>
            <button type="button" className="dc-button dc-button-solid" disabled={busy || checking || problem !== null} onClick={() => void review.accept()}>
              Accept
            </button>
            <button type="button" className="dc-button dc-button-quiet" disabled={busy} onClick={() => void review.reject()}>
              Reject
            </button>
            <span className="dc-companion-review-links">
              <button type="button" className="dc-companion-link" disabled={!bounds} onClick={show}>
                Show me
              </button>
              <button type="button" className="dc-companion-link" onClick={onDetails}>
                Details
              </button>
            </span>
          </>
        )}
      </div>
    </section>
  );
}

/** `**bold**`, `` `code` `` and `[[id]]` inside a line, as elements: the agent's text is never HTML. */
function inline(text: string, entry: ReplyEntry | null): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[\[[^\]\s]{1,120}\]\])/).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={i}>{inline(part.slice(2, -2), entry)}</strong>;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <code key={i}>{part.slice(1, -1)}</code>;
    if (part.startsWith('[[') && part.endsWith(']]') && part.length > 4) return <PartChip key={i} id={part.slice(2, -2)} entry={entry} />;
    return part;
  });
}

/**
 * A part the reply names, by the name the diagram gives it: hovering lights it on the canvas, clicking
 * brings it into view. A part of another view is named but points at nothing here; an id the diagram
 * doesn't have at all (removed since, or a slip of the agent's) is never shown as the id, which means
 * nothing to the person.
 */
function PartChip({ id, entry }: { id: string; entry: ReplyEntry | null }) {
  const pointing = useContext(PointingContext);
  const name = pointing?.names.get(id);
  if (!pointing || !name) {
    return (
      <span className="dc-companion-part" data-missing="true">
        something not in this diagram
      </span>
    );
  }
  if (!pointing.here.has(id)) {
    return (
      <span className="dc-companion-part" data-elsewhere="true" title="In another view of this diagram">
        {name}
      </span>
    );
  }
  // Back to the whole point when the pointer leaves the chip but not the point.
  const back = () => pointing.pointAt(entry?.point ?? null, entry?.point ? entry.parts : []);
  return (
    <button
      type="button"
      className="dc-companion-part"
      title="Show it on the canvas"
      onMouseEnter={() => pointing.pointAt(entry?.point ?? null, [id])}
      onMouseLeave={back}
      onFocus={() => pointing.pointAt(entry?.point ?? null, [id])}
      onBlur={back}
      onClick={() => pointing.reveal(id)}
    >
      {name}
    </button>
  );
}

/**
 * The agent's reply as it reads best in the card: paragraphs and lists, as advice usually comes. In the
 * latest turn (`pinned`), each paragraph or bullet about a part carries the number pinned on it.
 */
function ReplyText({ text, pinned = false }: { text: string; pinned?: boolean }) {
  const pointing = useContext(PointingContext);
  const blocks = numberedBlocks(replyBlocks(text), (id) => pointing?.here.has(id) ?? false);
  const point = (entry: ReplyEntry) =>
    pinned && entry.point !== null
      ? {
          'data-point': entry.point,
          'data-hot': pointing?.hot === entry.point ? 'true' : undefined,
          onMouseEnter: () => pointing?.pointAt(entry.point, entry.parts),
          onMouseLeave: () => pointing?.pointAt(null, []),
        }
      : {};
  const body = (entry: ReplyEntry) => (
    <>
      {pinned && entry.point !== null && (
        <span className="dc-companion-point" aria-hidden="true">
          {entry.point}
        </span>
      )}
      {inline(entry.text, entry)}
    </>
  );
  return (
    <div className="dc-companion-reply">
      {blocks.map((block, i) =>
        block.kind === 'p' ? (
          <p key={i} {...point(block.entry)}>
            {body(block.entry)}
          </p>
        ) : block.kind === 'ul' ? (
          <ul key={i}>
            {block.entries.map((entry, j) => (
              <li key={j} {...point(entry)}>
                {body(entry)}
              </li>
            ))}
          </ul>
        ) : (
          <ol key={i}>
            {block.entries.map((entry, j) => (
              <li key={j} {...point(entry)}>
                {body(entry)}
              </li>
            ))}
          </ol>
        ),
      )}
    </div>
  );
}
