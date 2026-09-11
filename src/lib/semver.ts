/**
 * Minimal semantic version comparison — `major.minor.patch` plus an optional `-prerelease`
 * suffix, compared per semver precedence (numeric identifiers compare numerically so `1.10.0` is
 * correctly newer than `1.9.0`; a prerelease sorts before its own release). Not a full semver
 * range/validator — this project only ever needs to order and compare its own release numbers.
 */
export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated identifiers after the first `-`, e.g. `['beta', '1']` for `1.0.0-beta.1`. */
  prerelease: string[];
}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/;

export function parseVersion(input: string): ParsedVersion | null {
  const match = VERSION_RE.exec(input.trim());
  if (!match) return null;
  const [, major, minor, patch, prerelease] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease ? prerelease.split('.') : [],
  };
}

function compareIdentifiers(a: string, b: string): number {
  const numA = /^\d+$/.test(a) ? Number(a) : null;
  const numB = /^\d+$/.test(b) ? Number(b) : null;
  if (numA !== null && numB !== null) return numA - numB;
  if (numA !== null) return -1; // a numeric identifier always has lower precedence than an alphanumeric one
  if (numB !== null) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * -1 if `a` is older than `b`, 0 if equal, 1 if `a` is newer. A version that fails to parse
 * (malformed input, a corrupted persisted value) sorts as older than anything real — so a bad
 * stored "last seen" value fails toward *showing* an update rather than hiding one, and a bad
 * catalog entry never masquerades as the newest release.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;

  const aHasPre = pa.prerelease.length > 0;
  const bHasPre = pb.prerelease.length > 0;
  if (aHasPre && !bHasPre) return -1;
  if (!aHasPre && bHasPre) return 1;

  const len = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < len; i += 1) {
    const x = pa.prerelease[i];
    const y = pb.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const cmp = compareIdentifiers(x, y);
    if (cmp !== 0) return cmp;
  }
  return 0;
}

export function isVersionNewer(version: string, than: string): boolean {
  return compareVersions(version, than) > 0;
}

export type VersionKind = 'major' | 'minor' | 'patch';

/** Which segment of the version actually changed, going by the number's own shape — not stored
 *  metadata. A release's importance is already encoded in its version; this just reads it back
 *  out for subtle typographic hierarchy (see Release History). Unparseable input reads as the
 *  least significant kind, never claims false importance. */
export function versionKind(version: string): VersionKind {
  const parsed = parseVersion(version);
  if (!parsed) return 'patch';
  if (parsed.minor === 0 && parsed.patch === 0) return 'major';
  if (parsed.patch === 0) return 'minor';
  return 'patch';
}
