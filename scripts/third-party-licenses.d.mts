// Types for the parts of third-party-licenses.mjs the tests use.

export interface Package {
  name: string;
  version: string;
  license: string;
  path: string;
}

export const LICENSE_FILES: RegExp;
export const BUNDLED_DEV: string[];
export function licenseTextsIn(dir: string): Array<{ name: string; text: string }>;
export function npmPackages(): Package[];
export function cargoPackages(): Package[] | null;
export function render(): string;
