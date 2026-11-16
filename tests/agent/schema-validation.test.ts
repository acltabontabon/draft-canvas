import { expect, it } from 'vitest';
import Ajv from 'ajv';
import { FULL_TOOLS, TOOLS } from '../../src/agent/schema';
import { GALLERY } from '../fixtures/agent/gallery';

const ajv = new Ajv({ strict: false, allErrors: true });
const discovery = ajv.compile(TOOLS.find((tool) => tool.name === 'create_diagram')!.inputSchema);
const create = ajv.compile(FULL_TOOLS.find((tool) => tool.name === 'create_diagram')!.inputSchema);

it('the published schema accepts the create gallery, including descriptions inside rooms', () => {
  for (const fixture of GALLERY) {
    if (fixture.kind !== 'create') continue;
    expect(discovery({ requestId: fixture.id, ...fixture.request }), `${fixture.id}: ${JSON.stringify(discovery.errors)}`).toBe(true);
    expect(create({ requestId: fixture.id, ...fixture.request }), `${fixture.id}: ${JSON.stringify(create.errors)}`).toBe(true);
  }
});

it('still rejects unknown properties inside a nested room', () => {
  expect(create({ requestId: 'schema-test', title: 'Test', nodes: [{ id: 'system', type: 'service', label: 'System', inside: { nodes: [{ id: 'child', type: 'service', label: 'Child', invented: true }] } }] })).toBe(false);
  expect(create.errors?.some((e) => e.keyword === 'additionalProperties')).toBe(true);
});
