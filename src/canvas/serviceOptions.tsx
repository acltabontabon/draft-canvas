import { isGlyphServiceKind } from '../document/dataStoreGeometry';
import { SERVICE_KINDS } from '../document/types';
import { SERVICE_KIND_OPTION_LABELS } from '../lib/nodeKindLabels';
import { shapeVariantOptions } from './shapeVariantOptions';

/** The Service kind picker's shared option list — see `dataStoreOptions.tsx`. */
export const SERVICE_ICON_OPTIONS = shapeVariantOptions(
  'service',
  SERVICE_KINDS,
  SERVICE_KIND_OPTION_LABELS,
  (kind) => ({ serviceKind: kind }),
  // The glyph kinds preview in a box that hugs the glyph: at a card's size it is cut off at the
  // foot, and at their own it is a speck in the middle of the room its caption would have had.
  { sizeFor: (kind) => (isGlyphServiceKind(kind) ? { width: 78, height: 60 } : undefined) },
);
