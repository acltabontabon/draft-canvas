// Types for the parts of release-notes.mjs the tests use.

export function changelogSection(changelog: string, version: string): string | null;
export function unwrap(markdown: string): string;
export function getIt(version: string): string;
export function getItOnTheWeb(version: string): string;
export const FIRST_LAUNCH: string;
export function releaseBody(tag: string, changelog: string, options?: { platform?: 'desktop' | 'web' | 'all' }): string;
