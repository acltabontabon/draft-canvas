/**
 * Smart Ink's recognition, as one module the canvas loads on first use — nothing here is part of the
 * editor's start-up bundle (`canvas/inkSession.ts` imports it dynamically).
 */
export { recognize } from './recognize';
export { interpret } from './interpret';
