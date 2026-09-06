import { QUEUE_KINDS } from '../document/types';
import { QUEUE_KIND_OPTION_LABELS } from '../ui/Editor/nodeKindLabels';
import { shapeVariantOptions } from './shapeVariantOptions';

/** The Queue kind picker's shared option list — see `dataStoreOptions.tsx`. */
export const QUEUE_ICON_OPTIONS = shapeVariantOptions(
  'queue',
  QUEUE_KINDS,
  QUEUE_KIND_OPTION_LABELS,
  (kind) => ({ queueKind: kind }),
);
