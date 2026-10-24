import { reviewView, type ReviewCode } from '../../agent/review';
import { canCreateInside, hasInside } from '../../depth/tree';
import { categoryOf } from '../../document/connectorSemantics';
import type { DraftEdge, DraftNode } from '../../document/types';

/**
 * What Nodi says from rest, in its speech bubble: the one thing worth knowing now, said the way an
 * over-eager companion would say it. Pure, so what it says in each state is one place to read and to
 * test, and the lines are data: more personality is more lines, not more code.
 */

export type RestingTone = 'greet' | 'selected' | 'working' | 'waiting' | 'done' | 'blocked';

export interface RestingLine {
  tone: RestingTone;
  text: string;
  /** The small call to action under the line. */
  hint: string;
  /** Said until it is no longer true (work under way, a change waiting, an answer unread), rather
   *  than only on arrival and on hover: the person would want to know without looking for it. */
  stays: boolean;
}

export interface RestingState {
  /** Nodi can't run (no saved file, access off, no agent): say so, kindly. */
  blocked: boolean;
  /** What is in the way, as a short line (`Snag.rest`), when it is known. */
  snag?: string | null;
  /** The step a run is on ("Reading the diagram"), while one is. */
  working: string | null;
  /** The latest turn's proposal is waiting on the canvas. */
  waiting: boolean;
  /** The latest turn finished while the conversation was closed. */
  unseen: boolean;
  /** What is selected, by name ("Orders database", "3 shapes"). */
  selected: string | null;
  /** Picks the line for a greeting or a selection: a new one each time Nodi pipes up. */
  seed: number;
  /** Lines about this very diagram (`diagramLines`), mixed in with the greetings. */
  diagram?: readonly string[];
  /** Picks the line for news about a run: the same for the whole run, so it never changes mid-word. */
  runSeed: number;
}

/** An invitation now and then, and in between, what a companion who has seen too many incidents
 *  mutters to itself. Kept to a line or two: the bubble is small, and the canvas is the point. */
const GREETINGS = [
  'Boss, need a hand?',
  'Need a hand with this one, boss?',
  'Want a second opinion, boss? I have several.',
  'Say the word, boss, and I’ll find the weak spots.',
  'Psst. Boss. I read diagrams for fun.',
  'Ready when you are, boss. Probably readier.',
  'I have opinions about this diagram, boss.',
  'It’s always DNS. Unless it’s the cache. It’s the cache, boss.',
  'Somewhere, a cron job is running at 3am. I think it’s yours, boss.',
  'Someone deployed on a Friday. Not saying it was you, boss. The logs are.',
  'That TODO from 2019? git blame says hi, boss.',
  'The pager went off at 2am. Not your fault, boss. Probably.',
  'Someone hardcoded a 30-second timeout. Classic you, boss.',
  'I found a feature flag nobody remembers adding. Ring a bell, boss?',
  'Rule one of prod: never deploy on a Friday. Rule two: see rule one.',
  'That queue looks calm, boss. Too calm.',
  'I once watched a retry loop retry itself into the sun.',
  'Every arrow is a promise, boss. Some arrows lie.',
  'Ask me about the time a “quick fix” paged six people.',
  'Have you tried turning the architecture off and on again, boss?',
  'If a service falls over and there’s no alert, did it page?',
  'Retries without backoff? In this economy, boss?',
  'I don’t sleep, boss. I wait for 2am incidents.',
  'Nothing scales like a diagram. Production has notes.',
  'Is it me, boss, or is that arrow judging us?',
  'Timeouts set to “forever”: a love story.',
  'I promise not to rename anything, boss. Unless you ask.',
  // True, if said with a straight face: the laws and lessons this trade keeps relearning.
  'Conway’s law, boss: this diagram is your org chart wearing a disguise.',
  'Gall’s law: every complex system that works grew from a simple one that worked.',
  'Hyrum’s law, boss: somebody depends on that bug. Fix it anyway.',
  'Little’s law: what’s in the queue = arrival rate × time spent in it. The queue did the math.',
  'Brooks’s law: adding people to a late project makes it later. Boxes too, boss.',
  'Fallacy #1 of distributed computing: the network is reliable. It is not, boss.',
  'Fallacy #2: latency is zero. Ask anyone who called another region.',
  'When the network splits you get consistency or availability, boss. Not both. Thanks, CAP.',
  'Exactly-once delivery is a myth, boss. At-least-once plus idempotency is the cure.',
  'At-least-once means “twice, on a Friday”. Make the consumer idempotent, boss.',
  'The average is lying to you, boss. Look at the p99.',
  'A retry without a timeout is just hope with a for-loop.',
  'Cache stampede: one empty cache, a thousand requests, zero survivors.',
  'Two services sharing one database is a monolith in a trench coat, boss.',
  'A distributed monolith: all the pain of both, none of the joy.',
  'Clocks drift, boss. Never trust two servers to agree on “now”.',
  'Backpressure is just a service learning to say “no”. Healthy, honestly.',
  'Every microservice starts as “just a small one”, boss.',
  'There are two hard things: cache invalidation, naming things and off-by-one errors.',
];

const SELECTED = [
  'Want me to look at {it}, boss?',
  'Ooh, {it}. Want my take, boss?',
  '{it}? I have thoughts.',
  'Shall I poke at {it}, boss?',
  '{it} looks suspicious, boss. Want me to check?',
  'Ah, {it}. What has it done this time?',
  'Bold of you to select {it}, boss.',
];

const WORKING = ['On it, boss… {step}.', 'Hold my coffee, boss… {step}.', 'Busy busy… {step}.', 'Crunching, boss… {step}.', 'Don’t mind me… {step}.'];

const WAITING = ['Got a change for you to look at, boss!', 'I made a thing, boss. Take a look?', 'Fresh proposal on the canvas, boss.', 'Your review is requested, boss. Very official.'];

const DONE = ['Done, boss! Come see what I found.', 'Boss, I found stuff. Come look.', 'All done. You’ll want to read this, boss.', 'Finished. I was very thorough. Mostly.'];

const BLOCKED = ['Psst, boss… I need a hand first.', 'I’m stuck, boss. Click and I’ll explain.', 'Can’t start yet. Small snag, boss.'];

export function restingLine(state: RestingState): RestingLine {
  const { seed, runSeed } = state;
  if (state.blocked) return { tone: 'blocked', text: state.snag || pick(BLOCKED, seed), hint: state.snag ? 'Show me how' : 'See what’s missing', stays: false };
  if (state.working) return { tone: 'working', text: pick(WORKING, runSeed).replace('{step}', lowerFirst(state.working)), hint: 'Watch', stays: true };
  if (state.waiting) return { tone: 'waiting', text: pick(WAITING, runSeed), hint: 'Show me', stays: true };
  if (state.unseen) return { tone: 'done', text: pick(DONE, runSeed), hint: 'Open', stays: true };
  if (state.selected) return { tone: 'selected', text: upperFirst(pick(SELECTED, seed).replace('{it}', state.selected)), hint: 'Ask me', stays: false };
  // Every other greeting is about this diagram, when Nodi has something to say about it.
  const about = state.diagram ?? [];
  const text = about.length && seed % 2 !== 0 ? pick(about, (seed - 1) / 2) : pick(GREETINGS, Math.floor(seed / (about.length ? 2 : 1)));
  return { tone: 'greet', text, hint: 'Click to chat', stays: false };
}

/** A next step Nodi offers while it can't run, as one of the person's replies: each does the thing. */
export type SnagStep =
  | { kind: 'save'; label: string }
  | { kind: 'save-copy'; label: string }
  | { kind: 'settings'; label: string }
  | { kind: 'copy'; label: string; command: string };

/** Why Nodi can't take a message yet, in its voice, and what gets it going. */
export interface Snag {
  /** Said in the opened box: what is in the way and what fixes it. */
  line: string;
  /** The same, short, for the bubble at rest. */
  rest: string;
  steps: SnagStep[];
}

export interface SnagFacts {
  doc: 'none' | 'quick' | 'file';
  readOnly: boolean;
  /** Whether agent access is on; null until the shell has said. */
  access: boolean | null;
  /** The shell has said which agents are installed. */
  agentsKnown: boolean;
  /** The agent Nodi would run, if any. */
  agent: { agent: string; name: string; availability: 'installed' | 'missing' | 'too-old'; version: string | null; signIn: { loggedIn: boolean | null } } | null;
}

/** What the person types in a terminal to update an agent or sign it in, by `AgentKind`. An agent
 *  with none listed gets the words without a command to copy. */
const AGENT_COMMANDS: Record<string, { update: string; signIn: string }> = {
  'claude-code': { update: 'claude update', signIn: 'claude' },
  codex: { update: 'codex update', signIn: 'codex login' },
};

/**
 * What stops Nodi taking a message, first thing first, or null when nothing does. Agents are found
 * once per app run, so a fix made in a terminal is noticed the next time Draft Canvas starts.
 */
export function snagOf(facts: SnagFacts): Snag | null {
  if (facts.doc !== 'file') {
    return {
      line: 'This one’s a quick draft, boss. Agents only work on saved diagrams, so save it to a folder first and I’m all yours.',
      rest: 'Save this diagram first, boss, and I’m all yours.',
      steps: [{ kind: 'save', label: 'Save it to a folder' }],
    };
  }
  if (facts.readOnly) {
    return {
      line: 'This file is read-only, boss, so I can’t change it. Save a copy and I’ll work on that one.',
      rest: 'This file is read-only, boss. I can’t touch it.',
      steps: [{ kind: 'save-copy', label: 'Save a copy' }],
    };
  }
  // Unknown until the shell answers: only a shell that says it is off gets the snag.
  if (facts.access === false) {
    return {
      // Turning access on lets agents into the person's folders: theirs to do, in Settings.
      line: 'Agent access is off, boss, so I’m locked out. Only you can let me in: it’s in Settings, under AI agents.',
      rest: 'Agent access is off, boss. I’m locked out.',
      steps: [{ kind: 'settings', label: 'Turn on agent access in Settings' }],
    };
  }
  const { agent } = facts;
  if (facts.agentsKnown && !agent) {
    return { line: 'I can’t find a coding agent on this computer, boss. Install one and I’ll be right here.', rest: 'No coding agent here yet, boss.', steps: [] };
  }
  if (!agent) return null;
  const commands = AGENT_COMMANDS[agent.agent];
  if (agent.availability === 'missing') {
    return { line: `${agent.name} isn’t on this computer, boss. Install it and I’ll be right here.`, rest: `${agent.name} isn’t installed, boss.`, steps: [] };
  }
  if (agent.availability === 'too-old') {
    const yours = agent.version ? ` ${agent.version}` : '';
    return {
      line: `Your ${agent.name}${yours} is too old for me, boss. Update it${commands ? ` (${commands.update} in Terminal)` : ''}, and I’ll pick it up next time Draft Canvas starts.`,
      rest: `${agent.name} needs an update, boss.`,
      steps: commands ? [{ kind: 'copy', label: 'Copy the update command', command: commands.update }] : [],
    };
  }
  if (agent.signIn.loggedIn === false) {
    return {
      line: `${agent.name} isn’t signed in yet, boss. ${commands ? `Run ${commands.signIn} once in Terminal to sign in` : 'Sign in to it'}, and I’ll pick it up next time Draft Canvas starts.`,
      rest: `${agent.name} isn’t signed in yet, boss.`,
      steps: commands ? [{ kind: 'copy', label: 'Copy the sign-in command', command: commands.signIn }] : [],
    };
  }
  return null;
}

/** A stable small number from a string (a diagram or run id), for the seeds. */
export function seedOf(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return hash;
}

function pick<T>(lines: readonly T[], seed: number): T {
  return lines[Math.abs(seed) % lines.length]!;
}

function lowerFirst(text: string): string {
  return text ? text[0]!.toLowerCase() + text.slice(1) : text;
}

function upperFirst(text: string): string {
  return text ? text[0]!.toUpperCase() + text.slice(1) : text;
}

/** One of the person's replies Nodi offers: what they say, in their voice, and what the agent is
 *  actually asked, plainly, so the joke never reaches the agent's instructions. */
export interface Opener {
  label: string;
  prompt: string;
  /** A shape to step inside instead of asking the agent anything: the way in for someone who
   *  doesn't know a shape can hold a diagram of its own. */
  enter?: string;
}

/** A shape on screen that holds a diagram of its own, by id and name. */
export interface Door {
  id: string;
  name: string;
}

/** The wildcard third reply, a new one each time: the same honest review, asked with some nerve. */
const WILDCARDS: Opener[] = [
  { label: 'Roast my diagram', prompt: 'Review this diagram honestly: what is weak, missing or confusing, most important first?' },
  { label: 'What would page me at 3am?', prompt: 'What failures here would page someone at night, and how could we catch or prevent them earlier?' },
  { label: 'Where’s the single point of failure?', prompt: 'Where are the single points of failure here, and what would remove each one?' },
  { label: 'What did I forget?', prompt: 'What is missing from this diagram that a reviewer would expect to see?' },
];

const WILDCARDS_FOR: Opener[] = [
  { label: 'Roast {it}', prompt: 'Review this honestly: what is weak, missing or confusing about it, most important first?' },
  { label: 'What would {it} break at 3am?', prompt: 'How could this fail in production, and how could we catch or prevent that earlier?' },
  { label: 'Does {it} even need to exist?', prompt: 'Does this need to be here? What would change if it were removed or merged into something else?' },
];

/**
 * The replies Nodi offers before anything is asked: walk me through it, what breaks first, and a
 * wildcard. About the selection when there is one, by its name.
 */
export function openers(selected: string | null, seed: number, look: Look = {}): Opener[] {
  if (selected) {
    const wild = pick(WILDCARDS_FOR, seed);
    // The selected shape's own inside comes first when it has one; when it could have one and
    // doesn't, drawing it is the third offer.
    const third: Opener = look.into
      ? { label: `Take me inside ${look.into.name}`, prompt: '', enter: look.into.id }
      : look.drawable
        ? { label: `Draw what’s inside ${selected}`, prompt: DRAW_INSIDE }
        : { label: wild.label.replace('{it}', selected), prompt: wild.prompt };
    return [
      { label: `What’s ${selected} doing here?`, prompt: 'Explain what this does in the diagram and why it is there.' },
      { label: `What could go wrong with ${selected}?`, prompt: 'What are the risks here?' },
      third,
    ];
  }
  // A shape with a diagram inside is easy to miss: every other time, the third offer is the way in.
  const third = look.into && seed % 2 === 0 ? { label: `Take me inside ${look.into.name}`, prompt: '', enter: look.into.id } : pick(WILDCARDS, seed);
  return [{ label: 'Walk me through it', prompt: 'Explain this diagram' }, { label: 'What breaks first?', prompt: 'What are the risks here?' }, third];
}

/** What the person could look inside: a shape on screen that holds a diagram (`into`), and whether
 *  the selected shape could hold one it doesn't have yet (`drawable`). */
export interface Look {
  into?: Door;
  drawable?: boolean;
}

const DRAW_INSIDE =
  'Add a component view inside this element: the parts it is made of and how they work together, drawn from what the diagram and its notes say about it. Where the diagram doesn’t say, ask me rather than guess.';

/** The first shape on screen with a diagram inside, the selected one first: the door Nodi points at. */
export function doorOf(nodes: readonly DraftNode[], selected: readonly string[], name: (node: DraftNode) => string): Door | null {
  const inside = nodes.filter(hasInside);
  const door = inside.find((n) => selected.includes(n.id)) ?? inside[0];
  return door ? { id: door.id, name: name(door) } : null;
}

/**
 * What Nodi can say about the diagram on screen, by the names in it: an offer of help, with the
 * person gently cast as the cause. Each line needs a fact that holds (a queue with no dead-letter
 * path, a store everything writes to), so it reads as noticing, not as a random quip.
 */
/** Nodi's word after a review finding: the finding is the fact, this is the boss being told. */
const QUIP: Record<ReviewCode, string> = {
  'no-dead-letter': 'Bold choice, boss. Want me to add one?',
  'shared-database': 'That’s one service with extra steps, boss.',
  'call-cycle': 'That’s not architecture, boss, that’s a relationship.',
  'no-consumer': 'They’ll pile up forever, boss. Who was meant to read them?',
  'no-producer': 'Who’s supposed to feed it, boss?',
  'cache-not-written': 'Stale data has entered the chat, boss.',
  unconnected: 'Feature or cry for help, boss?',
};

export function diagramLines(nodes: readonly DraftNode[], edges: readonly DraftEdge[], flows: number, openPoints: number): string[] {
  const named = (node: DraftNode) => node.text?.split('\n')[0]?.trim().slice(0, 28) || null;
  const shapes = nodes.filter((n) => !['note', 'text', 'code', 'group', 'ellipse'].includes(n.type));
  const groups = nodes.filter((n) => n.type === 'group').length;
  const into = new Map<string, number>();
  const callees = new Map<string, Set<string>>();
  const writers = new Map<string, Set<string>>();
  const linked = new Set<string>();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const edge of edges) {
    into.set(edge.target, (into.get(edge.target) ?? 0) + 1);
    linked.add(edge.source);
    linked.add(edge.target);
    const from = byId.get(edge.source);
    const to = byId.get(edge.target);
    if (!from || !to) continue;
    if (categoryOf(from) === 'service' || categoryOf(from) === 'worker') {
      if (categoryOf(to) === 'database') writers.set(to.id, (writers.get(to.id) ?? new Set()).add(from.id));
      callees.set(from.id, (callees.get(from.id) ?? new Set()).add(to.id));
    }
  }
  const first = (categories: string[]) => shapes.find((n) => categories.includes(categoryOf(n)) && named(n));
  const lines: string[] = [];
  const say = (line: string | false | null | undefined) => line && lines.push(upperFirst(line));

  // What the semantic review finds comes first: it reads the connectors' stated meaning, so it names
  // the right parts where the guesses below only look at shapes. A guess it covers is left out.
  const found = new Set<ReviewCode>();
  for (const finding of reviewView(nodes, edges)) {
    found.add(finding.code);
    say(`${finding.message} ${QUIP[finding.code]}`);
  }

  if (shapes.length === 0) say('Blank canvas, boss. The most reliable architecture there is.');
  const queue = first(['queue', 'topic', 'stream']);
  const dlq = first(['deadLetter']);
  if (queue && !dlq && !found.has('no-dead-letter')) say(`${named(queue)} has no dead-letter queue, boss. Bold choice. Want me to add one?`);
  if (queue) say(`${named(queue)} looks calm, boss. Too calm. Want me to check what happens when it isn’t?`);
  const topic = first(['topic']);
  if (topic) say(`${named(topic)} fans out to everyone, boss. Including the consumer you forgot about.`);
  const stores = shapes.filter((n) => categoryOf(n) === 'database' && named(n));
  const busiest = [...stores].sort((a, b) => (into.get(b.id) ?? 0) - (into.get(a.id) ?? 0))[0];
  if (busiest && (into.get(busiest.id) ?? 0) >= 3) say(`${named(busiest)} has ${into.get(busiest.id)} things writing to it. Who approved that? Oh. You did, boss.`);
  if (busiest) say(`Everything important ends up in ${named(busiest)}, boss. You do have backups. Right?`);
  const cache = first(['cache']);
  if (cache) say(`${named(cache)} is either making things fast or quietly serving stale data. Want me to find out which, boss?`);
  const cron = first(['scheduler', 'worker']);
  if (cron) say(`${named(cron)} runs at 3am, I assume. Somebody’s cron job. I think it’s yours, boss.`);
  const external = first(['external']);
  if (external) say(`${named(external)} is someone else’s problem, boss. Until it’s down. Then it’s yours.`);
  const actor = first(['actor']);
  if (actor) say(`${named(actor)} is going to click that button twice, boss. Plan for it.`);
  const hub = [...shapes].filter(named).sort((a, b) => (into.get(b.id) ?? 0) - (into.get(a.id) ?? 0))[0];
  if (hub && hub !== busiest && (into.get(hub.id) ?? 0) >= 3) say(`Everything goes through ${named(hub)}, boss. I’d hate for it to have a bad day.`);
  const orphan = shapes.find((n) => !linked.has(n.id) && named(n));
  if (orphan && shapes.length > 1 && !found.has('unconnected')) say(`${named(orphan)} isn’t connected to anything, boss. Feature or cry for help?`);
  const services = shapes.filter((n) => categoryOf(n) === 'service').length;
  if (services >= 5) say(`${services} services, boss. Who’s on call for all of them? You. It’s you.`);
  const unlabelled = edges.filter((e) => !e.label?.trim()).length;
  if (unlabelled >= 3) say(`${unlabelled} arrows with no label, boss. Very mysterious. Want me to name them?`);
  if (flows === 0 && edges.length >= 3) say('No flows yet, boss. Want me to show how a request actually travels?');
  if (openPoints > 0) say(`${openPoints === 1 ? 'One open point' : `${openPoints} open points`}, boss. They’re not closing themselves. I checked.`);
  if (groups === 0 && shapes.length >= 8) say(`${shapes.length} shapes and no boundaries, boss. Who owns what? Asking for the pager.`);
  if (shapes.length >= 25) say('This diagram is getting big, boss. Want me to tidy it? I won’t rename anything.');

  // A shape can hold a diagram of its own, which is easy never to find out.
  const roomy = shapes.find((n) => hasInside(n) && named(n));
  if (roomy) {
    say(`Psst, boss. ${named(roomy)} is bigger on the inside. Want a tour?`);
    say(`There’s a whole diagram inside ${named(roomy)}, boss. Select it and Look inside, or ask me.`);
  }
  const busyOne = shapes.find((n) => canCreateInside(n) && !hasInside(n) && named(n) && (into.get(n.id) ?? 0) + edges.filter((e) => e.source === n.id).length >= 3);
  if (busyOne) say(`${named(busyOne)} does a lot, boss. Want me to draw what’s inside it?`);

  // More of what every system like this learns the hard way, said about the parts that will learn it.
  if (actor) {
    say(`${named(actor)} will paste an emoji into a name field, boss. Validate it.`);
    say(`${named(actor)} will hit refresh mid-checkout, boss. That’s what idempotency keys are for.`);
    say(`${named(actor)} has 40 tabs open on hotel Wi-Fi, boss. Timeouts, please.`);
  }
  const agent = first(['agent']);
  if (agent) say(`${named(agent)} is an AI agent, boss. Give it the smallest permissions that work. Ask me how I know.`);
  if (queue) {
    say(`${named(queue)} delivers at least once, boss. So, twice. Make the consumer idempotent.`);
    say(`If ${named(queue)}’s consumers stop, it just keeps growing. Usually the bill notices first, boss.`);
    say(`${named(queue)} won’t keep order across consumers, boss. Don’t let anything assume it does.`);
  }
  if (topic) say(`Every new consumer of ${named(topic)} gets every message, boss. Even the 2am ones.`);
  if (dlq) say(`${named(dlq)} is where messages go to be forgotten, boss. Is anyone alerted when it fills up?`);
  if (busiest) {
    say(`${named(busiest)} will need a schema change on a busy day, boss. Plan the migration now.`);
    say(`One slow query on ${named(busiest)} and everything upstream waits, boss. Want me to find where?`);
  }
  const shared = stores.find((n) => (writers.get(n.id)?.size ?? 0) >= 2);
  if (shared && !found.has('shared-database')) {
    const [a, b] = [...writers.get(shared.id)!].map((id) => byId.get(id)!);
    if (named(a!) && named(b!)) say(`${named(a!)} and ${named(b!)} both write to ${named(shared)}, boss. That’s one service with extra steps.`);
  }
  if (cache) {
    say(`When ${named(cache)} restarts cold, every request hits the database at once, boss. Stampede.`);
    say(`There are two hard things in computer science, boss, and ${named(cache)} is one of them.`);
  }
  if (cron) {
    say(`If ${named(cron)} crashes halfway, does it start over or pick up where it left off, boss?`);
    say(`${named(cron)} retries failed jobs, right, boss? With backoff? Right?`);
  }
  const scheduler = first(['scheduler']);
  if (scheduler) say(`${named(scheduler)} and daylight saving time are going to have a disagreement, boss.`);
  const gateway = first(['gateway']);
  if (gateway) {
    say(`${named(gateway)} is a single point of failure with a nice name, boss.`);
    say(`${named(gateway)} needs rate limits, boss, before somebody’s script finds it.`);
  }
  if (external) say(`${named(external)} will change its API without telling you, boss. Is the version pinned?`);
  const chatty = shapes.find((n) => (callees.get(n.id)?.size ?? 0) >= 3 && named(n));
  if (chatty) say(`${named(chatty)} waits on ${callees.get(chatty.id)!.size} other things per request, boss. It’s only as fast as the slowest one.`);
  // Only things that call: a store answering its writer isn't a loop.
  const calls = (id: string) => {
    const node = byId.get(id);
    return node !== undefined && ['service', 'worker', 'gateway'].includes(categoryOf(node));
  };
  const loop = edges.find((e) => calls(e.source) && calls(e.target) && edges.some((back) => back.source === e.target && back.target === e.source));
  const [left, right] = loop ? [byId.get(loop.source), byId.get(loop.target)] : [];
  if (left && right && named(left) && named(right) && !found.has('call-cycle')) say(`${named(left)} and ${named(right)} call each other, boss. That’s not architecture, that’s a relationship.`);
  const owner = nodes.find((n) => n.type === 'group' && named(n) && nodes.some((m) => m.parentId === n.id));
  if (owner) say(`${named(owner)} owns ${nodes.filter((m) => m.parentId === owner.id).length} things, boss. Does it own the pager too?`);
  return lines;
}
