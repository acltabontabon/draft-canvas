/**
 * The canvas's own "this is a node" language, borrowed for the home screen's targets: a selection
 * line with square resize handles at the corners, and round connection handles at the side
 * midpoints — the same shapes and sizes `canvas.css` gives `.dc-resize-handle` and `.dc-handle`.
 * Purely decorative; CSS decides which parts show (side handles on hover, the whole frame on
 * keyboard focus), exactly as hovering and selecting a node do in the editor.
 */
export function SelectionChrome() {
  return (
    <span className="dc-chrome" aria-hidden="true">
      <span className="dc-chrome-corner" data-at="nw" />
      <span className="dc-chrome-corner" data-at="ne" />
      <span className="dc-chrome-corner" data-at="se" />
      <span className="dc-chrome-corner" data-at="sw" />
      <span className="dc-chrome-anchor" data-at="n" />
      <span className="dc-chrome-anchor" data-at="e" />
      <span className="dc-chrome-anchor" data-at="s" />
      <span className="dc-chrome-anchor" data-at="w" />
    </span>
  );
}
