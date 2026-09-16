import type { RecipeId } from '../recipes';
import type { Scene } from '../types';
import { addToFlow, exportSequence, presentFlow } from './flows';
import { deadLetterQueue, intentContinuation, lookInside, starters } from './architecture';
import { addResponse, attachToConnector, connect, describeInteraction, junctionScene, makeAsync } from './connections';
import { addShape, attachNote, boundary, pickAKind } from './shapes';

/**
 * Every recipe's scene, by recipe id. Only the Learn drawer's own chunk imports this — the palette
 * searches recipes without ever loading a scene. A recipe without a scene doesn't compile.
 */
export const SCENES = {
  'add-shape': addShape,
  connect,
  'describe-interaction': describeInteraction,
  'attach-note': attachNote,
  'add-to-flow': addToFlow,
  'present-flow': presentFlow,
  'make-async': makeAsync,
  'add-response': addResponse,
  'attach-to-connector': attachToConnector,
  'pick-a-kind': pickAKind,
  'dead-letter-queue': deadLetterQueue,
  'look-inside': lookInside,
  boundary,
  junction: junctionScene,
  'intent-continuation': intentContinuation,
  starters,
  'export-sequence': exportSequence,
} as const satisfies Record<RecipeId, Scene>;

export function sceneFor(id: string): Scene | undefined {
  return (SCENES as Record<string, Scene>)[id];
}
