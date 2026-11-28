/**
 * Semantic review now lives with the other checks (`checks/review.ts`), where the headless CLI and
 * the editor read it too. Agents keep reaching it here, with the same findings as before.
 */
export * from '../checks/review';
