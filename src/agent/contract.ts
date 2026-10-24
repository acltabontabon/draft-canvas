import { FULL_TOOLS } from './schema';
import { AgentError } from './errors';
import { unknownFieldHint } from './fields';

interface Schema {
  type?: string | string[];
  properties?: Record<string, Schema>;
  additionalProperties?: boolean | Schema;
  required?: string[];
  enum?: unknown[];
  const?: unknown;
  oneOf?: Schema[];
  anyOf?: Schema[];
  not?: Schema;
  items?: Schema;
  minItems?: number;
  maxItems?: number;
  minProperties?: number;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  $ref?: string;
  $defs?: Record<string, Schema>;
}

/** "must be one of a, b, c" for a short list; a long one shows its first words and how many there are. */
function expected(allowed: unknown[]): string {
  const words = allowed.map((word) => (typeof word === 'string' ? word : JSON.stringify(word)));
  let shown = '';
  let count = 0;
  for (const word of words) {
    if (count > 0 && shown.length + word.length > 120) break;
    shown += `${count > 0 ? ', ' : ''}${word}`;
    count += 1;
  }
  return count < words.length ? `must be one of ${shown}, … (${words.length} in all; get_capabilities lists them)` : `must be one of ${shown}`;
}

type Tag = { key: string; values: unknown[] };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const isObject = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item);
const typesOf = (rule: Schema): string[] => (rule.type === undefined ? [] : Array.isArray(rule.type) ? rule.type : [rule.type]);
const matches = (type: string, item: unknown) => type === 'null' ? item === null : type === 'array' ? Array.isArray(item) : type === 'object' ? isObject(item) : type === 'integer' ? Number.isSafeInteger(item) : type === 'number' ? typeof item === 'number' && Number.isFinite(item) : typeof item === type;

/** The subset of JSON Schema emitted by schema.ts, checked at the page boundary even for clients
 *  that only send raw JSON-RPC. Semantic references and layout are still checked by the engine. */
export function schemaProblems(schema: unknown, value: unknown): string[] {
  const root = schema as Schema;
  const resolve = (rule: Schema): Schema => (rule.$ref ? root.$defs?.[rule.$ref.replace('#/$defs/', '')] ?? rule : rule);
  /** A field whose one allowed value names the branch (an op's `op`), if `rule` has one. */
  const tagsOf = (rule: Schema): Tag[] => Object.entries(resolve(rule).properties ?? {}).flatMap(([key, field]) => {
    const property = resolve(field);
    const values = property.enum?.length === 1 ? property.enum : 'const' in property ? [property.const] : undefined;
    return values ? [{ key, values }] : [];
  });
  /** The field every branch is told apart by, when they all have one. */
  const discriminator = (branches: Schema[]): string | undefined => {
    const [first, ...rest] = branches.map(tagsOf);
    return first?.find((tag) => rest.every((tags) => tags.some((other) => other.key === tag.key)))?.key;
  };
  /**
   * How far `item` is from being meant as `rule`'s shape, before any problem inside it counts: the
   * wrong type is furthest, then a tag naming another branch, then each field it lacks or doesn't
   * take. Counting problems alone picked the wrong branch: an add with six malformed open points
   * has more problems than reading it as an arrange ("/op: must be one of arrange"), and a step
   * with a too-long caption fewer as a bare string ("must be string").
   */
  const distanceTo = (branch: Schema, item: unknown): number => {
    const rule = resolve(branch);
    const types = typesOf(rule);
    if (types.length && !types.some((type) => matches(type, item))) return 1000;
    if (!isObject(item)) return 0;
    let far = 0;
    for (const tag of tagsOf(rule)) if (tag.key in item && !tag.values.some((allowed) => same(allowed, item[tag.key]))) far += 100;
    for (const key of rule.required ?? []) if (!(key in item)) far += 1;
    if (rule.additionalProperties === false) for (const key of Object.keys(item)) if (!rule.properties?.[key]) far += 1;
    return far;
  };
  /** A branch as a reader would write it: `{relationship, caption?}`, `string`. */
  const shapeOf = (branch: Schema): string => {
    const rule = resolve(branch);
    if (rule.properties) {
      const required = rule.required ?? [];
      const fields = [...required, ...Object.keys(rule.properties).filter((key) => !required.includes(key)).map((key) => `${key}?`)];
      return `{${fields.slice(0, 6).join(', ')}${fields.length > 6 ? ', …' : ''}}`;
    }
    return typesOf(rule).join(' or ');
  };
  /**
   * When no branch of a oneOf/anyOf fits, what was wrong with the branch that was meant. With a tag
   * (an op's `op`) that is the branch it names, and an unknown tag lists the ones there are. Without
   * one it is the nearest shape — and when even that is a poor fit, the shapes there are come
   * first, so a malformed flow step says what a step may be rather than what one branch lacked.
   */
  const unmatched = (branches: Schema[], results: string[][], item: unknown, path: string): string[] => {
    const key = discriminator(branches);
    if (key && isObject(item)) {
      const values = branches.flatMap((branch) => tagsOf(branch).find((tag) => tag.key === key)!.values);
      if (!(key in item)) return [`${path}/${key}: is required, ${expected(values)}`];
      const named = branches.findIndex((branch) => tagsOf(branch).some((tag) => tag.key === key && tag.values.some((allowed) => same(allowed, item[key]))));
      return named < 0 ? [`${path}/${key}: ${expected(values)}`] : results[named]!;
    }
    const far = branches.map((branch) => distanceTo(branch, item));
    let best = 0;
    for (let i = 1; i < branches.length; i += 1) if (far[i]! < far[best]! || (far[i] === far[best] && results[i]!.length < results[best]!.length)) best = i;
    if (far[best] === 0 || !branches.every((branch) => typesOf(resolve(branch)).length)) return results[best]!;
    const shapes = `${path}: must be ${[...new Set(branches.map(shapeOf))].join(', or ')}`;
    return far[best]! >= 1000 ? [shapes] : [shapes, ...results[best]!];
  };
  const visit = (rule: Schema, item: unknown, path: string): string[] => {
    if (rule.$ref) {
      const target = root.$defs?.[rule.$ref.replace('#/$defs/', '')];
      return target ? visit(target, item, path) : [`${path}: unresolved schema reference`];
    }
    const problems: string[] = [];
    if (rule.enum && !rule.enum.some((allowed) => same(allowed, item))) problems.push(`${path}: ${expected(rule.enum)}`);
    if ('const' in rule && rule.const !== item) problems.push(`${path}: unexpected value`);
    if (rule.oneOf) {
      const results = rule.oneOf.map((branch) => visit(branch, item, path));
      const matched = results.filter((found) => found.length === 0).length;
      if (matched === 0) problems.push(...unmatched(rule.oneOf, results, item, path));
      else if (matched > 1) problems.push(`${path}: must match exactly one supported shape`);
    }
    if (rule.anyOf) {
      const results = rule.anyOf.map((branch) => visit(branch, item, path));
      if (!results.some((found) => found.length === 0)) problems.push(...unmatched(rule.anyOf, results, item, path));
    }
    if (rule.not && visit(rule.not, item, path).length === 0) problems.push(`${path}: incompatible fields`);
    const types = typesOf(rule);
    if (types.length && !types.some((type) => matches(type, item))) return [...problems, `${path}: must be ${types.join(' or ')}`];
    if (isObject(item)) {
      const object = item;
      if (rule.minProperties && Object.keys(object).length < rule.minProperties) problems.push(`${path}: needs at least one field`);
      // A field sent under another name first: it is why a required one reads as missing, and its
      // hint ("use about") names the fix for both.
      if (rule.additionalProperties === false) {
        const known = Object.keys(rule.properties ?? {});
        for (const key of Object.keys(object)) if (!rule.properties?.[key]) problems.push(`${path}/${key}: unknown field${unknownFieldHint(key, known)}`);
      }
      for (const key of rule.required ?? []) {
        if (key in object) continue;
        // A missing word from a short list says which words there are: "kind: is required" alone
        // sent an agent back to the capabilities for tentative/awaiting/parked.
        const allowed = rule.properties?.[key] && resolve(rule.properties[key]).enum;
        problems.push(`${path}/${key}: is required${allowed ? `, ${expected(allowed)}` : ''}`);
      }
      for (const [key, field] of Object.entries(object)) {
        const property = rule.properties?.[key];
        if (property) problems.push(...visit(property, field, `${path}/${key}`));
        else if (typeof rule.additionalProperties === 'object') problems.push(...visit(rule.additionalProperties, field, `${path}/${key}`));
        if (problems.length >= 20) break;
      }
    }
    if (Array.isArray(item)) {
      if (rule.minItems !== undefined && item.length < rule.minItems) problems.push(`${path}: too few items`);
      if (rule.maxItems !== undefined && item.length > rule.maxItems) problems.push(`${path}: too many items (at most ${rule.maxItems})`);
      if (rule.items) for (let i = 0; i < Math.min(item.length, rule.maxItems ?? 10_000); i += 1) {
        problems.push(...visit(rule.items, item[i], `${path}/${i}`));
        if (problems.length >= 20) break;
      }
    }
    if (typeof item === 'string') {
      const length = [...item].length;
      if (rule.minLength !== undefined && length < rule.minLength) problems.push(`${path}: too short`);
      if (rule.maxLength !== undefined && length > rule.maxLength) problems.push(`${path}: too long: at most ${rule.maxLength} characters (got ${length})`);
      if (rule.pattern && !new RegExp(rule.pattern).test(item)) problems.push(`${path}: invalid format`);
    }
    if (typeof item === 'number' && ((rule.minimum !== undefined && item < rule.minimum) || (rule.maximum !== undefined && item > rule.maximum))) problems.push(`${path}: outside the supported range`);
    return problems.slice(0, 20);
  };
  return visit(root, value, '');
}

export function validateToolInput(name: string, args: unknown): void {
  const tool = FULL_TOOLS.find((tool) => tool.name === name);
  if (!tool) return; // Internal active_context/open_created are not MCP tools.
  const problems = schemaProblems(tool.inputSchema, args);
  if (problems.length) throw new AgentError('INVALID_INPUT', problems.length === 1 ? problems[0]! : `${problems.length} problems; first — ${problems[0]}`, { path: problems[0]!.split(':')[0], details: { problems } });
}
