import { SERVICE_KINDS } from '../document/types';
import { SERVICE_KIND_OPTION_LABELS } from '../ui/Editor/nodeKindLabels';
import { shapeVariantOptions } from './shapeVariantOptions';

/** The Service kind picker's shared option list — see `dataStoreOptions.tsx`. */
export const SERVICE_ICON_OPTIONS = shapeVariantOptions(
  'service',
  SERVICE_KINDS,
  SERVICE_KIND_OPTION_LABELS,
  (kind) => ({ serviceKind: kind }),
);
