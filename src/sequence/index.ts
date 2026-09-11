export { buildSequenceModel } from './build';
export { toMermaid } from './mermaid';
export { toPlantUml } from './plantuml';
export { aliasFor } from './alias';
export { isStructural, STRUCTURAL_SEMANTICS } from './structural';
export type {
  InteractionKind,
  ParticipantKind,
  SequenceAlternative,
  SequenceDivider,
  SequenceElement,
  SequenceGroup,
  SequenceLoop,
  SequenceMessage,
  SequenceModel,
  SequenceNote,
  SequenceParallel,
  SequenceParticipant,
} from './types';
