/**
 * What a Docker Compose file declares, held against the diagram: services that are declared but
 * not drawn, and dependencies that are declared between two drawn parts with nothing drawn between
 * them.
 *
 * Declared is not the same as true. A Compose file is one team's local setup, often a part of the
 * system and often more than the diagram means to show, so nothing here is ever more than
 * `potential-drift`, and nothing is reported at all until the diagram claims the file: one of its
 * parts cites it as evidence, or is named exactly as one of its services. A diagram of something
 * else is left alone.
 *
 * The file is parsed, never executed: no variable is expanded, no `include` or `extends` is
 * followed, no image is looked up.
 */

import { parse } from 'yaml';
import { labelOf, type ArchModel, type Entity } from '../../model/model';
import { finding, type Finding } from '../finding';
import { normalizeRepoPath, type RepoListing, type RepoReader } from './reader';

const COMPOSE_FILE = /(^|\/)(docker-)?compose(\.[A-Za-z0-9_-]+)?\.ya?ml$/;
/** Compose files read in one check, shallowest first. */
const MAX_FILES = 12;
/** Services read from one file. */
const MAX_SERVICES = 200;
/** Findings of each kind from one file; the rest are counted in the last one. */
const MAX_LISTED = 40;

interface Declared {
  name: string;
  dependsOn: string[];
}

/** The services a Compose document declares, or `null` when it is not one. */
export function composeServices(text: string): Declared[] | null {
  let root: unknown;
  try {
    // Aliases are capped so a small file can't expand into a huge one.
    root = parse(text, { maxAliasCount: 64, prettyErrors: false });
  } catch {
    return null;
  }
  if (!isRecord(root) || !isRecord(root.services)) return null;
  const out: Declared[] = [];
  for (const [name, value] of Object.entries(root.services).slice(0, MAX_SERVICES)) {
    const depends = isRecord(value) ? value.depends_on : undefined;
    const dependsOn = Array.isArray(depends) ? depends.filter((item): item is string => typeof item === 'string') : isRecord(depends) ? Object.keys(depends) : [];
    out.push({ name, dependsOn });
  }
  return out;
}

export async function checkCompose(model: ArchModel, reader: RepoReader, listing?: RepoListing): Promise<Finding[]> {
  const files = listing ?? (await reader.list());
  const candidates = files.paths
    .filter((path) => COMPOSE_FILE.test(path))
    .sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, MAX_FILES);
  const findings: Finding[] = [];
  const entities = [...model.entities.values()];

  for (const path of candidates) {
    const read = await reader.read(path);
    if (read.status !== 'ok') continue;
    const services = composeServices(read.text);
    if (!services) {
      // Only worth saying when the diagram points at this file.
      if (entities.some((entity) => cites(entity, path))) {
        findings.push(finding({ rule: 'compose/unreadable', class: 'unsupported', severity: 'info', subjects: [], selector: path, message: `${path} is cited as evidence but could not be read as a Compose file.`, evidence: [{ path }] }));
      }
      continue;
    }

    // Which part each service is drawn as: one that cites the service by name, else one named for it.
    const drawnAs = new Map<string, Entity>();
    for (const service of services) {
      const cited = entities.find((entity) => entity.evidence.some((item) => normalizeRepoPath(item.path) === path && item.symbol?.trim() === service.name));
      const named = cited ?? uniquely(entities.filter((entity) => plain(entity.name) === plain(service.name) && plain(entity.name) !== ''));
      if (named) drawnAs.set(service.name, named);
    }
    if (drawnAs.size === 0 && !entities.some((entity) => cites(entity, path))) continue;

    const scope = `Read from ${path}; ${drawnAs.size} of its ${services.length} service${services.length === 1 ? '' : 's'} matched a part by name or by cited evidence.`;
    const undrawn = services.filter((service) => !drawnAs.has(service.name));
    undrawn.slice(0, MAX_LISTED).forEach((service) => {
      findings.push(
        finding({
          rule: 'compose/undrawn-service',
          class: 'potential-drift',
          severity: 'info',
          subjects: [],
          selector: `${path}#${service.name}`,
          message: `${path} declares a service "${clip(service.name)}" that no part of the diagram is named for.`,
          evidence: [{ path, symbol: service.name }],
          scope,
        }),
      );
    });
    if (undrawn.length > MAX_LISTED) {
      findings.push(finding({ rule: 'compose/undrawn-service', class: 'potential-drift', severity: 'info', subjects: [], selector: `${path}#more`, message: `${path} declares ${undrawn.length - MAX_LISTED} more services that are not drawn.`, evidence: [{ path }], scope }));
    }

    let listed = 0;
    for (const service of services) {
      const from = drawnAs.get(service.name);
      if (!from) continue;
      for (const dependency of service.dependsOn) {
        const to = drawnAs.get(dependency);
        if (!to || to.id === from.id || listed >= MAX_LISTED) continue;
        const related = model.relations.some((relation) => (relation.from === from.id && relation.to === to.id) || (relation.from === to.id && relation.to === from.id));
        if (related) continue;
        listed += 1;
        findings.push(
          finding({
            rule: 'compose/undrawn-dependency',
            class: 'potential-drift',
            severity: 'info',
            subjects: [from.id, to.id],
            selector: `${path}#${service.name}>${dependency}`,
            message: `${path} says "${clip(service.name)}" depends on "${clip(dependency)}", and nothing is drawn between ${quote(from)} and ${quote(to)}.`,
            evidence: [{ path, symbol: service.name }],
            scope,
            ...(from.room.length ? { room: [...from.room] } : {}),
          }),
        );
      }
    }
  }
  return findings;
}

function cites(entity: Entity, path: string): boolean {
  return entity.evidence.some((item) => normalizeRepoPath(item.path) === path);
}

/** Letters and digits only, lower case: "Orders API", "orders-api" and "orders_api" are one name. */
function plain(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function uniquely<T>(items: T[]): T | undefined {
  return items.length === 1 ? items[0] : undefined;
}

function quote(entity: Entity): string {
  return entity.name ? `"${clip(entity.name)}"` : labelOf(entity);
}

function clip(text: string): string {
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
