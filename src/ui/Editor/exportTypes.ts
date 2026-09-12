/**
 * The Export dialog's own vocabulary, kept in a module of its own rather than on `ExportDialog.tsx`
 * so the panels never have to import from a component file: a panel and the dialog can then move,
 * or be reverted, independently without taking the build down with them.
 */
export type ExportMode = 'document' | 'image' | 'animated' | 'sequence';
export type DocumentFormat = 'editable' | 'secure';
export type ImageFormat = 'png' | 'svg';
