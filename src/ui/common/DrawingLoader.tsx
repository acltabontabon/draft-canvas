/**
 * What the canvas shows while the editor's code is still arriving: a tiny diagram drawing itself —
 * one card, then another, then the wire between them — fading, and drawing again until it lands.
 * The same sheet-and-wire the blank canvas and Home are made of, so waiting looks like the start of
 * drawing rather than a spinner.
 *
 * Vector and token-coloured, so it follows the theme and stays sharp at any zoom. Nothing shows for
 * the first 300ms (`app.css`): a sign that flashes for a fast load is worse than none. Under reduced
 * motion the finished drawing simply appears, still after the delay.
 */
export function DrawingLoader() {
  return (
    <div className="dc-editor-loading" aria-busy="true" aria-label="Opening the diagram" role="status">
      <svg className="dc-drawing-loader" viewBox="0 0 84 30" width="84" height="30" aria-hidden="true" focusable="false">
        <rect className="dc-drawing-loader-card" x="1" y="7" width="24" height="16" rx="3.5" pathLength="1" />
        <rect className="dc-drawing-loader-card" x="59" y="7" width="24" height="16" rx="3.5" pathLength="1" />
        <path className="dc-drawing-loader-wire" d="M26.5 15 H52" pathLength="1" />
        <path className="dc-drawing-loader-head" d="M52 11.5 L57 15 L52 18.5" pathLength="1" />
      </svg>
    </div>
  );
}
