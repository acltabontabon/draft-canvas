import { describe, expect, it } from 'vitest';
import { compareVersions, isVersionNewer, parseVersion } from '../src/lib/semver';

describe('compareVersions', () => {
  it('compares numerically, not lexically', () => {
    // The classic lexical-comparison trap: "1.10.0" < "1.9.0" as strings.
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.9.0', '1.10.0')).toBeLessThan(0);
  });

  it('treats an equal version as equal', () => {
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });

  it('orders major, then minor, then patch', () => {
    expect(compareVersions('2.0.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.2.0', '1.1.9')).toBeGreaterThan(0);
    expect(compareVersions('1.1.2', '1.1.1')).toBeGreaterThan(0);
  });

  it('ranks a prerelease below its own release', () => {
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0.0-beta.1')).toBeGreaterThan(0);
  });

  it('compares prerelease identifiers numerically where both sides are numeric', () => {
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.10')).toBeLessThan(0);
  });

  it('treats a malformed version as older than any real version', () => {
    expect(compareVersions('not-a-version', '0.0.1')).toBeLessThan(0);
    expect(isVersionNewer('0.0.1', 'not-a-version')).toBe(true);
  });

  it('treats two malformed versions as equal', () => {
    expect(compareVersions('garbage', 'also garbage')).toBe(0);
  });

  it('parseVersion extracts the numeric parts and prerelease identifiers', () => {
    expect(parseVersion('1.2.3-beta.4')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: ['beta', '4'] });
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(parseVersion('nope')).toBeNull();
  });
});

describe('isVersionNewer', () => {
  it('is false for an equal version', () => {
    expect(isVersionNewer('1.0.0', '1.0.0')).toBe(false);
  });

  it('is true only when strictly newer', () => {
    expect(isVersionNewer('1.0.1', '1.0.0')).toBe(true);
    expect(isVersionNewer('1.0.0', '1.0.1')).toBe(false);
  });
});
