/**
 * `get_capabilities`: the vocabulary, compact by default, one topic at a time on request. Built from
 * the same tables the app validates against, so it can never describe a type the app refuses.
 */

import { CONNECTOR_KINDS, EDGE_SEMANTICS } from '../document/types';
import { LEVEL_HINTS } from '../depth/level';
import { ARCHITECTURE_STARTERS } from '../starters';
import { AgentError } from './errors';
import { AGENT_LIMITS } from './input';
import { READ_LIMITS } from './read';
import { starterIds } from './starter';
import { ELEMENT_TYPES, GROUP_KINDS, NOTE_KIND_NAMES } from './vocabulary';

/**
 * Bumped when the tools' contract changes incompatibly; additions keep it. 2: an update reaches a
 * diagram that isn't open (no NOT_ACTIVE), saved receipts carry file revisions, a duplicate title is
 * refused on create, flows keep their step ids, and `arrange` exists.
 */
export const CONTRACT_VERSION = 2;

const TOPICS = ['types', 'relationships', 'c4', 'flows', 'starters', 'limits', 'layout'] as const;

export function capabilities(args: { topics?: unknown; starter?: unknown }): Record<string, unknown> {
  if (typeof args.starter === 'string') {
    const starter = ARCHITECTURE_STARTERS.find((s) => s.id === args.starter);
    if (!starter) throw new AgentError('NOT_FOUND', `No starter "${args.starter}".`);
    const ids = starterIds(starter, '');
    return {
      starter: {
        id: starter.id,
        name: starter.name,
        description: starter.description,
        elements: starter.nodes.map((n) => ({ key: n.key, type: n.type, label: n.text ?? null, ...(n.parent ? { group: n.parent } : {}) })),
        relationships: starter.edges.map((e, i) => ({ id: ids.edges[i], from: e.from, to: e.to, ...(e.label ? { label: e.label } : {}) })),
        flows: (starter.flows ?? []).map((f, i) => ({ id: ids.flows[i], title: f.title, steps: f.steps.length })),
        note: 'Ids here are unprefixed; with starter.prefix "p-", element "api" becomes "p-api".',
      },
    };
  }
  const topics = Array.isArray(args.topics) ? new Set(args.topics.filter((t): t is (typeof TOPICS)[number] => (TOPICS as readonly unknown[]).includes(t))) : undefined;
  const want = (topic: (typeof TOPICS)[number]) => !topics || topics.has(topic);
  const out: Record<string, unknown> = { contract: CONTRACT_VERSION };
  if (want('types')) {
    out.types = topics ? Object.fromEntries(Object.entries(ELEMENT_TYPES).map(([k, v]) => [k, v.summary])) : Object.keys(ELEMENT_TYPES);
    out.groupKinds = topics ? Object.fromEntries(Object.entries(GROUP_KINDS).map(([k, v]) => [k, v.summary])) : Object.keys(GROUP_KINDS);
    out.noteKinds = NOTE_KIND_NAMES;
  }
  if (want('relationships')) {
    out.relationships = {
      semantics: EDGE_SEMANTICS,
      kinds: CONNECTOR_KINDS,
      rule: 'Leave semantic out to infer it from the two element types (as the editor does). A semantic the pairing does not offer is replaced by the inferred one, with an advisory. One relationship per direction between two elements, plus a "compensates" twin. No self-loops.',
    };
  }
  if (want('c4')) {
    out.c4 = {
      levels: LEVEL_HINTS,
      fields: 'element.description and element.technology are native C4 fields, drawn on the shape. group kind "system" is a software-system boundary.',
      views: 'A view is the top level or the inside of an element (element.inside), nested up to 3 deep: context → container → component. The focal system of a container view is the element whose inside it is.',
      roles: 'Reads return c4.role (person, software-system, container, component, unspecified) and c4.scope (internal, external, unspecified), derived from type and level — never stored, and "unspecified" rather than a guess.',
      notSupported: 'No landscape, deployment, dynamic or code views; no relationship technology field (use semantic and label); no shared elements across views.',
    };
  }
  if (want('flows')) {
    out.flows = {
      what: 'A named, ordered walk over existing relationships (each at most once per flow). It plays in presentation mode, shows in the Flows panel, and exports as a Mermaid/PlantUML sequence diagram.',
      order: 'Only from an order the person or the code gives; never from layout or graph shape. When the order is unclear, draw the structure and ask.',
      several: 'Separate paths (normal processing, a retry, a compensation) are separate flows. One title per view: update an existing flow instead of adding a second one with its name.',
      default: 'There is no stored default or "main" flow. layout.primaryFlow only lays that flow out as the straight main path; presenting picks the selected flow, or the only one.',
      edits: 'update set.steps keeps each step whose relationship stays (its id, caption, highlights and camera); set.title alone leaves steps untouched.',
    };
    out.notes = {
      beside: 'about = an element: placed beside it, clear of shapes and connectors (placement only — nothing records the link).',
      inside: 'about = a group: a member of the boundary, placed inside it.',
      attached: 'about = a relationship, or an element with attach: true: a native attachment that moves, exports and is removed with its host; edit or remove it by the note id.',
    };
  }
  if (want('starters')) {
    out.starters = topics ? ARCHITECTURE_STARTERS.map((s) => ({ id: s.id, name: s.name, category: s.category })) : ARCHITECTURE_STARTERS.map((s) => s.id);
  }
  if (want('limits')) out.limits = { ...AGENT_LIMITS, read: READ_LIMITS };
  if (want('layout')) {
    out.layout = {
      direction: ['right', 'down'],
      spacing: ['compact', 'comfortable', 'spacious'],
      create: 'Fully automatic: shapes sized to their text, laid out in layers along the reading direction, connectors right-angled and straight where the layout can line them up, captions given room. A few spacings are tried and the most readable kept; one that still fails the check (overlap, clipped text, a connector through an element) is refused unless allowDegraded.',
      update: 'Existing elements never move. New ones are placed beside what they connect to (other spots are tried before giving up); a group grows to hold new members. If nothing fits, LAYOUT_CONSTRAINED carries suggestedOp: the arrange to add.',
      arrange: '{op:"arrange", scope?, direction?, spacing?, connectors?} re-lays out existing content in place — the whole view or one group — keeping ids, notes and flows; direction defaults to the way the view already reads.',
    };
  }
  return out;
}
