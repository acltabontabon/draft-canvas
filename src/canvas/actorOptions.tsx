import { ACTOR_KINDS } from '../document/types';
import { ACTOR_KIND_OPTION_LABELS } from '../ui/Editor/nodeKindLabels';
import { shapeVariantOptions } from './shapeVariantOptions';

/** The Actor kind picker's shared option list — see `dataStoreOptions.tsx`. Human/System/Device
 *  already have genuinely distinct silhouettes (`nodes/describe.ts`'s `humanGlyph`/`systemGlyph`/
 *  `deviceGlyph`) purely for visual/participant-type reasons — no relationship semantics hinge on
 *  actor kind, and none are being added here; this is the picker catching up visually to a
 *  distinction the shapes already made. */
export const ACTOR_ICON_OPTIONS = shapeVariantOptions(
  'actor',
  ACTOR_KINDS,
  ACTOR_KIND_OPTION_LABELS,
  (kind) => ({ actorKind: kind }),
);
