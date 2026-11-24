import { author } from '../package.json';

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
  /** The first-run home screen's one big line. */
  motto: 'Draw it so everyone gets it.',
  tagline: 'For meetings that suddenly need a diagram.',
  /** The About panel's one supporting sentence — what it enables, not what it contains. */
  pitch: 'Sketch architecture, trace flows, explain systems, and get back to the conversation.',
  author: author.name,
  version: __APP_VERSION__,
  /**
   * Where Draft Canvas lives on the web. The site and its docs are at the apex; the editor has an
   * origin of its own, so its storage, service worker and security policy are never the site's.
   */
  web: {
    site: 'https://draftcanvas.dev/',
    app: 'https://app.draftcanvas.dev/',
    appOrigin: 'https://app.draftcanvas.dev',
    /**
     * The editor's first home, `https://acltabontabon.com/draft-canvas/editor/`. Diagrams drawn
     * there stay in that origin's storage, where no other address can read them — so the editor
     * still served there offers to hand them to `app` (see `storage/handoff.ts`).
     */
    legacyOrigin: 'https://acltabontabon.com',
  },
  links: {
    github: 'https://github.com/acltabontabon',
    /** The guides and reference, where the in-app handbook used to be. */
    docs: 'https://draftcanvas.dev/docs/',
    linkedin: 'https://www.linkedin.com/in/acltabontabon/',
    website: author.url,
    email: author.email,
    kofi: 'https://ko-fi.com/aclt_attic',
  },
} as const;
