import { ownerAt } from '../../depth/tree';
import { displayNameFor } from '../../document/factory';
import { fileOf, useEditorStore } from '../../store/editorStore';
import { backOut } from './depthNavigation';

/**
 * Where you are, when you are inside something.
 *
 * Sheets rather than a breadcrumb trail: each room you stepped through is a page, and the one you
 * are looking at is the one on top. Collapsed it says only the name of the room you are in, which
 * is the question a walkthrough actually asks ("what are we inside?"); hovering or tabbing to it
 * fans the stack out so any of them can be clicked. It renders nothing at all at the top level, so
 * a canvas nobody has looked inside carries no chrome for a feature it isn't using.
 */
export function DepthStack() {
  const path = useEditorStore((state) => state.path);
  const file = useEditorStore((state) => fileOf(state));
  // Read before the early return, so the hook order never depends on where the user is standing.
  const contents = useEditorStore((state) => state.document.nodes.length);

  if (path.length === 0) return null;

  const rooms = path.map((_, index) => {
    const owner = ownerAt(file, path.slice(0, index + 1));
    return { depth: index, name: owner ? displayNameFor(owner) : 'Inside' };
  });

  const here = rooms.at(-1)?.name ?? file.metadata.title;

  return (
    <nav className="dc-depth" aria-label="Where you are">
      {/* Nothing about the move is visible to a screen reader otherwise: the canvas is one element
          whose contents simply became different ones. */}
      <p className="dc-sr-only" role="status">
        {`Inside ${here}. ${contents === 0 ? 'Empty.' : `${contents} ${contents === 1 ? 'shape' : 'shapes'}.`}`}
      </p>
      <ol className="dc-depth-list">
        <li className="dc-depth-rung">
          <button
            type="button"
            className="dc-depth-step"
            onClick={() => void backOut(0)}
            title="Back to the whole canvas"
          >
            {file.metadata.title}
          </button>
        </li>
        {rooms.map((room) => {
          const current = room.depth === rooms.length - 1;
          return (
            <li key={room.depth} className="dc-depth-rung" data-current={current ? 'true' : undefined}>
              <span className="dc-depth-into" aria-hidden>
                ↳
              </span>
              {current ? (
                <span className="dc-depth-step" aria-current="location">
                  {room.name}
                </span>
              ) : (
                <button
                  type="button"
                  className="dc-depth-step"
                  onClick={() => void backOut(room.depth + 1)}
                  title={`Back to ${room.name}`}
                >
                  {room.name}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
