import { reviewView, type ReviewCode } from '../../agent/review';
import { canCreateInside, hasInside } from '../../depth/tree';
import { categoryOf, type NodeCategory } from '../../document/connectorSemantics';
import type { DraftEdge, DraftNode } from '../../document/types';
import type { AgentClient, AgentClientSetup, AgentSkillSetup, AgentSkillTarget } from '../api';

/**
 * What Nodi says from rest, in its speech bubble: the one thing worth knowing now, said the way an
 * over-eager companion would say it. Pure, so what it says in each state is one place to read and to
 * test, and the lines are data: more personality is more lines, not more code.
 */

export type RestingTone = 'greet' | 'selected' | 'working' | 'waiting' | 'done' | 'blocked' | 'poked';

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
  /** What Nodi can say about the time and day (`clockLines`), mixed in with the greetings. */
  clock?: readonly string[];
  /** What kind of part the selection is, when it is one shape. */
  selectedKind?: NodeCategory | null;
  /** Poked too many times in a row: Nodi says so, over anything but news. */
  poked?: boolean;
  /** Nodi's hello, while it is saying hello on the diagram's opening (`arrivalLine`). */
  arrival?: string;
}

/** An invitation now and then, and in between, what a companion who has seen too many incidents
 *  mutters to itself. Kept to a line or two: the bubble is small, and the canvas is the point. */
const GREETINGS = [
  'Boss, need a hand?',
  'I read your diagram twice, boss. Once for the architecture, once for the crimes.',
  'Boss. Boss. I found a single point of failure. It’s the database. It’s always the database.',
  'I used to live inside a load balancer, boss. Round and round. I don’t talk about it.',
  'It’s not DNS. There’s no way it’s DNS. …It was DNS, boss.',
  'A cron job fires at 3am and nobody knows why. The commit says “temp”. The author says boss.',
  'git blame is pointing at you, boss. I didn’t make it do that. I just held the flashlight.',
  'The postmortem said “human error”, boss. I’m not a human. Just saying.',
  'I named the next outage after you, boss. It felt right.',
  'There’s a feature flag at 50% since 2021. Half your users live in another timeline, boss.',
  'The queue is quiet, boss. I don’t like it when the queue is quiet.',
  'I asked the logs what happened. The logs said “success”. The logs lie, boss.',
  'Every arrow here is a network call that can fail. I counted. I wish I hadn’t.',
  'Your p50 is gorgeous, boss. Your p99 is a crime scene.',
  'Deploying on a Friday? Bold, boss. I’ll be in the bunker.',
  'I don’t sleep, boss. I wait for the 2am page like it owes me money.',
  'Someone set prod logging to DEBUG. The disk is filling like a bathtub, boss.',
  'Your circuit breaker is open, boss. Mine too. Emotionally.',
  'The README says “self-explanatory”. It is not, boss. I have questions. Many.',
  'If you can’t draw it, you can’t fix it at 3am. I can draw it. The 3am part is yours, boss.',
  // True, if said with a straight face: the laws and lessons this trade keeps relearning.
  'Conway’s law, boss: this diagram is your org chart in a fake mustache.',
  'Gall’s law: every complex system that works grew from a simple one that worked. Start small, boss.',
  'Hyrum’s law, boss: somebody depends on that bug. They will email you. In caps.',
  'Little’s law: queue length = arrival rate × wait. The queue did the math and it’s upset, boss.',
  'Brooks’s law: nine people can’t ship a feature in one month, boss. I asked.',
  '“The network is reliable,” said nobody who has met a network, boss.',
  'Latency is zero, boss, as long as you never leave localhost. Please leave localhost.',
  'CAP, boss: when the network splits, you pick consistency or availability. The network doesn’t ask first.',
  'Exactly-once delivery is a bedtime story, boss. Idempotency is the grown-up version.',
  'At-least-once means “twice, on a Friday, during the demo”, boss.',
  'A retry without backoff is a denial-of-service attack you wrote on yourself, boss.',
  'A thousand clients retrying on the same second is a stampede, boss. Add jitter.',
  'A retry without a timeout is hope with a for-loop.',
  'Cache stampede: one cold cache, ten thousand requests, one database crying in the corner.',
  'Two services sharing one database is a monolith in a trench coat, boss.',
  'A distributed monolith: every network call of microservices, every deploy of a monolith. Collect them all, boss.',
  'Clocks drift, boss. Two servers will never agree on “now”. Neither will two of your teams.',
  'Backpressure is a service saying “no” before it falls over. Healthier than most of us, boss.',
  '“It’s just one small microservice,” said every boss, forty microservices ago.',
  'I counted your services three times and got three answers. Eventual consistency, boss.',
  'Distributed tracing: watch one request visit eleven services and achieve nothing, boss.',
  'There are two hard things: cache invalidation, naming things and off-by-one errors.',
];

const SELECTED = [
  'Want me to look at {it}, boss?',
  'Ooh, {it}. Want my take, boss? It’s spicy.',
  '{it}? I have thoughts.',
  'I’ve been watching {it}, boss. It’s been watching back.',
  '{it} looks fine. That’s what worries me, boss.',
  'Ah, {it}. What has it done this time?',
  'Of all the boxes, boss, you picked {it}. Interesting.',
  '{it}. Bold choice. Want me to poke it?',
  '{it}, huh? Ask me what breaks first.',
  'If {it} goes down at 3am, who gets the call, boss? Asking for a friend. The friend is you.',
  'Careful with {it}, boss. Something depends on it. Something always does.',
  '{it}: load-bearing, or decorative? Let’s find out.',
  'Click me and I’ll tell you what {it} is hiding.',
  '{it} again? You two should get a room. A server room.',
  'I’d interview {it} before trusting it with prod, boss.',
  'Honest review of {it}, or the polite one? I only do honest, boss.',
  '{it} has a story, boss. Want to hear how it ends?',
];

/** What a part of a kind tends to have coming, said about the one selected: the same `{it}`. */
const SELECTED_BY_KIND: Partial<Record<NodeCategory, readonly string[]>> = {
  database: [
    '{it} holds the data, boss. Which means {it} holds the grudges.',
    'Is {it} backed up, boss? Ever restored? Those are different questions.',
    'Everyone writes to {it} eventually. That’s how it starts.',
    'A schema change on {it} on a Friday? I’ll get the popcorn.',
  ],
  cache: [
    '{it}: fast, until it’s wrong. Want me to check the invalidation, boss?',
    '{it} is lying to you, boss. Only slightly, and only sometimes.',
    'What happens when {it} restarts cold? I know. You won’t like it.',
  ],
  queue: [
    '{it} delivers at least once, boss. Which means twice.',
    'Messages go into {it}. Where do the bad ones go, boss?',
    '{it} is quiet. Too quiet.',
    'Who drains {it} when the consumers die, boss?',
  ],
  deadLetter: ['{it}: where messages go to be forgotten. Is anyone watching it, boss?', '{it} is full of regrets, boss. Want me to read them out?'],
  external: [
    '{it} is someone else’s problem, boss. Until it’s down.',
    '{it} will change its API on a Tuesday without telling you.',
    'What’s the timeout on calls to {it}, boss? Please don’t say “the default”.',
  ],
  gateway: ['{it}: the front door. Who rate-limits the door, boss?', 'Everything walks through {it}, boss. I hope it has good shoes.'],
  worker: [
    '{it} runs while you sleep, boss. Does it finish while you sleep?',
    'If {it} crashes halfway, does it start over, or charge someone twice?',
    '{it} and daylight saving time. Name a worse couple, boss.',
  ],
  service: [
    '{it} does a lot, boss. Want me to look inside?',
    'How many things call {it}? I counted. You won’t like it.',
    '{it} has one job, boss. Let’s check it only has one.',
  ],
  actor: [
    '{it} will click that button twice, boss. Plan for it.',
    '{it} doesn’t read error messages. Nobody does. Design for it.',
    '{it} is the reason any of this exists, boss. Be nice to {it}.',
  ],
  agent: ['{it} is an AI agent, boss. Smallest permissions that work. Ask me how I know.'],
  objectStorage: ['{it} is where files go to live forever, boss. Who pays for forever?', 'Please tell me {it} isn’t a public bucket, boss.'],
  searchIndex: ['{it} is a copy of the truth, boss. How far behind is it?'],
  port: ['{it} is a promise, boss. Who keeps it?'],
  device: ['{it} will go offline at the worst moment, boss. Queue things up.'],
  junction: ['{it} splits the flow, boss. Where does each path end up?'],
};
const KIND_ALIAS: Partial<Record<NodeCategory, NodeCategory>> = { topic: 'queue', stream: 'queue', scheduler: 'worker', component: 'service', fileSystem: 'objectStorage' };

/** For a selection of several things ("3 shapes") or a shape with no name: lines that read right
 *  whatever stands in for `{it}`. */
const SELECTED_MANY = [
  'Want me to look at {it}, boss?',
  '{it}? I have thoughts.',
  'Ooh, {it}. Want my take, boss?',
  '{it} at once? Ambitious, boss.',
  'Shall I go through {it}, boss? Gently. Or not.',
];

/** The line about the selection: a new one for each shape, and each time Nodi pipes up about it;
 *  half the time about what that kind of part has coming, when Nodi knows its kind. */
function selectedLine(name: string, kind: NodeCategory | null | undefined, seed: number): string {
  const at = seed + seedOf(name);
  const many = /^\d+ /.test(name) || name === 'the selected shape';
  const own = kind && !many ? (SELECTED_BY_KIND[KIND_ALIAS[kind] ?? kind] ?? []) : [];
  const line = many ? pick(SELECTED_MANY, at) : own.length && Math.abs(at) % 2 === 1 ? pick(own, Math.floor(at / 2)) : pick(SELECTED, at);
  return upperFirst(line.replaceAll('{it}', name));
}


const WORKING = ['On it, boss… {step}.', 'Rummaging through your choices, boss… {step}.', 'Don’t unplug me, boss… {step}.', 'Pretending this is fine… {step}.', 'Whistling innocently… {step}.'];

const WAITING = ['Got a change for you to look at, boss!', 'I made a thing, boss. It’s on the canvas. Be gentle.', 'Nothing lands until you say so, boss. Those are the rules. I hate the rules.', 'Your judgement is requested, boss. Very official.'];

const DONE = ['Done, boss! Come see what I found.', 'Boss. Boss. I found stuff.', 'Finished. I was very thorough. Mostly.', 'Done. Some of it is your fault, boss. Come read.'];

/** Clicked over and over: a companion has its dignity. */
const POKED = [
  'Boss. I’m a companion, not a fidget spinner.',
  'Poke me again and I’m filing an incident. Severity: personal.',
  'That’s a lot of clicks, boss. Is the diagram that bad? …It’s that bad, isn’t it.',
  'Stop that, boss. I bruise in pixels.',
  'Rate limit exceeded, boss. Try again in a few seconds. Or never.',
];

/** Said over a turn that fell over, before the agent's own words for why: the error is the fact. */
const FAILED = [
  'Well. That went sideways, boss.',
  'That broke, boss. Not my fault. Probably not yours either. Probably.',
  'It fell over, boss. I’d blame the network. It’s usually the network.',
  'Ow. That one hurt, boss. Ask me again and I’ll try again.',
];

export function failLine(seed: number): string {
  return pick(FAILED, seed);
}

/** The weather, as far as a companion without a window can tell: indoors, in the system. No
 *  location, no network: it can't see outside, and doesn't ask to. */
const WEATHER = [
  'Today’s forecast, boss: cloudy, with a 40% chance of 503s.',
  'Weather in us-east-1: partly degraded. As is tradition.',
  'I can’t see outside, boss. In here it’s humid, with scattered retries.',
  'A cold start is moving in from the west, boss. Bring a warm cache.',
  'Forecast: timeouts in the afternoon, clearing by the next deploy.',
  'Current conditions: 100% chance of someone saying “works on my machine”.',
];

/**
 * What Nodi says about the time, from the computer's own clock and nothing else: the hour and the
 * day are the only facts it uses, and the jokes are about what they mean for production.
 */
export function clockLines(now: Date): string[] {
  const time = now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const weekday = now.toLocaleDateString(undefined, { weekday: 'long' });
  const hour = now.getHours();
  const day = now.getDay();
  const lines: string[] = [];
  if (hour < 5) {
    lines.push(`It’s ${time}, boss. Nothing good has ever been deployed at ${time}.`);
    lines.push(`${time}. Go to bed, boss. The diagram will still be wrong in the morning.`);
  } else if (hour < 9) {
    lines.push(`${time} and already on architecture? Respect, boss. Coffee first, decisions second.`);
  } else if (hour >= 12 && hour < 14) {
    lines.push(`It’s ${time}, boss. Lunch is eventually consistent: it gets to you, just not now.`);
  } else if (hour >= 21) {
    lines.push(`${time}, boss. Big decisions read better after sleep. So do diagrams.`);
  } else if (hour >= 17) {
    lines.push(`${time}. Perfect time for “one small change”, said every incident report ever, boss.`);
  }
  if (day === 5 && hour >= 14) lines.push(`It’s ${weekday}, ${time}. Step away from the deploy button, boss.`);
  if (day === 1 && hour < 12) lines.push(`${weekday} morning, boss. Somebody’s weekend deploy is about to become your problem.`);
  if (day === 0 || day === 6) lines.push(`It’s ${weekday}, boss. Working on the weekend? I won’t tell the pager.`);
  if (now.getMonth() === 11 && now.getDate() >= 15) lines.push('Change-freeze season, boss. The diagram can change. Production can’t.');
  lines.push(`It’s ${time} here, boss. In UTC it’s ${now.toISOString().slice(11, 16)}. Your logs only know the second one.`);
  lines.push(WEATHER[(now.getDate() + hour) % WEATHER.length]!);
  return lines;
}

/** What Nodi knows about the diagram just opened, for its hello. */
export interface Arrival {
  title: string;
  shapes: number;
  connectors: number;
  flows: number;
  openPoints: number;
  /** How many shapes hold a diagram of their own. */
  insides: number;
  now: Date;
}

/**
 * Nodi's hello when a diagram opens: about this diagram — its name, its size, what is waiting in it —
 * not a line from the general repertoire that could have been said anywhere. The pick is the
 * diagram's own (`seed`), so reopening it in the same mood says the same, and another diagram something else.
 */
export function arrivalLine(at: Arrival, seed: number): string {
  const title = at.title.trim().slice(0, 40) || 'this one';
  const { shapes, connectors } = at;
  const hour = at.now.getHours();
  const when = hour < 5 ? 'at this hour' : hour < 12 ? 'this morning' : hour < 17 ? 'this afternoon' : 'this evening';
  if (shapes === 0) {
    return upperFirst(pick(
      [
        `A blank ${title}, boss. Zero bugs. Enjoy it while it lasts.`,
        `${title}: empty. The most reliable architecture there is. Shall we ruin it?`,
        `Fresh canvas, boss. Every outage starts somewhere. Usually here.`,
      ],
      seed,
    ));
  }
  const lines: string[] = [
    `Back in ${title}, boss. ${shapes} ${shapes === 1 ? 'part' : 'parts'}, ${connectors} ${connectors === 1 ? 'arrow' : 'arrows'}. I counted. Twice.`,
    `Oh, ${title}. I remember this one. It remembers you too.`,
    `${title}, ${when}. Let’s see what changed since you last looked. Probably everything.`,
    `${title} is open. Somewhere, a pager just got nervous.`,
    `${title} again, boss? Unfinished business, or unfinished business?`,
  ];
  if (shapes >= 20) lines.push(`${title}: ${shapes} parts. A big one, boss. Coffee first?`);
  if (shapes > 0 && shapes <= 4) lines.push(`${title}: ${shapes} ${shapes === 1 ? 'part' : 'parts'}. Small, boss. Small is how the big ones start.`);
  if (connectors === 0 && shapes > 1) lines.push(`${title} has ${shapes} parts and not one arrow, boss. A very peaceful architecture.`);
  if (at.openPoints > 0) lines.push(`${title} has ${at.openPoints === 1 ? 'an open point' : `${at.openPoints} open points`} waiting, boss. ${at.openPoints === 1 ? 'It' : 'They'} missed you.`);
  if (at.flows > 0) lines.push(`${title} has ${at.flows === 1 ? 'a flow' : `${at.flows} flows`} to present, boss. Want a rehearsal?`);
  else if (connectors >= 3) lines.push(`${title}: plenty of arrows, no flows yet. Nobody knows which way the request goes, boss. Except me. Maybe.`);
  if (at.insides > 0) lines.push(`${title} is bigger on the inside, boss. ${at.insides === 1 ? 'One part has a whole diagram in it.' : `${at.insides} parts have a whole diagram in them.`}`);
  if (hour < 5) lines.push(`Opening ${title} ${when}, boss? Bold. I’ll keep the pager away.`);
  return upperFirst(pick(lines, seed));
}

/** Whether it is the small hours, when Nodi dozes between messages. */
export function smallHours(now: Date): boolean {
  return now.getHours() < 5;
}

const BLOCKED = ['Psst, boss… I need a hand first.', 'I’m stuck, boss. Click and I’ll explain.', 'All revved up and nowhere to run, boss.'];

export function restingLine(state: RestingState): RestingLine {
  const { seed, runSeed } = state;
  if (state.blocked) return { tone: 'blocked', text: state.snag || pick(BLOCKED, seed), hint: state.snag ? 'Show me how' : 'See what’s missing', stays: false };
  if (state.working) return { tone: 'working', text: pick(WORKING, runSeed).replace('{step}', lowerFirst(state.working)), hint: 'Watch', stays: true };
  if (state.waiting) return { tone: 'waiting', text: pick(WAITING, runSeed), hint: 'Show me', stays: true };
  if (state.unseen) return { tone: 'done', text: pick(DONE, runSeed), hint: 'Open', stays: true };
  if (state.poked) return { tone: 'poked', text: pick(POKED, seed), hint: 'Click to chat', stays: true };
  if (state.arrival) return { tone: 'greet', text: state.arrival, hint: 'Click to chat', stays: false };
  if (state.selected) return { tone: 'selected', text: selectedLine(state.selected, state.selectedKind, seed), hint: 'Ask me', stays: false };
  // Every other greeting is about this diagram, when Nodi has something to say about it; of the
  // rest, every third is about the time of day, when Nodi was told it.
  const about = state.diagram ?? [];
  const clock = state.clock ?? [];
  const rest = Math.floor(seed / (about.length ? 2 : 1));
  const text =
    about.length && seed % 2 !== 0
      ? pick(about, (seed - 1) / 2)
      : clock.length && rest % 3 === 2
        ? pick(clock, Math.floor(rest / 3))
        : pick(GREETINGS, rest - (clock.length ? Math.floor((rest + 1) / 3) : 0));
  return { tone: 'greet', text, hint: 'Click to chat', stays: false };
}

/** A next step Nodi offers while it can't run, as one of the person's replies: each does the thing. */
export type SnagStep =
  | { kind: 'save'; label: string }
  | { kind: 'save-copy'; label: string }
  | { kind: 'settings'; label: string }
  /** Agent access switched on, here: the person's click is the decision Settings would ask for. */
  | { kind: 'allow'; label: string }
  /** One listed folder opened to agents, the one this diagram is in. */
  | { kind: 'allow-folder'; label: string; handle: string }
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
  /** The listed folder holding this diagram, when agents can't use it yet (see `blockedFolderOf`). */
  folder?: { handle: string; name: string } | null;
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
  // Turning access on lets agents into the person's folders, so it is theirs to do — and a click
  // here, on a button that says what it does, is them doing it. Sending them to Settings for the
  // same switch only made them hunt for it. Settings stays the second step, for the finer controls.
  if (facts.access === false) {
    return {
      line: 'Agent access is off, boss, so I’m locked out. Let me in? Agents on this computer, me included, can then work on diagrams in the folders you allow. Switch it off any time in Settings.',
      rest: 'Agent access is off, boss. I’m locked out.',
      steps: [
        { kind: 'allow', label: 'Let Nodi in' },
        { kind: 'settings', label: 'Open agent settings' },
      ],
    };
  }
  if (facts.folder) {
    return {
      line: `Agents can’t use ${facts.folder.name} yet, boss, and this diagram lives there. Open that folder to agents? Only that folder, and you can close it again in Settings.`,
      rest: `I’m not allowed in ${facts.folder.name}, boss.`,
      steps: [
        { kind: 'allow-folder', label: `Allow ${facts.folder.name}`, handle: facts.folder.handle },
        { kind: 'settings', label: 'Open agent settings' },
      ],
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

/**
 * The listed folder this file is in, when no listed folder agents may use holds it: the nearest one,
 * so allowing it opens no more than the diagram needs. Null when one already lets agents in, or when
 * no listed folder holds the file (only Settings can list a folder). Matched by the shell's own
 * display paths, which both come in the same form.
 */
export function blockedFolderOf(
  file: string,
  projects: readonly { handle: string; name: string; displayPath: string; agent: boolean }[],
): { handle: string; name: string } | null {
  const holds = (folder: string) => file.startsWith(`${folder.replace(/[\\/]+$/, '')}/`) || file.startsWith(`${folder.replace(/[\\/]+$/, '')}\\`);
  const holding = projects.filter((p) => holds(p.displayPath));
  if (holding.length === 0 || holding.some((p) => p.agent)) return null;
  const nearest = holding.reduce((a, b) => (b.displayPath.length > a.displayPath.length ? b : a));
  return { handle: nearest.handle, name: nearest.name };
}

/** One thing Nodi can set up for the agent it runs, in one click, with why it matters. */
export type SetupStep =
  | { kind: 'connect'; client: AgentClient; label: string; why: string }
  | { kind: 'skill'; target: AgentSkillTarget; label: string; why: string };

/**
 * What would make the agent Nodi runs better outside Nodi's box too, from Settings → AI agents' own
 * facts: Draft Canvas in that agent's MCP servers (so a conversation carried on in its terminal, or
 * any session of its own, still reaches the diagram) and the drawing skill in the folder it reads.
 * Only what Settings could do with its one-click buttons; an edited skill is the person's, and left be.
 */
export function setupStepsOf(
  agent: { agent: string; name: string },
  clients: readonly AgentClientSetup[] | null,
  skills: readonly AgentSkillSetup[] | null,
): SetupStep[] {
  if (agent.agent !== 'codex' && agent.agent !== 'claude-code') return [];
  const client = agent.agent as AgentClient;
  const target: AgentSkillTarget = client === 'claude-code' ? 'claude-code' : 'agents';
  const steps: SetupStep[] = [];
  const connection = clients?.find((c) => c.client === client);
  if (connection?.automatic && connection.state === 'not-set-up') {
    steps.push({
      kind: 'connect',
      client,
      label: `Connect ${agent.name} everywhere`,
      why: `${agent.name} only finds me inside this box, boss. One click and it finds Draft Canvas in your terminal and editor too, including when you continue there.`,
    });
  } else if (connection?.automatic && connection.state === 'outdated') {
    steps.push({ kind: 'connect', client, label: `Rewire ${agent.name}`, why: `${agent.name} is wired to another copy of Draft Canvas, boss. Or to nothing. One click and it’s this one.` });
  }
  const skill = skills?.find((s) => s.target === target);
  if (skill?.state === 'not-installed') {
    steps.push({
      kind: 'skill',
      target,
      label: `Teach ${agent.name} to draw`,
      why: `There’s a drawing skill for ${agent.name}, boss: C4 levels, real flows, notes with evidence. Installed once, every project gets it.`,
    });
  } else if (skill?.state === 'outdated') {
    steps.push({ kind: 'skill', target, label: 'Update the drawing skill', why: `${agent.name}’s drawing skill is from an older Draft Canvas, boss. Mine’s newer. Obviously.` });
  }
  return steps;
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
  'cache-not-written': 'It will serve yesterday’s answer with total confidence, boss.',
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
