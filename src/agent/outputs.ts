type Schema = Record<string, unknown>;
const string = { type: 'string' };
const array = { type: 'array', items: { type: 'object' } };
const identity = { diagramId: string, revision: string };
const receipt = { ...identity, applied: { type: 'boolean' }, persisted: { type: 'boolean' }, state: string, added: { type: 'integer' }, updated: { type: 'integer' }, removed: { type: 'integer' }, quality: { type: 'object' } };
const error: Schema = { type: 'object', properties: { error: { type: 'object', properties: { code: string, message: string }, required: ['code', 'message'] } }, required: ['error'] };
const object = (properties: Record<string, unknown>, required: string[]): Schema => ({ type: 'object', properties, required });

export function outputFor(name: string): Schema {
  let success: Schema;
  switch (name) {
    case 'get_capabilities': success = object({ contract: { type: 'integer' }, starter: { type: 'object' } }, []); break;
    case 'list_diagrams': success = object({ diagrams: array, cursor: string, complete: { type: 'boolean' } }, ['diagrams']); break;
    case 'read_diagram': success = { anyOf: [
      object({ ...identity, elements: array, relationships: array, flows: array, cursor: string, completeness: { type: 'object', properties: Object.fromEntries(['elements', 'relationships', 'flows', 'openPoints'].map((key) => [key, { type: 'boolean' }])), required: ['elements', 'relationships', 'flows', 'openPoints'] } }, ['diagramId', 'revision', 'elements', 'relationships', 'flows', 'completeness']),
      object({ ...identity, format: { enum: ['mermaid', 'plantuml', 'c4'] }, source: string }, ['diagramId', 'revision', 'format', 'source']),
    ] }; break;
    case 'read_attachment': success = object({ ...identity, attachmentId: string, hostId: string, kind: { enum: ['note', 'code', 'text'] }, text: string, code: string, offset: { type: 'integer' }, nextOffset: { type: ['integer', 'null'] }, totalCharacters: { type: 'integer' } }, ['diagramId', 'revision', 'attachmentId', 'hostId', 'kind', 'offset', 'nextOffset', 'totalCharacters']); break;
    case 'render_diagram': success = object({ ...identity, format: { enum: ['png', 'svg'] }, mimeType: string, width: { type: 'number' }, height: { type: 'number' }, previewId: string, provisional: { type: 'boolean' } }, ['diagramId', 'revision', 'format', 'mimeType', 'width', 'height']); break;
    case 'create_diagram': success = object({ ...identity, created: { type: 'object' }, quality: { type: 'object' } }, ['diagramId', 'revision', 'created']); break;
    case 'update_diagram': success = object(receipt, ['diagramId', 'revision', 'applied']); break;
    case 'preview_diagram': success = object({ ...receipt, previewId: string, canApply: { type: 'boolean' }, diff: array, expiresInSeconds: { type: 'integer' } }, ['diagramId', 'revision', 'previewId', 'canApply', 'diff', 'expiresInSeconds']); break;
    case 'read_selection': success = object({ ...identity, selection: { type: ['object', 'null'] } }, ['diagramId', 'revision', 'selection']); break;
    case 'get_implementation_context': success = object({ ...identity, flows: array }, ['diagramId', 'revision', 'flows']); break;
    case 'list_proposals': success = object({ proposals: array, complete: { type: 'boolean' } }, ['proposals', 'complete']); break;
    default: success = object({ proposalId: string, status: string }, ['proposalId']);
  }
  return { type: 'object', anyOf: [success, error] };
}
