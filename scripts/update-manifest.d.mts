// Types for the parts of update-manifest.mjs the tests use.

export interface Platform {
  key: string;
  label: string;
  file: (version: string) => string;
}

export interface Manifest {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, { signature: string; url: string }>;
}

export const REPO: string;
export const CHANNELS_TAG: string;
export const CHANNELS: string[];
export const ENDPOINT: string;
export const PLATFORMS: Platform[];
export function assetUrl(version: string, file: string, baseUrl?: string | null): string;
export function parseVersion(text: string): { major: number; minor: number; patch: number; pre: string[] } | null;
export function compareVersions(a: string, b: string): -1 | 0 | 1;
export function isPrerelease(version: string): boolean;
export function decodePublicKey(pubkey: string): { keyId: Buffer; key: Buffer };
export function signedVersion(trustedComment: string): string | null;
export function verifySignature(
  data: Uint8Array,
  signature: string,
  pubkey: string,
): { ok: true; trustedComment: string; version: string | null } | { ok: false; reason: string };
export function changelogSection(changelog: string, version: string): string | null;
export function buildManifest(options: {
  version: string;
  notes?: string | null;
  pubDate: string;
  signatures: Record<string, string>;
  baseUrl?: string | null;
}): Manifest;
export function manifestProblems(
  manifest: unknown,
  options: { version: string; pubkey: string; artifacts?: string | null; requireSignedVersion?: boolean; baseUrl?: string | null },
): string[];
export function channelsToWrite(options: {
  version: string;
  existing?: Record<string, { version?: string } | undefined>;
  force?: boolean;
}): string[];
export function configProblems(updater: Record<string, unknown> | null): string[];
