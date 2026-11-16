import { isDeepStrictEqual } from 'node:util';

/** Compare serialized diagram content, ignoring object-key order and transient undefined fields. */
export function verify(before, candidate, task) {
  const beforeDoc = JSON.parse(JSON.stringify(before));
  const file = JSON.parse(JSON.stringify(candidate));
  let verified = false;
  if (task === 'rename') {
    const node = file.nodes.find(n => n.id === 'editor');
    verified = node?.text === 'Diagram editor';
    if (verified) node.text = beforeDoc.nodes.find(n => n.id === 'editor').text;
  } else if (task === 'repoint') {
    const edge = file.edges.find(e => e.id === 'r2');
    verified = edge?.target === 'files';
    if (verified) {
      const old = beforeDoc.edges.find(e => e.id === 'r2');
      // Redirecting a connector recomputes its anchors; its identity, label and semantics stay.
      for (const key of ['target', 'sourceAnchor', 'targetAnchor']) {
        if (key in old) edge[key] = old[key]; else delete edge[key];
      }
    }
  } else if (task === 'description') {
    const old = beforeDoc.nodes.find(n=>n.id==='editor').inside.nodes.find(n=>n.id==='e.model');
    const node = file.nodes.find(n=>n.id==='editor')?.inside?.nodes.find(n=>n.id==='e.model');
    verified = node?.description==='Validates files and manages nested views.';
    if (verified) node.description=old.description;
  } else if (task === 'shape') {
    const added = file.nodes.filter(n=>!beforeDoc.nodes.some(b=>b.id===n.id));
    verified = added.length===1 && added[0].text==='Audit worker' && added[0].type==='service' && added[0].description==='Records audit events.' && !file.edges.some(e=>e.source===added[0].id || e.target===added[0].id);
    if (verified) file.nodes=file.nodes.filter(n=>n.id!==added[0].id);
  } else if (task === 'connection') {
    const old = beforeDoc.edges.find(e=>e.id==='r2');
    const edge = file.edges.find(e=>e.id==='r2');
    verified = edge?.label==='Saves locally';
    if (verified) edge.label=old.label;
  }
  let otherFieldsSame = null;
  if (file && beforeDoc) {
    const normalize = ({metadata: {updatedAt: _updatedAt,...metadata},...graph})=>({...graph, metadata});
    otherFieldsSame = isDeepStrictEqual(normalize(file), normalize(beforeDoc));
  }
  return { verified: !!verified, otherFieldsSame };
}
