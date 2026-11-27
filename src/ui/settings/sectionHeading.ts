import { createContext } from 'react';

/**
 * The level a settings section's title takes. Under a Settings page's own `h3` it is an `h4`; the
 * Appearance panel has no page title, only its cover's `h2`, so there it is an `h3` — an `h4` skipped
 * a level. Read by `SettingsSection` and the style packs' own heading.
 */
export const SectionHeadingLevel = createContext<3 | 4>(4);
