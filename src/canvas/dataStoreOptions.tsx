import { DATABASE_KINDS } from '../document/types';
import { DATABASE_KIND_OPTION_LABELS } from '../ui/Editor/nodeKindLabels';
import { shapeVariantOptions } from './shapeVariantOptions';

/** The Data Store kind picker's shared option list — icon + label — so `Inspector.tsx`'s and
 *  `ElementInspectorPopover.tsx`'s pickers can't drift apart, same discipline `nodeKindLabels.ts`
 *  already applies to the plain label tables. */
export const DATABASE_ICON_OPTIONS = shapeVariantOptions(
  'database',
  DATABASE_KINDS,
  DATABASE_KIND_OPTION_LABELS,
  (kind) => ({ databaseKind: kind }),
);
