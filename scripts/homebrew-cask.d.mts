export function stableVersion(tag: string): string;
export function assertPublishedRelease(release: { tag_name: string; draft: boolean; prerelease: boolean }, tag: string): void;
export function shouldUpdateCask(current: string, tag: string): boolean;
export function buildCask(input: { version: string; armSha256: string; intelSha256: string }): string;
export function caskForRelease(tag: string, directory: string): string;
