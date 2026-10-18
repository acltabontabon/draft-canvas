import { memo, useId, useState } from 'react';
import type { DraftNode } from '../document/types';
import { technologyMarkBounds } from '../nodes/technology';

/** Only the mark's hit target and disclosure live here. Its appearance belongs to describeNode,
 * so the canvas and exported images always use the same bundled path and placement. */
export const TechnologyDetails = memo(function TechnologyDetails({ node }: { node: DraftNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const mark = technologyMarkBounds(node);
  if (!mark) return null;
  return (
    <>
      <button
        type="button"
        className="dc-technology-target nodrag nopan"
        style={{ left: mark.x - 4, top: mark.y - 4 }}
        aria-label={`Technology: ${node.technology}`}
        aria-expanded={open}
        aria-controls={id}
        title={node.technology}
        onPointerDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          setOpen(!open);
        }}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Escape') setOpen(false);
        }}
      />
      <div
        id={id}
        className="dc-technology-detail nodrag nopan"
        style={{ top: mark.y + mark.height + 8 }}
        hidden={!open}
      >
        {node.technology}
      </div>
    </>
  );
});
