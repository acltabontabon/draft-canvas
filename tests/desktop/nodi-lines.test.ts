import { describe, expect, it } from 'vitest';
import { createEdge, createNode } from '../../src/document/factory';
import { arrivalLine, updateLine, blockedFolderOf, smallTalkOf, clockLines, diagramLines, doorOf, goodbyeLine, openers, restingLine, returnLine, seedOf, setupStepsOf, smallHours, snagOf } from '../../src/desktop/ui/nodiLines';

/** What Nodi says from rest: the one thing worth knowing, most pressing first. */

const quiet = { blocked: false, working: null, waiting: false, unseen: false, selected: null, seed: 0, runSeed: 0 };

describe('Nodi at rest', () => {
  it('has seeded goodbyes and returns, with news and snags still coming first', () => {
    for (const line of [goodbyeLine, returnLine]) {
      const variants = Array.from({ length: 14 }, (_, seed) => line(seed));
      expect(new Set(variants).size).toBeGreaterThanOrEqual(6);
      for (const text of variants) expect(text).toMatch(/boss/i);
      expect(line(-123)).toBe(line(-123));
    }
    const departure = { ...quiet, departure: true, arrival: 'HELLO', selected: 'Orders' };
    expect(restingLine(departure)).toMatchObject({ text: goodbyeLine(0), stays: true });
    expect(restingLine({ ...quiet, returning: true, arrival: 'HELLO' })).toMatchObject({ text: returnLine(0), stays: false });
    expect(restingLine({ ...departure, blocked: true }).tone).toBe('blocked');
    expect(restingLine({ ...departure, working: 'Reading' }).tone).toBe('working');
    expect(restingLine({ ...departure, waiting: true }).tone).toBe('waiting');
    expect(restingLine({ ...departure, unseen: true }).tone).toBe('done');
    expect(restingLine({ ...departure, poked: true }).tone).toBe('poked');
  });

  it('greets, and offers to look at what is selected', () => {
    expect(restingLine(quiet)).toMatchObject({ tone: 'greet', text: 'Boss, need a hand?', stays: false });
    expect(restingLine({ ...quiet, selected: 'Orders database' })).toMatchObject({ tone: 'selected', text: expect.stringContaining('Orders database'), stays: false });
    // A line that starts with the name still starts with a capital.
    for (let seed = 0; seed < 40; seed += 1) expect(restingLine({ ...quiet, selected: 'orders', seed }).text).toMatch(/^[^a-z]/);
  });

  it('reads right for several things selected, or a shape with no name', () => {
    for (let seed = 0; seed < 20; seed += 1) {
      for (const many of ['2 shapes', '3 selected items', 'the selected shape']) {
        expect(restingLine({ ...quiet, selected: many, seed }).text).not.toMatch(/\ba (2|3|the) /);
      }
    }
  });

  it('has something new to say about each shape, and each time, about what its kind has coming', () => {
    const shapes = ['Orders database', 'Membership module', 'Notification module', 'Catalog', 'Billing', 'Loans'];
    expect(new Set(shapes.map((name) => restingLine({ ...quiet, selected: name }).text.replace(name, '{it}'))).size).toBeGreaterThan(3);
    const again = new Set([0, 1, 2, 3, 4, 5, 6, 7].map((seed) => restingLine({ ...quiet, selected: 'Membership module', seed }).text));
    expect(again.size).toBeGreaterThanOrEqual(6);
    // A database selected hears about databases some of the time.
    const db = [0, 1, 2, 3, 4, 5, 6, 7].map((seed) => restingLine({ ...quiet, selected: 'Orders database', selectedKind: 'database', seed }).text);
    expect(db.some((line) => /backed up|grudges|schema change|writes to/.test(line))).toBe(true);
  });

  it('says hello about the diagram that just opened, not a line from anywhere', () => {
    const now = new Date(2026, 9, 21, 10, 0);
    const at = { title: 'Library System', shapes: 7, connectors: 13, flows: 0, openPoints: 2, insides: 1, now };
    const hellos = new Set(Array.from({ length: 60 }, (_, seed) => arrivalLine(at, seed)));
    // Plenty of them: the same diagram opened again says something else.
    expect(hellos.size).toBeGreaterThan(15);
    for (const hello of hellos) expect(hello).toMatch(/Library System|Fresh canvas/);
    expect([...hellos].some((h) => h.includes('2 open points waiting'))).toBe(true);
    expect([...hellos].some((h) => h.includes('bigger on the inside'))).toBe(true);
    expect(arrivalLine({ ...at, shapes: 0, connectors: 0 }, 0)).toMatch(/blank|empty|Fresh canvas/i);
    // Grammar that holds for one, and a lower-case title still starts the line with a capital.
    const one = new Set(Array.from({ length: 60 }, (_, seed) => arrivalLine({ ...at, insides: 1 }, seed)));
    expect([...one].some((h) => h.includes('One part has a whole diagram in it.'))).toBe(true);
    for (let seed = 0; seed < 10; seed += 1) expect(arrivalLine({ ...at, title: 'orders' }, seed)).toMatch(/^[^a-z]/);
    // While it says hello, the hello is what it says.
    expect(restingLine({ ...quiet, arrival: 'HELLO' }).text).toBe('HELLO');
    expect(restingLine({ ...quiet, arrival: 'HELLO', unseen: true }).tone).toBe('done');
  });

  it('keeps saying what is under way, waiting or unread until it no longer is', () => {
    expect(restingLine({ ...quiet, working: 'Reading the diagram', waiting: true })).toMatchObject({ tone: 'working', text: 'On it, boss… reading the diagram.', stays: true });
    expect(restingLine({ ...quiet, waiting: true, unseen: true })).toMatchObject({ tone: 'waiting', stays: true });
    expect(restingLine({ ...quiet, unseen: true, selected: 'Orders database' })).toMatchObject({ tone: 'done', text: 'Done, boss! Come see what I found.', stays: true });
  });

  it('says first when it can’t run at all, and what is in the way when it knows', () => {
    expect(restingLine({ ...quiet, blocked: true, working: 'Reading the diagram' })).toMatchObject({ tone: 'blocked', stays: false });
    expect(restingLine({ ...quiet, blocked: true, snag: 'Agent access is off, boss. I’m locked out.' })).toMatchObject({
      tone: 'blocked',
      text: 'Agent access is off, boss. I’m locked out.',
      hint: 'Show me how',
    });
  });

  it('has a new line each time it pipes up, but one line for the whole of a run', () => {
    const greetings = new Set([0, 1, 2, 3, 4, 5].map((seed) => restingLine({ ...quiet, seed }).text));
    expect(greetings.size).toBe(6);
    const working = (seed: number) => restingLine({ ...quiet, working: 'Reading the diagram', seed, runSeed: seedOf('run-1') }).text;
    expect(working(0)).toBe(working(7));
    expect(seedOf('d_terpy4jwc2so')).toBe(seedOf('d_terpy4jwc2so'));
  });
});

describe('what stops Nodi, and the next step it offers', () => {
  const claude = { agent: 'claude-code', name: 'Claude Code', availability: 'installed' as const, version: '2.1.0', signIn: { loggedIn: true } };
  const ready = { doc: 'file' as const, readOnly: false, access: true, agentsKnown: true, agent: claude };

  it('is nothing when it can run, and nothing about access before the shell has said', () => {
    expect(snagOf(ready)).toBeNull();
    expect(snagOf({ ...ready, access: null })).toBeNull();
    // Unknown sign-in is not signed out.
    expect(snagOf({ ...ready, agent: { ...claude, signIn: { loggedIn: null } } })).toBeNull();
  });

  it('names the first thing in the way, with a step that does it', () => {
    expect(snagOf({ ...ready, doc: 'quick', readOnly: true, access: false })).toMatchObject({ steps: [{ kind: 'save', label: 'Save it to a folder' }] });
    expect(snagOf({ ...ready, readOnly: true, access: false })).toMatchObject({ steps: [{ kind: 'save-copy', label: 'Save a copy' }] });
    // Switching access on is the person's call: a button that does it, here, with Settings beside it.
    expect(snagOf({ ...ready, access: false })).toMatchObject({ steps: [{ kind: 'allow', label: 'Let Nodi in' }, { kind: 'settings' }] });
    expect(snagOf({ ...ready, folder: { handle: 'p1', name: 'Library' } })).toMatchObject({
      rest: 'I’m not allowed in Library, boss.',
      steps: [{ kind: 'allow-folder', label: 'Allow Library', handle: 'p1' }, { kind: 'settings' }],
    });
    expect(snagOf({ ...ready, agent: { ...claude, availability: 'too-old', version: '1.0.3' } })).toMatchObject({
      line: expect.stringContaining('Your Claude Code 1.0.3 is too old for me, boss.'),
      rest: 'Claude Code needs an update, boss.',
      steps: [{ kind: 'copy', label: 'Copy the update command', command: 'claude update' }],
    });
    expect(snagOf({ ...ready, agent: { ...claude, signIn: { loggedIn: false } } })).toMatchObject({
      line: expect.stringContaining('Run claude once in Terminal to sign in'),
      steps: [{ kind: 'copy', label: 'Copy the sign-in command', command: 'claude' }],
    });
    expect(snagOf({ ...ready, agent: { ...claude, availability: 'missing' } })).toMatchObject({ steps: [] });
    expect(snagOf({ ...ready, agent: null })).toMatchObject({ steps: [] });
  });

  it('finds the folder to allow: the nearest listed one holding the file, and none when one already lets agents in', () => {
    const outer = { handle: 'a', name: 'Work', displayPath: '~/Work', agent: false };
    const inner = { handle: 'b', name: 'Library', displayPath: '~/Work/Library', agent: false };
    expect(blockedFolderOf('~/Work/Library/plan.dcanvas', [outer, inner])).toEqual({ handle: 'b', name: 'Library' });
    expect(blockedFolderOf('~/Work/Library/plan.dcanvas', [{ ...outer, agent: true }, inner])).toBeNull();
    // Not a folder just because the name starts the same.
    expect(blockedFolderOf('~/Work/Library2/plan.dcanvas', [inner])).toEqual({ handle: null, name: '~/Work/Library2' });
    expect(blockedFolderOf('C:\\Work\\plan.dcanvas', [{ ...outer, displayPath: 'C:\\Work' }])).toEqual({ handle: 'a', name: 'Work' });
  });

  it('guides an unregistered folder through adding a project before granting access', () => {
    const folder = blockedFolderOf('~/Work/Library/plan.dcanvas', []);
    expect(folder).toEqual({ handle: null, name: '~/Work/Library' });
    expect(snagOf({ ...ready, folder })).toMatchObject({
      line: expect.stringContaining('~/Work/Library'),
      steps: [{ kind: 'add-project', label: 'Add project…' }],
    });
    expect(blockedFolderOf('C:\\Work\\plan.dcanvas', [])).toEqual({ handle: null, name: 'C:\\Work' });
    expect(blockedFolderOf('~/Work/plan.dcanvas', [{ handle: 'other', name: 'Other', displayPath: '~/Other', agent: true }])).toEqual({ handle: null, name: '~/Work' });
  });

  it('says it in Nodi’s voice, with a short line for rest', () => {
    for (const facts of [{ ...ready, doc: 'quick' as const }, { ...ready, readOnly: true }, { ...ready, access: false }]) {
      const snag = snagOf(facts)!;
      expect(snag.line).toMatch(/boss/);
      expect(snag.rest.length).toBeLessThan(snag.line.length);
    }
  });

  it('gives an agent with no known commands the words without a command', () => {
    expect(snagOf({ ...ready, agent: { ...claude, agent: 'other', name: 'Other', availability: 'too-old' } })).toMatchObject({ steps: [] });
  });
});

describe('the replies Nodi offers', () => {
  it('words them as the person would, and asks the agent plainly', () => {
    const [walk, risks, wild] = openers(null, 0);
    expect(walk).toEqual({ label: 'Walk me through it', prompt: 'Explain this diagram' });
    expect(risks!.prompt).toBe('What are the risks here?');
    // The wildcard's nerve stays in the label; the agent gets an honest review request.
    expect(wild!.label).toBe('Roast my diagram');
    expect(wild!.prompt).not.toMatch(/roast/i);
  });

  it('are about the selection by name when there is one, with a new wildcard each time', () => {
    const options = openers('Orders database', 1);
    expect(options.map((o) => o.label)).toEqual(['What’s Orders database doing here?', 'What could go wrong with Orders database?', 'What would Orders database break at 3am?']);
    expect(new Set([0, 1, 2, 3].map((seed) => openers(null, seed)[2]!.label)).size).toBe(4);
  });
});

describe('what Nodi says about the diagram', () => {
  const api = createNode({ id: 'api', type: 'service', x: 0, y: 0, text: 'Orders API' });
  const worker = createNode({ id: 'w', type: 'service', serviceKind: 'worker', x: 0, y: 0, text: 'Fulfilment worker' });
  const db = createNode({ id: 'db', type: 'database', x: 0, y: 0, text: 'Orders database' });
  const queue = createNode({ id: 'q', type: 'queue', x: 0, y: 0, text: 'orders' });
  const lonely = createNode({ id: 'x', type: 'service', x: 0, y: 0, text: 'Legacy billing' });
  const nodes = [api, worker, db, queue, lonely];
  const edges = [
    createEdge({ id: 'e1', source: 'api', target: 'q' }),
    createEdge({ id: 'e2', source: 'q', target: 'w' }),
    createEdge({ id: 'e3', source: 'w', target: 'db' }),
    createEdge({ id: 'e4', source: 'api', target: 'db' }),
    createEdge({ id: 'e5', source: 'q', target: 'db' }),
  ];

  it('notices what is there by name, and who is to blame', () => {
    const lines = diagramLines(nodes, edges, 0, 2);
    expect(lines).toEqual(
      expect.arrayContaining([
        'Queue "orders" has consumers ("Fulfilment worker" and "Orders database") but no dead-letter path: a message that keeps failing has nowhere to go. Bold choice, boss. Want me to add one?',
        'Orders database has 3 things writing to it. Who approved that? Oh. You did, boss.',
        'Fulfilment worker runs at 3am, I assume. Somebody’s cron job. I think it’s yours, boss.',
        // From the semantic review, which reads the connectors: the fact first, then Nodi's word.
        '"Legacy billing" has no connections in this view. Feature or cry for help, boss?',
        'No flows yet, boss. Want me to show how a request actually travels?',
        '2 open points, boss. They’re not closing themselves. I checked.',
      ]),
    );
  });

  it('knows the hard lessons of the parts it sees', () => {
    const lines = diagramLines(nodes, edges, 1, 0);
    expect(lines).toEqual(
      expect.arrayContaining([
        'Orders delivers at least once, boss. So, twice. Make the consumer idempotent.',
        'Fulfilment worker and Orders API both write to Orders database, boss. That’s one service with extra steps.',
        'If Fulfilment worker crashes halfway, does it start over or pick up where it left off, boss?',
      ]),
    );
    // Two services calling each other.
    const looped = diagramLines(nodes, [...edges, createEdge({ id: 'e6', source: 'db', target: 'api' }), createEdge({ id: 'e7', source: 'api', target: 'w' }), createEdge({ id: 'e8', source: 'w', target: 'api' })], 1, 0);
    expect(looped).toContain('Orders API and Fulfilment worker call each other, boss. That’s not architecture, that’s a relationship.');
  });

  it('says only what holds', () => {
    const dlq = createNode({ id: 'dlq', type: 'queue', deliveryRole: 'dead-letter', x: 0, y: 0, text: 'orders-dlq' });
    const lines = diagramLines([...nodes, dlq], edges, 1, 0);
    expect(lines.some((l) => l.includes('no dead-letter queue'))).toBe(false);
    expect(lines.some((l) => l.includes('No flows yet'))).toBe(false);
    expect(lines.some((l) => l.includes('open point'))).toBe(false);
    expect(lines.some((l) => l.includes('call each other'))).toBe(false);
    expect(lines.some((l) => l.includes('API without telling you'))).toBe(false);
    expect(diagramLines([], [], 0, 0)).toEqual(['Blank canvas, boss. The most reliable architecture there is.']);
  });

  it('mixes them in with the greetings, every other time', () => {
    const diagram = diagramLines(nodes, edges, 0, 0);
    const said = [0, 1, 2, 3].map((seed) => restingLine({ ...quiet, seed, diagram }).text);
    expect(diagram).toContain(said[1]);
    expect(diagram).toContain(said[3]);
    expect(diagram).not.toContain(said[0]);
  });
});

describe('pointing the way inside', () => {
  const room = { nodes: [createNode({ id: 'c1', type: 'component', x: 0, y: 0, text: 'Catalog' })], edges: [], flows: [], viewport: { x: 0, y: 0, zoom: 1 } };
  const roomy = { ...createNode({ id: 'lib', type: 'service', x: 0, y: 0, text: 'Library System' }), inside: room };
  const plain = createNode({ id: 'mail', type: 'service', x: 0, y: 0, text: 'Email Service' });

  it('offers to step inside the selected shape that holds a diagram, or to draw one it could hold', () => {
    const into = openers('Library System', 0, { into: { id: 'lib', name: 'Library System' } });
    expect(into[2]).toEqual({ label: 'Take me inside Library System', prompt: '', enter: 'lib' });
    const draw = openers('Email Service', 0, { drawable: true });
    expect(draw[2]!.label).toBe('Draw what’s inside Email Service');
    expect(draw[2]!.prompt).toMatch(/component view inside this element/);
    expect(draw[2]!.enter).toBeUndefined();
  });

  it('with nothing selected, the way in every other time, a wildcard otherwise', () => {
    const look = { into: { id: 'lib', name: 'Library System' } };
    expect(openers(null, 0, look)[2]!.enter).toBe('lib');
    expect(openers(null, 1, look)[2]!.enter).toBeUndefined();
  });

  it('finds the door, the selected shape first, and says it is bigger on the inside', () => {
    const other = { ...roomy, id: 'lib2', text: 'Archive' };
    expect(doorOf([plain, roomy, other], [], (n) => n.text!)).toEqual({ id: 'lib', name: 'Library System' });
    expect(doorOf([plain, roomy, other], ['lib2'], (n) => n.text!)).toEqual({ id: 'lib2', name: 'Archive' });
    expect(doorOf([plain], [], (n) => n.text!)).toBeNull();
    expect(diagramLines([roomy, plain], [], 0, 0)).toContain('Psst, boss. Library System is bigger on the inside. Want a tour?');
  });
});

describe('setting the agent up from Nodi', () => {
  const codex = { agent: 'codex', name: 'Codex' };
  const client = (state: 'not-set-up' | 'ready' | 'outdated', automatic = true) => ({ client: 'codex' as const, state, automatic, location: null, configuredCommand: null });
  const skill = (state: 'not-installed' | 'ready' | 'outdated' | 'modified' | 'newer') => ({ target: 'agents' as const, state, location: null, installedVersion: null, bundledVersion: '10', backup: null });

  it('offers what Settings would, for the agent Nodi runs, one click each', () => {
    const steps = setupStepsOf(codex, [client('not-set-up')], [skill('not-installed')]);
    expect(steps.map((s) => s.kind)).toEqual(['connect', 'skill']);
    expect(steps[0]).toMatchObject({ client: 'codex', label: 'Connect Codex everywhere' });
    expect(steps[1]).toMatchObject({ target: 'agents', label: 'Teach Codex to draw' });
    expect(setupStepsOf(codex, [client('outdated')], [skill('outdated')]).map((s) => s.label)).toEqual(['Rewire Codex', 'Update the drawing skill']);
  });

  it('leaves alone what is done, what only a terminal can do, and a skill the person edited', () => {
    expect(setupStepsOf(codex, [client('ready')], [skill('ready')])).toEqual([]);
    expect(setupStepsOf(codex, [client('not-set-up', false)], [skill('modified')])).toEqual([]);
    expect(setupStepsOf({ agent: 'claude-code', name: 'Claude Code' }, [client('not-set-up')], [skill('not-installed')])).toEqual([]);
    expect(setupStepsOf(codex, null, null)).toEqual([]);
  });
});

describe('what Nodi says about the time', () => {
  it('reads the hour and day off the clock, and nothing else', () => {
    const late = clockLines(new Date(2026, 9, 21, 2, 14));
    expect(late.some((l) => l.includes('Nothing good has ever been deployed at'))).toBe(true);
    expect(smallHours(new Date(2026, 9, 21, 2, 14))).toBe(true);
    expect(smallHours(new Date(2026, 9, 21, 10, 0))).toBe(false);
    // Friday afternoon (23 October 2026 is a Friday).
    expect(clockLines(new Date(2026, 9, 23, 16, 0)).some((l) => l.includes('Step away from the deploy button'))).toBe(true);
    // And always the weather it can't see, and the time in UTC.
    const noon = clockLines(new Date(2026, 9, 21, 10, 30));
    expect(noon.some((l) => l.includes('In UTC it’s'))).toBe(true);
    expect(noon.length).toBeGreaterThanOrEqual(2);
  });

  it('mixes the time in every third greeting, keeping every greeting new', () => {
    const clock = ['CLOCK'];
    const said = [0, 1, 2, 3, 4, 5].map((seed) => restingLine({ ...quiet, seed, clock }).text);
    expect(said[2]).toBe('CLOCK');
    expect(said[5]).toBe('CLOCK');
    expect(new Set(said.filter((l) => l !== 'CLOCK')).size).toBe(4);
  });

  it('has a word to say when poked too often, and it stays up', () => {
    expect(restingLine({ ...quiet, poked: true })).toMatchObject({ tone: 'poked', stays: true });
    // News still wins.
    expect(restingLine({ ...quiet, poked: true, unseen: true }).tone).toBe('done');
  });
});

describe('small talk Nodi answers itself', () => {
  it('answers a greeting, a thanks, an okay, a goodbye or a how-are-you, however it is typed', () => {
    for (const said of ['hello', 'Hello!', 'hey boss', 'Hi there 👋', 'good morning', 'thanks', 'Thank you!!', 'ok', 'lol', 'bye', 'How are you?', 'what’s up', 'whats your name', 'Who are you?', 'how old are you?', 'how hold are you?', 'are you an AI?', 'tell me a joke', 'good job', 'you there?']) {
      expect(smallTalkOf(said, 0), said).toMatch(/\w/);
    }
  });

  it('says its own name, whatever runs it', () => {
    for (let seed = 0; seed < 3; seed += 1) expect(smallTalkOf('what’s your name?', seed)).toMatch(/Nodi/);
  });

  it('passes short confirmations to an ongoing agent conversation', () => {
    for (const said of ['yes', 'Yep!', 'sure', 'okay', 'sounds good', 'alright']) {
      expect(smallTalkOf(said, 0, true), said).toBeNull();
      expect(smallTalkOf(said, 0), said).not.toBeNull();
    }
    expect(smallTalkOf('thanks', 0, true)).not.toBeNull();
    expect(smallTalkOf('hello', 0, true)).not.toBeNull();
  });

  it('sends anything more to the agent', () => {
    for (const said of ['hello, what breaks first?', 'hi can you add a cache', 'thanks, now add a queue', 'ok do it', 'why', 'explain this', 'hey what is this service for', 'how old is the database', 'what can you do with the queue', 'help me add a cache', '']) {
      expect(smallTalkOf(said, 0), said).toBeNull();
    }
  });
});

describe('a new version, mentioned', () => {
  it('names it, says whether it is waiting, and opens the update panel rather than the chat', () => {
    expect(updateLine('1.16.0', false)).toMatch(/1\.16\.0/);
    expect(updateLine('1.16.0', true)).toMatch(/1\.16\.0.*(waiting|ready)/);
    expect(restingLine({ ...quiet, update: 'NEWS' })).toMatchObject({ tone: 'update', text: 'NEWS', hint: 'What’s new' });
    // Work under way and news of a turn come first.
    expect(restingLine({ ...quiet, update: 'NEWS', working: 'Reading the diagram' }).tone).toBe('working');
  });
});
