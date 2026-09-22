// Types for changelog.mjs — read by vite.config.ts (What's New) and the tests.

export type Platform = 'shared' | 'desktop' | 'web';
export type Audience = 'desktop' | 'web' | 'all';

export interface ChangelogEntry {
  version: string;
  date: string | null;
  heading: string;
  anchor: string;
  line: number;
  format: 'platform' | 'legacy';
  intro: string;
  sections: Partial<Record<Platform, string>>;
}

export interface WhatsNewRelease {
  version: string;
  date?: string;
  summary?: string;
  highlights: { title: string; description?: string }[];
  changelogUrl: string;
}

export const REPO: string;
export const PLATFORMS: Platform[];
export const HIGHLIGHT: string;
export const LABELS: Record<Platform, string>;
export class ChangelogError extends Error {}
export function parseVersion(version: string): { major: number; minor: number; patch: number; pre: string[] } | null;
export function compareVersions(a: string, b: string): number;
export function isPrerelease(version: string): boolean;
export function versionFromTag(tag: string): { version: string; desktopPreview: boolean };
export function headingAnchor(heading: string): string;
export function changelogUrl(entry: ChangelogEntry, tag: string): string;
export function parseChangelog(text: string): ChangelogEntry[];
export function findEntry(entries: ChangelogEntry[], version: string): ChangelogEntry;
export function releaseRange(entries: ChangelogEntry[], version: string): ChangelogEntry[];
export function platformsFor(platform: Audience): Platform[];
export function unwrap(markdown: string): string;
export function releaseNotes(changelog: string, options: { version: string; platform: Audience; tag: string }): string;
export function plainText(markdown: string): string;
export function whatsNew(changelog: string, platform: 'desktop' | 'web'): WhatsNewRelease[];
export function withDraft(changelog: string, version: string): string;
