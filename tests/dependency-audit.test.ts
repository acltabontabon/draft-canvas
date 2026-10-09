import { describe, expect, it } from 'vitest';
import { findingsOf, unaccepted, type Exception } from '../scripts/dependency-audit';

const advisory = { name: 'parser', severity: 'high', url: 'https://github.com/advisories/GHSA-abcd-efgh-ijkl' };
const finding = { ecosystem: 'npm' as const, id: 'GHSA-abcd-efgh-ijkl', package: 'parser' };
const exception: Exception = { ...finding, reason: 'No patched upstream release; input is restricted.', tracking: 'SECURITY.md', expires: '2026-11-01' };

describe('dependency audit gate', () => {
  it('finds underlying high/critical advisories without duplicating transitive effects', () => {
    expect(findingsOf('npm', { metadata: {}, vulnerabilities: { parser: { via: [advisory, advisory] }, wrapper: { via: ['parser'] }, other: { via: [{ ...advisory, severity: 'moderate' }] } } })).toEqual([finding]);
  });

  it('never treats a failed or incomplete scan as clean', () => {
    for (const report of [null, {}, { error: { message: 'registry unavailable' } }, { metadata: {}, vulnerabilities: { parser: {} } }]) {
      expect(() => findingsOf('npm', report)).toThrow();
    }
    expect(() => findingsOf('cargo', { vulnerabilities: {} })).toThrow();
  });

  it('requires a current, package-specific exception and blocks unrelated packages', () => {
    expect(unaccepted([finding], [], '2026-10-09')).toEqual([finding]);
    expect(unaccepted([finding], [exception], '2026-10-09')).toEqual([]);
    expect(unaccepted([{ ...finding, package: 'other' }], [exception], '2026-10-09')).toHaveLength(1);
    expect(() => unaccepted([], [{ ...exception, reason: '' }], '2026-10-09')).toThrow();
    expect(() => unaccepted([], [exception], '2026-11-01')).toThrow();
  });

  it('blocks RustSec vulnerabilities regardless of a missing severity rating', () => {
    const report = { vulnerabilities: { list: [{ advisory: { id: 'RUSTSEC-2026-9999' }, package: { name: 'crate' } }] } };
    expect(findingsOf('cargo', report)).toEqual([{ ecosystem: 'cargo', id: 'RUSTSEC-2026-9999', package: 'crate' }]);
  });

  it('also blocks unsoundness warnings and refuses yanked dependencies', () => {
    const unsound = { advisory: { id: 'RUSTSEC-2026-9998' }, package: { name: 'glib' } };
    expect(findingsOf('cargo', { vulnerabilities: { list: [] }, warnings: { unsound: [unsound] } })).toEqual([
      { ecosystem: 'cargo', id: 'RUSTSEC-2026-9998', package: 'glib' },
    ]);
    expect(() => findingsOf('cargo', { vulnerabilities: { list: [] }, warnings: { yanked: [{ package: 'old' }] } })).toThrow(/yanked/);
  });
});
