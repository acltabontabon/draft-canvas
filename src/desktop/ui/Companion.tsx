import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react';
import { useReactFlow, useStoreApi, useStore as useReactFlowStore } from '@xyflow/react';
import { useShallow } from 'zustand/react/shallow';
import { Icon } from '../../ui/common/Icon';
import { SegmentedControl } from '../../ui/common/SegmentedControl';
import { Tooltip } from '../../ui/common/Tooltip';
import { MOD_SYMBOL } from '../../lib/platform';
import { readPreference, writePreference } from '../../lib/preferences';
import { walkGraphs } from '../../depth/tree';
import { categoryOf } from '../../document/connectorSemantics';
import { boundsOf } from '../../document/geometry';
import type { DraftDocument, DraftEdge, DraftNode } from '../../document/types';
import { isInteracting, useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import type { AgentClientSetup, AgentInfo, AgentSkillSetup, ApplyMode, CodeFolder, CodeGrant, PromptRequest, Proposal } from '../api';
import { activityOf, companion, conversationKey, newTokens, numberedBlocks, partsIn, replyBlocks, replyOf, replyPoints, spentOn, stepText, stopMessage, tokenCount, type ReplyEntry, type Spent, type Turn } from '../companion';
import { useDesktopController, useDesktopState } from '../useDesktop';
import { useNodiShown } from '../nodiShown';
import { describeUpdate } from '../updates';
import { desktopStore } from '../store';
import { forgetTurnSnapshot, unchangedSinceLastTurn } from '../turnSnapshot';
import { Mascot } from './mascot/Mascot';
import { CHANNEL_MS, CHANNELS, channelClock, type Channel, type Mood } from './mascot/pixels';
import { CHIP_HEIGHT, chipPlace, revealViewport, type Box } from './chipPlace';
import { canCreateInside, hasInside } from '../../depth/tree';
import { lookInside, navigateToRoom } from '../../ui/Editor/depthNavigation';
import { agentlessAnswer, localAnswer, type LocalAction, type LocalFacts } from './nodiLocal';
import { commandsFor } from '../../commands/registry';
import { isStage, type CommandContext } from '../../commands/types';
import { arrivalLine, updateLine, blockedFolderOf, clockLines, RUN_SALT, smallTalkOf, diagramLines, failLine, doorOf, openers, restingLine, seedOf, setupStepsOf, smallHours, snagOf, type Look, type SetupStep, type SnagStep } from './nodiLines';
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
  /** The shapes on screen that hold a diagram of their own, by name: a reply naming one offers the way in. */
  doors: ReadonlyMap<string, string>;
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
  const add = ({ nodes, edges, flows }: Pick<DraftDocument, 'nodes' | 'edges' | 'flows'>) => {
    for (const node of nodes) names.set(node.id, line(node.text) ?? (node.type === 'group' ? 'Boundary' : 'Shape'));
    for (const edge of edges) names.set(edge.id, line(edge.label) ?? `${names.get(edge.source) ?? '?'} → ${names.get(edge.target) ?? '?'}`);
    // Flows and their steps too: a reply about a story names them, and they came out as a part
    // "not in this diagram".
    for (const flow of flows ?? []) {
      names.set(flow.id, line(flow.title) ?? 'A flow');
      flow.steps.forEach((step, i) => {
        names.set(step.id, line(step.caption) ?? (step.edgeId ? names.get(step.edgeId) : undefined) ?? `Step ${i + 1} of ${line(flow.title) ?? 'a flow'}`);
      });
    }
  };
  walkGraphs(file, add);
  add(view);
  for (const point of file.openPoints ?? []) names.set(point.id, line(point.context) ?? 'An open point');
  return names;
}

/** The latest turn's points, once it has finished: not for a turn whose proposal is up, where the
 *  change on the canvas is the answer. */
function pointsOf(turn: Turn | null, here: ReadonlySet<string>) {
  const reply = turn && turn.stop !== null && !turn.proposalId ? replyOf(turn) : '';
  return reply ? replyPoints(numberedBlocks(replyBlocks(reply), (id) => here.has(id))) : [];
}

/** How many times the box has opened on each diagram this app run. Kept here, not in the
 *  component, which mounts again with each opening of the editor: its general suggestions come
 *  on the first open only, and stayed on every open while counted per mount. */
const boxOpens = new Map<string, number>();
/** How many times each diagram has opened this app run, so each opening gets its own hello. */
const opened = new Map<string, number>();
/** Diagrams Nodi has greeted this app run: the greeting pops up once on arrival, then on hover. */
const greeted = new Set<string>();
/** The latest finished turn the person has had open, by diagram: one finished since is news. */
const seenRun = new Map<string, string>();
/** How long the arrival greeting stays before Nodi goes quiet. */
const PEEK_MS = 5000;
/** Nodi's walk on (`desktop.css`'s `dc-nodi-arrive`). */
const ARRIVAL_MS = 1400;
/** Quiet long enough to take a break, with a word before walking off. */
export const IDLE_MS = 90_000;
const GOODBYE_MS = 2500;
const FADE_MS = 200;
/** How long the bubble lingers once nothing keeps it up, plus its exit (`desktop.css`'s `.dc-companion-say`). */
const SAY_GONE_MS = 2500 + 200;

/** Asked once per app run: finding the agent can start a login shell. Asked again only while none
 *  was found, when the box opens (see `CompanionFor`). */
let agentsOnce: Promise<AgentInfo[]> | null = null;
/** What `agentsOnce` answered, so a box mounted again (another diagram) has it from its first draw. */
let knownAgents: AgentInfo[] | null = null;

function askAgents(controller: { companionAgents(): Promise<AgentInfo[]> }): Promise<AgentInfo[]> {
  return controller
    .companionAgents()
    .catch((): AgentInfo[] => [])
    .then((found) => (knownAgents = found));
}
/** Clicks on Nodi this close together, this many times, and it has had enough. */
const POKE_WINDOW_MS = 2500;
const POKES = 4;
const POKED_MS = 3500;

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
const NO_NODES: readonly DraftNode[] = [];
const NO_EDGES: readonly DraftEdge[] = [];
const NO_NAMES: ReadonlyMap<string, string> = new Map();
const NO_LINES: string[] = [];

export function Companion(props: { buildCommandContext?: () => CommandContext } = {}) {
  const diagramId = useEditorStore((s) => s.document.metadata.id);
  // Everything the box holds is about one diagram: a draft, a folded thread, a lit point, a greeting
  // still to give. The editor stays mounted when another diagram opens in its place, and the draft
  // typed about the last one went to this one's agent on Enter; this one never got its walk-on.
  return <CompanionFor key={diagramId} {...props} />;
}

function CompanionFor({ buildCommandContext }: { buildCommandContext?: () => CommandContext }) {
  const controller = useDesktopController();
  const shown = useNodiShown();
  const diagramId = useEditorStore((s) => s.document.metadata.id);
  const room = useEditorStore((s) => s.path);
  const selection = useEditorStore(useShallow((s) => ({ nodes: s.selection.nodes, edges: s.selection.edges })));
  // The one selected shape's name, as it is now: renamed while selected, the chip and lines follow.
  // A string, so the selector is stable between unrelated store updates.
  const onlyName = useEditorStore((s) => {
    if (s.selection.nodes.length !== 1) return '';
    const node = s.document.nodes.find((n) => n.id === s.selection.nodes[0]);
    return node?.text?.split('\n')[0]?.trim().slice(0, 40) ?? '';
  });
  // And its kind, so what Nodi says about it can be about what that kind of part has coming.
  const onlyKind = useEditorStore((s) => {
    if (s.selection.nodes.length !== 1 || s.selection.edges.length) return null;
    const node = s.document.nodes.find((n) => n.id === s.selection.nodes[0]);
    // (A junction is an ellipse, and has lines of its own.)
    return node && !['group', 'note', 'text', 'code'].includes(node.type) ? categoryOf(node) : null;
  });
  const names = useMemo(() => {
    const out = new Map<string, string>();
    if (selection.nodes.length === 1 && onlyName) out.set(selection.nodes[0]!, onlyName);
    return out;
  }, [selection.nodes, onlyName]);
  const open = useUiStore((s) => s.companionOpen);
  const setOpen = useUiStore((s) => s.setCompanionOpen);
  const panelOpen = useUiStore((s) => s.proposalPanelOpen || s.openPointsPanelOpen);
  const openProposal = useUiStore((s) => s.setProposalPanelOpen);
  const review = (id: string) => openProposal(true, id);
  const proposalPanelOpen = useUiStore((s) => s.proposalPanelOpen);
  const { doc, agent: access, update: updateState, explorerMode } = useDesktopState();
  // The folder picker owns focus while it is open. Mount the next setup step only after it closes,
  // or its focus callback fights the modal's focus trap when adding the project updates access.
  const yielded = panelOpen || explorerMode != null;
  // A new version to mention: only while the app's own update chip would (not once dismissed).
  const updateView = describeUpdate(updateState);
  const newVersion = updateView.chip && updateView.version && (updateState?.state.phase === 'available' || updateState?.state.phase === 'ready') ? updateLine(updateView.version, updateState.state.phase === 'ready') : null;
  const [agents, setAgents] = useState<AgentInfo[] | null>(() => knownAgents);
  // The agent the person chose, else the first one installed. Every agent-specific word comes from
  // the shell (`AgentInfo.name`), so another agent needs no change here.
  const [preferred, setPreferred] = useState(() => readPreference(AGENT_KEY));
  const conversations = useSyncExternalStore(companion.subscribe, companion.snapshot);
  // A recovered run can belong to another agent than the saved footer preference. Keep that run
  // visible and block another send until it finishes; native allows one run per diagram.
  const working = companion.running(diagramId);
  const workingAgent = working ? companion.agentOf(working.runId) : undefined;
  const agent = agents?.find((a) => a.agent === (workingAgent ?? preferred) && a.availability !== 'missing') ?? agents?.find((a) => a.availability === 'installed') ?? agents?.[0] ?? null;
  useEffect(() => {
    if (workingAgent && workingAgent !== preferred) {
      writePreference(AGENT_KEY, workingAgent);
      setPreferred(workingAgent);
    }
  }, [workingAgent, preferred]);
  const conversation = conversations.get(conversationKey(diagramId, agent?.agent));
  useEffect(() => {
    companion.selectAgent(diagramId, agent?.agent ?? 'claude-code');
  }, [diagramId, agent?.agent]);
  const turns = conversation?.turns ?? NO_TURNS;
  const last = turns.at(-1) ?? null;
  const running = working !== null;

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
    agentsOnce ??= askAgents(controller);
    let live = true;
    void agentsOnce.then((found) => live && setAgents(found));
    return () => {
      live = false;
    };
  }, [agents, controller]);

  // The composer has the focus whenever it appears: on opening, and once what was in the way (access,
  // a folder) is cleared from inside the box, where the step that cleared it has just gone.
  const focusInput = useCallback((element: HTMLInputElement | null) => {
    input.current = element;
    element?.focus();
  }, []);
  // While Nodi can't take a message, the first thing that fixes that has the focus the composer
  // would: whenever it appears, which may be after opening (once the shell says access is off).
  const focusStep = useCallback((step: HTMLButtonElement | null) => step?.focus(), []);

  // Asked again whenever Nodi opens: access is switched in Settings, or by another window of the app.
  useEffect(() => {
    if (expanded) void controller.refreshAgent();
  }, [expanded, controller]);

  // The thread reads downward to the newest, so it opens at the bottom, and follows a reply as it
  // streams in only while the reader is there: scrolled up to read an earlier turn, they stay put.
  const following = useRef(true);
  const placeThread = useCallback((element: HTMLElement | null) => {
    thread.current = element;
    following.current = true;
    if (element) element.scrollTop = element.scrollHeight;
  }, []);
  const turnCount = turns.length;
  useEffect(() => {
    following.current = true;
  }, [turnCount]);
  useEffect(() => {
    const box = thread.current;
    if (box && following.current) box.scrollTop = box.scrollHeight;
  }, [turns]);

  // The review panel may have accepted or rejected the companion's proposal.
  useEffect(() => {
    if (!proposalPanelOpen) void controller.refreshCompanionProposals();
  }, [proposalPanelOpen, controller]);

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
  // One timer: a second click's word was taken away by the first click's, a moment after it appeared.
  const continuedTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(continuedTimer.current), []);
  const continueInTerminal = async () => {
    const ran = agent?.agent;
    const line = ran ? await controller.companionContinue(diagramId, ran) : null;
    const ok = line !== null && (await useEditorStore.getState().copyText(line));
    setContinued(ok ? 'copied' : 'failed');
    window.clearTimeout(continuedTimer.current);
    continuedTimer.current = window.setTimeout(() => setContinued(null), 4000);
  };
  const agentName = agent?.name ?? 'your agent';
  // No coding agent on this computer: Nodi still answers what it can itself, and says plainly that
  // the thinking needs one (`nodiLocal.ts`).
  const agentless = agents !== null && !agents.some((a) => a.availability !== 'missing');
  // None found is asked again each time the box opens: an agent installed while the app runs, or a
  // shell that couldn't answer the first time, otherwise left Nodi without one until a restart.
  useEffect(() => {
    if (!expanded || !agentless) return;
    let live = true;
    agentsOnce = askAgents(controller);
    void agentsOnce.then((found) => live && setAgents(found));
    return () => {
      live = false;
    };
  }, [expanded, agentless, controller]);
  // Why Nodi can't take a message yet, with the next steps it offers in place of the composer.
  const blocker = useMemo(
    () =>
      agentless ? null : snagOf({
        doc: doc.kind,
        readOnly: doc.kind === 'file' && doc.readOnly,
        access: access ? access.enabled : null,
        folder: doc.kind === 'file' && access ? blockedFolderOf(doc.displayPath, access.projects) : null,
        agentsKnown: agents !== null,
        agent,
      }),
    [doc, access, agents, agent, agentless],
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
    else if (step.kind === 'add-project') controller.addProject();
    else if (step.kind === 'allow') void controller.configureAgent({ enabled: true });
    else if (step.kind === 'allow-folder') void controller.configureAgent({ project: { handle: step.handle, agent: true } });
    else void useEditorStore.getState().copyText(step.command).then((ok) => setCopied({ command: step.command, ok }));
  };

  // Poked over and over, Nodi has a word to say about it, and a face to go with it.
  const pokes = useRef<number[]>([]);
  const [poked, setPoked] = useState(false);
  const poke = () => {
    const now = performance.now();
    pokes.current = [...pokes.current.filter((at) => now - at < POKE_WINDOW_MS), now];
    if (pokes.current.length < POKES) return;
    pokes.current = [];
    setPoked(true);
  };
  useEffect(() => {
    if (!poked) return;
    const timer = setTimeout(() => setPoked(false), POKED_MS);
    return () => clearTimeout(timer);
  }, [poked]);
  // News not yet read: a finished turn the person hasn't had open since.
  const unseen = Boolean(last && last.stop !== null && !expanded && seenRun.get(diagramId) !== last.runId);
  // Read off the clock when Nodi next has something to say, not on every render.
  const [clockAt, setClockAt] = useState(() => new Date());
  const clock = useMemo(() => clockLines(clockAt), [clockAt]);
  const failed = last?.stop?.kind === 'failed' || last?.stop?.kind === 'refusal';
  const mood: Mood = poked
    ? 'angry'
    : blocker
      ? 'asleep'
      : running
        ? 'working'
        : last?.proposalId
          ? 'waiting'
          : failed
            ? 'dizzy'
            : last?.outcome === 'accepted'
              ? 'love'
              : unseen
                ? 'surprised'
                : last?.stop?.kind === 'end-turn' && last.outcome === null
                  ? 'happy'
                  : smallHours(clockAt)
                    ? 'sleepy'
                    : 'idle';

  // What would make the agent better outside this box too, each one click (`setupStepsOf`).
  const [setup, setSetup] = useState<{ clients: AgentClientSetup[]; skills: AgentSkillSetup[] } | null>(null);
  const accessOn = access?.enabled === true;
  const [setupBusy, setSetupBusy] = useState<string | null>(null);
  const [setupSaid, setSetupSaid] = useState<string | null>(null);
  // Asked each time Nodi opens, as Settings asks each time it shows them: one may have been set up
  // (or undone) elsewhere since.
  useEffect(() => {
    if (!expanded || !accessOn) return;
    let live = true;
    void Promise.all([controller.agentClients(), controller.agentSkills()]).then(([clients, skills]) => live && setSetup({ clients, skills }));
    return () => {
      live = false;
      setSetupSaid(null);
    };
  }, [expanded, accessOn, controller]);
  const setupSteps = useMemo(() => (agent && setup && accessOn ? setupStepsOf(agent, setup.clients, setup.skills) : []), [agent, setup, accessOn]);
  const runSetup = async (step: SetupStep) => {
    if (setupBusy || !setup) return;
    setSetupBusy(step.label);
    const name = agent?.name ?? 'your agent';
    if (step.kind === 'connect') {
      const done = await controller.connectAgentClient(step.client);
      if (done) {
        setSetup((now) => now && { ...now, clients: now.clients.map((c) => (c.client === done.client ? done : c)) });
        setSetupSaid(`Done, boss. A new ${name} session finds Draft Canvas from anywhere now.`);
      }
    } else {
      const done = await controller.installAgentSkill(step.target);
      if (done) {
        setSetup((now) => now && { ...now, skills: now.skills.map((s) => (s.target === done.target ? done : s)) });
        setSetupSaid(`Installed. ${name} draws like it means it now, boss.`);
      }
    }
    setSetupBusy(null);
  };
  const hasSelection = selection.nodes.length + selection.edges.length > 0;
  const selectionKey = `${selection.nodes.join(',')}|${selection.edges.join(',')}`;
  const includeSelection = leftOut !== selectionKey;
  const selected = hasSelection ? aboutOf(selection.nodes, selection.edges, names) : null;
  const about = includeSelection ? selected : null;
  const showsCost = /api/i.test(agent?.signIn.method ?? '');
  const spent = spentOn(conversation);

  // The parts the latest reply points at: named in its text, pinned by number on the canvas, and lit
  // on both together.
  // Read only while the box is open, where they are shown: at rest, every frame of a drag re-rendered
  // Nodi and walked every view of the file for names nothing at rest says.
  const view = useEditorStore((s) => (expanded ? s.document : null));
  const outerFile = useEditorStore((s) => (expanded ? s.outer : null));
  const docNodes = view?.nodes ?? NO_NODES;
  const docEdges = view?.edges ?? NO_EDGES;
  const partNames = useMemo(() => (view ? partNamesOf(outerFile ?? view, view) : NO_NAMES), [outerFile, view]);
  const partsHere = useMemo(() => new Set([...docNodes.map((n) => n.id), ...docEdges.map((e) => e.id)]), [docNodes, docEdges]);
  const doors = useMemo(() => new Map(docNodes.filter(hasInside).map((n) => [n.id, partNames.get(n.id) ?? 'it'])), [docNodes, partNames]);
  // What Nodi can offer to look inside: the selected shape's inside, or draw one it could have; else
  // the first shape on screen that holds a diagram.
  const look = useMemo<Look>(() => {
    const only = selection.nodes.length === 1 && selection.edges.length === 0 ? docNodes.find((n) => n.id === selection.nodes[0]) : undefined;
    if (only && hasInside(only)) return { into: { id: only.id, name: partNames.get(only.id) ?? 'it' } };
    if (only) return { drawable: canCreateInside(only) };
    return { into: doorOf(docNodes, [], (n) => partNames.get(n.id) ?? 'it') ?? undefined };
  }, [selection.nodes, selection.edges, docNodes, partNames]);
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
  // Closed, or making way for a panel: nothing it pointed at stays lit on the canvas.
  useEffect(() => {
    if (expanded) return;
    setHot(null);
    setPointedIds(null);
  }, [expanded, setPointedIds]);
  // Pins taken away from under the pointer (the next turn began, its answer became a proposal) never
  // get their mouseleave: what one lit stayed lit on the canvas through the whole next run, and its
  // number came back lit with the next reply.
  const pinsUp = points.length > 0;
  useEffect(() => {
    if (pinsUp) return;
    setHot(null);
    if (useUiStore.getState().pointedIds) setPointedIds(null);
  }, [pinsUp, setPointedIds]);
  const pointing = useMemo<Pointing>(
    () => ({
      names: partNames,
      here: partsHere,
      doors,
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
    [partNames, partsHere, doors, hot, pointAt, flowStore, setViewport],
  );

  // What Nodi knows without asking an agent, read when a message is sent (`nodiLocal.ts`).
  const localFacts = (): LocalFacts => {
    const { document: view, outer } = useEditorStore.getState();
    const file = outer ?? view;
    const shapes = view.nodes.filter((n) => !['note', 'text', 'code', 'group'].includes(n.type));
    let commands: LocalFacts['commands'] = [];
    try {
      commands = buildCommandContext ? commandsFor(buildCommandContext()) : [];
    } catch {
      commands = [];
    }
    return {
      now: new Date(),
      title: file.metadata.title,
      shapes: shapes.map((n) => ({ id: n.id, name: partNames.get(n.id) ?? 'Shape', category: categoryOf(n) })),
      connectors: view.edges.map((e) => ({ id: e.id, name: partNames.get(e.id) ?? '' })),
      flows: view.flows.map((f) => ({ id: f.id, title: f.title })),
      boundaries: view.nodes.filter((n) => n.type === 'group').map((n) => ({ id: n.id, name: partNames.get(n.id) ?? 'Boundary' })),
      notes: view.nodes.filter((n) => n.type === 'note').length,
      openPoints: file.openPoints?.filter((p) => !p.resolved).length ?? 0,
      file: doc.kind === 'file' ? doc.displayPath : null,
      folders: access ? access.projects.map((p) => ({ name: p.name, displayPath: p.displayPath, agent: p.agent })) : null,
      agentName: agentless ? null : agentName,
      commands,
    };
  };
  // A button under Nodi's own answer: a command runs as ⌘K runs it (a command that needs a second
  // step opens ⌘K at it), a question goes to the agent.
  const runAction = (action: LocalAction) => {
    if (action.kind === 'ask') send(action.prompt);
    else if (action.kind === 'settings') controller.openAgentSettings();
    else if (action.kind === 'palette') useUiStore.getState().openCommandPaletteAt(action.query);
    else if (action.kind === 'say') send(action.text);
    else {
      const ctx = buildCommandContext?.();
      const command = ctx ? commandsFor(ctx).find((c) => c.id === action.id) : undefined;
      if (!ctx || !command) {
        useUiStore.getState().openCommandPaletteAt(action.label.replace(/…$/, ''));
        return;
      }
      const next = command.run(ctx);
      if (isStage(next)) useUiStore.getState().openCommandPaletteAt(command.title.replace(/…$/, ''));
    }
  };
  // Between Send and the turn starting (its view is read first): a second Enter is not a second turn.
  const sending = useRef(false);
  const send = (text = draft) => {
    const prompt = text.trim();
    if (!prompt || running || blocker || sending.current) return;
    // Small talk, and what Nodi can answer or do itself, are its own: no agent run, no tokens.
    // "Yes" may answer a question in the CLI's resumed session, even after a restart has cleared
    // the on-screen conversation. With an agent available, never consume confirmations locally.
    const own = smallTalkOf(prompt, seedOf(diagramId) + turns.length, !agentless);
    const local = own ? null : localAnswer(prompt, localFacts());
    if (own || local) {
      setDraft('');
      companion.answer(diagramId, prompt, own ?? local!.text, local?.actions, agent?.agent);
      if (local?.reveal) pointing.reveal(local.reveal);
      // Plainly asked for: done at once, no button to press.
      if (local?.run) runAction({ kind: 'command', id: local.run, label: local.text });
      return;
    }
    // Only an agent could answer this, and there is none: Nodi says so, and what it can still do.
    if (agentless) {
      setDraft('');
      const reply = agentlessAnswer(seedOf(diagramId) + turns.length);
      companion.answer(diagramId, prompt, reply.text, reply.actions, agent?.agent);
      return;
    }
    const scoped = includeSelection && hasSelection;
    const kind = agent?.agent ?? 'claude-code';
    const request: PromptRequest = {
      runId: crypto.randomUUID(),
      diagramId,
      text: prompt,
      selection: scoped ? { nodes: selection.nodes, edges: selection.edges } : null,
      room: [...room],
      agent: kind,
      mode,
      // A follow-up on a diagram nobody has touched since: the agent needn't read it again.
      unchanged: unchangedSinceLastTurn(diagramId, useEditorStore.getState().document, room, kind, turns.length > 0),
    };
    setDraft('');
    sending.current = true;
    void (async () => {
      try {
        // The view up front, so the agent's first call is its answer rather than a read; not when it
        // has the view from last turn already.
        const snapshot = request.unchanged ? null : await controller.companionSnapshot(diagramId, room).catch(() => null);
        await controller.companionSend(snapshot ? { ...request, snapshot } : request, scoped ? about : null);
      } finally {
        sending.current = false;
      }
    })();
  };

  // One function for every turn's buttons, so a streamed token re-renders only the turn it is part of:
  // with a new one each render, every earlier turn's reply was parsed again for every token.
  const actions = useRef(runAction);
  useLayoutEffect(() => {
    actions.current = runAction;
  });
  const onAction = useCallback((action: LocalAction) => actions.current(action), []);

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
  const [focused, setFocused] = useState(false);
  // Each time Nodi pipes up on a hover, a new line from its repertoire: only once the last one has
  // gone, so coming back while it lingers never swaps the line being read.
  const [visits, setVisits] = useState(0);
  // The questions Nodi offers when the box opens: the first time on a diagram, and whenever
  // something is selected (they are about it then); otherwise behind one "Ideas" link, so a box
  // opened to type isn't the same three suggestions every time.
  const [ideasWanted, setIdeasWanted] = useState(false);
  const [openNumber, setOpenNumber] = useState(0);
  // Counted once per open and diagram: a ref, so development's doubled effects don't make it the
  // second.
  const counted = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!expanded) {
      counted.current = null;
      setIdeasWanted(false);
      return;
    }
    if (counted.current === diagramId) return;
    counted.current = diagramId;
    const opens = (boxOpens.get(diagramId) ?? 0) + 1;
    boxOpens.set(diagramId, opens);
    setOpenNumber(opens);
  }, [expanded, diagramId]);
  const ideasShown = ideasWanted || about !== null || openNumber <= 1;
  // Closed after a look, Nodi has something new to say next time, not the line it opened on.
  const wasExpanded = useRef(expanded);
  useEffect(() => {
    if (wasExpanded.current && !expanded) setVisits((n) => n + 1);
    wasExpanded.current = expanded;
  }, [expanded]);
  const leftAt = useRef(0);
  // On a diagram's first opening this app run, Nodi walks on from the canvas's edge, then greets.
  const [arriving, setArriving] = useState(() => !greeted.has(diagramId) && !prefersReducedMotion());
  const [peeking, setPeeking] = useState(() => !greeted.has(diagramId));
  // Read under the pointer when its five seconds are up, the hello stays until the bubble goes,
  // rather than being typed over with another line mid-read.
  const [helloHeld, setHelloHeld] = useState(false);
  const [wandering, setWandering] = useState<'here' | 'goodbye' | 'leaving' | 'away'>('here');
  const [returned, setReturned] = useState(false);
  const [trips, setTrips] = useState(0);
  const lastActivity = useRef<number | null>(null);
  const needed = open || running || Boolean(last?.proposalId) || unseen || blocker !== null || hovered || focused || poked;
  const canWander = !needed && !arriving && !peeking && !helloHeld && shown && !yielded && agents !== null;

  useEffect(() => {
    lastActivity.current ??= Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let changed = false;
    const comeBack = () => {
      if (changed) return;
      changed = true;
      setWandering('here');
      setReturned(true);
      setArriving(!open && wandering !== 'goodbye');
      setPeeking(!open && wandering !== 'goodbye');
    };
    const activity = () => {
      lastActivity.current = Date.now();
      if (wandering !== 'here') comeBack();
    };
    // Input only updates a timestamp while Nodi is here. One timeout checks the remaining quiet
    // time, so moving the pointer neither renders the companion nor churns a timer per event.
    const checkIdle = () => {
      const remaining = IDLE_MS - (Date.now() - lastActivity.current!);
      if (remaining > 0) timer = setTimeout(checkIdle, remaining);
      else {
        setReturned(false);
        setTrips((n) => n + 1);
        setWandering('goodbye');
      }
    };
    if (wandering !== 'here' && needed) comeBack();
    else if (wandering === 'here' && canWander) timer = setTimeout(checkIdle, Math.max(0, IDLE_MS - (Date.now() - lastActivity.current!)));
    else if (wandering === 'goodbye') timer = setTimeout(() => setWandering('leaving'), GOODBYE_MS);
    else if (wandering === 'leaving') timer = setTimeout(() => setWandering('away'), prefersReducedMotion() ? FADE_MS : ARRIVAL_MS);

    const events = ['pointermove', 'pointerdown', 'click', 'keydown', 'wheel', 'scroll'] as const;
    for (const event of events) window.addEventListener(event, activity, { capture: true, passive: true });
    const unsubscribe = useEditorStore.subscribe((state, previous) => {
      if (state.document !== previous.document || state.outer !== previous.outer || state.selection !== previous.selection) activity();
    });
    // The same key can wake Nodi and open it: opening takes precedence over the walk it just began.
    const unsubscribeOpen = useUiStore.subscribe((state, previous) => {
      if (!state.companionOpen || previous.companionOpen) return;
      changed = true;
      lastActivity.current = Date.now();
      setWandering('here');
      setArriving(false);
      setPeeking(false);
      setFocused(false);
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
      unsubscribeOpen();
      for (const event of events) window.removeEventListener(event, activity, true);
    };
  }, [wandering, needed, canWander, open, diagramId]);
  useEffect(() => {
    if (hovered || !helloHeld) return;
    const timer = setTimeout(() => setHelloHeld(false), SAY_GONE_MS);
    return () => clearTimeout(timer);
  }, [hovered, helloHeld]);
  // The hello itself, about this diagram as it opened: worked out once per diagram, so it doesn't
  // change under the reader as the diagram does.
  const hello = useMemo(() => {
    opened.set(diagramId, (opened.get(diagramId) ?? 0) + 1);
    const { document: view, outer } = useEditorStore.getState();
    const file = outer ?? view;
    const shapes = view.nodes.filter((n) => !['note', 'text', 'code', 'group', 'ellipse'].includes(n.type));
    let insides = 0;
    walkGraphs(file, (graph) => {
      insides += graph.nodes.filter(hasInside).length;
    });
    return arrivalLine(
      {
        title: file.metadata.title,
        shapes: shapes.length,
        connectors: view.edges.length,
        flows: view.flows.length,
        openPoints: file.openPoints?.filter((p) => !p.resolved).length ?? 0,
        insides,
        now: new Date(),
      },
      // A new hello each time it opens, and each time the app runs: the same diagram used to open
      // to the same line, every time.
      seedOf(diagramId) + RUN_SALT + (opened.get(diagramId) ?? 0),
    );
  }, [diagramId]);
  useEffect(() => {
    greeted.add(diagramId);
  }, [diagramId]);
  useEffect(() => {
    if (!arriving) return;
    // Ends with the walk's animation; this is only for a walk that never gets to play (a hidden window).
    const timer = setTimeout(() => setArriving(false), (prefersReducedMotion() ? FADE_MS : ARRIVAL_MS) + 800);
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
  // What Nodi can say about this very diagram: its queues, stores, crons and loose ends, by name. Only
  // while it could be said (open, or the bubble up): worked out at rest, the semantic review it starts
  // with ran on every frame of every drag.
  const speaking = expanded || hovered || focused || peeking || helloHeld;
  const sayNodes = useEditorStore((s) => (speaking ? s.document.nodes : NO_NODES));
  const sayEdges = useEditorStore((s) => (speaking ? s.document.edges : NO_EDGES));
  const flowCount = useEditorStore((s) => (speaking ? s.document.flows.length : 0));
  const openPointCount = useEditorStore((s) => (speaking ? (s.document.openPoints?.filter((p) => !p.resolved).length ?? 0) : 0));
  const aboutDiagram = useMemo(() => (speaking ? diagramLines(sayNodes, sayEdges, flowCount, openPointCount) : NO_LINES), [speaking, sayNodes, sayEdges, flowCount, openPointCount]);
  const resting = restingLine({
    blocked: blocker !== null,
    snag: blocker?.rest,
    working: working ? (working.steps.length ? stepText(working.steps.at(-1)!.tool) : 'Thinking') : null,
    waiting: Boolean(last?.proposalId),
    unseen,
    // What the message would be about: the selection, unless the person left it out.
    selected: about,
    selectedKind: about ? onlyKind : null,
    seed: seedOf(diagramId) + (wandering === 'goodbye' || (returned && (peeking || helloHeld)) ? trips : RUN_SALT + visits),
    diagram: setupSteps.length ? [`Psst, boss. ${agentName} can’t find me outside this box yet. Open me: it’s one click.`, ...aboutDiagram] : aboutDiagram,
    runSeed: seedOf(last?.runId ?? diagramId),
    clock,
    poked,
    departure: wandering === 'goodbye',
    returning: returned && (peeking || helloHeld),
    arrival: peeking || helloHeld ? hello : undefined,
    // Said with the hello, and then every fourth time Nodi pipes up: news, not nagging.
    update: newVersion && (peeking || visits % 4 === 0) ? newVersion : undefined,
  });
  // The line the bubble says. While it is up, whatever Nodi has to say now; once it starts to go (the
  // hello's five seconds are up, the pointer has left), the line it was saying stays until it has
  // gone, instead of being typed over with the next line on its way out.
  const bubbleUp = resting.stays || peeking || hovered;
  const [said, setSaid] = useState(resting);
  const latest = useRef(resting);
  useLayoutEffect(() => {
    latest.current = resting;
  });
  useEffect(() => {
    if (bubbleUp) {
      setSaid(latest.current);
      return;
    }
    const timer = setTimeout(() => setSaid(latest.current), SAY_GONE_MS);
    return () => clearTimeout(timer);
  }, [bubbleUp, resting.text, resting.tone, resting.hint]);
  // Up, the current line at once (no frame of the old one); going, the one it was saying.
  const line = bubbleUp ? resting : said;
  // Opened from rest: the pointer was over the bubble, which goes from under it without a leave, so
  // the hover is put down here or Nodi would keep talking after the conversation closes.
  const openFromRest = () => {
    setHovered(false);
    setFocused(false);
    setOpen(true);
  };

  // The review and open-points panels sit in the same corner: the companion makes way for them. And
  // with no agent on this computer (or until that is known) there is no Nodi: nothing it could run.
  // Nor once the person has switched it off in Settings.
  // Until the shell says which agents there are, nothing: then Nodi, agent or not.
  if (!shown || yielded || agents === null) return null;
  if (wandering === 'away' && !open) return null;

  if (!expanded) {
    return (
      <>
        {chip}
        <div
          className="dc-companion"
          data-open="false"
          // Its own keys: Backspace on a focused button must not delete the selection behind it.
          data-dc-keyboard-region=""
          data-arriving={arriving ? 'true' : undefined}
          data-leaving={wandering === 'leaving' ? 'true' : undefined}
          onAnimationEnd={(event) => {
            if (event.animationName === 'dc-nodi-arrive' || event.animationName === 'dc-nodi-fade-in') setArriving(false);
            if (event.animationName === 'dc-nodi-leave' || event.animationName === 'dc-nodi-fade-out') setWandering('away');
          }}
          onFocusCapture={() => setFocused(true)}
          onBlurCapture={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
          }}
          // The pointer only: focus is handed back here when the conversation closes, and a bubble
          // kept up by it stayed under a pointer long gone. News is said without either.
          onMouseEnter={() => {
            setHovered(true);
            if (peeking) setHelloHeld(true);
            if (!resting.stays && !peeking && performance.now() - leftAt.current > SAY_GONE_MS) {
              setVisits((n) => n + 1);
              setClockAt(new Date());
            }
          }}
          onMouseLeave={() => {
            setHovered(false);
            leftAt.current = performance.now();
          }}
        >
          {/* Nodi says the one thing worth knowing, and the bubble is the way in. Kept mounted: it
              lingers a moment after the pointer leaves, then goes (`desktop.css`), so a line isn't
              snatched away mid-read. */}
          {!arriving && wandering !== 'leaving' && (
            <button
              type="button"
              className="dc-companion-say"
              data-tone={line.tone}
              data-shown={bubbleUp ? 'true' : undefined}
              aria-label={`Nodi: ${line.text} ${line.hint}`}
              // News of a new version opens the update panel; anything else, the conversation.
              onClick={line.tone === 'update' ? () => desktopStore.update({ updateOpen: true }) : openFromRest}
            >
              {/* Who is talking, as a game's dialogue box says it: a nameplate on the box's edge. */}
              <span className="dc-companion-say-name" aria-hidden="true">
                Nodi
              </span>
              <Typed key={line.text} text={line.text} />
              <span className="dc-companion-say-hint" aria-hidden="true">
                {line.hint}
              </span>
            </button>
          )}
          <button
            type="button"
            className="dc-companion-mascot"
            aria-label="Open Nodi"
            onClick={() => {
              poke();
              openFromRest();
            }}
          >
            <Mascot mood={arriving || wandering === 'leaving' ? (prefersReducedMotion() ? 'idle' : 'walking') : mood} facing={wandering === 'leaving' ? 'right' : 'left'} />
          </button>
        </div>
      </>
    );
  }

  return (
    <PointingContext.Provider value={pointing}>
      {chip}
      {pins}
    <div
      className="dc-companion"
      data-open="true"
      // Its own keys (see the resting one), and Escape closes it from anywhere inside, not only the composer.
      data-dc-keyboard-region=""
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) return;
        event.preventDefault();
        setOpen(false);
      }}
    >
      <div className="dc-companion-presence">
        <button
          type="button"
          className="dc-companion-mascot"
          aria-label="Hide Nodi"
          onClick={() => {
            poke();
            setOpen(false);
          }}
        >
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
              <button
                type="button"
                aria-label="New conversation"
                title="New conversation"
                onClick={() => {
                  forgetTurnSnapshot(diagramId);
                  void controller.companionForget(diagramId, agent?.agent);
                }}
              >
                <Icon name="pencil" />
              </button>
{/* Only once an agent has run: Nodi's own replies leave no session to carry on. */}
              {turns.some((t) => !t.local) && (
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
              )}
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
              <section
                className="dc-companion-thread"
                aria-label={`Conversation with ${agentName}`}
                ref={placeThread}
                onScroll={(event) => {
                  const box = event.currentTarget;
                  following.current = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
                }}
              >
                {folded > 0 && (
                  <button type="button" className="dc-companion-earlier" onClick={() => setShowEarlier(true)}>
                    {folded === 1 ? '1 earlier turn' : `${folded} earlier turns`}
                  </button>
                )}
                {turns.slice(folded).map((turn) => (
                  <TurnView key={turn.runId} turn={turn} pinned={turn === last} onAction={onAction} />
                ))}
                {last && last.stop !== null && last.steps.some((step) => step.tool === 'ask_to_read_code') && (
                  <CodeAsk key={last.runId} diagramId={diagramId} turn={last} onAllowed={send} />
                )}
              </section>
              {/* Said once a turn ends, for someone who stayed in the composer and can't see the reply arrive. */}
              <p className="dc-sr-only" role="status">
                {last && last.stop !== null ? (stopMessage(last.stop) ?? (last.proposalId ? `${agentName} proposed a change.` : `${agentName} has answered.`)) : ''}
              </p>
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
              {agentless ? (
                // Without an agent: said once, plainly, and what Nodi can still do as the replies.
                <>
                  <Typed key="agentless" text="No coding agent on this computer, boss, so I can’t think about the architecture yet. I can still count, find, tell the time and run the app for you." />
                  <ul className="dc-companion-options" aria-label="Ask Nodi">
                    {['What can you do?', 'What’s in this diagram?', 'What time is it?'].map((said) => (
                      <li key={said}>
                        <button type="button" onClick={() => send(said)}>
                          {said}
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <>
                  <Typed key={resting.text} text={resting.text} />
                  {ideasShown ? (
                    <ul className="dc-companion-options" aria-label="Ask Nodi">
                      {openers(about, seedOf(diagramId) + visits, look).map((option) => (
                        <li key={option.label}>
                          <button type="button" onClick={() => (option.enter ? void lookInside(option.enter) : send(option.prompt))}>
                            {option.label}
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <button type="button" className="dc-companion-link dc-companion-ideas" onClick={() => setIdeasWanted(true)}>
                      Ideas
                    </button>
                  )}
                </>
              )}
              {/* Set apart from the questions: what would make the agent better outside this box,
                  each one Settings' own one-click button, done from here. */}
              {(setupSteps.length > 0 || setupSaid) && (
                <div className="dc-companion-setup">
                  {setupSaid ? (
                    <p role="status">{setupSaid}</p>
                  ) : (
                    <p>{setupSteps.length === 1 ? setupSteps[0]!.why : `Two things and I’m at full power, boss. ${setupSteps[0]!.why}`}</p>
                  )}
                  {setupSteps.length > 0 && (
                    <ul className="dc-companion-options" aria-label="Set up">
                      {setupSteps.map((step) => (
                        <li key={step.label}>
                          <button type="button" data-setup="true" disabled={setupBusy !== null} aria-busy={setupBusy === step.label || undefined} onClick={() => void runSetup(step)}>
                            {setupBusy === step.label ? 'On it…' : step.label}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
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
          ref={focusInput}
          type="text"
          autoComplete="off"
          spellCheck
          value={draft}
          // Short beside a chip, so it reads whole.
          placeholder={about ? 'Ask about this…' : selected ? 'Ask about the whole view…' : agentless ? 'Ask Nodi…' : `Ask ${agentName} about this diagram…`}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKey}
        />
        {running ? (
          <button type="button" className="dc-companion-stop" aria-label="Stop" title="Stop" onClick={() => void controller.companionCancel(working!.runId)}>
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
      {agentless ? (
        <div className="dc-companion-footer">
          <span>Nodi on its own · no coding agent</span>
        </div>
      ) : (
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
      )}
      </>
      )}
    </div>
    </PointingContext.Provider>
  );
}

/** What the mascot says about the latest turn: the step it is on, then its reply as it streams in. */
const TurnView = memo(function TurnView({ turn, pinned, onAction }: { turn: Turn; pinned: boolean; onAction: (action: LocalAction) => void }) {
  const reply = replyOf(turn);
  const activity = activityOf(turn.steps, turn.stop === null);
  const stopped = stopMessage(turn.stop);
  return (
    <article className="dc-companion-turn">
      <div className="dc-companion-you">
        {turn.about && <span className="dc-companion-about">About {turn.about}</span>}
        <p>{turn.prompt}</p>
      </div>
      {/* One line, not a list: the step under way while it runs, then what it did, each kind once. */}
      {turn.stop !== null && activity.done.length > 0 && (
        <p className="dc-companion-activity">
          <Icon name="check" />
          <span>{activity.done.join(' · ')}</span>
        </p>
      )}
      {activity.snag && (
        <p className="dc-companion-activity" data-status="failed">
          <Icon name="close" />
          <span>
            Couldn’t finish {lowerFirst(activity.snag.what)}: <span className="dc-companion-step-error">{activity.snag.error}</span>
          </span>
        </p>
      )}
      {/* Numbered only while its pins can be on the canvas: a waiting proposal holds the canvas
          (`pointsOf`), and numbers in the bubble with no pins to match point at nothing. */}
      {reply && <ReplyText text={reply} pinned={pinned && !turn.proposalId} />}
      {/* Still at it: below whatever it has said so far, so words that arrive first ("I'll review the
          modules, then…") never look like the end of the turn. */}
      {turn.stop === null && <Working now={activity.now} />}
      {pinned && turn.stop !== null && reply && <Doors reply={reply} />}
      {(turn.stop?.kind === 'failed' || turn.stop?.kind === 'refusal') && <p className="dc-companion-quip">{failLine(seedOf(turn.runId))}</p>}
      {stopped && <p className="dc-companion-stopped">{stopped}</p>}
      {turn.proposalId &&
        (pinned ? (
          <p className="dc-companion-hint">The change is shown on the canvas: accept or reject it there.</p>
        ) : (
          <p className="dc-companion-hint">Still waiting for you, boss: it’s under “proposals to review”.</p>
        ))}
      {turn.outcome === 'accepted' && (
        <p className="dc-companion-outcome">
          <Icon name="check" /> Added to the diagram. {UNDO} undoes it.
        </p>
      )}
      {turn.outcome === 'rejected' && <p className="dc-companion-stopped">Rejected. The diagram is unchanged.</p>}
      {turn.actions && (
        <ul className="dc-companion-options dc-companion-actions" aria-label="Nodi can">
          {turn.actions.map((action) => (
            <li key={`${action.kind}:${action.label}`}>
              <button type="button" data-kind={action.kind} onClick={() => onAction(action)}>
                {action.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
});

/** How the person answered each run that asked to read the code, this app run: answered once, the
 *  card stays answered, however often the box is opened again. */
const codeAnswered = new Map<string, 'yes' | 'no'>();

/**
 * Nodi asking to read the project, after a reply that needed the code: the agent can't read a file
 * until the person says so here, and what they allow is one folder, read-only, with secrets left out
 * (`src-tauri/src/agent/code.rs`). Yes asks the same question again, with the code.
 */
function CodeAsk({ diagramId, turn, onAllowed }: { diagramId: string; turn: Turn; onAllowed: (prompt: string) => void }) {
  const controller = useDesktopController();
  const [folder, setFolder] = useState<CodeFolder | null | undefined>(undefined);
  const [answer, setAnswer] = useState(() => codeAnswered.get(turn.runId) ?? null);
  useEffect(() => {
    let live = true;
    void controller.companionCode(diagramId).then((found) => live && setFolder(found));
    return () => {
      live = false;
    };
  }, [controller, diagramId]);
  const answered = (said: 'yes' | 'no') => {
    codeAnswered.set(turn.runId, said);
    setAnswer(said);
  };
  const allow = async (grant: CodeGrant) => {
    if (!(await controller.companionAllowCode(diagramId, grant))) return;
    answered('yes');
    onAllowed(turn.prompt);
  };
  const choose = async () => {
    const chosen = await controller.companionChooseCode(diagramId);
    if (chosen) setFolder(chosen);
  };
  if (answer === 'no') return <p className="dc-companion-hint">Fair, boss. I’ll stick to the diagram.</p>;
  if (answer === 'yes' || folder === undefined) return null;
  return (
    <div className="dc-companion-ask" role="group" aria-label="Let Nodi read the code">
      {folder ? (
        <p>
          Can I read the code in <strong title={folder.displayPath}>{folder.name}</strong>, boss? Only reading: nothing gets changed, and secrets stay out.
        </p>
      ) : (
        <p>I can’t tell where this diagram’s code lives, boss. Show me?</p>
      )}
      <ul className="dc-companion-options dc-companion-actions" aria-label="Your answer">
        {folder?.allowed ? (
          <li>
            <button
              type="button"
              onClick={() => {
                answered('yes');
                onAllowed(turn.prompt);
              }}
            >
              Ask again, with the code
            </button>
          </li>
        ) : folder ? (
          <>
            <li>
              <button type="button" onClick={() => void allow('now')}>
                Just for now
              </button>
            </li>
            <li>
              <button type="button" onClick={() => void allow('always')}>
                Always for this folder
              </button>
            </li>
          </>
        ) : null}
        <li>
          <button type="button" onClick={() => answered('no')}>
            No
          </button>
        </li>
      </ul>
      <button type="button" className="dc-companion-link" onClick={() => void choose()}>
        {folder ? 'Another folder…' : 'Choose the folder…'}
      </button>
    </div>
  );
}

/** What Nodi's screen is on while the agent thinks, said as a joke beside the honest "Thinking". */
const THINKING_ASIDES: Record<Channel, string | readonly string[]> = {
  typing: '',
  feed: 'and scrolling Reddit, a little',
  show: 'one more episode on Netflix',
  likes: 'liking Instagram posts about microservices',
  swipe: 'just one more TikTok',
  dating: ['swiping on Tinder for a database that commits', 'on Bumble, waiting for the API to make the first move'],
  pong: 'and winning at pong',
  reading: 'reading the comments on Facebook',
  music: 'lo-fi beats on Spotify',
  coffee: 'coffee first',
};

/**
 * The live line while a turn runs: the step under way, or "Thinking" between steps, with an aside
 * that changes as Nodi's screen does (`pixels.ts`'s channels, the same order and pace).
 */
function Working({ now }: { now: string | null }) {
  // The channel clock the mascot's screen runs on, so the joke is about what is on it.
  const [channel, setChannel] = useState(() => (prefersReducedMotion() ? 0 : channelClock().index));
  useEffect(() => {
    if (now || prefersReducedMotion()) return;
    let timer = 0;
    const next = () => {
      const ms = Date.now();
      setChannel(channelClock(ms).index);
      // Woken just after the next change of channel, wherever in this one it is now.
      timer = window.setTimeout(next, CHANNEL_MS - (ms % CHANNEL_MS) + 5);
    };
    next();
    return () => window.clearTimeout(timer);
  }, [now]);
  // A channel with more than one aside says the next one each time round.
  const said = THINKING_ASIDES[CHANNELS[channel % CHANNELS.length]!];
  const aside = now ? '' : typeof said === 'string' ? said : said[Math.floor(channel / CHANNELS.length) % said.length]!;
  return (
    <p className="dc-companion-activity" data-running="true">
      <span className="dc-companion-spinner" aria-hidden="true" />
      {/* One run of text, so a long aside wraps under it rather than squeezing the label into a column. */}
      <span>
        <span className="dc-companion-activity-label">{now ?? 'Thinking'}</span>
        {aside && <span className="dc-companion-aside"> ({aside})</span>}
      </span>
    </p>
  );
}

/**
 * The way into the shapes a reply names that hold a diagram of their own: after an agent has drawn
 * the inside of a shape, or talked about one, the next step is often to go and look, and nothing on
 * the canvas says you can.
 */
function Doors({ reply }: { reply: string }) {
  const pointing = useContext(PointingContext);
  const named = partsIn(reply).filter((id) => pointing?.doors.has(id)).slice(0, 2);
  if (!pointing || named.length === 0) return null;
  return (
    <ul className="dc-companion-options" aria-label="Look inside">
      {named.map((id) => (
        <li key={id}>
          <button type="button" onClick={() => void lookInside(id)}>
            Take me inside {pointing.doors.get(id)}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** What the conversation has used so far, beside its links: the person's own plan or key pays for it,
 *  so they see it as it adds up. A dollar figure only with an API key, where it is what is billed. */
function SpentLine({ spent, showsCost }: { spent: Spent; showsCost: boolean }) {
  const { input, cached, output } = spent.usage;
  const fresh = tokenCount(newTokens(spent.usage));
  const cost = showsCost && spent.costMicroUsd !== null ? dollars(spent.costMicroUsd) : null;
  const turns = spent.turns === 1 ? '1 turn' : `${spent.turns} turns`;
  const rows = [
    ['New input', Math.max(0, input - cached).toLocaleString()],
    ['Cached input', cached.toLocaleString()],
    ['Output', output.toLocaleString()],
    ['New tokens', newTokens(spent.usage).toLocaleString()],
    ['All tokens', (input + output).toLocaleString()],
    ...(cost ? [['API cost', cost]] : []),
  ];
  const hint = 'New tokens are new input + output. Cached input is reused context; provider pricing and plan limits still apply.';
  return (
    <Tooltip
      showOnClick
      content={{ title: `Token usage · ${turns}`, description: rows.map(([label, value]) => `${label}: ${value}`).join('. '), usageHint: hint }}
      body={
        <dl className="dc-companion-token-breakdown">
          {rows.map(([label, value]) => (
            <div key={label} data-total={label === 'New tokens' ? 'true' : undefined}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      }
    >
      {(tip) => (
        <button type="button" className="dc-companion-link dc-companion-spent" aria-label={`Token usage: ${fresh} new tokens so far`} {...tip}>
          {fresh} new tokens so far{cost ? ` · ${cost}` : ''}
          <Icon name="info" />
        </button>
      )}
    </Tooltip>
  );
}

function lowerFirst(text: string): string {
  return text ? text[0]!.toLowerCase() + text.slice(1) : text;
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
  const { busy, checking, conflicts, dryRunProblem, error, alreadyApplied, recoveringAccept, bounds, targetsCurrentView } = review;
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
  const reveal = revealViewport(bounds, [tx, ty, zoom], { width: viewWidth - RESERVED_WIDTH, height: viewHeight });
  const show = () => {
    if (reveal) void setViewport(reveal, { duration: 320 });
  };
  // A change to another view of the diagram (inside a shape, or out of the one on screen) has no place
  // on this canvas: the chip offered Accept on a change nobody could see, and no way to it but Details.
  // Show me goes there; the change is framed once it is worked out in that view.
  const elsewhere = !targetsCurrentView;
  // Once, when the change is first worked out: it is what the person is waiting to see. After that the
  // camera is theirs, and Show me brings it back. Show me is offered only while the change is out of
  // view: offered always, it sat beside a change already on screen and did nothing.
  const framed = useRef(false);
  useEffect(() => {
    if (!bounds || framed.current) return;
    // Not under a drag or a label being typed, where the camera moved beneath the person's hands. Their
    // edit lands, the change is checked again and `bounds` comes back: framed then.
    if (isInteracting()) return;
    framed.current = true;
    show();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- framed once, on the first bounds
  }, [bounds]);
  if (proposal.status !== 'pending' && proposal.status !== 'accepting') return null;
  // An interrupted accept has the panel's fuller explanation and choices.
  const unusual = alreadyApplied || recoveringAccept;
  const problem = dryRunProblem ?? (conflicts.length > 0 ? 'Something this change is about has moved on since. Ask the agent to revise it.' : null);
  return (
    <ChipBox bounds={bounds} transform={[tx, ty, zoom]} view={{ width: viewWidth, height: viewHeight }}>
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
      {elsewhere && <p className="dc-companion-review-note">It’s in another view of this diagram.</p>}
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
              {(reveal || elsewhere) && (
                <button type="button" className="dc-companion-link" onClick={elsewhere ? () => void navigateToRoom(proposal.path) : show}>
                  Show me
                </button>
              )}
              <button type="button" className="dc-companion-link" onClick={onDetails}>
                Details
              </button>
            </span>
          </>
        )}
      </div>
    </ChipBox>
  );
}

/**
 * The chip's place, from how tall it is as drawn and where Nodi and Depth are: measured after each
 * draw, so a chip grown by its history or a problem stays on the canvas and clear of its chrome.
 */
function ChipBox({ bounds, transform, view, children }: { bounds: ReturnType<typeof useProposalReview>['bounds']; transform: [number, number, number]; view: { width: number; height: number }; children: ReactNode }) {
  const box = useRef<HTMLElement>(null);
  const [room, setRoom] = useState<{ height: number; keepOut: Box[] }>({ height: CHIP_HEIGHT, keepOut: [] });
  const measure = useCallback(() => {
    const chip = box.current;
    const parent = chip?.offsetParent;
    if (!chip || !parent) return;
    const base = parent.getBoundingClientRect();
    const keepOut = [...parent.querySelectorAll('.dc-companion, .dc-depth')]
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .map((rect) => ({ x: rect.left - base.left, y: rect.top - base.top, width: rect.width, height: rect.height }));
    const height = chip.offsetHeight || CHIP_HEIGHT;
    setRoom((now) =>
      now.height === height && JSON.stringify(now.keepOut) === JSON.stringify(keepOut) ? now : { height, keepOut },
    );
  }, []);
  // After every draw (cheap, and set only on a change), and whenever the chip or chrome resizes.
  useLayoutEffect(measure);
  useEffect(() => {
    const chip = box.current;
    if (!chip || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(chip);
    for (const chrome of chip.offsetParent?.querySelectorAll('.dc-companion, .dc-depth') ?? []) observer.observe(chrome);
    return () => observer.disconnect();
  }, [measure]);
  const place = chipPlace(bounds, transform, view, room.height, room.keepOut);
  return (
    <section ref={box} className="dc-companion-review" aria-label="Proposed change" style={{ left: place.left, top: place.top }} data-anchored={bounds ? 'true' : undefined} data-dc-keyboard-region="">
      {children}
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

/** `f_due_date-reminder2` → "due date reminder 2": an id's own words, short prefixes and all. */
function wordsOfId(id: string): string {
  const words = id
    .replace(/^[a-z]{1,2}_(?=.)/i, '')
    .replace(/([a-z])([A-Z0-9])/g, '$1 $2')
    .split(/[_\-\s.:]+/)
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return words.length > 1 ? words : 'that part';
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
  // Not a part Nodi knows (removed since, or a slip of the agent's): its id said as words, muted, the
  // nearest thing to what was meant. "Something not in this diagram" read as Nodi losing the plot.
  if (!pointing || !name) {
    return (
      <span className="dc-companion-part" data-missing="true" title="Not in this diagram any more">
        {wordsOfId(id)}
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
      {/* An earlier turn's chips light their part alone: its own numbers are not the pins on the
          canvas, and hovering one lit the latest reply's point of the same number. */}
      {inline(entry.text, pinned ? entry : null)}
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
