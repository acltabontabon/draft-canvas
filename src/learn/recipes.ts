import type { LearnRecipe, RecipeCategory } from './types';

/**
 * Every recipe Learn knows, in the order Explore lists them. Copy rules: the title is the question
 * someone would ask, the summary is one sentence a developer would say out loud, and every label it
 * names must be a label the product actually shows. The scene (same id, `scenes/`) does the rest.
 *
 * Adding one: an entry here plus a scene in `scenes/index.ts` — the compiler insists on the pair.
 */
export const RECIPES = [
  {
    id: 'add-shape',
    title: 'Drop a shape',
    summary: 'Press a letter and it lands under your cursor.',
    category: 'shapes',
    keywords: ['add', 'create', 'new', 'node', 'box', 'element', 'place', 'draw', 'service', 'data store', 'queue', 'actor', 'component', 'letter'],
    keys: [['s'], ['d'], ['q'], ['a']],
    note: 'Or double-click empty canvas for a quick picker.',
    related: ['pick-a-kind', 'connect', 'starters'],
    quickStart: 1,
  },
  {
    id: 'connect',
    title: 'Connect two things',
    summary: 'Drag from a handle onto another shape.',
    category: 'connections',
    keywords: ['connection', 'connector', 'arrow', 'line', 'link', 'edge', 'wire', 'relationship', 'drag', 'handle', 'anchor'],
    note: 'Drop on empty canvas instead to create the next shape and wire it in one go.',
    related: ['describe-interaction', 'junction', 'intent-continuation'],
    appliesTo: { nodeTypes: ['service', 'database', 'queue', 'actor', 'component'] },
    quickStart: 2,
  },
  {
    id: 'describe-interaction',
    title: 'Say what the arrow means',
    summary: 'Pick an interaction type and the line labels itself.',
    category: 'connections',
    keywords: ['interaction', 'type', 'semantic', 'meaning', 'relationship', 'label', 'http', 'grpc', 'event', 'reads', 'writes', 'publishes', 'consumes', 'calls', 'protocol'],
    note: 'Only the types that make sense for that pair are offered.',
    related: ['make-async', 'add-response', 'attach-to-connector'],
    appliesTo: { edge: true },
    quickStart: 3,
  },
  {
    id: 'attach-note',
    title: 'Attach a note',
    summary: 'Drag a note onto a shape and hold until it docks.',
    category: 'shapes',
    keywords: ['note', 'comment', 'annotate', 'annotation', 'context', 'detail', 'attach', 'attachment', 'explain', 'sticky'],
    note: 'Or right-click a shape → Add Note.',
    related: ['attach-to-connector', 'pick-a-kind'],
    appliesTo: { nodeTypes: ['service', 'database', 'queue', 'actor', 'component', 'group'] },
    quickStart: 4,
  },
  {
    id: 'add-to-flow',
    title: 'Tell it as a flow',
    summary: 'Select a connector, then Add to flow — each one becomes the next step.',
    category: 'flows',
    keywords: ['flow', 'story', 'steps', 'scenario', 'path', 'journey', 'order', 'use case', 'happy path'],
    keys: [['f']],
    note: 'F opens every flow on the canvas.',
    related: ['present-flow', 'export-sequence'],
    appliesTo: { edge: true },
    quickStart: 5,
  },
  {
    id: 'present-flow',
    title: 'Present a flow',
    summary: 'Walk the room through it, one step at a time.',
    category: 'flows',
    keywords: ['present', 'presentation', 'slides', 'demo', 'meeting', 'walkthrough', 'play', 'fullscreen', 'next step'],
    keys: [['mod', 'enter'], ['right'], ['esc']],
    related: ['add-to-flow', 'export-sequence'],
    quickStart: 6,
  },
  {
    id: 'make-async',
    title: 'Make a call async',
    summary: 'Set Interaction mode to Async — the line gets a break mark.',
    category: 'connections',
    keywords: ['async', 'asynchronous', 'sync', 'synchronous', 'mode', 'fire and forget', 'non-blocking', 'background', 'dashed'],
    note: 'Want it dashed as well? Right-click the connector → Make async.',
    related: ['describe-interaction', 'add-response'],
    appliesTo: { edge: true },
  },
  {
    id: 'add-response',
    title: 'Show the response',
    summary: 'Turn Response on to draw the reply coming back.',
    category: 'connections',
    keywords: ['response', 'reply', 'return', 'status', 'request', 'round trip', '200'],
    note: 'Guess fills in a sensible status and body.',
    related: ['make-async', 'attach-to-connector'],
    appliesTo: { edge: true },
  },
  {
    id: 'attach-to-connector',
    title: 'Put a payload on a connector',
    summary: 'Drop a code card onto the line to attach it.',
    category: 'connections',
    keywords: ['payload', 'json', 'example', 'code', 'snippet', 'schema', 'body', 'message', 'attach', 'attachment'],
    note: 'Notes attach to connectors the same way.',
    related: ['attach-note', 'describe-interaction'],
    appliesTo: { edge: true },
  },
  {
    id: 'pick-a-kind',
    title: 'Pick the right kind',
    summary: 'Same shape, sharper meaning — a queue becomes a topic, a store becomes a cache.',
    category: 'shapes',
    keywords: ['kind', 'type', 'topic', 'stream', 'cache', 'data store', 'database', 'sql', 'nosql', 'object storage', 'search index', 'worker', 'gateway', 'external', 'scheduler', 'api', 'port', 'adapter'],
    related: ['dead-letter-queue', 'add-shape'],
    appliesTo: { nodeTypes: ['service', 'database', 'queue', 'actor', 'component'] },
  },
  {
    id: 'dead-letter-queue',
    title: 'Add a dead-letter queue',
    summary: 'Select a queue, then Add DLQ.',
    category: 'architecture',
    keywords: ['dlq', 'dead letter', 'poison message', 'retry', 'failure', 'error queue', 'redrive', 'delivery attempts'],
    note: 'Messages land there after 3 failed deliveries — change it on the connector.',
    related: ['pick-a-kind', 'intent-continuation'],
    appliesTo: { nodeTypes: ['queue'], kinds: ['queue'] },
  },
  {
    id: 'boundary',
    title: 'Group into a boundary',
    summary: 'Select a few shapes and group them.',
    category: 'architecture',
    keywords: ['boundary', 'group', 'grouping', 'domain', 'bounded context', 'system', 'network', 'region', 'deployment', 'cluster', 'container', 'ungroup'],
    keys: [['mod', 'g'], ['mod', 'shift', 'g']],
    note: 'Drag a shape inside a boundary to add it.',
    related: ['junction', 'starters'],
    appliesTo: { nodeTypes: ['group'] },
  },
  {
    id: 'junction',
    title: 'Branch with a junction',
    summary: 'Route one source to many targets through a single point.',
    category: 'connections',
    keywords: ['junction', 'branch', 'fan out', 'split', 'router', 'merge', 'fork', 'join', 'decision'],
    keys: [['j']],
    note: 'A bundled connector can become one too: right-click → Convert to junction.',
    related: ['connect', 'boundary'],
    appliesTo: { nodeTypes: ['ellipse'] },
  },
  {
    id: 'intent-continuation',
    title: 'Take the suggested next move',
    summary: 'Select a shape — Tab accepts the ghost, ] shows another idea.',
    category: 'architecture',
    keywords: ['suggest', 'suggestion', 'next', 'autocomplete', 'ghost', 'continuation', 'intent', 'tab', 'complete'],
    keys: [['tab'], [']'], ['[']],
    note: 'Turn suggestions off in Canvas settings.',
    related: ['dead-letter-queue', 'connect'],
    appliesTo: { nodeTypes: ['service', 'queue', 'actor', 'component'] },
  },
  {
    id: 'starters',
    title: 'Start from a known architecture',
    summary: 'Type a pattern into the command palette, press Enter.',
    category: 'architecture',
    keywords: ['starter', 'template', 'example', 'pattern', 'architecture', 'microservices', 'event-driven', 'cqrs', 'saga', 'outbox', 'hexagonal', 'monolith', 'bff', 'medallion', 'kappa', 'cdc'],
    keys: [['mod', 'k']],
    note: 'A starter lands on the canvas you’re on — it never replaces it.',
    related: ['add-shape', 'boundary'],
  },
  {
    id: 'export-sequence',
    title: 'Export a flow as a sequence diagram',
    summary: 'Export → Source, then Mermaid or PlantUML.',
    category: 'flows',
    keywords: ['export', 'sequence', 'sequence diagram', 'mermaid', 'plantuml', 'uml', 'mmd', 'puml', 'diagram as code', 'markdown', 'docs', 'text'],
    keys: [['mod', 'e']],
    note: 'Every flow on the canvas lands in the same file.',
    related: ['add-to-flow', 'present-flow'],
  },
] as const satisfies readonly LearnRecipe[];

export type RecipeId = (typeof RECIPES)[number]['id'];

const BY_ID: ReadonlyMap<string, LearnRecipe> = new Map(RECIPES.map((recipe) => [recipe.id, recipe]));

export function recipeById(id: string | null | undefined): LearnRecipe | undefined {
  return id ? BY_ID.get(id) : undefined;
}

/** The curated "short version" path, in order. */
export const QUICK_START: readonly LearnRecipe[] = (RECIPES as readonly LearnRecipe[])
  .filter((recipe) => recipe.quickStart !== undefined)
  .sort((a, b) => a.quickStart! - b.quickStart!);

export interface LearnCategory {
  id: RecipeCategory;
  label: string;
  /** The architecture primitive drawn beside the label. */
  glyph: 'service' | 'connector' | 'queue' | 'flow';
}

export const CATEGORIES: readonly LearnCategory[] = [
  { id: 'shapes', label: 'Shapes', glyph: 'service' },
  { id: 'connections', label: 'Connections', glyph: 'connector' },
  { id: 'architecture', label: 'Architecture', glyph: 'queue' },
  { id: 'flows', label: 'Flows', glyph: 'flow' },
];

export function recipesIn(category: RecipeCategory): readonly LearnRecipe[] {
  return (RECIPES as readonly LearnRecipe[]).filter((recipe) => recipe.category === category);
}
