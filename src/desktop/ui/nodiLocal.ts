import type { NodeCategory } from '../../document/connectorSemantics';

/**
 * What Nodi can answer or do on its own, with no agent run: the time, what is in the diagram, where a
 * part is, which folder the file is in, and the app's own commands (the ones ⌘K runs). An agent turn
 * costs thousands of tokens and some seconds; these cost nothing and are exact. Conservative by
 * design: a message that isn't plainly one of these returns null and goes to the agent as before.
 *
 * Pure: the caller gathers the facts (`LocalFacts`) and runs what the person picks.
 */

/** A button under Nodi's answer. */
export type LocalAction =
  /** One of the editor's commands, by id (`commands/registry.ts`), run when clicked. */
  | { kind: 'command'; id: string; label: string }
  /** A question for the agent, sent when clicked. */
  | { kind: 'ask'; label: string; prompt: string }
  /** ⌘K, open at a search. */
  | { kind: 'palette'; label: string; query: string }
  /** Settings → AI agents. */
  | { kind: 'settings'; label: string }
  /** Something to say to Nodi itself: answered here, like a message typed. */
  | { kind: 'say'; label: string; text: string };

export interface LocalAnswer {
  /** Nodi's words; `[[id]]` names a part, as an agent's reply does. */
  text: string;
  actions?: LocalAction[];
  /** A part to bring into view at once. */
  reveal?: string;
}

export interface LocalFacts {
  now: Date;
  title: string;
  shapes: readonly { id: string; name: string; category: NodeCategory }[];
  connectors: readonly { id: string; name: string }[];
  flows: readonly { id: string; title: string }[];
  boundaries: readonly { id: string; name: string }[];
  notes: number;
  openPoints: number;
  /** Where the file is, as the shell shows it; null for a quick draft. */
  file: string | null;
  /** The listed folders, and whether agents may use each; null until known. */
  folders: readonly { name: string; displayPath: string; agent: boolean }[] | null;
  /** The agent Nodi runs; null when there is no coding agent on this computer. */
  agentName: string | null;
  /** The editor's commands as ⌘K lists them now (selection-aware). */
  commands: readonly { id: string; title: string; keywords?: readonly string[] }[];
}

/** What Nodi says to a message only an agent could answer, when there is no agent. */
const NO_BRAIN = [
  'That one needs a brain, boss, and mine is on loan from a coding agent this computer doesn’t have. Install Claude Code or Codex and I’ll think about it with you.',
  'I’d love to, boss, but architecture thinking runs on a coding agent (Claude Code or Codex), and there isn’t one here. Until then I’m a very opinionated clock.',
  'No coding agent on this computer, boss, so no big thoughts from me. Install Claude Code or Codex and ask me again.',
];

export function agentlessAnswer(seed: number): LocalAnswer {
  return {
    text: `${NO_BRAIN[Math.abs(seed) % NO_BRAIN.length]} Meanwhile, the small stuff I can still do:`,
    actions: [
      { kind: 'say', label: 'What can you do?', text: 'What can you do?' },
      { kind: 'say', label: 'What’s in this diagram?', text: 'What’s in this diagram?' },
      { kind: 'palette', label: 'Every command', query: '' },
    ],
  };
}

/** Words that carry nothing about what is asked. */
const FILLER = new Set(['a', 'an', 'the', 'please', 'pls', 'can', 'could', 'would', 'will', 'you', 'nodi', 'boss', 'me', 'my', 'for', 'to', 'this', 'that', 'it', 'now', 'just', 'quickly', 'kindly', 'hey', 'hi', 'ok', 'okay', 'go', 'ahead', 'and', 'of', 'i', 'want', 'wanna', 'need', 'let', 'lets', 'us', 'as', 'in', 'into', 'with', 'some', 'bit', 'little']);

/** First words that ask the app to do something rather than the agent to think about something. */
const DOING = new Set(['export', 'copy', 'open', 'show', 'zoom', 'fit', 'present', 'start', 'undo', 'redo', 'arrange', 'tidy', 'find', 'share', 'trace', 'select', 'next', 'previous', 'exit', 'back', 'look', 'switch', 'outline', 'spotlight', 'reset', 'distribute', 'group', 'ungroup', 'duplicate', 'paste', 'cut']);

/** What "the queues" or "the databases" means, by the shape categories it covers. */
const KINDS: { words: RegExp; label: [string, string]; categories: readonly NodeCategory[] | 'all' }[] = [
  { words: /^(shapes?|elements?|parts?|nodes?|boxes|box|things|components and services)$/, label: ['part', 'parts'], categories: 'all' },
  { words: /^(services?|microservices?)$/, label: ['service', 'services'], categories: ['service'] },
  { words: /^(gateways?|apis?)$/, label: ['gateway', 'gateways'], categories: ['gateway'] },
  { words: /^(workers?|jobs?|crons?|schedulers?)$/, label: ['worker', 'workers'], categories: ['worker', 'scheduler'] },
  { words: /^(databases?|dbs?|data stores?|stores?|tables?)$/, label: ['data store', 'data stores'], categories: ['database'] },
  { words: /^(caches?)$/, label: ['cache', 'caches'], categories: ['cache'] },
  { words: /^(queues?|topics?|streams?|message queues?)$/, label: ['queue', 'queues'], categories: ['queue', 'topic', 'stream', 'deadLetter'] },
  { words: /^(externals?|external systems?|third part(y|ies)|vendors?)$/, label: ['external system', 'external systems'], categories: ['external'] },
  { words: /^(people|persons?|users?|actors?|personas?)$/, label: ['person', 'people'], categories: ['actor'] },
  { words: /^(components?)$/, label: ['component', 'components'], categories: ['component'] },
];

const plain = (text: string) =>
  text
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Nodi's own answer to `text`, or null when it is for the agent. */
export function localAnswer(text: string, facts: LocalFacts): LocalAnswer | null {
  const said = plain(text);
  if (!said || said.split(' ').length > 10) return null;
  return timeOf(said, facts) ?? weatherOf(said) ?? limitsOf(said, facts) ?? countOf(said, facts) ?? summaryOf(said, facts) ?? whereOf(said, facts) ?? folderOf(said, facts) ?? themeOf(said, facts) ?? helpOf(said, facts) ?? commandOf(said, facts);
}

function timeOf(said: string, facts: LocalFacts): LocalAnswer | null {
  if (!/^(whats |what is )?(the )?(current )?(time|date|day|today)( is it| now| today| is today| please)?$/.test(said) && !/^what (time|day|date) is it( now| today)?$/.test(said)) return null;
  const { now } = facts;
  const time = now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const date = now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  const utc = now.toISOString().slice(11, 16);
  const hour = now.getHours();
  const aside = hour < 5 ? 'Go to bed, boss.' : now.getDay() === 5 && hour >= 14 ? 'Friday afternoon. Don’t deploy.' : hour >= 12 && hour < 14 ? 'Lunch is a valid architecture decision.' : 'Your logs only know the UTC one.';
  return { text: `It’s **${time}**, ${date}, boss. In UTC it’s ${utc}. ${aside}` };
}

function weatherOf(said: string): LocalAnswer | null {
  if (!/^(whats |what is |hows |how is )?(the )?weather( like)?( today| outside| now)?$/.test(said)) return null;
  return { text: 'I can’t see outside, boss: no window, no network, no location, on purpose. In here: cloudy, with a 40% chance of 503s.' };
}

/** "How many queues", "list the services", "show me the databases", "what flows are there". */
function countOf(said: string, facts: LocalFacts): LocalAnswer | null {
  const m = said.match(/^(?:how many|count|list|show me|show|what are|which are|what|which|name)(?: all)?(?: the| my| of the)? ([a-z ]+?)(?: are there| do i have| do we have| are in (?:this|the) (?:diagram|view|canvas)| in (?:this|the) (?:diagram|view|canvas)| here| there)?$/);
  if (!m) return null;
  const noun = m[1]!.trim();
  if (/^(arrows?|connectors?|relationships?|connections?|edges?|lines?)$/.test(noun)) {
    const n = facts.connectors.length;
    if (n === 0) return { text: 'No arrows yet, boss. Very peaceful. Very unrealistic.' };
    return { text: `${n} ${n === 1 ? 'connector' : 'connectors'}, boss:\n\n${bullets(facts.connectors.map((c) => c.id))}` };
  }
  if (/^(flows?|presentations?)$/.test(noun)) {
    if (facts.flows.length === 0) return { text: 'No flows yet, boss. Nobody knows which way a request goes. Except the request.', actions: [{ kind: 'command', id: 'flow-new', label: 'Make a flow' }] };
    return {
      text: `${facts.flows.length === 1 ? 'One flow' : `${facts.flows.length} flows`}, boss: ${facts.flows.map((f) => `**${f.title}**`).join(', ')}.`,
      actions: facts.flows.slice(0, 3).map((f) => ({ kind: 'command' as const, id: `present-flow:${f.id}`, label: `Present ${f.title}` })),
    };
  }
  if (/^(boundaries|boundary|groups?)$/.test(noun)) {
    const n = facts.boundaries.length;
    return { text: n === 0 ? 'No boundaries, boss. Everything owns everything. Bold.' : `${n} ${n === 1 ? 'boundary' : 'boundaries'}, boss:\n\n${bullets(facts.boundaries.map((b) => b.id))}` };
  }
  if (/^(open points?|questions?|todos?|to dos?)$/.test(noun)) {
    const n = facts.openPoints;
    return { text: n === 0 ? 'No open points, boss. Either it’s all decided or nobody’s asked yet.' : `${n} open ${n === 1 ? 'point' : 'points'} waiting, boss.`, actions: n ? [{ kind: 'command', id: 'open-points', label: 'Show open points' }] : undefined };
  }
  if (/^(notes?)$/.test(noun)) return { text: facts.notes === 0 ? 'No notes, boss. The diagram speaks for itself. Allegedly.' : `${facts.notes} ${facts.notes === 1 ? 'note' : 'notes'}, boss.` };
  const kind = KINDS.find((k) => k.words.test(noun));
  if (!kind) return null;
  const found = facts.shapes.filter((s) => kind.categories === 'all' || kind.categories.includes(s.category));
  if (found.length === 0) return { text: `No ${kind.label[1]} in this view, boss.${kind.categories !== 'all' && kind.categories.includes('queue') ? ' Everything synchronous, then. Brave.' : ''}` };
  const [one, many] = kind.label;
  return { text: `${found.length} ${found.length === 1 ? one : many}, boss:\n\n${bullets(found.map((s) => s.id))}` };
}

function bullets(ids: readonly string[]): string {
  const shown = ids.slice(0, 8).map((id) => `- [[${id}]]`);
  if (ids.length > 8) shown.push(`- and ${ids.length - 8} more`);
  return shown.join('\n');
}

function summaryOf(said: string, facts: LocalFacts): LocalAnswer | null {
  if (!/^(whats |what is )(in |on )(this|the|my) (diagram|canvas|view)$|^(give me )?(a |the )?(summary|overview|stats|statistics)( please)?$|^summari[sz]e( this| it| the diagram)?$/.test(said)) return null;
  const counts = new Map<string, number>();
  for (const s of facts.shapes) counts.set(s.category, (counts.get(s.category) ?? 0) + 1);
  const parts = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([category, n]) => `${n} ${categoryWord(category, n)}`);
  const text = facts.shapes.length === 0
    ? `**${facts.title}** is empty, boss. Zero bugs so far.`
    : `**${facts.title}**: ${facts.shapes.length} ${facts.shapes.length === 1 ? 'part' : 'parts'} (${parts.join(', ')}), ${facts.connectors.length} ${facts.connectors.length === 1 ? 'connector' : 'connectors'}, ${facts.flows.length} ${facts.flows.length === 1 ? 'flow' : 'flows'}${facts.openPoints ? `, ${facts.openPoints} open ${facts.openPoints === 1 ? 'point' : 'points'}` : ''}. That’s the count. For what it *means*, ask me to walk you through it.`;
  return { text, actions: facts.shapes.length && facts.agentName ? [{ kind: 'ask', label: 'Walk me through it', prompt: 'Explain this diagram' }, { kind: 'ask', label: 'What breaks first?', prompt: 'What are the risks here?' }] : undefined };
}

const CATEGORY_WORDS: Partial<Record<NodeCategory, [string, string]>> = {
  actor: ['person', 'people'],
  service: ['service', 'services'],
  worker: ['worker', 'workers'],
  scheduler: ['scheduler', 'schedulers'],
  gateway: ['gateway', 'gateways'],
  component: ['component', 'components'],
  database: ['data store', 'data stores'],
  cache: ['cache', 'caches'],
  queue: ['queue', 'queues'],
  topic: ['topic', 'topics'],
  stream: ['stream', 'streams'],
  deadLetter: ['dead-letter queue', 'dead-letter queues'],
  external: ['external system', 'external systems'],
  objectStorage: ['bucket', 'buckets'],
  agent: ['AI agent', 'AI agents'],
};

function categoryWord(category: string, n: number): string {
  const words = CATEGORY_WORDS[category as NodeCategory] ?? ['other', 'others'];
  return n === 1 ? words[0] : words[1];
}

/** "Where is the orders queue", "find billing", "show me the cache". */
function whereOf(said: string, facts: LocalFacts): LocalAnswer | null {
  const m = said.match(/^(?:where is|wheres|where s|find|locate|show me|go to|jump to|take me to)(?: the| my)? (.+)$/);
  if (!m) return null;
  const wanted = m[1]!.replace(/ (service|queue|database|db|box|shape|component|worker)$/, '').trim();
  if (wanted.length < 2) return null;
  const all = [...facts.shapes, ...facts.boundaries];
  const exact = all.find((s) => plain(s.name) === wanted);
  const hits = exact ? [exact] : all.filter((s) => plain(s.name).includes(wanted));
  if (hits.length === 0) return null;
  if (hits.length === 1) return { text: `There, boss: [[${hits[0]!.id}]].`, reveal: hits[0]!.id };
  return { text: `A few of those, boss:\n\n${bullets(hits.map((h) => h.id))}` };
}

function folderOf(said: string, facts: LocalFacts): LocalAnswer | null {
  if (/^(where is|wheres|where s) (this|the|my) (file|diagram|drawing) (saved|stored|kept)?$|^(which|what) folder( is (this|it) in)?$|^(the )?file path$|^where (is it|am i) saved$|^where is this saved$/.test(said)) {
    return facts.file
      ? { text: `This one lives at **${facts.file}**, boss.` }
      : { text: 'This is a quick draft, boss: it isn’t saved to a folder yet.', actions: [{ kind: 'palette', label: 'Save it…', query: 'save' }] };
  }
  if (/^(which|what) folders( can you| do you| are)?( see| access| use| reach| allowed)?$|^what can you (see|access)$/.test(said)) {
    if (!facts.folders) return null;
    const allowed = facts.folders.filter((f) => f.agent);
    return {
      text: allowed.length
        ? `Agents can use ${allowed.length === 1 ? 'one folder' : `${allowed.length} folders`}, boss:\n\n${allowed.map((f) => `- **${f.name}**: ${f.displayPath}`).join('\n')}`
        : 'No folders are open to agents yet, boss. Only you can let me in.',
      actions: [{ kind: 'settings', label: 'Agent settings' }],
    };
  }
  return null;
}

function themeOf(said: string, facts: LocalFacts): LocalAnswer | null {
  if (!/\b(dark mode|light mode|dark theme|light theme|theme|night mode)\b/.test(said) || said.split(' ').length > 6) return null;
  const settings = facts.commands.find((c) => c.id === 'settings');
  return {
    text: 'Draft Canvas follows your computer’s light or dark setting, boss. Flip it there and I’ll follow, pixels and all.',
    actions: settings ? [{ kind: 'command', id: settings.id, label: settings.title.replace(/…$/, '') }] : undefined,
  };
}

/** "What can't you do": the honest list, said as Nodi would. */
function limitsOf(said: string, facts: LocalFacts): LocalAnswer | null {
  if (!/^(what (cant|cannot|can not) you do|what are your limits|what are your limitations|your limits|limitations|what wont you do|what dont you do)$/.test(said)) return null;
  return {
    text: [
      'Plenty, boss. Honestly:',
      '',
      '- **I can’t touch your code or your files.** Only this diagram, and only through Draft Canvas’s own tools.',
      '- **I can’t change anything behind your back.** A change is a proposal you accept or reject (unless you told me to apply directly).',
      '- **I can’t see outside.** No web, no weather, no location, on purpose.',
      facts.agentName
        ? `- **I can’t think without ${facts.agentName}.** The architecture brain is your agent; I’m the face and the attitude.`
        : '- **I can’t think about architecture at all right now.** That brain is a coding agent (Claude Code or Codex), and this computer has none.',
      '- **I can’t make you rich, boss.** I tried. The stock market has no API I’m allowed to call.',
      '- **I can’t fix production.** I can only draw where it’s going to break, and say I told you so.',
    ].join('\n'),
    actions: [{ kind: 'palette', label: 'Every command', query: '' }],
  };
}

function helpOf(said: string, facts: LocalFacts): LocalAnswer | null {
  if (!/^(what can you do|what do you do|help|help me|how do you work|how does this work|what are you for|commands|what can i ask( you)?|what can i say)$/.test(said)) return null;
  const actions: LocalAction[] = facts.agentName
    ? [
        { kind: 'ask', label: 'Walk me through it', prompt: 'Explain this diagram' },
        { kind: 'ask', label: 'What breaks first?', prompt: 'What are the risks here?' },
      ]
    : [
        { kind: 'say', label: 'What’s in this diagram?', text: 'What’s in this diagram?' },
        { kind: 'say', label: 'What can’t you do?', text: 'What can’t you do?' },
      ];
  const exporting = facts.commands.find((c) => c.id === 'export');
  if (exporting) actions.push({ kind: 'command', id: exporting.id, label: 'Export…' });
  if (facts.flows[0]) actions.push({ kind: 'command', id: `present-flow:${facts.flows[0].id}`, label: `Present ${facts.flows[0].title}` });
  actions.push({ kind: 'palette', label: 'Every command', query: '' });
  return {
    text: [
      'Three kinds of things, boss:',
      '',
      '- **Answer on the spot**, free: the time, what’s in this diagram (“how many queues”), where a part is (“where is billing”), which folder it’s in.',
      '- **Run the app for you**: export, present a flow, tidy connectors, zoom, find. Just say it.',
      facts.agentName
        ? `- **Think, with ${facts.agentName}**: explain the diagram, find what breaks, propose a change you accept or reject.`
        : '- **Think**: not yet. Explaining the diagram, finding what breaks and drawing changes needs a coding agent (Claude Code or Codex). Install one and I get a brain.',
    ].join('\n'),
    actions,
  };
}

/** "Export", "export as png", "tidy connectors", "zoom in", "present": the app's own commands. */
function commandOf(said: string, facts: LocalFacts): LocalAnswer | null {
  const words = said.split(' ').filter((w) => !FILLER.has(w));
  if (words.length === 0 || words.length > 5) return null;
  const exactTitle = facts.commands.find((c) => plain(c.title) === words.join(' '));
  if (!exactTitle && !DOING.has(words[0]!)) return null;
  const vocabulary = (c: (typeof facts.commands)[number]) => [...plain(c.title).split(' '), ...(c.keywords ?? []).flatMap((k) => plain(k).split(' '))].filter(Boolean);
  const matches = (word: string, vocab: string[]) => vocab.some((v) => v === word || (word.length >= 3 && (v.startsWith(word) || word.startsWith(v) && v.length >= 3)));
  const scored = facts.commands
    .filter((c) => c.id !== 'companion')
    .map((c) => {
      const vocab = vocabulary(c);
      const hit = words.filter((w) => matches(w, vocab)).length;
      const titleWords = plain(c.title).split(' ').filter((w) => !FILLER.has(w));
      const covered = titleWords.filter((t) => words.some((w) => t === w || t.startsWith(w) || w.startsWith(t))).length;
      return { c, hit, score: hit * 10 + covered * 3 - titleWords.length };
    })
    // Every word said must be about the command: "export the cache design doc" is not Export.
    .filter((s) => s.hit === words.length)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  if (scored.length === 0) return null;
  // Offered, not run: the person clicks the one they meant, and a slip of the tongue does nothing.
  return {
    text: scored.length === 1 ? 'On it, boss. One click:' : 'Here’s what I can do, boss. Pick one:',
    actions: scored.map(({ c }) => ({ kind: 'command' as const, id: c.id, label: c.title })),
  };
}
