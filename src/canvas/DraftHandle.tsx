import type { CSSProperties } from 'react';
import { addEdge, useStoreApi, type Connection, type Position } from '@xyflow/react';
import { XYHandle } from '@xyflow/system';

/**
 * A connection handle, as React Flow's `<Handle>` draws it, minus its store subscription.
 *
 * Each `<Handle>` subscribes to React Flow's store on its own, and a shape has twelve. At 500 shapes
 * that was 6,000 selectors re-run (and shallow-compared) on every pan frame and every drag frame,
 * about a third of each frame's script, to learn that no connection was being drawn. The one thing
 * the handles show from that state, which of a shape's handles a connection in flight starts at or
 * would land on, is now asked once per shape (`useConnectingHandles.ts`) and handed down.
 *
 * Everything React Flow reads from a handle is kept: its classes (`source`, `connectable`,
 * `connectableend` — measured into the node's handle bounds and checked when a connection ends),
 * its `data-*` attributes, and the same pointer-down that starts a connection.
 */
export function DraftHandle({
  nodeId,
  id,
  position,
  connectable,
  from,
  to,
  className,
  style,
  armed,
}: {
  nodeId: string;
  id: string;
  position: Position;
  connectable: boolean;
  /** A connection in flight starts here. */
  from: boolean;
  /** A connection in flight would validly land here. */
  to: boolean;
  className?: string;
  style?: CSSProperties;
  armed?: boolean;
}) {
  const store = useStoreApi();
  // Neither changes while the canvas is mounted; read, not subscribed to.
  const { rfId, noPanClassName } = store.getState();

  const onPointerDown = (event: React.MouseEvent<HTMLDivElement> | React.TouchEvent<HTMLDivElement>) => {
    const isMouse = 'clientX' in event.nativeEvent;
    if (!connectable || (isMouse && (event as React.MouseEvent).button !== 0)) return;
    const state = store.getState();
    const onConnect = (params: Connection) => {
      const { defaultEdgeOptions, onConnect: onConnectAction, hasDefaultEdges } = store.getState();
      const edgeParams = { ...defaultEdgeOptions, ...params };
      if (hasDefaultEdges) {
        const { edges, setEdges, onError } = store.getState();
        setEdges(addEdge(edgeParams, edges, { onError }));
      }
      onConnectAction?.(edgeParams);
    };
    XYHandle.onPointerDown(event.nativeEvent, {
      handleDomNode: event.currentTarget,
      autoPanOnConnect: state.autoPanOnConnect,
      connectionMode: state.connectionMode,
      connectionRadius: state.connectionRadius,
      domNode: state.domNode,
      nodeLookup: state.nodeLookup,
      lib: state.lib,
      isTarget: false,
      handleId: id,
      nodeId,
      flowId: state.rfId,
      panBy: state.panBy,
      cancelConnection: state.cancelConnection,
      onConnectStart: state.onConnectStart,
      onConnectEnd: (...args) => store.getState().onConnectEnd?.(...args),
      updateConnection: state.updateConnection,
      onConnect,
      isValidConnection: (...args) => store.getState().isValidConnection?.(...args) ?? true,
      getTransform: () => store.getState().transform,
      getFromHandle: () => store.getState().connection.fromHandle,
      autoPanSpeed: state.autoPanSpeed,
      dragThreshold: state.connectionDragThreshold,
    });
  };

  const classes = [
    'react-flow__handle',
    `react-flow__handle-${position}`,
    'nodrag',
    noPanClassName,
    className,
    'source',
    connectable && 'connectable connectablestart connectableend',
    from && 'connectingfrom',
    to && 'connectingto valid',
    // Where a connection can start, and where one in flight can end: anywhere but where it began.
    connectable && !from && 'connectionindicator',
  ];

  return (
    <div
      data-handleid={id}
      data-nodeid={nodeId}
      data-handlepos={position}
      data-id={`${rfId}-${nodeId}-${id}-source`}
      data-armed={armed ? 'true' : undefined}
      className={classes.filter(Boolean).join(' ')}
      style={style}
      onMouseDown={onPointerDown}
      onTouchStart={onPointerDown}
    />
  );
}
