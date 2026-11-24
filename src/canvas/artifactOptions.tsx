import { ARTIFACT_KINDS } from '../document/types';
import { ARTIFACT_KIND_OPTION_LABELS } from '../lib/nodeKindLabels';
import { shapeVariantOptions } from './shapeVariantOptions';

/** The Artifact kind picker's shared option list — see `dataStoreOptions.tsx`. One sheet, four
 *  marks on it (`nodes/describe.ts`'s `artifactMark`), so the previews are worth looking at. */
export const ARTIFACT_ICON_OPTIONS = shapeVariantOptions(
  'artifact',
  ARTIFACT_KINDS,
  ARTIFACT_KIND_OPTION_LABELS,
  (kind) => ({ artifactKind: kind }),
);
