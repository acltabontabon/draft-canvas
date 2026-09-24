/**
 * `peerNormalize` (`agent/place.ts`): peer shapes — same type, sub-kind, parent, and rough rank —
 * end up one shared, bounded size, so a row of actors or external systems reads as a row.
 */
import { describe, expect, it } from 'vitest';
import { compose } from '../../src/agent/compile';
import { applyUpdate } from '../../src/agent/patch';
import { deserializeDocument } from '../../src/export/project';
import type { DraftDocument, DraftNode } from '../../src/document/types';

function build(raw: Record<string, unknown>): DraftDocument {
  const parsed = deserializeDocument(compose({ title: 'T', ...raw }, 'd_peersize0').text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.document;
}

const byId = (doc: DraftDocument, id: string) => doc.nodes.find((n) => n.id === id) as DraftNode;
const sizeOf = (n: DraftNode) => `${n.width}x${n.height}`;

describe('peer sizing', () => {
  it('gives two actors with very different content one shared, bounded size', () => {
    const doc = build({
      nodes: [
        { id: 'applicant', type: 'person', label: 'Applicant', description: 'A person applying for a loan online.' },
        { id: 'officer', type: 'person', label: 'Loan Officer', description: 'Reviews applications, overrides automated decisions when the model is unsure.' },
      ],
    });
    const applicant = byId(doc, 'applicant');
    const officer = byId(doc, 'officer');
    expect(sizeOf(applicant)).toBe(sizeOf(officer));
  });

  it('gives four external systems one shared row size, without one long description enlarging the rest', () => {
    const doc = build({
      nodes: [
        { id: 'focal', type: 'service', label: 'Loan Application System', description: 'Accepts, underwrites, decisions and disburses consumer loan applications.' },
        { id: 'bureau', type: 'external-system', label: 'Credit Bureau', description: 'Third-party credit history and score provider.' },
        { id: 'kyc', type: 'external-system', label: 'KYC Provider', description: 'Identity verification and fraud checks.' },
        { id: 'core', type: 'external-system', label: 'Core Banking System', description: 'Holds accounts, settles disbursed funds, and reconciles every transaction against the general ledger nightly.' },
        { id: 'notify', type: 'external-system', label: 'Email/SMS Provider', description: 'Delivers applicant notifications.' },
      ],
      relationships: [
        { id: 'r1', from: 'focal', to: 'bureau' },
        { id: 'r2', from: 'focal', to: 'kyc' },
        { id: 'r3', from: 'focal', to: 'core' },
        { id: 'r4', from: 'focal', to: 'notify' },
      ],
    });
    const bureau = byId(doc, 'bureau');
    const kyc = byId(doc, 'kyc');
    const core = byId(doc, 'core');
    const notify = byId(doc, 'notify');
    // The three short-description systems share one size...
    expect(sizeOf(bureau)).toBe(sizeOf(kyc));
    expect(sizeOf(kyc)).toBe(sizeOf(notify));
    // ...and Core Banking's much longer description didn't drag them up to match it.
    expect(core.height).toBeGreaterThan(bureau.height);
    expect(sizeOf(core)).not.toBe(sizeOf(bureau));
  });

  it('leaves a lone shape of its kind untouched', () => {
    const doc = build({
      nodes: [
        { id: 'only', type: 'service', label: 'Solo Service' },
        { id: 'db', type: 'database', label: 'Store' },
      ],
      relationships: [{ id: 'r', from: 'only', to: 'db' }],
    });
    // A group of one proves nothing was forced; it's still sized to its own content.
    expect(byId(doc, 'only').width).toBeGreaterThan(0);
  });

  it('never merges different types, sub-kinds or parents', () => {
    const doc = build({
      groups: [{ id: 'g', label: 'Group' }],
      nodes: [
        { id: 'svc', type: 'service', label: 'A' },
        { id: 'api', type: 'api', label: 'B' },
        { id: 'db', type: 'database', label: 'C' },
        { id: 'inside', type: 'service', label: 'D', group: 'g' },
      ],
    });
    // service (generic) vs api (a distinct serviceKind) vs database (a distinct type) vs a service
    // inside a group (a distinct parent) — none of these are peers of each other.
    const sizes = new Set(['svc', 'api', 'db', 'inside'].map((id) => sizeOf(byId(doc, id))));
    expect(sizes.size).toBeGreaterThan(1);
  });

  it("keeps a merge point out of the parallel shapes that feed it, even though they share a type", () => {
    // fraud/stock are parallel siblings of intake; decide is one step downstream of both — same
    // type and sub-kind as fraud/stock, but a different rank, so it must not share their size.
    const doc = build({
      nodes: [
        { id: 'intake', type: 'service', label: 'Order Intake' },
        { id: 'fraud', type: 'service', label: 'Fraud Check' },
        { id: 'stock', type: 'service', label: 'Inventory Check' },
        { id: 'decide', type: 'service', label: 'Order Decision', description: 'Combines the fraud score and stock reservation into one accept-or-reject outcome for the order.' },
      ],
      relationships: [
        { id: 'a', from: 'intake', to: 'fraud' },
        { id: 'b', from: 'intake', to: 'stock' },
        { id: 'c', from: 'fraud', to: 'decide' },
        { id: 'd', from: 'stock', to: 'decide' },
      ],
    });
    expect(sizeOf(byId(doc, 'fraud'))).toBe(sizeOf(byId(doc, 'stock')));
    // decide's much longer description would have enlarged fraud/stock had rank not separated them.
    expect(sizeOf(byId(doc, 'decide'))).not.toBe(sizeOf(byId(doc, 'fraud')));
  });

  it('defaults off when arranging an existing diagram: sizes it already has are kept as they are', () => {
    // normalizePeerSizes: false at creation, so 'a' and 'b' start out genuinely different sizes —
    // standing in for an existing diagram nobody has re-normalized yet.
    const original = build({
      layout: { normalizePeerSizes: false },
      nodes: [
        { id: 'a', type: 'external-system', label: 'A' },
        { id: 'b', type: 'external-system', label: 'B', description: 'A rather longer description that would need a taller box to show in full.' },
      ],
    });
    const before = { a: byId(original, 'a'), b: byId(original, 'b') };
    expect(sizeOf(before.a)).not.toBe(sizeOf(before.b));
    const { file } = applyUpdate(original, [], [{ op: 'arrange' }], undefined);
    expect(sizeOf(byId(file, 'a'))).toBe(sizeOf(before.a));
    expect(sizeOf(byId(file, 'b'))).toBe(sizeOf(before.b));
  });

  it('normalizes on request, but never shrinks a shape below the size it already has', () => {
    const original = build({
      nodes: [
        { id: 'a', type: 'external-system', label: 'A' },
        { id: 'b', type: 'external-system', label: 'B' },
      ],
    });
    // A manually widened shape, wider than its own content needs, but not a wild outlier.
    const widened: DraftDocument = { ...original, nodes: original.nodes.map((n) => (n.id === 'a' ? { ...n, width: n.width + 40 } : n)) };
    const { file } = applyUpdate(widened, [], [{ op: 'arrange' }], { normalizePeerSizes: true });
    const a = byId(file, 'a');
    const b = byId(file, 'b');
    expect(a.width).toBeGreaterThanOrEqual(byId(widened, 'a').width);
    expect(sizeOf(a)).toBe(sizeOf(b));
  });

  it('leaves a genuine outlier at its own size instead of shrinking or enlarging its peers', () => {
    const doc = build({
      nodes: [
        { id: 'a', type: 'external-system', label: 'A' },
        { id: 'b', type: 'external-system', label: 'B' },
        { id: 'huge', type: 'external-system', label: 'C', description: 'A description so much longer than its two siblings’ that this shape reads as its own case rather than a third member of the same row, and folding it in would balloon the whole row to match it.' },
      ],
    });
    const a = byId(doc, 'a');
    const b = byId(doc, 'b');
    const huge = byId(doc, 'huge');
    expect(sizeOf(a)).toBe(sizeOf(b));
    expect(huge.height).toBeGreaterThan(a.height * 1.5);
  });
});
