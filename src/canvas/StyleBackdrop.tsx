import { useStore, type ReactFlowState } from '@xyflow/react';
import { memo } from 'react';
import { backdropTile } from '../render/style/backdrop';
import { useTheme } from '../theme/useTheme';
import { useDiagramStyle } from './useDiagramStyle';

const transformOf = (state: ReactFlowState) => state.transform;
const sameTransform = (a: ReactFlowState['transform'], b: ReactFlowState['transform']) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

/**
 * The style's backdrop: one drawing repeated behind the diagram, moving and scaling with it like
 * the grid does, so it reads as the paper the diagram is drawn on.
 *
 * Canvas chrome, never a diagram object: it takes no pointer events and is in no selection, route
 * or layout. It is one element whose background the browser repeats, so a pan repaints nothing but
 * its position. It sits under the diagram's own background image, which covers it when there is one.
 */
export const StyleBackdrop = memo(function StyleBackdrop() {
  const style = useDiagramStyle();
  const { name } = useTheme();
  const tile = backdropTile(style, name);
  if (!tile) return null;
  return <Tiles uri={tile.uri} width={tile.width} height={tile.height} />;
});

/** Follows the camera. Apart from its parent so only this re-renders on a pan, and only when there is a backdrop. */
function Tiles({ uri, width, height }: { uri: string; width: number; height: number }) {
  const [x, y, zoom] = useStore(transformOf, sameTransform);
  return (
    <div
      className="dc-canvas-backdrop"
      aria-hidden="true"
      style={{ backgroundImage: uri, backgroundSize: `${width * zoom}px ${height * zoom}px`, backgroundPosition: `${x}px ${y}px` }}
    />
  );
}
