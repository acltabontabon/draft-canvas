import { author, version } from '../package.json';

/**
 * Draft Canvas' own identity, in one place.
 *
 * The About panel (`ui/common/AboutDialog.tsx`) and the home screen
 * (`ui/Library/LibraryScreen.tsx`) both read from here — keeping it in one
 * place, rather than inline in either, is what stops the name, tagline or
 * version from drifting between them.
 */
export const PRODUCT = {
  name: 'Draft Canvas',
  tagline: 'For meetings that suddenly need a diagram.',
  /** The home screen's second line — the tagline's attitude, one notch quieter. */
  aside: 'Sketch the system before someone asks if you can draw that.',
  /** The About panel's one supporting sentence — what it enables, not what it contains. */
  pitch: 'Sketch architecture, trace flows, explain systems, and get back to the conversation.',
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
