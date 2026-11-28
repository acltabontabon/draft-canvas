/**
 * Rules a person declares about their architecture, and the waivers that go with them: "nothing
 * outside Payments reaches its database", "a client goes through the gateway".
 *
 * A rule is data, from a small fixed vocabulary. There is no expression language and nothing is
 * ever evaluated as code: a rule file is read by someone else's CI as readily as by its author, so
 * it must not be able to do anything but describe. Each rule picks parts with selectors and names
 * one constraint between them; a rule that selects nothing says so instead of passing silently.
 *
 * Rules and waivers live in `draftcanvas.json` beside the code, not in the diagram: they are
 * reviewed like code, and neither a collaborator on the canvas nor an agent's proposal can relax
 * one. A waiver names a finding by id, gives a reason and may expire; once it has, the finding
 * comes back and the waiver itself is reported.
 */

import { cyclesOf, downstreamOf } from '../model/graph';
import { labelOf, type ArchModel, type Boundary, type Entity, type Relation } from '../model/model';
import { finding, SEVERITIES, type Finding, type Severity } from './finding';

export const CONFIG_VERSION = 1;
export const CONFIG_LIMITS = { maxRules: 200, maxWaivers: 1000, maxText: 300, maxListed: 100 } as const;

/** Which parts a rule is about. Every field given must match; an empty selector matches every part. */
export interface Selector {
  /** A shape type (`service`, `database`), the kind picked for it (`api`, `gateway`, `cache`) or
   *  what it is read as (`deadLetter`, `objectStorage`). */
  kind?: string[];
  /** The part's name, `*` standing for anything. Case is ignored. */
  name?: string;
  /** The single product its technology names (`postgresql`), or part of the technology text. */
  technology?: string;
  /** It sits in a boundary with this name (`*` allowed), however deeply. */
  boundary?: string;
  /** C4 scope: inside the system the view is about, or outside it. */
  scope?: 'internal' | 'external';
}

export type Requirement = 'technology' | 'description' | 'evidence' | 'boundary';

interface RuleBase {
  /** Names the rule in findings and waivers. Unique in the file. */
  id: string;
  severity: Severity;
  /** The person's own words for why the rule exists, quoted in each finding. */
  because?: string;
}

export type Rule = RuleBase &
  (
    | { type: 'must-not-depend'; from: Selector; to: Selector; transitive: boolean }
    | { type: 'must-go-through'; from: Selector; to: Selector; via: Selector }
    | { type: 'no-cycle'; among: Selector }
    | { type: 'no-shared-store'; store: Selector }
    | { type: 'crossing-only-via'; boundary: string; via: Selector }
    | { type: 'must-have'; of: Selector; require: Requirement }
  );

export interface Waiver {
  /** The id of the finding it sets aside. */
  finding: string;
  reason: string;
  /** `YYYY-MM-DD`: the last day it applies. Absent never expires. */
  expires?: string;
}

export interface CheckConfig {
  version: typeof CONFIG_VERSION;
  rules: Rule[];
  waivers: Waiver[];
}

export type ConfigResult = { ok: true; config: CheckConfig } | { ok: false; errors: string[] };

const RULE_TYPES = ['must-not-depend', 'must-go-through', 'no-cycle', 'no-shared-store', 'crossing-only-via', 'must-have'] as const;
const REQUIREMENTS: readonly Requirement[] = ['technology', 'description', 'evidence', 'boundary'];
const SELECTOR_FIELDS = ['kind', 'name', 'technology', 'boundary', 'scope'];

/** Reads a rule file. Strict on purpose: a rule that is misread is worse than one that is refused. */
export function parseConfig(input: unknown): ConfigResult {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ['The rule file must be a JSON object.'] };
  if (input.version !== CONFIG_VERSION) errors.push(`"version" must be ${CONFIG_VERSION}.`);
  for (const key of Object.keys(input)) if (!['version', 'rules', 'waivers', '$schema'].includes(key)) errors.push(`Unknown field "${clip(key)}".`);

  const text = (value: unknown, where: string, required = true): string | undefined => {
    if (value === undefined && !required) return undefined;
    // oxlint-disable-next-line no-control-regex -- rule text is quoted in reports and must be printable
    if (typeof value !== 'string' || !value.trim() || value.length > CONFIG_LIMITS.maxText || /[\u0000-\u001f\u007f]/.test(value)) {
      errors.push(`${where} must be a line of text of at most ${CONFIG_LIMITS.maxText} characters.`);
      return undefined;
    }
    return value.trim();
  };

  const selector = (value: unknown, where: string, required = true): Selector => {
    if (value === undefined && !required) return {};
    if (!isRecord(value)) {
      errors.push(`${where} must be a selector object.`);
      return {};
    }
    const out: Selector = {};
    for (const key of Object.keys(value)) if (!SELECTOR_FIELDS.includes(key)) errors.push(`${where} has an unknown field "${clip(key)}".`);
    if (value.kind !== undefined) {
      const kinds = typeof value.kind === 'string' ? [value.kind] : value.kind;
      if (!Array.isArray(kinds) || kinds.length === 0 || kinds.length > 20 || !kinds.every((kind) => typeof kind === 'string' && /^[A-Za-z-]{1,40}$/.test(kind))) errors.push(`${where}.kind must be a kind or a list of kinds.`);
      else out.kind = kinds as string[];
    }
    for (const field of ['name', 'technology', 'boundary'] as const) {
      const read = text(value[field], `${where}.${field}`, false);
      if (read !== undefined) out[field] = read;
    }
    if (value.scope !== undefined) {
      if (value.scope !== 'internal' && value.scope !== 'external') errors.push(`${where}.scope must be "internal" or "external".`);
      else out.scope = value.scope;
    }
    return out;
  };

  const rules: Rule[] = [];
  const rawRules = input.rules ?? [];
  if (!Array.isArray(rawRules) || rawRules.length > CONFIG_LIMITS.maxRules) errors.push(`"rules" must be a list of at most ${CONFIG_LIMITS.maxRules}.`);
  else {
    const seen = new Set<string>();
    rawRules.forEach((raw, index) => {
      const where = `rules[${index}]`;
      if (!isRecord(raw)) return void errors.push(`${where} must be an object.`);
      const id = typeof raw.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(raw.id) ? raw.id : undefined;
      if (!id) return void errors.push(`${where}.id must be a short name of letters, digits, ".", "_" and "-".`);
      if (seen.has(id)) return void errors.push(`Two rules are called "${id}".`);
      seen.add(id);
      const severity = raw.severity === undefined ? 'error' : raw.severity;
      if (!(SEVERITIES as readonly unknown[]).includes(severity)) return void errors.push(`${where}.severity must be error, warning or info.`);
      const because = text(raw.because, `${where}.because`, false);
      const base = { id, severity: severity as Severity, ...(because ? { because } : {}) };
      const allowed = (fields: string[]) => {
        for (const key of Object.keys(raw)) if (!['id', 'type', 'severity', 'because', ...fields].includes(key)) errors.push(`${where} has an unknown field "${clip(key)}" for a ${String(raw.type)} rule.`);
      };
      switch (raw.type) {
        case 'must-not-depend':
          allowed(['from', 'to', 'transitive']);
          if (raw.transitive !== undefined && typeof raw.transitive !== 'boolean') errors.push(`${where}.transitive must be true or false.`);
          rules.push({ ...base, type: raw.type, from: selector(raw.from, `${where}.from`), to: selector(raw.to, `${where}.to`), transitive: raw.transitive === true });
          break;
        case 'must-go-through':
          allowed(['from', 'to', 'via']);
          rules.push({ ...base, type: raw.type, from: selector(raw.from, `${where}.from`), to: selector(raw.to, `${where}.to`), via: selector(raw.via, `${where}.via`) });
          break;
        case 'no-cycle':
          allowed(['among']);
          rules.push({ ...base, type: raw.type, among: selector(raw.among, `${where}.among`, false) });
          break;
        case 'no-shared-store':
          allowed(['store']);
          rules.push({ ...base, type: raw.type, store: selector(raw.store, `${where}.store`, false) });
          break;
        case 'crossing-only-via': {
          allowed(['boundary', 'via']);
          const boundary = text(raw.boundary, `${where}.boundary`);
          rules.push({ ...base, type: raw.type, boundary: boundary ?? '', via: selector(raw.via, `${where}.via`) });
          break;
        }
        case 'must-have':
          allowed(['of', 'require']);
          if (!REQUIREMENTS.includes(raw.require as Requirement)) errors.push(`${where}.require must be one of: ${REQUIREMENTS.join(', ')}.`);
          rules.push({ ...base, type: raw.type, of: selector(raw.of, `${where}.of`, false), require: raw.require as Requirement });
          break;
        default:
          errors.push(`${where}.type must be one of: ${RULE_TYPES.join(', ')}.`);
      }
    });
  }

  const waivers: Waiver[] = [];
  const rawWaivers = input.waivers ?? [];
  if (!Array.isArray(rawWaivers) || rawWaivers.length > CONFIG_LIMITS.maxWaivers) errors.push(`"waivers" must be a list of at most ${CONFIG_LIMITS.maxWaivers}.`);
  else {
    rawWaivers.forEach((raw, index) => {
      const where = `waivers[${index}]`;
      if (!isRecord(raw)) return void errors.push(`${where} must be an object.`);
      for (const key of Object.keys(raw)) if (!['finding', 'reason', 'expires'].includes(key)) errors.push(`${where} has an unknown field "${clip(key)}".`);
      if (typeof raw.finding !== 'string' || !/^[0-9a-f]{16}$/.test(raw.finding)) return void errors.push(`${where}.finding must be a finding id (16 hex digits, as a report prints it).`);
      // A waiver with no reason is a finding switched off, which is what this is here to prevent.
      const reason = text(raw.reason, `${where}.reason`);
      if (raw.expires !== undefined && !(typeof raw.expires === 'string' && isDay(raw.expires))) return void errors.push(`${where}.expires must be a date as YYYY-MM-DD.`);
      if (reason) waivers.push({ finding: raw.finding, reason, ...(typeof raw.expires === 'string' ? { expires: raw.expires } : {}) });
    });
  }

  return errors.length ? { ok: false, errors } : { ok: true, config: { version: CONFIG_VERSION, rules, waivers } };
}

function isDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

// --- selecting ---------------------------------------------------------------------------------

function glob(pattern: string): RegExp {
  return new RegExp(`^${pattern.trim().split('*').map((piece) => piece.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
}

function matcher(model: ArchModel, selector: Selector): (entity: Entity) => boolean {
  const kinds = selector.kind?.map((kind) => kind.toLowerCase());
  const name = selector.name ? glob(selector.name) : undefined;
  const technology = selector.technology?.trim().toLowerCase();
  const boundary = selector.boundary ? glob(selector.boundary) : undefined;
  return (entity) => {
    if (kinds && !kinds.includes(entity.type) && !kinds.includes(entity.category.toLowerCase()) && !(entity.kind && kinds.includes(entity.kind.toLowerCase()))) return false;
    if (name && !name.test(entity.name)) return false;
    if (technology && entity.product !== technology && !(entity.technology ?? '').toLowerCase().includes(technology)) return false;
    if (boundary && !entity.boundaries.some((id) => boundary.test(model.boundaries.get(id)?.name ?? ''))) return false;
    if (selector.scope && entity.c4?.scope !== selector.scope) return false;
    return true;
  };
}

// --- checking ----------------------------------------------------------------------------------

const WRITES = new Set(['writes', 'readsWrites']);
const STORES = new Set<string>(['database', 'cache', 'fileSystem', 'objectStorage', 'searchIndex']);

/** What the declared rules find in the model. */
export function assertFindings(model: ArchModel, rules: readonly Rule[]): Finding[] {
  const out: Finding[] = [];
  const entities = [...model.entities.values()];
  const name = (id: string) => {
    const part: Entity | Boundary | undefined = model.entities.get(id) ?? model.boundaries.get(id);
    return part ? (part.name ? `"${clip(part.name, 60)}"` : labelOf(part)) : id;
  };
  const roomOf = (id: string) => {
    const room = model.entities.get(id)?.room ?? model.boundaries.get(id)?.room ?? [];
    return room.length ? { room: [...room] } : {};
  };

  for (const rule of rules) {
    const why = rule.because ? ` (${rule.because})` : '';
    const before = out.length;
    const violation = (subjects: string[], message: string, selector: string) => {
      if (out.length - before >= CONFIG_LIMITS.maxListed) return;
      out.push(finding({ rule: `rule/${rule.id}`, class: 'violation', severity: rule.severity, subjects, message: `${message}${why}`, selector, ...roomOf(subjects[0]!) }));
    };
    /** A rule that selects nothing checks nothing: say so, or a typo passes for ever. */
    const empty = (what: string) => {
      out.push(finding({ rule: `rule/${rule.id}`, class: 'ambiguous', severity: 'info', subjects: [], selector: `empty:${what}`, message: `Rule "${rule.id}" checked nothing: no part of the diagram matches its "${what}".` }));
    };

    switch (rule.type) {
      case 'must-not-depend': {
        const from = entities.filter(matcher(model, rule.from));
        const to = new Set(entities.filter(matcher(model, rule.to)).map((entity) => entity.id));
        if (from.length === 0) empty('from');
        else if (to.size === 0) empty('to');
        for (const source of from) {
          if (rule.transitive) {
            for (const reached of downstreamOf(model, source.id, (relation) => relation.directed).ids) {
              if (to.has(reached) && reached !== source.id) violation([source.id, reached], `${name(source.id)} reaches ${name(reached)}, which rule "${rule.id}" forbids.`, `${source.id}>${reached}`);
            }
          } else {
            for (const relation of model.relations) {
              if (relation.from === source.id && to.has(relation.to)) violation([source.id, relation.to, ...relation.edges], `${name(source.id)} depends on ${name(relation.to)}, which rule "${rule.id}" forbids.`, relation.id);
            }
          }
        }
        break;
      }
      case 'must-go-through': {
        const isFrom = matcher(model, rule.from);
        const isTo = matcher(model, rule.to);
        const isVia = matcher(model, rule.via);
        if (!entities.some(isFrom)) empty('from');
        else if (!entities.some(isTo)) empty('to');
        else if (!entities.some(isVia)) empty('via');
        for (const relation of model.relations) {
          const source = model.entities.get(relation.from);
          const target = model.entities.get(relation.to);
          if (!source || !target || !isFrom(source) || !isTo(target) || isVia(source) || isVia(target)) continue;
          violation([source.id, target.id, ...relation.edges], `${name(source.id)} reaches ${name(target.id)} directly; rule "${rule.id}" says it goes through something else.`, relation.id);
        }
        break;
      }
      case 'no-cycle': {
        const among = new Set(entities.filter(matcher(model, rule.among)).map((entity) => entity.id));
        if (among.size === 0) empty('among');
        const within = (relation: Relation) => among.has(relation.from) && among.has(relation.to);
        for (const loop of cyclesOf(model, within)) violation(loop, `${loop.slice(0, 5).map(name).join(', ')}${loop.length > 5 ? ` and ${loop.length - 5} more` : ''} form a loop, which rule "${rule.id}" forbids.`, loop.join(','));
        break;
      }
      case 'no-shared-store': {
        const isStore = matcher(model, rule.store);
        const stores = entities.filter((entity) => STORES.has(entity.category) && isStore(entity));
        if (stores.length === 0) empty('store');
        for (const store of stores) {
          const writers = [...new Set(model.relations.filter((relation) => relation.to === store.id && relation.semantic && WRITES.has(relation.semantic)).map((relation) => relation.from))];
          if (writers.length > 1) violation([store.id, ...writers], `${name(store.id)} is written by ${writers.slice(0, 5).map(name).join(', ')}${writers.length > 5 ? ` and ${writers.length - 5} more` : ''}; rule "${rule.id}" allows one writer.`, store.id);
        }
        break;
      }
      case 'crossing-only-via': {
        const pattern = glob(rule.boundary);
        const boundaries = [...model.boundaries.values()].filter((boundary) => pattern.test(boundary.name));
        const isVia = matcher(model, rule.via);
        if (boundaries.length === 0) empty('boundary');
        else if (!entities.some(isVia)) empty('via');
        for (const boundary of boundaries) {
          for (const relation of model.relations) {
            if (!relation.crosses.includes(boundary.id)) continue;
            const ends = [model.entities.get(relation.from), model.entities.get(relation.to)];
            if (ends.some((end) => end && isVia(end))) continue;
            violation([relation.from, relation.to, ...relation.edges], `${name(relation.from)} and ${name(relation.to)} are connected across ${name(boundary.id)} without going through what rule "${rule.id}" allows.`, `${boundary.id}:${relation.id}`);
          }
        }
        break;
      }
      case 'must-have': {
        const of = entities.filter(matcher(model, rule.of));
        if (of.length === 0) empty('of');
        const has: Record<Requirement, (entity: Entity) => boolean> = {
          technology: (entity) => !!entity.technology,
          description: (entity) => !!entity.description,
          evidence: (entity) => entity.evidence.length > 0,
          boundary: (entity) => entity.boundaries.length > 0,
        };
        const lacks: Record<Requirement, string> = { technology: 'no technology', description: 'no description', evidence: 'no evidence', boundary: 'no boundary around it' };
        for (const entity of of) if (!has[rule.require](entity)) violation([entity.id], `${name(entity.id)} has ${lacks[rule.require]}, which rule "${rule.id}" requires.`, rule.require);
        break;
      }
    }
  }
  return out;
}

// --- waiving -----------------------------------------------------------------------------------

export interface Waived {
  /** What is left to report: unwaived findings, and what there is to say about the waivers. */
  findings: Finding[];
  /** Findings a waiver in force set aside, with its reason. */
  waived: { finding: Finding; reason: string; expires?: string }[];
}

/**
 * Sets aside the findings waivers name. `today` is `YYYY-MM-DD`: a waiver applies through its
 * last day, and after that the finding comes back and the waiver is reported. A waiver for
 * something no longer found is reported too, so the list can't quietly outlive its reasons.
 */
export function applyWaivers(findings: readonly Finding[], waivers: readonly Waiver[], today: string): Waived {
  const byId = new Map<string, Waiver>();
  for (const waiver of waivers) if (!byId.has(waiver.finding)) byId.set(waiver.finding, waiver);
  const kept: Finding[] = [];
  const waived: Waived['waived'] = [];
  const used = new Set<string>();
  for (const entry of findings) {
    const waiver = byId.get(entry.id);
    if (!waiver) {
      kept.push(entry);
      continue;
    }
    used.add(entry.id);
    if (waiver.expires && waiver.expires < today) {
      kept.push(entry);
      kept.push(finding({ rule: 'config/expired-waiver', class: 'advisory', severity: 'warning', subjects: entry.subjects, selector: entry.id, message: `The waiver for finding ${entry.id} expired on ${waiver.expires}, so it is reported again. It was waived because: ${waiver.reason}` }));
    } else {
      waived.push({ finding: entry, reason: waiver.reason, ...(waiver.expires ? { expires: waiver.expires } : {}) });
    }
  }
  for (const waiver of byId.values()) {
    if (used.has(waiver.finding)) continue;
    kept.push(finding({ rule: 'config/unused-waiver', class: 'advisory', severity: 'info', subjects: [], selector: waiver.finding, message: `A waiver names finding ${waiver.finding}, which was not found. It can be removed.` }));
  }
  return { findings: kept, waived };
}

function clip(text: string, max = 40): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
