import { ALL_PRESETS, DEV_PRESETS, type Preset } from '../canvas/presets';
import { capabilityFor, categoryOf, edgeRelationLabel } from '../document/connectorSemantics';
import { relationLabel } from '../document/edgeSemantics';
import { createAttachment, defaultSizeFor, displayNameFor } from '../document/factory';
import { stepIndexOf } from '../document/flow';
import { LIMITS } from '../document/limits';
import { routingPlan } from '../edges/bundles';
import { boundsOf, descendantsOf } from '../document/operations';
import {
  CONNECTOR_KINDS,
  EDGE_SEMANTICS,
  TEXT_ROLES,
  type AttachableType,
  type ConnectorKind,
  type DraftEdge,
  type DraftNode,
  type ViewLevel,
} from '../document/types';
import { TEXT_ROLE_OPTION_LABELS } from '../ui/Editor/nodeKindLabels';
import { requestClipboardRead } from '../lib/clipboardPermission';
import { effectiveTextRole } from '../nodes/describe';
import { continuationsFor, materialize } from '../continuation';
import { MOD_SYMBOL } from '../lib/platform';
import { canCreateInside, hasInside, ownerAt, totals } from '../depth/tree';
import { backOut, lookInside } from '../ui/Editor/depthNavigation';
import { inheritedLevel, LEVEL_HINTS, LEVEL_LABELS } from '../depth/level';
import { fileOf, ownsData, viewLevel } from '../store/editorStore';
import { pointer } from '../store/uiStore';
import { focusBounds, focusNodes } from './search';
import { RECIPES } from '../learn/recipes';
import { ARCHITECTURE_STARTERS } from '../starters';
import type { StarterCategory } from '../starters';
import type { Command, CommandContext, CommandGroup, CommandOption, CommandStage } from './types';
import { count } from '../lib/plural';
import { indexFile, isEmpty, openCount, resolveTarget, takeawaysFor } from '../takeaways/collect';
import { takeawaysMarkdown } from '../takeaways/markdown';
import { CAPTURE_ACTION_KEY, captureAnchorFor, type CaptureSource } from '../takeaways/capture';

/**
 * The whole command catalog, derived fresh from context on every call. Nothing
 * here is registered ahead of time or kept in a store: `commandsFor` reads the selection, the
 * mode, and the document, and returns exactly the commands that make sense *right now*, in the
 * order they should list. Cheap (a few dozen entries), pure, and trivially testable.
 *
 * Every `run` is one call into an existing store action or hook — see `types.ts`.
 */

const PRESET_KEYWORDS: Record<string, string[]> = {
  text: ['label', 'caption', 'heading', 'annotation'],
  note: ['remark', 'question', 'warning', 'decision', 'sticky'],
  code: ['snippet', 'json', 'yaml', 'sql', 'log', 'config'],
  boundary: ['container', 'system', 'domain', 'network', 'deployment'],
  service: ['api', 'app', 'worker', 'microservice'],
  database: ['db', 'database', 'sql', 'store', 'cache', 'table'],
  queue: ['topic', 'stream', 'kafka', 'event bus', 'message'],
  actor: ['user', 'person', 'client', 'device'],
  ellipse: ['junction', 'branch', 'merge', 'circle'],
  // Deliberately no 'module'/'adapter' typed alone here — 'module' would compete with
  // Architecture Starters' own "Modular Monolith" alias ('modules') for the same query, and
  // "typing 'adapter' creates a Component *already set to* kind Adapter" would need `createAt`/
  // `createAtPointer` to thread a starting sub-kind through node creation, which nothing in the
  // app does today for any kind-bearing type (Service included) — out of scope for adding one new
  // node type. A user reaches Module/Adapter by adding a Component, then picking its kind in the
  // inspector, same as every other kind-bearing shape.
  component: ['building block', 'internal', 'logical component'],
};

function createCommand(preset: Preset): Command {
  return {
    id: `add-${preset.id}`,
    title: `Add ${preset.label}`,
    group: 'create',
    keywords: PRESET_KEYWORDS[preset.id],
    hint: preset.hint,
    shortcut: preset.shortcut,
    run: (ctx) => {
      const node = ctx.createAtPointer(preset);
      // Select what was just made, so "Add Service → Connect to…" chains without a mouse.
      if (node) ctx.editor.setSelection({ nodes: [node.id], edges: [] });
    },
  };
}

/** Same as `createCommand`, but places the new node at an explicit document coordinate instead of
 *  the tracked pointer — for a caller that already knows exactly where (the right-click menu's own
 *  click point), where `createAtPointer`'s tracked position would be stale by the time a menu item
 *  is actually clicked (the pointer has moved to hover the menu itself by then). */
export function createCommandAt(preset: Preset, position: { x: number; y: number }): Command {
  return {
    id: `add-${preset.id}`,
    title: `Add ${preset.label}`,
    group: 'create',
    keywords: PRESET_KEYWORDS[preset.id],
    hint: preset.hint,
    shortcut: preset.shortcut,
    run: (ctx) => {
      const node = ctx.createAt(preset, position);
      if (node) ctx.editor.setSelection({ nodes: [node.id], edges: [] });
    },
  };
}

/** The context-menu "Paste" — same underlying command as `canvasCommands`' pointer-tracked one,
 *  just landing at an explicit document coordinate (the right-click point, captured when the menu
 *  opened) with `exact: true` so it never inherits the ⌘V stagger meant for repeated same-spot
 *  pastes. Always offered: `ctx.editor.clipboard` only reflects a prior in-app copy/cut, not
 *  content the OS clipboard actually holds — that's only known after `requestClipboardRead`
 *  resolves, inside `run` — so gating the row on it here would hide Paste after a copy made
 *  outside the app. `paste()` itself already no-ops harmlessly if nothing comes back. */
export function pasteAtCommand(position: { x: number; y: number }): Command {
  return {
    id: 'paste',
    title: 'Paste',
    group: 'canvas',
    keywords: ['clipboard'],
    shortcut: `${MOD_SYMBOL} V`,
    run: (inner) => {
      void (async () => {
        await requestClipboardRead(inner.editor, inner.ui);
        inner.editor.paste(position, { exact: true });
      })();
    },
  };
}

/** `EditorScreen`'s own `onPresent`, not a second copy of it: starting a presentation has to mean
 *  the same thing from the palette as from the toolbar — the same framing, and the same memory of
 *  where the editing was left. */
function startPresentation(ctx: CommandContext) {
  ctx.onPresent();
}

function presentFlowStage(ctx: CommandContext): CommandStage {
  return {
    prompt: 'Present flow',
    // Only flows with something to show — see `useFlowPlayback`'s `flows`.
    options: ctx.playback.flows.map((flow) => ({
      id: `present-flow:${flow.id}`,
      title: flow.title,
      hint: count(flow.steps.length, 'step'),
      run: (inner) => inner.onPresent(flow.id),
    })),
  };
}

/** Jumping to another flow from inside a presentation — the palette's twin of the bar's own
 *  picker. Already presenting, so this is `pickFlow`, not a fresh `onPresent`: the camera the
 *  presenter will be put back into on the way out was captured when they started. */
function switchFlowStage(ctx: CommandContext): CommandStage {
  return {
    prompt: 'Switch flow',
    options: ctx.playback.flows.map((flow, index) => ({
      id: `switch-to-flow:${flow.id}`,
      title: flow.title,
      hint:
        flow.id === ctx.playback.flow?.id
          ? 'Current'
          : `Flow ${index + 1} · ${count(flow.steps.length, 'step')}`,
      run: (inner) => inner.playback.pickFlow(flow.id),
    })),
  };
}

/** What the palette offers while presenting: moving through the story, never rewriting it. */
function presentModeCommands(ctx: CommandContext): Command[] {
  const { playback } = ctx;
  const commands: Command[] = [];
  if (playback.active && playback.flow) {
    const last = playback.steps.length;
    commands.push(
      {
        id: 'step-next',
        title: 'Next step',
        group: 'flow',
        shortcut: '→',
        hint: playback.step < last ? `Step ${playback.step + 1} of ${last}` : 'At the end',
        run: (inner) => inner.playback.next(),
      },
      {
        id: 'step-previous',
        title: 'Previous step',
        group: 'flow',
        shortcut: '←',
        hint: playback.step > 1 ? `Step ${playback.step - 1} of ${last}` : 'At the start',
        run: (inner) => inner.playback.previous(),
      },
      {
        id: 'step-go-to',
        title: 'Go to step…',
        group: 'flow',
        keywords: ['jump', 'skip'],
        run: (inner) => ({
          prompt: 'Go to step',
          options: inner.playback.steps.map((step) => ({
            id: `step:${step.step}`,
            title: `${step.step}. ${step.caption ?? stepTitle(inner, step.edge?.id)}`,
            hint: step.step === inner.playback.step ? 'Current' : undefined,
            run: (deep) => deep.playback.goTo(step.step),
          })),
        }),
      },
    );
    // Moving between flows, offered *while* a flow is playing — the whole point being that a
    // question from the room doesn't have to end the presentation to be answered.
    if (playback.flows.length > 1) {
      const upcoming = playback.flows[playback.flowIndex + 1];
      const previous = playback.flowIndex > 0 ? playback.flows[playback.flowIndex - 1] : undefined;
      commands.push(
        {
          id: 'flow-next',
          title: 'Next flow',
          group: 'flow',
          shortcut: 'Shift →',
          keywords: ['switch', 'another', 'skip'],
          hint: upcoming ? `Next: ${upcoming.title}` : 'At the last flow',
          run: (inner) => inner.playback.nextFlow(),
        },
        {
          id: 'flow-previous',
          title: 'Previous flow',
          group: 'flow',
          shortcut: 'Shift ←',
          keywords: ['switch', 'back'],
          hint: previous ? `Back to: ${previous.title}` : 'At the first flow',
          run: (inner) => inner.playback.previousFlow(),
        },
        {
          id: 'flow-switch',
          title: 'Switch flow…',
          group: 'flow',
          shortcut: 'Shift F',
          keywords: ['jump', 'another', 'change', 'pick'],
          run: switchFlowStage,
        },
      );
    }
  } else if (playback.canStart) {
    commands.push({
      id: 'present-flow',
      title: 'Present a flow…',
      group: 'flow',
      keywords: ['walkthrough', 'play', 'story'],
      run: presentFlowStage,
    });
  }
  commands.push(
    {
      // The one capture path that matters most: somebody asks "can we verify this?" mid-flow, and
      // the step being presented is the context, worked out for you. Offered here as well as on
      // its bare key so it is discoverable without the walkthrough stopping.
      id: 'capture-action',
      title: 'Capture an action…',
      group: 'takeaways',
      keywords: ['todo', 'task', 'follow up', 'action item', 'next step', 'remember'],
      hint: anchorHintFor(ctx),
      shortcut: CAPTURE_ACTION_KEY,
      run: (inner) => inner.ui.setActionCaptureOpen(true),
    },
    {
      id: 'fit',
      title: 'Fit to view',
      group: 'view',
      keywords: ['zoom', 'center', 'all'],
      shortcut: 'Shift 1',
      run: (inner) => void inner.camera.fitView({ padding: 0.2, duration: 320 }),
    },
    {
      id: 'present-exit',
      title: 'Exit presentation',
      group: 'view',
      keywords: ['stop', 'edit', 'leave'],
      shortcut: `${MOD_SYMBOL} Enter`,
      run: (inner) => inner.editor.setMode('edit'),
    },
  );
  return commands;
}

function stepTitle(ctx: CommandContext, edgeId: string | undefined): string {
  if (!edgeId) return 'Frame';
  const edge = ctx.editor.document.edges.find((entry) => entry.id === edgeId);
  if (!edge) return 'Step';
  const names = new Map(ctx.editor.document.nodes.map((node) => [node.id, node]));
  const from = names.get(edge.source);
  const to = names.get(edge.target);
  const label = edge.label?.trim();
  return `${from ? displayNameFor(from) : '?'} → ${to ? displayNameFor(to) : '?'}${label ? ` · ${label}` : ''}`;
}


/** The live capture source: what is selected, or what the presentation step is about. */
export function captureSourceFrom(ctx: CommandContext): CaptureSource {
  const presenting = ctx.editor.mode === 'present';
  const current = ctx.playback.active ? ctx.playback.current : null;
  return {
    presenting,
    selection: ctx.editor.selection,
    stepEdgeId: current?.edge?.id,
    // A frame step holds up shapes rather than a connection; the first is the one it is about.
    stepNodeId: current?.extraNodes[0]?.id,
  };
}

/**
 * Takeaways — what the discussion produced.
 *
 * Three names for three store actions, like every other entry here. Capture is offered always:
 * it is the one thing in this group that has to be reachable before there is anything to review,
 * and an empty list is exactly when somebody needs to add the first thing to it. The other two
 * appear only once the canvas has something to show, which on an older diagram means the moment
 * it is opened — its decisions were already in the file.
 */
export function takeawaysCommands(ctx: CommandContext): Command[] {
  const commands: Command[] = [
    {
      id: 'capture-action',
      title: 'Capture an action…',
      group: 'takeaways',
      keywords: ['todo', 'task', 'follow up', 'action item', 'next step', 'assign', 'remember'],
      hint: anchorHintFor(ctx),
      shortcut: CAPTURE_ACTION_KEY,
      run: (inner) => inner.ui.setActionCaptureOpen(true),
    },
  ];

  const takeaways = takeawaysFor(fileOf(ctx.editor));
  if (isEmpty(takeaways)) return commands;

  const open = openCount(takeaways);
  commands.push({
    id: 'takeaways',
    title: 'Takeaways',
    group: 'takeaways',
    keywords: ['decisions', 'questions', 'actions', 'summary', 'outcome', 'review', 'meeting'],
    hint: open > 0 ? `${count(open, 'open action')}` : undefined,
    run: (inner) => inner.ui.setTakeawaysOpen(true, 'readout'),
  });
  commands.push({
    id: 'copy-takeaways',
    title: 'Copy takeaways',
    group: 'takeaways',
    keywords: ['markdown', 'clipboard', 'share', 'slack', 'teams', 'notes', 'minutes'],
    hint: 'As Markdown',
    run: (inner) => {
      const text = takeawaysMarkdown(takeawaysFor(fileOf(inner.editor)), inner.editor.document.metadata.title);
      if (!text) return;
      void inner.editor
        .copyText(text)
        .then((ok) => inner.ui.notify(ok ? 'Takeaways copied.' : 'The browser wouldn’t let us copy.'));
    },
  });
  return commands;
}

/** What the capture line would keep if it opened right now, said in words. */
function anchorHintFor(ctx: CommandContext): string | undefined {
  const anchor = captureAnchorFor(captureSourceFrom(ctx));
  if (!anchor) return undefined;
  const target = resolveTarget(indexFile(fileOf(ctx.editor)), anchor.kind, anchor.id);
  return target ? `From ${target.label}` : undefined;
}

function flowCommands(ctx: CommandContext): Command[] {
  const { flows } = ctx.editor.document;
  const commands: Command[] = [];
  if (flows.length > 0) {
    commands.push({
      id: 'present',
      title: 'Start presentation',
      group: 'flow',
      keywords: ['present', 'walkthrough', 'play', 'story', 'meeting'],
      shortcut: `${MOD_SYMBOL} Enter`,
      hint: flows.length === 1 ? flows[0]!.title : `${flows.length} flows`,
      run: startPresentation,
    });
    if (flows.length > 1) {
      commands.push({
        id: 'present-flow',
        title: 'Present flow…',
        group: 'flow',
        keywords: ['walkthrough', 'play'],
        run: presentFlowStage,
      });
    }
    commands.push({
      id: 'switch-flow',
      title: 'Switch to flow…',
      group: 'flow',
      keywords: ['lens', 'view', 'select flow'],
      run: (inner) => ({
        prompt: 'Switch to',
        options: [
          {
            id: 'switch-flow:diagram',
            title: 'Diagram',
            hint: inner.editor.selectedFlowId === null ? 'Current' : 'No flow lens',
            run: (deep) => deep.editor.setSelectedFlowId(null),
          },
          ...inner.editor.document.flows.map((flow) => ({
            id: `switch-flow:${flow.id}`,
            title: flow.title,
            hint:
              inner.editor.selectedFlowId === flow.id
                ? 'Current'
                : count(flow.steps.length, 'step'),
            run: (deep: CommandContext) => deep.editor.setSelectedFlowId(flow.id),
          })),
        ],
      }),
    });
  } else {
    commands.push({
      id: 'present',
      title: 'Start presentation',
      group: 'flow',
      keywords: ['present', 'walkthrough', 'play'],
      shortcut: `${MOD_SYMBOL} Enter`,
      hint: 'No flows yet — presents the diagram',
      run: startPresentation,
    });
  }
  // Not offered once the document holds `LIMITS.maxFlows` — `createFlow` would silently refuse.
  if (flowTotal(ctx) < LIMITS.maxFlows) {
    commands.push({
      id: 'flow-new',
      title: 'New flow',
      group: 'flow',
      keywords: ['create flow', 'story', 'path', 'walkthrough'],
      run: (inner) => {
        newFlow(inner);
      },
    });
  }
  commands.push(
    {
      id: 'flow-manage',
      title: 'Show flows',
      group: 'flow',
      keywords: ['manage', 'rename', 'reorder', 'steps', 'panel'],
      shortcut: 'F',
      run: (inner) => inner.ui.setFlowPanelOpen(true),
    },
  );
  return commands;
}

function viewCommands(ctx: CommandContext): Command[] {
  const commands: Command[] = [
    {
      id: 'fit',
      title: 'Fit to view',
      group: 'view',
      keywords: ['zoom', 'center', 'all', 'canvas'],
      shortcut: 'Shift 1',
      run: (inner) => void inner.camera.fitView({ padding: 0.2, duration: 320 }),
    },
    ...backOutCommands(ctx),
    {
      id: 'zoom-in',
      title: 'Zoom in',
      group: 'view',
      shortcut: `${MOD_SYMBOL} +`,
      run: (inner) => void inner.camera.zoomIn({ duration: 160 }),
    },
    {
      id: 'zoom-out',
      title: 'Zoom out',
      group: 'view',
      shortcut: `${MOD_SYMBOL} −`,
      run: (inner) => void inner.camera.zoomOut({ duration: 160 }),
    },
    {
      id: 'zoom-reset',
      title: 'Zoom to 100%',
      group: 'view',
      keywords: ['actual size', 'reset zoom'],
      shortcut: `${MOD_SYMBOL} 0`,
      run: (inner) => void inner.camera.zoomTo(1, { duration: 160 }),
    },
  ];
  if (ctx.editor.selection.nodes.length > 0) {
    commands.push({
      id: 'fit-selection',
      title: 'Fit selection',
      group: 'view',
      keywords: ['zoom to', 'center on', 'frame'],
      run: (inner) => focusNodes(inner, inner.editor.selection.nodes),
    });
  }
  if (ctx.editor.focus.active) {
    commands.push({
      id: 'focus-exit',
      title: 'Exit spotlight',
      group: 'view',
      keywords: ['focus', 'clear', 'unhighlight'],
      shortcut: 'Esc',
      run: (inner) => inner.editor.exitFocus(),
    });
  }
  commands.push({
    id: 'continuation-toggle',
    title: ctx.ui.continuationsEnabled ? 'Turn off Intent Continuation' : 'Turn on Intent Continuation',
    group: 'view',
    keywords: ['suggest', 'suggestion', 'ghost', 'next', 'continue', 'assist', 'autocomplete'],
    run: (inner) => inner.ui.setContinuationsEnabled(!inner.ui.continuationsEnabled),
  });
  return commands;
}

export function canvasCommands(ctx: CommandContext): Command[] {
  const commands: Command[] = [];
  if (ctx.editor.canUndo()) {
    commands.push({
      id: 'undo',
      title: 'Undo',
      group: 'canvas',
      shortcut: `${MOD_SYMBOL} Z`,
      run: (inner) => inner.editor.undo(),
    });
  }
  if (ctx.editor.canRedo()) {
    commands.push({
      id: 'redo',
      title: 'Redo',
      group: 'canvas',
      shortcut: `${MOD_SYMBOL} Shift Z`,
      run: (inner) => inner.editor.redo(),
    });
  }
  if (ctx.editor.document.edges.some((edge) => edge.routeMode)) {
    commands.push({
      id: 'tidy-connections',
      title: 'Tidy connectors',
      group: 'canvas',
      keywords: ['route', 'routing', 'clean up', 'arrange', 'straighten', 'smart'],
      hint: 'Re-route every connector automatically',
      run: (inner) => inner.editor.tidyConnections(),
    });
  }
  if (ctx.editor.document.nodes.length > 0) {
    commands.push({
      id: 'select-all',
      title: 'Select all',
      group: 'canvas',
      shortcut: `${MOD_SYMBOL} A`,
      run: (inner) =>
        inner.editor.setSelection({
          nodes: inner.editor.document.nodes.map((node) => node.id),
          edges: [],
        }),
    });
  }
  // Always offered — see `pasteAtCommand`'s doc comment: `editor.clipboard` alone can't tell
  // whether the OS clipboard actually holds something pasteable.
  commands.push({
    id: 'paste',
    title: 'Paste',
    group: 'canvas',
    keywords: ['clipboard'],
    shortcut: `${MOD_SYMBOL} V`,
    run: (inner) => {
      void (async () => {
        await requestClipboardRead(inner.editor, inner.ui);
        const target = pointer.known ? { x: pointer.x, y: pointer.y } : undefined;
        inner.editor.paste(target);
      })();
    },
  });
  commands.push(viewLevelCommand(ctx));
  commands.push(
    {
      id: 'export',
      title: 'Export…',
      group: 'canvas',
      keywords: ['png', 'svg', 'gif', 'download', 'save', 'share', 'image', 'sequence diagram', 'mermaid', 'plantuml', 'uml'],
      // ⌘⇧E leads because it always reaches the page: browser extensions (Claude's, among others)
      // claim a bare ⌘E before Draft Canvas ever sees it. ⌘E still works wherever it gets through.
      shortcut: `${MOD_SYMBOL} Shift E`,
      run: (inner) => inner.ui.setExportOpen(true),
    },
    {
      id: 'settings',
      title: 'Canvas settings…',
      group: 'canvas',
      keywords: ['background', 'personality', 'roughness', 'sketch', 'appearance', 'image', 'theme'],
      run: (inner) => inner.ui.setSettingsOpen(true),
    },
    {
      id: 'shortcuts',
      title: 'Keyboard shortcuts',
      group: 'canvas',
      keywords: ['help', 'keys', 'hotkeys'],
      shortcut: '?',
      run: (inner) => inner.ui.setShortcutsOpen(true),
    },
    {
      id: 'open-learn',
      title: 'Open Learn Draft Canvas',
      group: 'canvas',
      keywords: ['learn', 'help', 'docs', 'how', 'guide', 'handbook'],
      run: (inner) => inner.ui.openLearn(),
    },
    {
      id: 'about',
      title: 'About Draft Canvas',
      group: 'canvas',
      keywords: ['version', 'update', 'info'],
      run: (inner) => inner.ui.setAboutOpen(true),
    },
  );
  return commands;
}


/* ------------------------------------------------------------ selection -- */

const KIND_TITLES: Record<ConnectorKind, string> = {
  sync: 'Sync',
  async: 'Async',
  event: 'Event',
  callback: 'Callback',
  conditional: 'Conditional',
  retry: 'Retry',
  failure: 'Failure',
  fallback: 'Fallback',
};

const TYPE_CAPTIONS: Record<DraftNode['type'], string> = {
  text: 'Text',
  note: 'Note',
  code: 'Code',
  service: 'Service',
  database: 'Data store',
  queue: 'Queue',
  actor: 'Actor',
  component: 'Component',
  group: 'Boundary',
  ellipse: 'Junction',
};

function captionFor(node: DraftNode): string {
  return TYPE_CAPTIONS[node.type] ?? node.type;
}

/** Nodes worth offering as a connector endpoint — everything but boundaries and the node itself. */
function endpointCandidates(ctx: CommandContext, exclude: string[]): DraftNode[] {
  return ctx.editor.document.nodes.filter((node) => node.type !== 'group' && !exclude.includes(node.id));
}

function nodeOptions(nodes: DraftNode[], prefix: string, run: (node: DraftNode, ctx: CommandContext) => void): CommandOption[] {
  return nodes.map((node) => ({
    id: `${prefix}:${node.id}`,
    title: displayNameFor(node),
    hint: captionFor(node),
    run: (ctx) => run(node, ctx),
  }));
}

/** How far to the right of its source a "Connect to → New …" node lands. A UX choice, not a rule. */
const NEW_NEIGHBOUR_GAP = 120;

function connectToStage(ctx: CommandContext, source: DraftNode): CommandStage {
  const existing = nodeOptions(endpointCandidates(ctx, [source.id]), 'connect', (target, inner) => {
    const edge = inner.editor.connect(source.id, target.id);
    if (edge) inner.editor.setSelection({ nodes: [], edges: [edge.id] });
  });
  const fresh: CommandOption[] = DEV_PRESETS.filter((preset) => preset.id !== 'ellipse').map((preset) => ({
    id: `connect-new:${preset.id}`,
    title: `New ${preset.label}`,
    keywords: PRESET_KEYWORDS[preset.id],
    hint: 'Create and connect',
    run: (inner) => {
      const size = defaultSizeFor(preset.type);
      // One gesture, one undo step — the same as Quick Connect — not an orphan left behind by ⌘Z.
      inner.editor.beginInteraction(`Add and connect ${preset.label}`);
      try {
        const created = inner.createAt(
          preset,
          {
            x: Math.round(source.x + source.width + NEW_NEIGHBOUR_GAP),
            y: Math.round(source.y + source.height / 2 - size.height / 2),
          },
          // Only reachable via ⌘K/Shift+F10 on a selected node — never a mouse gesture — so this
          // opens ready to name, same as every other keyboard-driven creation path.
          true,
        );
        if (!created) return;
        inner.editor.connect(source.id, created.id);
        inner.editor.setSelection({ nodes: [created.id], edges: [] });
      } finally {
        inner.editor.endInteraction();
      }
    },
  }));
  return { prompt: 'Connect to', options: [...existing, ...fresh] };
}

/**
 * The one way a flow comes into being from a command: created, made the active flow, and handed
 * to the panel to be named right away (`requestFlowRename`) — naming is part of creating, not a
 * separate "manage" errand. Returns the id, or `null` at the flow cap (nothing happens then).
 */
function newFlow(ctx: CommandContext): string | null {
  const flowId = ctx.editor.createFlow();
  if (!flowId) return null;
  ctx.editor.setSelectedFlowId(flowId);
  ctx.ui.setFlowPanelOpen(true);
  ctx.ui.requestFlowRename(flowId);
  return flowId;
}

function startFlowWith(ctx: CommandContext, edge: DraftEdge) {
  const flowId = newFlow(ctx);
  if (!flowId) return;
  ctx.editor.addEdgeToFlow(flowId, edge.id);
  ctx.editor.setSelection({ nodes: [], edges: [edge.id] });
}

function edgeTitle(ctx: CommandContext, edge: DraftEdge): string {
  const nodes = ctx.editor.document.nodes;
  const from = nodes.find((node) => node.id === edge.source);
  const to = nodes.find((node) => node.id === edge.target);
  return `${from ? displayNameFor(from) : '?'} → ${to ? displayNameFor(to) : '?'}`;
}

function bringToFrontCommand(): Command {
  return {
    id: 'bring-to-front',
    title: 'Bring to front',
    group: 'selection',
    keywords: ['raise', 'z-order', 'top'],
    run: (inner) => inner.editor.raise(true),
  };
}

function sendToBackCommand(): Command {
  return {
    id: 'send-to-back',
    title: 'Send to back',
    group: 'selection',
    keywords: ['lower', 'z-order', 'bottom'],
    run: (inner) => inner.editor.lower(true),
  };
}

/** One step at a time, unlike `bringToFrontCommand`/`sendToBackCommand` — the store's `raise`/
 *  `lower` already support both (`toFront`/`toBack` default `false`); no UI surface called the
 *  single-step form until now. */
function bringForwardCommand(): Command {
  return {
    id: 'bring-forward',
    title: 'Bring forward',
    group: 'selection',
    keywords: ['raise', 'z-order'],
    run: (inner) => inner.editor.raise(false),
  };
}

function sendBackwardCommand(): Command {
  return {
    id: 'send-backward',
    title: 'Send backward',
    group: 'selection',
    keywords: ['lower', 'z-order'],
    run: (inner) => inner.editor.lower(false),
  };
}

function copyCommand(): Command {
  return {
    id: 'copy',
    title: 'Copy',
    group: 'selection',
    keywords: ['clipboard'],
    shortcut: `${MOD_SYMBOL} C`,
    run: (inner) => void inner.editor.copySelection(),
  };
}

function cutCommand(): Command {
  return {
    id: 'cut',
    title: 'Cut',
    group: 'selection',
    keywords: ['clipboard', 'remove'],
    shortcut: `${MOD_SYMBOL} X`,
    run: (inner) => void inner.editor.cutSelection(),
  };
}

/** "Add Note"/"Add Code" on a node's own menu — creates a brand-new, empty attachment directly
 *  (`attachToNode`/`createAttachment` already existed with zero UI call sites; every attachment
 *  before this was created by dragging an existing standalone Note/Code node onto a host and
 *  folding it in). Opens the new attachment's card immediately (pinned via `openAttachmentDetail`,
 *  same as clicking its chip) instead of leaving the user to go find and click the new chip
 *  themselves. Deliberately does not also force `AttachmentPresentation.tsx`'s own local `editing`
 *  state open — that pin→edit split is that component's own established, tested safety behavior
 *  (view before you commit to editing), and reaching past its public interface to bypass it for
 *  this one entry point would be a bigger change than this menu warrants; one more click (the
 *  card's own pencil icon) reaches the textarea. Id is `attach-*`, not `add-*` — `add-note`/
 *  `add-code` are already taken by the "create a standalone Note/Code node" preset commands, and
 *  sharing an id would corrupt `commands/history.ts`'s by-id "Recent" lookup in the palette (two
 *  different commands silently shadowing each other under one key). */
function addAttachmentCommand(
  host: { hostKind: 'node'; node: DraftNode } | { hostKind: 'edge'; edge: DraftEdge },
  type: AttachableType,
  group: CommandGroup,
): Command {
  const hostId = host.hostKind === 'node' ? host.node.id : host.edge.id;
  return {
    id: `attach-${type}`,
    title: type === 'note' ? 'Add Note' : 'Add Code',
    group,
    keywords: ['attach', 'context', 'detail'],
    run: (inner) => {
      const attachment = createAttachment({ type });
      if (host.hostKind === 'node') inner.editor.attachToNode(hostId, attachment);
      else inner.editor.attachToEdge(hostId, attachment);
      inner.ui.setOpenAttachmentDetail({ hostKind: host.hostKind, hostId, attachmentId: attachment.id });
    },
  };
}

/**
 * The keyboard-free, hover-free path to Intent Continuation's current offer for this node — the
 * same accept Tab and a click on the ghost perform. Prefers the offer already on screen (same ids,
 * same placement); otherwise asks the engine directly, so ⌘K still offers it when there was no
 * room to draw a ghost.
 */
function continuationCommandFor(ctx: CommandContext, node: DraftNode): Command | undefined {
  if (!ctx.ui.continuationsEnabled) return undefined;
  const shown = ctx.ui.continuation;
  const offer =
    shown && shown.anchorId === node.id && shown.trigger === 'select'
      ? shown
      : (() => {
          const [first] = continuationsFor(ctx.editor.document, node.id, 'select', {
            dismissed: ctx.ui.continuationDismissals,
            recent: ctx.ui.continuationRecent,
            level: viewLevel(ctx.editor),
          });
          return first ? materialize(ctx.editor.document, first) : undefined;
        })();
  if (!offer) return undefined;
  return {
    id: 'accept-continuation',
    title: offer.actionLabel,
    group: 'selection',
    keywords: ['suggested', 'continue', 'next', 'ghost', offer.label.toLowerCase()],
    hint: 'Suggested',
    shortcut: 'Tab',
    run: (inner) => inner.editor.acceptContinuation(offer),
  };
}

/** A Queue-family node's own shape-native quick actions — Add Consumer, Add DLQ/Remove DLQ, and
 *  (for a Topic) Add Subscriber — computed once here and reused by both the full `nodeCommands`
 *  list and `primaryCommandsFor`'s fast path for the primary popover, so there is exactly one
 *  place that decides what a queue/topic/stream node can do; neither surface can drift from the
 *  other. Caller must already know `node.type === 'queue'`. */
function queueQuickCommands(ctx: CommandContext, node: DraftNode): Command[] {
  const commands: Command[] = [];
  const category = categoryOf(node);
  // Consuming from it is universally valid for a plain Queue, a Stream (`categoryOf` already
  // folds `queueKind: 'stream'` in) or a DLQ (a re-drive worker reads a dead-letter queue like
  // any other) but not for a Topic: a fan-out subscriber is a different relationship, offered
  // below instead.
  if (category === 'queue' || category === 'deadLetter') {
    commands.push({
      id: 'add-consumer',
      title: 'Add Consumer',
      group: 'selection',
      keywords: ['worker', 'subscriber', 'consume'],
      primary: true,
      run: (inner) => inner.editor.addConsumer(node.id),
    });
  }
  // A DLQ belongs only to a plain Queue — deliberately the literal `queueKind === 'queue'`, not
  // `categoryOf`, since a Stream's own dead-letter destination is typically a separate topic
  // managed by a consumer/framework, not a queue-shaped DLQ (and a Topic's failure handling
  // belongs to a subscription/consumer path Draft Canvas doesn't model yet) — and never on a
  // node that is itself already a generated DLQ.
  if (node.queueKind === 'queue' && node.deliveryRole !== 'dead-letter') {
    const hasDlq = ctx.editor.document.edges.some((edge) => edge.source === node.id && edge.semantic === 'deadLetters');
    commands.push(
      hasDlq
        ? {
            id: 'remove-dead-letter-queue',
            title: 'Remove DLQ',
            group: 'selection',
            keywords: ['dlq', 'dead letter', 'failure', 'reliability'],
            primary: true,
            run: (inner) => inner.editor.removeDeadLetterQueue(node.id),
          }
        : {
            id: 'add-dead-letter-queue',
            title: 'Add DLQ',
            group: 'selection',
            keywords: ['dlq', 'dead letter', 'failure', 'reliability'],
            primary: true,
            run: (inner) => inner.editor.addDeadLetterQueue(node.id),
          },
    );
  }
  // A Topic's own fan-out companion. Repeatable — a topic fanning out to several queues is
  // normal — so there's no "Remove Subscriber" counterpart; the created queue deletes like any
  // other node.
  if (category === 'topic') {
    commands.push({
      id: 'add-subscriber',
      title: 'Add Subscriber',
      group: 'selection',
      keywords: ['queue', 'fan out', 'subscribe'],
      primary: true,
      run: (inner) => inner.editor.addSubscriber(node.id),
    });
  }
  return commands;
}

/** A Service's own shape-native quick actions — "Add Data Store" for a service kind that owns
 *  data, "Add Service" (a routed target) for a Gateway — computed once here and reused by both
 *  `nodeCommands` and `primaryCommandsFor`, the same single-source discipline as
 *  `queueQuickCommands`. An External System and a Scheduler are left alone: the natural
 *  continuation for those isn't a companion this command could name honestly. */
/**
 * "View level" — what this view is showing, said out loud.
 *
 * The one place a level is ever written down by hand, and deliberately a plain choice rather than
 * anything Draft Canvas decides for itself. It matters because a level narrows what gets
 * suggested here (see `src/continuation/`), and nothing should narrow anything on a guess the
 * user never made and cannot see.
 */
function viewLevelCommand(ctx: CommandContext): Command {
  const stored = ctx.editor.document.level;
  const effective = viewLevel(ctx.editor);
  // Clearing a room's own level would hand it the one outside again, so under a known level
  // "nothing in particular" has to be said out loud.
  const inherited = inheritedLevel(fileOf(ctx.editor), ctx.editor.path);
  return {
    id: 'view-level',
    title: 'View level…',
    group: 'canvas',
    keywords: ['c4', 'context', 'container', 'component', 'abstraction', 'altitude', 'zoom level'],
    hint: effective && effective !== 'none' ? LEVEL_LABELS[effective] : 'Not set',
    run: () => ({
      prompt: 'This view shows',
      options: [
        ...(['context', 'container', 'component'] as const).map((level) => ({
          id: `view-level:${level}`,
          title: LEVEL_LABELS[level],
          hint: effective === level ? 'Current' : LEVEL_HINTS[level],
          run: (inner: CommandContext) => inner.editor.setViewLevel(level),
        })),
        {
          id: 'view-level:none',
          title: 'Nothing in particular',
          hint: 'Just a drawing — no suggestions narrowed',
          run: (inner: CommandContext) =>
            inner.editor.setViewLevel(stored === undefined || inherited !== undefined ? 'none' : undefined),
        },
      ],
    }),
  };
}

/**
 * The way back out, one room at a time, plus a direct jump to the canvas itself once you are more
 * than one room deep. Nothing at all at the top, where there is nowhere to go.
 */
function backOutCommands(ctx: CommandContext): Command[] {
  const { path } = ctx.editor;
  if (path.length === 0) return [];
  const parentName = path.length > 1 ? nameOfOwner(ctx, path.slice(0, -1)) : undefined;
  const commands: Command[] = [
    {
      id: 'back-out',
      title: 'Back out',
      group: 'view',
      keywords: ['outside', 'up', 'leave', 'out', 'parent', 'exit inside'],
      hint: parentName ? `Back to ${parentName}` : 'Back to the whole canvas',
      shortcut: `${MOD_SYMBOL} ↑`,
      run: () => void backOut(),
    },
  ];
  if (path.length > 1) {
    commands.push({
      id: 'back-out-all',
      title: 'Back to the whole canvas',
      group: 'view',
      keywords: ['outside', 'top', 'root', 'overview'],
      run: () => void backOut(0),
    });
  }
  return commands;
}

/** Flows across the whole file, since that is what the cap counts. */
function flowTotal(ctx: CommandContext): number {
  return totals(fileOf(ctx.editor)).flows;
}

/** What the shape owning the room at `path` is called — for a hint, so a fallback is fine. */
function nameOfOwner(ctx: CommandContext, path: readonly string[]): string {
  const owner = ownerAt(fileOf(ctx.editor), path);
  return owner ? displayNameFor(owner) : 'the canvas';
}

/**
 * "Look inside" — the way into a shape's own architecture.
 *
 * Deliberately the same wording whether or not there is anything in there yet: stepping into an
 * empty shape writes nothing, so the difference between "has an inside" and "could have one" is
 * something the canvas shows (a shape with contents stands in front of a faint plane), not a
 * different action to choose between.
 */
/** Whether stepping into `node` from where you stand can succeed — not at the deepest a canvas goes. */
function canLookInside(ctx: CommandContext, node: DraftNode): boolean {
  if (ctx.editor.path.length >= LIMITS.maxInsideDepth) return false;
  return hasInside(node) || canCreateInside(node);
}

function lookInsideCommand(node: DraftNode): Command {
  return {
    id: 'look-inside',
    title: 'Look inside',
    group: 'selection',
    keywords: ['inside', 'internals', 'deeper', 'contains', 'drill down', 'zoom in', 'c4', 'container', 'component'],
    hint: hasInside(node) ? `What runs inside ${displayNameFor(node)}` : `Draw what runs inside ${displayNameFor(node)}`,
    primary: hasInside(node),
    shortcut: `${MOD_SYMBOL} ↓`,
    run: () => void lookInside(node.id),
  };
}

function serviceQuickCommands(node: DraftNode, level?: ViewLevel): Command[] {
  const commands: Command[] = [];
  // What a system keeps its data in is true, and a level down from a view that has said it is a
  // system overview — the same reason `SERVICE_NEXT`'s data rows go quiet there. Offering it as
  // the shape's *first* action is the loudest way to pull a picture of a business out of altitude.
  if (ownsData(node) && level !== 'context') {
    commands.push({
      // Titled for the relationship it draws, never "Add Data Store" — that is the creation
      // command's own title, and an identical title would take the palette's "data store" query
      // away from it whenever a service happens to be selected.
      id: 'add-data-store',
      title: 'Connect Data Store',
      group: 'selection',
      keywords: ['database', 'db', 'storage', 'writes', 'persist'],
      primary: true,
      run: (inner) => inner.editor.addDataStore(node.id),
    });
  }
  if (categoryOf(node) === 'gateway') {
    commands.push({
      id: 'add-routed-service',
      title: 'Route to Service',
      group: 'selection',
      keywords: ['route', 'routes', 'downstream', 'target'],
      primary: true,
      run: (inner) => inner.editor.addRoutedService(node.id),
    });
  }
  return commands;
}

/** A Boundary's own structural action — reused by both `nodeCommands` (single-node selection) and
 *  `primaryCommandsFor`. Multi-selection's own "Ungroup" (`multiCommands`) is a separate command
 *  object, since it acts over the whole selection rather than one specific node. */
function boundaryUngroupCommand(): Command {
  return {
    id: 'ungroup',
    title: 'Ungroup',
    group: 'selection',
    keywords: ['dissolve boundary', 'remove group'],
    shortcut: `${MOD_SYMBOL} Shift G`,
    primary: true,
    run: (inner) => inner.editor.ungroupSelection(),
  };
}

/** The 0-3 shape-native actions worth surfacing in the primary popover for a single selected
 *  node — the same commands `nodeCommands` would include (same ids, same `run`), just computed
 *  directly instead of building the full palette/context-menu list (continuation suggestions,
 *  `connectToStage`, attachments, z-order, …) only to filter it down. Cheap enough to call on
 *  every render; callers should still memoize on the node fields that can change the result
 *  (`type`, `queueKind`, `deliveryRole`, and whether a `deadLetters` edge exists) rather than on
 *  node position, so dragging a node doesn't recompute this every animation frame. */
export function primaryCommandsFor(ctx: CommandContext, node: DraftNode): Command[] {
  // Offered first wherever it applies: once a shape has architecture inside it, going in is the
  // likeliest thing anyone wants from it. A shape that merely *could* hold one still gets the
  // action, just after whatever else it offers — nothing about it says "fill me in".
  const inside = canLookInside(ctx, node) ? [lookInsideCommand(node)] : [];
  if (node.type === 'queue') return [...inside, ...queueQuickCommands(ctx, node)];
  if (node.type === 'service') {
    const quick = serviceQuickCommands(node, viewLevel(ctx.editor));
    return hasInside(node) ? [...inside, ...quick] : [...quick, ...inside];
  }
  if (node.type === 'group') return [boundaryUngroupCommand()];
  return inside;
}

export function nodeCommands(ctx: CommandContext, node: DraftNode): Command[] {
  const commands: Command[] = [];
  const isBoundary = node.type === 'group';
  const suggested = continuationCommandFor(ctx, node);
  if (suggested) commands.push(suggested);
  if (!isBoundary) {
    commands.push({
      id: 'connect-to',
      title: 'Connect to…',
      group: 'selection',
      keywords: ['link', 'edge', 'arrow', 'wire', 'draw connection'],
      hint: displayNameFor(node),
      run: (inner) => connectToStage(inner, node),
    });
  }
  commands.push({
    id: 'edit-text',
    title: isBoundary ? 'Edit caption' : 'Edit text',
    group: 'selection',
    keywords: ['rename', 'label', 'name'],
    shortcut: 'Enter',
    run: (inner) => inner.ui.requestEdit(node.id),
  });
  if (node.type === 'text') {
    const currentRole = effectiveTextRole(node);
    commands.push(
      {
        id: 'text-role',
        title: 'Text role…',
        group: 'selection',
        keywords: ['body', 'label', 'heading', 'title', 'technical', 'style', 'hierarchy'],
        hint: TEXT_ROLE_OPTION_LABELS[currentRole],
        run: () => ({
          prompt: 'Text role',
          options: TEXT_ROLES.map((role) => ({
            id: `text-role:${role}`,
            title: TEXT_ROLE_OPTION_LABELS[role],
            hint: role === currentRole ? 'Current' : undefined,
            run: (inner: CommandContext) =>
              inner.editor.updateNodeById(node.id, { textRole: role }, 'Change text role'),
          })),
        }),
      },
      {
        id: 'text-toggle-bold',
        title: node.textBold ? 'Remove bold' : 'Bold',
        group: 'selection',
        keywords: ['emphasis', 'weight', 'strong'],
        shortcut: `${MOD_SYMBOL} B`,
        run: (inner) => inner.editor.updateNodeById(node.id, { textBold: !node.textBold }, 'Toggle bold'),
      },
      {
        id: 'text-toggle-italic',
        title: node.textItalic ? 'Remove italic' : 'Italic',
        group: 'selection',
        keywords: ['emphasis', 'oblique', 'slant'],
        shortcut: `${MOD_SYMBOL} I`,
        run: (inner) => inner.editor.updateNodeById(node.id, { textItalic: !node.textItalic }, 'Toggle italic'),
      },
    );
  }
  const outgoing = ctx.editor.document.edges.filter((edge) => edge.source === node.id);
  if (outgoing.length > 0) {
    commands.push({
      id: 'flow-start-here',
      title: 'Start flow here',
      group: 'selection',
      keywords: ['new flow', 'story', 'walkthrough', 'begin'],
      hint:
        outgoing.length === 1
          ? `${displayNameFor(node)} → ${edgeTitle(ctx, outgoing[0]!).split(' → ')[1]}`
          : `${outgoing.length} outgoing connectors`,
      run: (inner) => {
        if (outgoing.length === 1) {
          startFlowWith(inner, outgoing[0]!);
          return;
        }
        return {
          prompt: 'Start flow with',
          options: outgoing.map((edge) => ({
            id: `flow-start:${edge.id}`,
            title: edgeTitle(inner, edge),
            hint: edge.label?.trim() || undefined,
            run: (deep) => startFlowWith(deep, edge),
          })),
        };
      },
    });
  }
  if (canLookInside(ctx, node)) {
    commands.push(lookInsideCommand(node));
  }
  const attachmentCount = node.attachments?.length ?? 0;
  if (attachmentCount < LIMITS.maxAttachmentsPerNode) {
    commands.push(
      addAttachmentCommand({ hostKind: 'node', node }, 'note', 'selection'),
      addAttachmentCommand({ hostKind: 'node', node }, 'code', 'selection'),
    );
  }
  if (node.type === 'queue') {
    commands.push(...queueQuickCommands(ctx, node));
  }
  if (node.type === 'service') {
    commands.push(...serviceQuickCommands(node));
  }
  commands.push(
    {
      id: 'spotlight',
      title: 'Spotlight selection',
      group: 'selection',
      keywords: ['focus', 'highlight', 'dim others'],
      run: (inner) => inner.editor.enterFocus([node.id], []),
    },
    {
      id: 'duplicate',
      title: 'Duplicate',
      group: 'selection',
      keywords: ['copy', 'clone'],
      shortcut: `${MOD_SYMBOL} D`,
      run: (inner) => inner.editor.duplicateSelection(),
    },
    copyCommand(),
    cutCommand(),
    bringToFrontCommand(),
    bringForwardCommand(),
    sendBackwardCommand(),
    sendToBackCommand(),
  );
  if (isBoundary) {
    const descendantIds = descendantsOf(ctx.editor.document, node.id);
    if (descendantIds.length > 0) {
      const descendantSet = new Set(descendantIds);
      commands.push({
        id: 'select-contents',
        title: 'Select Contents',
        group: 'selection',
        keywords: ['children', 'members', 'inside'],
        hint: count(descendantIds.length, 'element'),
        run: (inner) => {
          const edgeIds = inner.editor.document.edges
            .filter((edge) => descendantSet.has(edge.source) && descendantSet.has(edge.target))
            .map((edge) => edge.id);
          inner.editor.setSelection({ nodes: descendantIds, edges: edgeIds });
        },
      });
    }
    commands.push(boundaryUngroupCommand());
  }
  commands.push(deleteCommand('Delete'));
  return commands;
}

function deleteCommand(title: string): Command {
  return {
    id: 'delete',
    title,
    group: 'selection',
    keywords: ['remove', 'trash'],
    shortcut: 'Backspace',
    run: (inner) => inner.editor.deleteSelection(),
  };
}

/** Whether this connector is currently drawn through a shared routing trunk —
 *  the one situation where "Convert to junction" has something to convert. */
function isBundled(ctx: CommandContext, edge: DraftEdge): boolean {
  return routingPlan(ctx.editor.document.nodes, ctx.editor.document.edges).spineFor(edge.id) !== undefined;
}

export function edgeCommands(ctx: CommandContext, edge: DraftEdge): Command[] {
  const doc = ctx.editor.document;
  const semanticTitle = edgeRelationLabel(doc, edge) ?? 'Plain';
  // What this pairing usually means leads the list, in the arrow's own wording; every other
  // relationship follows, so nothing unusual is ever out of reach.
  const sourceNode = doc.nodes.find((n) => n.id === edge.source);
  const targetNode = doc.nodes.find((n) => n.id === edge.target);
  const sourceCategory = sourceNode && categoryOf(sourceNode);
  const targetCategory = targetNode && categoryOf(targetNode);
  const suggested = sourceCategory && targetCategory ? (capabilityFor(sourceCategory, targetCategory)?.relations ?? []) : [];
  const orderedSemantics = [...suggested, ...EDGE_SEMANTICS.filter((semantic) => !suggested.includes(semantic))];
  // `stepIndexOf`, not a primary-`edgeId` scan: a connector that is only an *extra* member of a
  // step is still in that flow, and offering to add it again would be a silent no-op.
  const flowsContaining = ctx.editor.document.flows.filter((flow) => stepIndexOf(flow, edge.id) !== undefined);
  // A flow already at `LIMITS.maxStepsPerFlow` can't take the connector; listing it would switch the
  // lens to a flow that silently didn't change.
  const flowsAvailable = ctx.editor.document.flows.filter(
    (flow) => !flowsContaining.includes(flow) && flow.steps.length < LIMITS.maxStepsPerFlow,
  );
  const canStartFlow = flowTotal(ctx) < LIMITS.maxFlows;
  const commands: Command[] = [
    {
      id: 'edge-semantic',
      title: 'Change relationship…',
      group: 'connector',
      keywords: ['semantic', 'http', 'event', 'reads', 'writes', 'publishes', 'consumes', 'calls', 'implements', 'implemented by', 'compensates', 'compensation', 'saga', 'transforms', 'refine', 'etl', 'meaning', 'type'],
      hint: semanticTitle,
      run: () => ({
        prompt: 'Relationship',
        options: [
          ...orderedSemantics.map((semantic) => ({
            id: `edge-semantic:${semantic}`,
            title: relationLabel(semantic, sourceCategory, targetCategory),
            hint: edge.semantic === semantic ? 'Current' : undefined,
            run: (inner: CommandContext) => inner.editor.setEdgeSemantic(edge.id, semantic),
          })),
          {
            id: 'edge-semantic:none',
            title: 'None',
            hint: edge.semantic ? 'Clear the relationship' : 'Current',
            run: (inner) => inner.editor.setEdgeSemantic(edge.id, undefined),
          },
        ],
      }),
    },
    // A saga's undo for this step: the one second connector between a pair a drag won't draw.
    ...(edge.semantic !== 'compensates' && suggested.includes('compensates')
      ? [
          {
            id: 'edge-add-compensation',
            title: 'Add compensation',
            group: 'connector',
            keywords: ['compensate', 'compensates', 'saga', 'undo', 'rollback', 'release'],
            run: (inner: CommandContext) => inner.editor.addCompensation(edge.id),
          } satisfies Command,
        ]
      : []),
    {
      id: 'edge-kind',
      title: 'Change kind…',
      group: 'connector',
      keywords: ['behaviour', 'behavior', 'sync', 'async', 'callback', 'retry', 'failure', 'fallback', 'conditional', 'line style'],
      hint: edge.kind ? KIND_TITLES[edge.kind] : 'Plain',
      run: () => ({
        prompt: 'Kind',
        options: [
          ...CONNECTOR_KINDS.map((kind) => ({
            id: `edge-kind:${kind}`,
            title: KIND_TITLES[kind],
            hint: edge.kind === kind ? 'Current' : undefined,
            run: (inner: CommandContext) => inner.editor.setEdgeKind(edge.id, kind),
          })),
          {
            id: 'edge-kind:none',
            title: 'None',
            hint: edge.kind ? 'Clear the kind' : 'Current',
            run: (inner) => inner.editor.setEdgeKind(edge.id, undefined),
          },
        ],
      }),
    },
    {
      id: 'edge-async',
      title: edge.async ? 'Make synchronous' : 'Make asynchronous',
      group: 'connector',
      keywords: ['async', 'sync', 'dashed', 'solid', 'toggle'],
      hint: edge.async ? 'Solid line' : 'Dashed line',
      run: (inner) => inner.editor.toggleEdgeAsync(edge.id),
    },
    {
      id: 'edge-response',
      title: edge.hasResponse ? 'Remove response line' : 'Add response line',
      group: 'connector',
      keywords: ['reply', 'return', 'request response', '200'],
      run: (inner) => inner.editor.setEdgeHasResponse(edge.id, !edge.hasResponse),
    },
    {
      id: 'edge-route-direct',
      title: edge.routeMode === 'direct' ? 'Use smart routing' : 'Use direct routing',
      group: 'connector',
      keywords: ['route', 'routing', 'bundle', 'trunk', 'straighten', 'manual', 'auto'],
      hint: edge.routeMode === 'direct' ? 'Let the router bundle this again' : 'Route this one on its own',
      run: (inner) => inner.editor.setEdgeRouteMode(edge.id, edge.routeMode === 'direct' ? undefined : 'direct'),
    },
    {
      id: 'edge-reverse',
      title: 'Reverse direction',
      group: 'connector',
      keywords: ['flip', 'swap', 'invert', 'arrow'],
      hint: edgeTitle(ctx, edge),
      run: (inner) => inner.editor.reverseEdge(edge.id),
    },
    {
      id: 'edge-reconnect-source',
      title: 'Reconnect source…',
      group: 'connector',
      keywords: ['move start', 'from', 'origin', 'retarget'],
      run: (inner) => ({
        prompt: 'Source',
        options: nodeOptions(endpointCandidates(inner, [edge.source, edge.target]), 'reconnect-source', (node, deep) =>
          deep.editor.reconnectEdge(edge.id, 'source', node.id, undefined),
        ),
      }),
    },
    {
      id: 'edge-reconnect-target',
      title: 'Reconnect target…',
      group: 'connector',
      keywords: ['move end', 'to', 'destination', 'retarget'],
      run: (inner) => ({
        prompt: 'Target',
        options: nodeOptions(endpointCandidates(inner, [edge.source, edge.target]), 'reconnect-target', (node, deep) =>
          deep.editor.reconnectEdge(edge.id, 'target', node.id, undefined),
        ),
      }),
    },
    {
      id: 'edge-add-to-flow',
      title: 'Add to flow…',
      group: 'connector',
      keywords: ['step', 'story', 'walkthrough', 'sequence'],
      hint: flowsContaining.length > 0 ? `In ${flowsContaining.map((flow) => flow.title).join(', ')}` : undefined,
      run: () => ({
        prompt: 'Add to flow',
        options: [
          ...flowsAvailable.map((flow) => ({
            id: `edge-add-to-flow:${flow.id}`,
            title: flow.title,
            hint: count(flow.steps.length, 'step'),
            run: (deep: CommandContext) => {
              deep.editor.addEdgeToFlow(flow.id, edge.id);
              deep.editor.setSelectedFlowId(flow.id);
            },
          })),
          ...(canStartFlow
            ? [
                {
                  id: 'edge-add-to-flow:new',
                  title: 'New flow',
                  hint: 'Starts a flow with this connector',
                  run: (deep: CommandContext) => startFlowWith(deep, edge),
                },
              ]
            : []),
        ],
      }),
    },
    {
      id: 'spotlight',
      title: 'Spotlight selection',
      group: 'connector',
      keywords: ['focus', 'highlight', 'dim others'],
      run: (inner) => inner.editor.enterFocus([], [edge.id]),
    },
    {
      id: 'edit-text',
      title: 'Edit label',
      group: 'connector',
      keywords: ['rename', 'caption', 'name'],
      shortcut: 'Enter',
      run: (inner) => inner.ui.requestEdit(edge.id),
    },
    { ...deleteCommand('Delete connector'), group: 'connector' },
  ];
  if (isBundled(ctx, edge)) {
    commands.push({
      id: 'edge-convert-to-junction',
      title: 'Convert to junction',
      group: 'connector',
      keywords: ['junction', 'branch', 'trunk', 'bundle', 'split', 'explicit'],
      hint: 'Turn this shared route into a real element',
      run: (inner) => inner.editor.convertBundleToJunction(edge.id),
    });
  }
  if ((edge.attachments?.length ?? 0) < LIMITS.maxAttachmentsPerEdge) {
    commands.push(
      addAttachmentCommand({ hostKind: 'edge', edge }, 'note', 'connector'),
      addAttachmentCommand({ hostKind: 'edge', edge }, 'code', 'connector'),
    );
  }
  // Nowhere left to add it: every flow already has it or is full, and no room for a new one.
  if (flowsAvailable.length === 0 && !canStartFlow) return commands.filter((command) => command.id !== 'edge-add-to-flow');
  return commands;
}

export function multiCommands(ctx: CommandContext): Command[] {
  const { selection, document } = ctx.editor;
  const nodes = document.nodes.filter((node) => selection.nodes.includes(node.id));
  const commands: Command[] = [];
  if (nodes.length >= 2) {
    commands.push({
      id: 'group',
      title: 'Group into boundary',
      group: 'selection',
      keywords: ['boundary', 'system', 'domain', 'container', 'wrap'],
      shortcut: `${MOD_SYMBOL} G`,
      hint: `${nodes.length} elements`,
      run: (inner) => inner.editor.groupSelection(),
    });
  }
  if (nodes.some((node) => node.type === 'group')) {
    commands.push({
      id: 'ungroup',
      title: 'Ungroup',
      group: 'selection',
      keywords: ['dissolve boundary', 'remove group'],
      shortcut: `${MOD_SYMBOL} Shift G`,
      run: (inner) => inner.editor.ungroupSelection(),
    });
  }
  if (nodes.length >= 2) {
    const aligns: [string, string, Parameters<CommandContext['editor']['align']>[0]][] = [
      ['align-left', 'Align left', 'left'],
      ['align-right', 'Align right', 'right'],
      ['align-top', 'Align top', 'top'],
      ['align-bottom', 'Align bottom', 'bottom'],
      ['align-center-x', 'Align centers horizontally', 'centerX'],
      ['align-center-y', 'Align centers vertically', 'centerY'],
    ];
    for (const [id, title, edge] of aligns) {
      commands.push({
        id,
        title,
        group: 'selection',
        keywords: ['align', 'line up', 'tidy'],
        run: (inner) => inner.editor.align(edge),
      });
    }
  }
  if (nodes.length >= 3) {
    commands.push(
      {
        id: 'distribute-x',
        title: 'Distribute horizontally',
        group: 'selection',
        keywords: ['space evenly', 'spread', 'tidy'],
        run: (inner) => inner.editor.distribute('x'),
      },
      {
        id: 'distribute-y',
        title: 'Distribute vertically',
        group: 'selection',
        keywords: ['space evenly', 'spread', 'tidy'],
        run: (inner) => inner.editor.distribute('y'),
      },
    );
  }
  commands.push({
    id: 'spotlight',
    title: 'Spotlight selection',
    group: 'selection',
    keywords: ['focus', 'highlight', 'dim others'],
    hint: `${selection.nodes.length + selection.edges.length} elements`,
    run: (inner) => inner.editor.enterFocus(inner.editor.selection.nodes, inner.editor.selection.edges),
  });
  if (nodes.length > 0) {
    // `duplicateSelection`/`copySelection`/`cutSelection` all no-op on an edges-only selection (an
    // edge has no meaningful standalone duplicate/clipboard identity apart from its endpoints) —
    // gated here to match, rather than showing a command that silently does nothing.
    commands.push(
      {
        id: 'duplicate',
        title: 'Duplicate',
        group: 'selection',
        keywords: ['copy', 'clone'],
        shortcut: `${MOD_SYMBOL} D`,
        run: (inner) => inner.editor.duplicateSelection(),
      },
      copyCommand(),
      cutCommand(),
      bringToFrontCommand(),
      sendToBackCommand(),
      {
        id: 'export-selection',
        title: 'Export selection…',
        group: 'selection',
        keywords: ['png', 'svg', 'image', 'share', 'only'],
        run: (inner) => {
          inner.ui.requestExportSelection(true);
          inner.ui.setExportOpen(true);
        },
      },
    );
  }
  commands.push(deleteCommand('Delete selection'));
  return commands;
}

/** The selection-dependent part of the list — empty when nothing is selected. */
function selectionCommands(ctx: CommandContext): Command[] {
  const { nodes, edges } = ctx.editor.selection;
  const { document } = ctx.editor;
  if (nodes.length === 1 && edges.length === 0) {
    const node = document.nodes.find((entry) => entry.id === nodes[0]);
    return node ? nodeCommands(ctx, node) : [];
  }
  if (edges.length === 1 && nodes.length === 0) {
    const edge = document.edges.find((entry) => entry.id === edges[0]);
    return edge ? edgeCommands(ctx, edge) : [];
  }
  if (nodes.length + edges.length >= 2) return multiCommands(ctx);
  return [];
}

const STARTER_CATEGORY_GROUP: Record<StarterCategory, CommandGroup> = {
  architecture: 'starter',
  data: 'data',
  pattern: 'pattern',
};

/**
 * Starters — one row per composed opening diagram (`src/starters/`), under three headers:
 * *Architectures* (how the major parts of a system are organized), *Data Architectures* (how data
 * moves and is refined — Medallion, Kappa, CDC) and *Patterns* (how one recurring design problem is
 * solved — a saga, an outbox). The split is the catalog's own
 * `category`, kept purely for discoverability; a starter is one architectural idea at one scope,
 * and a real system composes several of them, so nothing here reads as a choice between them.
 *
 * These are not a template browser and deliberately not a separate surface: a starter is a name for
 * `insertStarter`, exactly as "Add Service" is a name for `addNode`. The row adds only the camera
 * move that puts the result on screen, so ⌘K → "microservices" → Enter is the whole interaction.
 *
 * They never depend on `ctx`, so unlike the selection-driven builders this one takes no argument —
 * a starter applies to any canvas, empty or not. Exported for the same reason `nodeCommands` is:
 * the empty canvas's starter row is a second surface over these identical commands, not a second
 * implementation of them (`ui/Editor/EmptyState.tsx`). The catalog lists every architecture, then
 * every data architecture, then every pattern, which is what keeps the three headers contiguous
 * without sorting here.
 */
export function starterCommands(): Command[] {
  return ARCHITECTURE_STARTERS.map((starter) => ({
    id: `starter-${starter.id}`,
    title: starter.name,
    group: STARTER_CATEGORY_GROUP[starter.category],
    keywords: starter.aliases,
    hint: starter.description,
    run: (inner) => focusBounds(inner, boundsOf(inner.editor.insertStarter(starter))),
  }));
}

/** How many Learn rows may join a typed query's results — a pointer to the handbook, never a flood. */
export const LEARN_LIMIT = 3;
/**
 * Ranked alongside commands, a Learn row gives up more than a jump does: someone typing "note"
 * most likely wants to add one, and "Attach a note" is there for when they want to know how.
 */
export const LEARN_RANK_PENALTY = 1.5;

/**
 * One row per Learn recipe, opening the drawer straight on it. Like jump rows these only join a
 * typed query (see `CommandPalette`), and they match on the title alone: a recipe's search keywords
 * ("service", "queue") are deliberately broad for Learn's own box, and here they'd shoulder aside
 * the command that actually does the thing.
 */
export function learnCommands(): readonly Command[] {
  // Recipes never change at runtime, so neither do their rows — built once, not on every keystroke.
  learnRows ??= RECIPES.map((recipe) => ({
    id: `learn-${recipe.id}`,
    title: recipe.title,
    group: 'learn' as const,
    keywords: ['learn', 'how'],
    run: (inner) => inner.ui.openLearn(recipe.id),
  }));
  return learnRows;
}
let learnRows: Command[] | undefined;

/**
 * The palette's answer when nothing matches: carry the question over to Learn's own search, which
 * reads keywords and aliases the palette deliberately doesn't.
 */
export function askLearnCommand(query: string): Command {
  const question = query.trim();
  return {
    id: 'learn-ask',
    title: `Ask Learn about “${question}”`,
    group: 'learn',
    run: (inner) => {
      inner.ui.setLearnQuery(question);
      inner.ui.showLearnRecipe(null);
      inner.ui.openLearn();
    },
  };
}

/** Every command that applies to `ctx` right now, in display order. */

export function commandsFor(ctx: CommandContext): Command[] {
  if (ctx.editor.mode === 'present') return presentModeCommands(ctx);
  return [
    ...selectionCommands(ctx),
    ...ALL_PRESETS.map(createCommand),
    ...starterCommands(),
    ...flowCommands(ctx),
    ...takeawaysCommands(ctx),
    ...viewCommands(ctx),
    ...canvasCommands(ctx),
  ];
}
