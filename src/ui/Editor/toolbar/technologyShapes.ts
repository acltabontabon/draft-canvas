import { shapeForTechnology } from '../../../document/technologyKind';
import { ALL_PRESETS, type Preset } from '../../../lib/presets';
import { DATABASE_KIND_OPTION_LABELS, QUEUE_KIND_OPTION_LABELS, SERVICE_KIND_OPTION_LABELS } from '../../../lib/nodeKindLabels';
import { GENERIC_TECHNOLOGY_ICON, technologyIcon, technologySuggestions } from '../../../nodes/technology';

/** How many technologies a search offers: a few good answers, not the catalog. */
const LIMIT = 5;

/**
 * Products `technologyKind.ts` knows the shape of but the logo catalog has no mark for (it carries
 * no AWS or Azure service logos). Spelled the way they should read on the shape; each has to be a
 * name that table recognises, which `tests/shape-picker.test.tsx` holds it to.
 */
export const UNLISTED_TECHNOLOGIES = [
  'Amazon S3', 'Amazon SQS', 'Amazon SNS', 'Amazon DynamoDB', 'Amazon Kinesis', 'Amazon EventBridge', 'Amazon RDS',
  'Amazon Redshift', 'Amazon MSK', 'Amazon ElastiCache', 'Amazon OpenSearch', 'Amazon API Gateway', 'AWS Glue',
  'Azure Service Bus', 'Azure Event Hubs', 'Azure Event Grid', 'Azure Cosmos DB', 'Azure Blob Storage', 'Azure Synapse',
  'Azure API Management', 'Google Pub/Sub', 'Google Cloud Storage', 'Google Cloud SQL', 'Google BigQuery', 'Google Dataflow',
];

/**
 * What services are written in and built on: languages, frameworks and runtimes. None of them is a
 * shape of its own — Spring Boot is not a kind of Service the way Kafka is a kind of Queue — but
 * "a Spring Boot service" is the commonest thing a box in a diagram is, so these are offered from
 * the first letters like the technologies above, as a Service built with them. A short, curated
 * list on purpose: the catalog's other three thousand names still need typing in full.
 */
export const SERVICE_STACKS = [
  'Spring Boot', 'Node.js', 'Express', 'NestJS', 'Next.js', 'Python', 'Django', 'Flask', 'FastAPI', 'Go', 'Rust', 'Java',
  'Kotlin', 'Ktor', 'Quarkus', '.NET', 'C#', 'Ruby on Rails', 'Ruby', 'PHP', 'Laravel', 'Elixir', 'Scala', 'TypeScript',
  'Deno', 'Bun', 'GraphQL', 'React', 'Vue.js', 'Angular', 'Svelte', 'Flutter', 'Swift', 'AWS Lambda', 'Cloudflare Workers',
];

const slugOf = (name: string) => {
  const icon = technologyIcon(name);
  return icon && icon !== GENERIC_TECHNOLOGY_ICON ? icon.slug : name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
};

const words = (text: string) => text.toLowerCase().split(/[^a-z0-9.+#/]+/).filter(Boolean);

function presetFor(technology: string, slug: string): { preset: Preset; known: boolean } {
  const shape = shapeForTechnology(technology);
  const base = ALL_PRESETS.find((preset) => preset.type === (shape?.type ?? 'service'))!;
  const kind = !shape
    ? undefined
    : shape.type === 'database'
      ? DATABASE_KIND_OPTION_LABELS[shape.databaseKind]
      : shape.type === 'queue'
        ? QUEUE_KIND_OPTION_LABELS[shape.queueKind]
        : SERVICE_KIND_OPTION_LABELS[shape.serviceKind];
  // Two logos share a title ("Spring"): the catalog tells them apart as "Spring (spring)", which
  // the shape has to keep to get the right logo — but nobody needs to read it in a list.
  const name = technology.endsWith(` (${slug})`) ? technology.slice(0, -slug.length - 3) : technology;
  return {
    known: shape !== null,
    preset: {
      id: `technology:${slug}`,
      label: name,
      type: base.type,
      shortcut: '',
      hint: kind ? `${base.label} · ${kind}` : `${base.label} · built with ${name}`,
      description: kind
        ? `A ${base.label} for ${name}, set to ${kind}, with its logo.`
        : `A ${base.label} built with ${name}, with its logo.`,
      technology,
    },
  };
}

/**
 * The shapes a technology's name stands for — "kafka" is a Queue that is an Apache Kafka topic,
 * "redis" a Data Store that is a cache — as presets the shape picker can arm like any other.
 *
 * Two existing tables do the work, so this adds no vocabulary of its own: the logo catalog knows
 * how a technology is spelled, and `technologyKind.ts` knows which shape and kind one is. Only
 * what that second table knows is offered freely. The catalog is thousands of brands, most of them
 * not something a diagram draws, and guessing a shape for each ("zebra" → a Service built with
 * Zebra Technologies) would bury the real answers. So a technology the table is silent about is
 * offered only when it was named outright, as what a Service is *built with*, said so in the row
 * — and not at all when `guess` is off, which the picker turns off whenever the same word names a
 * shape ("note" is a Note). The exception is `SERVICE_STACKS`: the languages and frameworks a
 * service usually is, which match from their first letters like everything else here.
 *
 * Matching is by the start of a word of the name, or an alias the catalog recognises ("postgres",
 * "k8s"): "contains these letters" finds far too much.
 */
export function technologyShapes(query: string, { guess = true }: { guess?: boolean } = {}): Preset[] {
  const typed = query.trim().toLowerCase();
  if (typed.length < 2) return [];
  const exact = technologyIcon(typed);
  const exactSlug = exact && exact !== GENERIC_TECHNOLOGY_ICON ? exact.slug : undefined;
  const first = words(typed)[0] ?? typed;
  const starts = (name: string) => words(name).some((word) => word.startsWith(first));

  const known: Preset[] = [];
  let named: Preset | null = null;
  for (const { value, icon } of technologySuggestions(typed)) {
    const isExact = icon.slug === exactSlug;
    if (!isExact && !starts(value)) continue;
    const entry = presetFor(value, icon.slug);
    if (entry.known) known.push(entry.preset);
    else if (isExact && guess && !named) named = entry.preset;
  }
  for (const name of UNLISTED_TECHNOLOGIES) {
    if (!starts(name) || known.some((preset) => preset.label.toLowerCase() === name.toLowerCase())) continue;
    known.push(presetFor(name, slugOf(name)).preset);
  }
  const taken = new Set([...known, ...(named ? [named] : [])].map((preset) => preset.label.toLowerCase()));
  const stacks = SERVICE_STACKS.filter((name) => starts(name) && !taken.has(name.toLowerCase())).map((name) => presetFor(name, slugOf(name)).preset);
  // Named outright, it is what was asked for: ahead of names that merely start the same way. Then
  // what is a shape of its own, then what a Service is built with.
  return [...(named ? [named] : []), ...known, ...stacks].slice(0, LIMIT);
}
