import { author, version } from '../package.json';

/**
 * Draft Canvas' own identity, in one place.
 *
 * The About panel (`ui/common/AboutDialog.tsx`) is the only reader today, but
 * keeping it here — rather than inline in that component — is what stops the
 * name, tagline or version from drifting if a second surface ever needs them.
 */
export const PRODUCT = {
  name: 'Draft Canvas',
  tagline: 'For meetings that suddenly need a diagram.',
  description: 'Sketch systems, flows, code, and ideas without breaking the conversation.',
  privacy: 'Local-first. Nothing you draw leaves your device.',
  author: author.name,
  version,
  links: {
    github: 'https://github.com/acltabontabon',
    linkedin: 'https://www.linkedin.com/in/acltabontabon/',
    website: author.url,
    email: author.email,
    kofi: 'https://ko-fi.com/aclt_attic',
  },
} as const;
