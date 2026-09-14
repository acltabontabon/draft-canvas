import { useEffect, useMemo, useState, type KeyboardEvent, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { CATEGORIES, QUICK_START, RECIPES, recipesIn, type LearnCategory } from '../../learn/recipes';
import { searchLearn, type RecipeMatch } from '../../learn/search';
import { isImeKeyEvent } from '../../lib/isEditableTarget';
import type { LearnRecipe } from '../../learn/types';
import type { DraftNode } from '../../document/types';
import { useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import { Icon } from '../common/Icon';
import { RecipePoster } from './RecipePoster';

interface LearnHomeProps {
  searchRef: RefObject<HTMLInputElement | null>;
  /** Back from a recipe, rather than opening onto home. */
  returning: boolean;
  onOpen: (recipeId: string) => void;
}

/** Offered when a search comes up empty — the three questions people ask most. */
const TRY_INSTEAD = ['async', 'flow', 'export'];

/**
 * Learn's landing: a search box that answers "how do I…", the short version of Draft Canvas as a
 * six-stop route, and four ways in by topic. Never a directory — sixteen links would be a wall.
 */
export function LearnHome({ searchRef, returning, onOpen }: LearnHomeProps) {
  const query = useUiStore((state) => state.learnQuery);
  const setQuery = useUiStore((state) => state.setLearnQuery);
  const category = useUiStore((state) => state.learnCategory);
  const setCategory = useUiStore((state) => state.setLearnCategory);
  const setShortcutsOpen = useUiStore((state) => state.setShortcutsOpen);

  const results = useMemo(() => searchLearn(query), [query]);
  const searching = query.trim().length > 0;
  const activeCategory = CATEGORIES.find((candidate) => candidate.id === category);

  // Spoken once typing pauses, not on every keystroke.
  const summary = searching ? announce(results.recipes.length, results.shortcuts) : '';
  const [announced, setAnnounced] = useState(summary);
  useEffect(() => {
    const id = window.setTimeout(() => setAnnounced(summary), ANNOUNCE_DELAY_MS);
    return () => window.clearTimeout(id);
  }, [summary]);

  // The search box leads into what it found: Enter opens the best answer, ↓ walks into the list.
  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isImeKeyEvent(event)) return;
    if (event.key === 'Enter' && searching) {
      event.preventDefault();
      const top = results.recipes[0];
      if (top) onOpen(top.recipe.id);
      else if (results.shortcuts) setShortcutsOpen(true);
    } else if (event.key === 'ArrowDown') {
      const first = listItems(event.currentTarget)[0];
      if (!first) return;
      event.preventDefault();
      first.focus();
    }
  };

  // ↑/↓ between the rows of whatever the body is showing; ↑ from the first goes back to the box.
  const onBodyKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = listItems(event.currentTarget);
    const index = items.indexOf(event.target as HTMLElement);
    if (index < 0) return;
    event.preventDefault();
    const next = index + (event.key === 'ArrowDown' ? 1 : -1);
    if (next < 0) searchRef.current?.focus();
    else items[Math.min(next, items.length - 1)]?.focus();
  };

  return (
    <div className="dc-learn-home" data-returning={returning ? 'true' : undefined}>
      <div className="dc-learn-search">
        <Icon name="search" size={14} />
        <input
          ref={searchRef}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onSearchKeyDown}
          placeholder="How do I…"
          aria-label="Search Learn"
          aria-controls="dc-learn-body"
          spellCheck={false}
          autoComplete="off"
        />
        {searching && (
          <button type="button" className="dc-learn-search-clear" onClick={() => {
            setQuery('');
            searchRef.current?.focus();
          }} aria-label="Clear search">
            <Icon name="close" size={12} />
          </button>
        )}
      </div>
      <p className="dc-sr-only" aria-live="polite">
        {announced}
      </p>

      {/* Arrow keys over native buttons, not a composite widget: each row stays a plain Tab stop. */}
      <div className="dc-learn-body" id="dc-learn-body" onKeyDown={onBodyKeyDown}>
        {searching ? (
          <SearchResults
            matches={results.recipes}
            shortcuts={results.shortcuts}
            onOpen={onOpen}
            // The pill pressed is about to unmount; focus goes where the answer is, not to the page.
            onTry={(next) => {
              setQuery(next);
              searchRef.current?.focus();
            }}
            onCategory={(next) => {
              flushSync(() => {
                setQuery('');
                setCategory(next);
              });
              searchRef.current?.closest('.dc-learn-home')?.querySelector<HTMLElement>('.dc-learn-topic[aria-pressed="true"]')?.focus();
            }}
            onShortcuts={() => setShortcutsOpen(true)}
          />
        ) : (
          <>
            <div className="dc-learn-topics" role="group" aria-label="Topics">
              {CATEGORIES.map((candidate) => (
                <button
                  key={candidate.id}
                  type="button"
                  className="dc-learn-topic"
                  aria-pressed={candidate.id === category}
                  onClick={() => setCategory(candidate.id === category ? null : candidate.id)}
                >
                  <TopicGlyph glyph={candidate.glyph} />
                  {candidate.label}
                </button>
              ))}
            </div>

            {activeCategory ? (
              <section className="dc-learn-section" aria-labelledby="dc-learn-topic-title">
                <h3 id="dc-learn-topic-title" className="dc-learn-eyebrow">
                  {activeCategory.label}
                </h3>
                <RecipeList recipes={recipesIn(activeCategory.id)} onOpen={onOpen} />
              </section>
            ) : (
              <Route onOpen={onOpen} />
            )}

            <button type="button" className="dc-learn-shortcuts" onClick={() => setShortcutsOpen(true)}>
              <Icon name="keyboard" size={14} />
              <span>Keyboard shortcuts</span>
              <kbd>?</kbd>
            </button>
          </>
        )}
      </div>

      {!searching && <SelectionContext onOpen={onOpen} />}
    </div>
  );
}

const ANNOUNCE_DELAY_MS = 400;

function announce(count: number, shortcuts: boolean): string {
  if (count === 0) return shortcuts ? 'Keyboard shortcuts' : 'No results';
  const recipes = `${count} ${count === 1 ? 'recipe' : 'recipes'}`;
  return shortcuts ? `${recipes}, plus Keyboard shortcuts` : recipes;
}

/** The rows ↑/↓ step through, in order — within the Learn view `from` sits in. */
function listItems(from: HTMLElement): HTMLElement[] {
  const body = from.closest('.dc-learn-home')?.querySelector('.dc-learn-body');
  return body ? Array.from(body.querySelectorAll<HTMLElement>('.dc-learn-row, .dc-learn-stop, .dc-learn-shortcuts')) : [];
}

/** The short version: six stops on a line, the way a flow reads — no progress, no checkmarks. */
function Route({ onOpen }: { onOpen: (id: string) => void }) {
  return (
    <section className="dc-learn-section" aria-labelledby="dc-learn-route-title">
      <h3 id="dc-learn-route-title" className="dc-learn-eyebrow">
        The short version
      </h3>
      <ol className="dc-learn-route">
        {QUICK_START.map((recipe, index) => (
          <li key={recipe.id}>
            <button type="button" className="dc-learn-stop" data-recipe-id={recipe.id} onClick={() => onOpen(recipe.id)}>
              <span className="dc-learn-stop-dot" aria-hidden="true">
                {index + 1}
              </span>
              <span className="dc-learn-stop-text">
                <span className="dc-learn-row-title">{recipe.title}</span>
                <span className="dc-learn-row-summary">{recipe.summary}</span>
              </span>
              <RecipePoster recipeId={recipe.id} />
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

function RecipeList({ recipes, onOpen }: { recipes: readonly LearnRecipe[]; onOpen: (id: string) => void }) {
  return (
    <ul className="dc-learn-list">
      {recipes.map((recipe) => (
        <li key={recipe.id}>
          <RecipeRow recipe={recipe} onOpen={onOpen} />
        </li>
      ))}
    </ul>
  );
}

function RecipeRow({ recipe, indices, onOpen }: { recipe: LearnRecipe; indices?: readonly number[]; onOpen: (id: string) => void }) {
  return (
    <button type="button" className="dc-learn-row" data-recipe-id={recipe.id} onClick={() => onOpen(recipe.id)}>
      <RecipePoster recipeId={recipe.id} />
      <span className="dc-learn-row-text">
        <span className="dc-learn-row-title">
          <Highlighted text={recipe.title} indices={indices ?? []} />
        </span>
        <span className="dc-learn-row-summary">{recipe.summary}</span>
      </span>
      <Icon name="forward" size={12} className="dc-learn-row-go" />
    </button>
  );
}

function SearchResults({
  matches,
  shortcuts,
  onOpen,
  onTry,
  onCategory,
  onShortcuts,
}: {
  matches: readonly RecipeMatch[];
  shortcuts: boolean;
  onOpen: (id: string) => void;
  onTry: (query: string) => void;
  onCategory: (category: LearnCategory['id']) => void;
  onShortcuts: () => void;
}) {
  if (matches.length === 0 && !shortcuts) {
    return (
      <div className="dc-learn-empty">
        <p>No recipe for that yet.</p>
        <div className="dc-learn-empty-try">
          <span>Try</span>
          {TRY_INSTEAD.map((term) => (
            <button key={term} type="button" className="dc-learn-pill" onClick={() => onTry(term)}>
              {term}
            </button>
          ))}
        </div>
        <div className="dc-learn-empty-try">
          <span>Or browse</span>
          {CATEGORIES.map((category) => (
            <button key={category.id} type="button" className="dc-learn-pill" onClick={() => onCategory(category.id)}>
              {category.label}
            </button>
          ))}
        </div>
      </div>
    );
  }
  return (
    <ul className="dc-learn-list" aria-label="Results">
      {matches.map((match) => (
        <li key={match.recipe.id}>
          <RecipeRow recipe={match.recipe} indices={match.titleIndices} onOpen={onOpen} />
        </li>
      ))}
      {shortcuts && (
        <li>
          <button type="button" className="dc-learn-row dc-learn-row-plain" onClick={onShortcuts}>
            <span className="dc-learn-row-icon" aria-hidden="true">
              <Icon name="keyboard" size={16} />
            </span>
            <span className="dc-learn-row-text">
              <span className="dc-learn-row-title">Keyboard shortcuts</span>
              <span className="dc-learn-row-summary">Every key, in one sheet.</span>
            </span>
            <kbd>?</kbd>
          </button>
        </li>
      )}
    </ul>
  );
}

function Highlighted({ text, indices }: { text: string; indices: readonly number[] }) {
  if (indices.length === 0) return <>{text}</>;
  const marked = new Set(indices);
  const parts: { text: string; mark: boolean }[] = [];
  for (const [i, char] of [...text].entries()) {
    const mark = marked.has(i);
    const last = parts[parts.length - 1];
    if (last && last.mark === mark) last.text += char;
    else parts.push({ text: char, mark });
  }
  return (
    <>
      {parts.map((part, i) => (part.mark ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>))}
    </>
  );
}

const NODE_NAMES: Record<DraftNode['type'], string> = {
  text: 'Text',
  note: 'Note',
  code: 'Code',
  service: 'Service',
  database: 'Data Store',
  queue: 'Queue',
  actor: 'Actor',
  component: 'Component',
  group: 'Boundary',
  ellipse: 'Junction',
};

function kindOf(node: DraftNode): string | undefined {
  return node.serviceKind ?? node.queueKind ?? node.databaseKind ?? node.actorKind ?? node.componentKind;
}

/**
 * "Selected · Queue": while Learn is open, what you've selected on the canvas quietly offers the
 * recipes about it. Pinned to the foot of the home view so it can change under you without anything
 * above it moving.
 */
function SelectionContext({ onOpen }: { onOpen: (id: string) => void }) {
  // A string, so the selector is stable across unrelated document changes.
  const selected = useEditorStore((state) => {
    const { nodes, edges } = state.selection;
    if (nodes.length === 1 && edges.length === 0) {
      const node = state.document.nodes.find((candidate) => candidate.id === nodes[0]);
      return node ? `node:${node.type}:${kindOf(node) ?? ''}` : '';
    }
    return nodes.length === 0 && edges.length === 1 ? 'edge' : '';
  });

  const offer = useMemo(() => {
    if (!selected) return null;
    const [what, type, kind] = selected.split(':') as [string, DraftNode['type'] | undefined, string | undefined];
    const recipes = (RECIPES as readonly LearnRecipe[]).filter((recipe) => {
      const applies = recipe.appliesTo;
      if (!applies) return false;
      if (what === 'edge') return applies.edge === true;
      if (!type || !applies.nodeTypes?.includes(type)) return false;
      return !applies.kinds || (kind !== undefined && applies.kinds.includes(kind));
    });
    // Most specific first: a recipe that names this exact kind beats one that fits any shape.
    recipes.sort((a, b) => Number(Boolean(b.appliesTo?.kinds)) - Number(Boolean(a.appliesTo?.kinds)));
    const label = what === 'edge' ? 'Connector' : type ? NODE_NAMES[type] : '';
    return recipes.length ? { label, recipes: recipes.slice(0, 2) } : null;
  }, [selected]);

  if (!offer) return null;
  return (
    <section className="dc-learn-context" aria-label={`About the selected ${offer.label}`}>
      <span className="dc-learn-context-label">
        <span className="dc-learn-context-dot" aria-hidden="true" />
        Selected · {offer.label}
      </span>
      <span className="dc-learn-context-links">
        {offer.recipes.map((recipe) => (
          <button key={recipe.id} type="button" className="dc-learn-pill" data-recipe-id={recipe.id} onClick={() => onOpen(recipe.id)}>
            {recipe.title}
          </button>
        ))}
      </span>
    </section>
  );
}

function TopicGlyph({ glyph }: { glyph: LearnCategory['glyph'] }) {
  return (
    <svg className="dc-learn-topic-glyph" viewBox="0 0 16 16" aria-hidden="true">
      {glyph === 'service' && <rect x="2" y="4" width="12" height="8" rx="2" />}
      {glyph === 'connector' && (
        <>
          <circle cx="3" cy="8" r="1.6" />
          <path d="M5 8h8M10.5 5.5L13 8l-2.5 2.5" />
        </>
      )}
      {glyph === 'queue' && (
        <>
          <rect x="1.5" y="5" width="13" height="6" rx="3" />
          <path d="M6 5v6M10 5v6" />
        </>
      )}
      {glyph === 'flow' && (
        <>
          <circle cx="3" cy="11" r="1.6" />
          <circle cx="8" cy="5" r="1.6" />
          <circle cx="13" cy="11" r="1.6" />
          <path d="M4.2 9.8l2.6-3.6M9.2 6.2l2.6 3.6" />
        </>
      )}
    </svg>
  );
}
