import { TOOLS } from './schema';
import { AgentError } from './errors';

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

/** The subset of JSON Schema emitted by schema.ts, checked at the page boundary even for clients
 *  that only send raw JSON-RPC. Semantic references and layout are still checked by the engine. */
export function schemaProblems(schema: unknown, value: unknown): string[] {
  const root = schema as Schema;
  const visit = (rule: Schema, item: unknown, path: string): string[] => {
    if (rule.$ref) {
      const target = root.$defs?.[rule.$ref.replace('#/$defs/', '')];
      return target ? visit(target, item, path) : [`${path}: unresolved schema reference`];
    }
    const problems: string[] = [];
    if (rule.enum && !rule.enum.some((allowed) => JSON.stringify(allowed) === JSON.stringify(item))) problems.push(`${path}: unsupported value`);
    if ('const' in rule && rule.const !== item) problems.push(`${path}: unexpected value`);
    if (rule.oneOf && rule.oneOf.filter((branch) => visit(branch, item, path).length === 0).length !== 1) problems.push(`${path}: must match exactly one supported shape`);
    if (rule.anyOf && !rule.anyOf.some((branch) => visit(branch, item, path).length === 0)) problems.push(`${path}: must match a supported shape`);
    if (rule.not && visit(rule.not, item, path).length === 0) problems.push(`${path}: incompatible fields`);
    const types = rule.type === undefined ? [] : Array.isArray(rule.type) ? rule.type : [rule.type];
    const matches = (type: string) => type === 'null' ? item === null : type === 'array' ? Array.isArray(item) : type === 'object' ? !!item && typeof item === 'object' && !Array.isArray(item) : type === 'integer' ? Number.isSafeInteger(item) : type === 'number' ? typeof item === 'number' && Number.isFinite(item) : typeof item === type;
    if (types.length && !types.some(matches)) return [...problems, `${path}: must be ${types.join(' or ')}`];
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const object = item as Record<string, unknown>;
      if (rule.minProperties && Object.keys(object).length < rule.minProperties) problems.push(`${path}: needs at least one field`);
      for (const key of rule.required ?? []) if (!(key in object)) problems.push(`${path}/${key}: is required`);
      for (const [key, field] of Object.entries(object)) {
        const property = rule.properties?.[key];
        if (property) problems.push(...visit(property, field, `${path}/${key}`));
        else if (rule.additionalProperties === false) problems.push(`${path}/${key}: unknown field`);
        else if (typeof rule.additionalProperties === 'object') problems.push(...visit(rule.additionalProperties, field, `${path}/${key}`));
        if (problems.length >= 20) break;
      }
    }
    if (Array.isArray(item)) {
      if (rule.minItems !== undefined && item.length < rule.minItems) problems.push(`${path}: too few items`);
      if (rule.maxItems !== undefined && item.length > rule.maxItems) problems.push(`${path}: too many items`);
      if (rule.items) for (let i = 0; i < Math.min(item.length, rule.maxItems ?? 10_000); i += 1) {
        problems.push(...visit(rule.items, item[i], `${path}/${i}`));
        if (problems.length >= 20) break;
      }
    }
    if (typeof item === 'string') {
      const length = [...item].length;
      if (rule.minLength !== undefined && length < rule.minLength) problems.push(`${path}: too short`);
      if (rule.maxLength !== undefined && length > rule.maxLength) problems.push(`${path}: too long`);
      if (rule.pattern && !new RegExp(rule.pattern).test(item)) problems.push(`${path}: invalid format`);
    }
    if (typeof item === 'number' && ((rule.minimum !== undefined && item < rule.minimum) || (rule.maximum !== undefined && item > rule.maximum))) problems.push(`${path}: outside the supported range`);
    return problems.slice(0, 20);
  };
  return visit(root, value, '');
}

export function validateToolInput(name: string, args: unknown): void {
  const tool = TOOLS.find((tool) => tool.name === name);
  if (!tool) return; // Internal active_context/open_created are not MCP tools.
  const problems = schemaProblems(tool.inputSchema, args);
  if (problems.length) throw new AgentError('INVALID_INPUT', problems[0]!, { path: problems[0]!.split(':')[0], details: { problems } });
}
