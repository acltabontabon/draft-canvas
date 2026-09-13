import { fuzzyMatch } from '../commands/fuzzy';
import { RECIPES } from './recipes';
import type { LearnRecipe } from './types';

/**
 * "How do I…" search over a few dozen recipes. Deliberately not a search engine: someone types the
 * word they have in their head — "kafka", "db", "dlq" — and the right recipe should simply be first.
 * So the scoring is a short ladder of plain, explainable signals (title word, keyword, alias,
 * summary) with the palette's own fuzzy matcher only as a last resort for typos and abbreviations.
 */

/** Words people use for things Draft Canvas names differently. Each maps to terms recipes carry. */
const ALIASES: Readonly<Record<string, readonly string[]>> = {
  kafka: ['topic', 'stream', 'queue', 'event'],
  rabbitmq: ['queue', 'topic'],
  rabbit: ['queue', 'topic'],
  sqs: ['queue', 'dead letter'],
  sns: ['topic'],
  pubsub: ['topic', 'publishes'],
  'pub/sub': ['topic', 'publishes'],
  broker: ['queue', 'topic'],
  message: ['queue', 'topic', 'payload'],
  messaging: ['queue', 'topic'],
  db: ['database', 'cache', 'data store'],
  postgres: ['sql', 'data store'],
  mysql: ['sql', 'data store'],
  mongo: ['nosql', 'data store'],
  redis: ['cache', 'data store'],
  s3: ['object storage'],
  storage: ['object storage', 'data store'],
  elasticsearch: ['search index'],
  sequence: ['sequence diagram'],
  uml: ['sequence diagram'],
  diagram: ['sequence diagram'],
  comments: ['note'],
  sticky: ['note'],
  slideshow: ['presentation'],
  slides: ['presentation'],
  walkthrough: ['presentation', 'flow'],
  poison: ['dead letter'],
  retries: ['dead letter'],
  reply: ['response'],
  vpc: ['boundary', 'network'],
  context: ['boundary', 'note'],
  fanout: ['fan out', 'junction'],
  'fan-out': ['fan out', 'junction'],
  template: ['starter'],
  templates: ['starter'],
  autocomplete: ['suggestion'],
  arrow: ['connector'],
  dashed: ['async'],
  gateway: ['kind', 'junction'],
  webhook: ['async', 'interaction'],
  rest: ['http', 'response'],
  api: ['http', 'kind'],
  image: ['export'],
  png: ['export'],
};

/** Terms that mean "show me the keys" — answered by the Keyboard shortcuts row, not by a recipe. */
const SHORTCUT_TERMS = ['shortcut', 'shortcuts', 'keyboard', 'keys', 'hotkey', 'hotkeys', 'keybinding', 'cheatsheet'];

export interface RecipeMatch {
  recipe: LearnRecipe;
  score: number;
  /** Title characters to highlight — empty when the match came from somewhere other than the title. */
  titleIndices: readonly number[];
}

export interface LearnSearchResult {
  recipes: readonly RecipeMatch[];
  /** Whether the Keyboard shortcuts row answers this query too. */
  shortcuts: boolean;
}

export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** "notes" → "note", "queues" → "queue" — enough English for a recipe index, and no more. */
function singular(term: string): string | null {
  if (term.length <= 3 || !term.endsWith('s') || term.endsWith('ss')) return null;
  return term.slice(0, -1);
}

function range(start: number, length: number): number[] {
  return Array.from({ length }, (_, i) => start + i);
}

/** Where `term` starts a word in `text` (lowercased), or -1. */
function wordStartIndex(text: string, term: string): number {
  let from = 0;
  for (;;) {
    const at = text.indexOf(term, from);
    if (at < 0) return -1;
    if (at === 0 || /[\s\-/(·—]/.test(text[at - 1]!)) return at;
    from = at + 1;
  }
}

function keywordScore(keywords: readonly string[], term: string, exact: number, prefix: number): number {
  let best = 0;
  for (const keyword of keywords) {
    if (keyword === term) best = Math.max(best, exact);
    else if (term.length >= 2 && wordStartIndex(keyword, term) >= 0) best = Math.max(best, prefix);
  }
  return best;
}

/** One term against one recipe: the best of its plain signals, before aliases or fuzzy. */
function termScore(recipe: LearnRecipe, term: string): { score: number; titleIndices: number[] } {
  const title = recipe.title.toLowerCase();
  const titleAt = wordStartIndex(title, term);
  if (titleAt >= 0) return { score: titleAt === 0 ? 110 : 100, titleIndices: range(titleAt, term.length) };
  const keyword = keywordScore(recipe.keywords, term, 80, 60);
  if (keyword > 0) return { score: keyword, titleIndices: [] };
  if (term.length >= 3 && recipe.summary.toLowerCase().includes(term)) return { score: 25, titleIndices: [] };
  return { score: 0, titleIndices: [] };
}

function scoreRecipe(recipe: LearnRecipe, query: string): { score: number; titleIndices: number[] } {
  const variants = [query, singular(query)].filter((term): term is string => term !== null);
  let best = { score: 0, titleIndices: [] as number[] };
  for (const [i, term] of variants.entries()) {
    const hit = termScore(recipe, term);
    // The singular form is a guess about what was meant, so it gives up a little.
    const score = hit.score - i * 2;
    if (score > best.score) best = { score, titleIndices: hit.titleIndices };

    // Aliases are listed closest meaning first — Kafka is a topic before it is a queue.
    for (const [rank, alias] of (ALIASES[term] ?? []).entries()) {
      const aliased = termScore(recipe, alias);
      const aliasScore = Math.min(aliased.score, 80) - 30 - rank * 6;
      if (aliasScore > best.score) best = { score: aliasScore, titleIndices: [] };
    }
  }

  // Several words: every one has to land somewhere, and together they rank like a keyword hit.
  const words = query.split(' ').filter((word) => word.length > 1);
  if (best.score === 0 && words.length > 1) {
    const hits = words.map((word) => termScore(recipe, singular(word) ?? word).score || termScore(recipe, word).score);
    if (hits.every((hit) => hit > 0)) best = { score: 55, titleIndices: [] };
  }

  // Last resort, for typos and abbreviations ("prsnt", "seq diag"): only a tight fuzzy title match.
  if (best.score === 0 && query.replace(/ /g, '').length >= 3) {
    const fuzzy = fuzzyMatch(query, recipe.title);
    if (fuzzy && fuzzy.score >= query.replace(/ /g, '').length * 2) {
      best = { score: 10 + fuzzy.score, titleIndices: fuzzy.indices };
    }
  }
  return best;
}

export function searchLearn(query: string, recipes: readonly LearnRecipe[] = RECIPES): LearnSearchResult {
  const q = normalizeQuery(query);
  if (!q) return { recipes: [], shortcuts: false };

  const matches: RecipeMatch[] = [];
  recipes.forEach((recipe) => {
    const { score, titleIndices } = scoreRecipe(recipe, q);
    if (score > 0) matches.push({ recipe, score, titleIndices });
  });
  // Stable, so the catalog's own order (quick start first) settles ties.
  matches.sort((a, b) => b.score - a.score);

  const shortcuts = q.length >= 3 && SHORTCUT_TERMS.some((term) => term.startsWith(q) || q.startsWith(term));
  return { recipes: matches, shortcuts };
}
