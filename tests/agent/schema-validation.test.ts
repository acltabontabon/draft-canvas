import { expect, it } from 'vitest';
import Ajv from 'ajv';
import { TOOLS } from '../../src/agent/schema';
import { GALLERY } from '../fixtures/agent/gallery';

const ajv = new Ajv({ strict: false, allErrors: true });
const create = ajv.compile(TOOLS.find((tool) => tool.name === 'create_diagram')!.inputSchema);

it('the published schema accepts the create gallery, including descriptions inside rooms', () => {
  for (const fixture of GALLERY) {
    if (fixture.kind !== 'create') continue;
    expect(create({ requestId: fixture.id, ...fixture.request }), `${fixture.id}: ${JSON.stringify(create.errors)}`).toBe(true);
  }
});

it('still rejects unknown properties inside a nested room', () => {
  expect(create({ requestId: 'schema-test', title: 'Test', nodes: [{ id: 'system', type: 'service', label: 'System', inside: { nodes: [{ id: 'child', type: 'service', label: 'Child', invented: true }] } }] })).toBe(false);
  expect(create.errors?.some((e) => e.keyword === 'additionalProperties')).toBe(true);
});
