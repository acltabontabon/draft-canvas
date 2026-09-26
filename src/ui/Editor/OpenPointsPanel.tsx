import { useCallback, useMemo } from 'react';
import type { CommandContext } from '../../commands/types';
import { OPEN_POINT_LABELS } from '../../document/openPoints';
import { count } from '../../lib/plural';
import { OpenPointGlyph } from '../../canvas/OpenPointGlyph';
import { usePopoverPresence } from '../../canvas/usePopoverPresence';
import { openPointsOverview, unresolvedTargetsIn, type OpenPointRow } from '../../openPoints/collect';
import { fileOf, useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import type { TakeawayTarget } from '../../takeaways/collect';
import { Button } from '../common/Button';
import { Icon } from '../common/Icon';
import { navigateToElement } from './depthNavigation';

/**
 * Open points — the return visit.
 *
 * Next week's meeting opens the diagram and needs to know where the last one left off. This is that
 * list: every point still open, what it says, and what it is about — each a way back to the shape or
 * connector, wherever in the file it lives. It grows out of the status bar's count the way Takeaways
 * does (the same corner, the same surface), and the two never show at once.
 *
 * Deliberately not a task board. No owners, no dates, no filters: a small list of what is still
 * unsettled, a way to settle each one, and the settled ones folded away underneath with a way back.
 */

const EXIT_MS = 140;

export function OpenPointsPanel({ buildCommandContext }: { buildCommandContext: () => CommandContext }) {
  const open = useUiStore((state) => state.openPointsPanelOpen);
  const presenting = useEditorStore((state) => state.mode === 'present');
  const showPanel = open && !presenting;
  const { mounted, closing } = usePopoverPresence(showPanel, EXIT_MS);
  if (!mounted) return null;
  return (
    <div
      className="dc-takeaways dc-open-points"
      data-mode="panel"
      data-closing={closing || undefined}
      data-dc-keyboard-region=""
      role="complementary"
      aria-label="Open points"
    >
      <div className="dc-takeaways-header">
        <strong className="dc-takeaways-title">Open points</strong>
        <Button variant="quiet" icon="close" aria-label="Close open points" onClick={() => useUiStore.getState().setOpenPointsPanelOpen(false)} />
      </div>
      <OpenPointsBody buildCommandContext={buildCommandContext} />
    </div>
  );
}

function OpenPointsBody({ buildCommandContext }: { buildCommandContext: () => CommandContext }) {
  const revision = useEditorStore((state) => state.revision);
  const overview = useMemo(() => {
    void revision;
    return openPointsOverview(fileOf(useEditorStore.getState()));
  }, [revision]);
  const focusActive = useEditorStore((state) => state.focus.active);
  const inRoom = useEditorStore((state) => {
    void state.revision;
    const { nodeIds, edgeIds } = unresolvedTargetsIn(state.document);
    return nodeIds.length + edgeIds.length;
  });
  const resolvedOpen = useUiStore((state) => state.openPointsResolvedOpen);

  const goTo = useCallback(
    async (row: OpenPointRow, target: TakeawayTarget) => {
      await navigateToElement(target, buildCommandContext);
      // Arrived: the point's own popover opens beside the element, so what was said is one glance
      // away and settling it is one click — without the list having to grow controls of its own.
      const anchor = { kind: target.kind, id: target.id } as const;
      useUiStore.getState().setOpenPointPopover({ anchor, targets: [anchor], creating: false, pointId: row.point.id });
    },
    [buildCommandContext],
  );

  const focusAll = () => {
    const editor = useEditorStore.getState();
    if (editor.focus.active) {
      editor.exitFocus();
      return;
    }
    const { nodeIds, edgeIds } = unresolvedTargetsIn(editor.document);
    if (nodeIds.length + edgeIds.length > 0) editor.enterFocus(nodeIds, edgeIds);
  };

  return (
    <>
      <div className="dc-takeaways-scroll">
        {overview.open.length === 0 ? (
          <p className="dc-takeaways-empty">
            Nothing is open. Select a shape or connector and choose <strong>Add open point</strong> to mark what the
            discussion has not settled yet.
          </p>
        ) : (
          <ul className="dc-takeaways-list">
            {overview.open.map((row) => (
              <OpenRow key={row.point.id} row={row} goTo={goTo} />
            ))}
          </ul>
        )}
        {overview.resolved.length > 0 && (
          <div className="dc-takeaways-done">
            <button
              type="button"
              className="dc-takeaways-done-toggle"
              aria-expanded={resolvedOpen}
              onClick={() => useUiStore.getState().setOpenPointsResolvedOpen(!resolvedOpen)}
            >
              <Icon name={resolvedOpen ? 'down' : 'forward'} />
              {count(overview.resolved.length, 'resolved')}
            </button>
            {resolvedOpen && (
              <ul className="dc-takeaways-list">
                {overview.resolved.map((row) => (
                  <ResolvedRowItem key={row.point.id} row={row} goTo={goTo} />
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
      {(inRoom > 0 || focusActive) && (
        <div className="dc-takeaways-foot">
          <span className="dc-muted dc-takeaways-hint">{focusActive ? 'Focused on what is still open' : count(inRoom, 'element')} in this view</span>
          <Button variant="quiet" onClick={focusAll} title={focusActive ? 'Show everything again' : 'Dim everything that has no open point'}>
            {focusActive ? 'Exit focus' : 'Focus open points'}
          </Button>
        </div>
      )}
    </>
  );
}

function TargetLinks({ row, goTo }: { row: OpenPointRow; goTo: (row: OpenPointRow, target: TakeawayTarget) => void }) {
  return (
    <div className="dc-open-points-targets">
      {row.targets.map((target) => (
        <button
          key={`${target.kind}:${target.id}`}
          type="button"
          className="dc-takeaways-context"
          aria-label={`Go to ${target.label}`}
          title={`Go to ${target.label}`}
          onClick={() => goTo(row, target)}
        >
          <span className="dc-takeaways-chip-arrow" aria-hidden="true">
            ↳
          </span>
          <span className="dc-takeaways-context-label">{target.label}</span>
          {target.room && <span className="dc-takeaways-room">{target.room}</span>}
        </button>
      ))}
    </div>
  );
}

function OpenRow({ row, goTo }: { row: OpenPointRow; goTo: (row: OpenPointRow, target: TakeawayTarget) => void }) {
  const { point } = row;
  const first = row.targets[0];
  return (
    <li className="dc-takeaways-row dc-open-points-row" data-kind={point.kind}>
      <div className="dc-takeaways-line">
        <button
          type="button"
          className="dc-open-points-main"
          title={first ? `Go to ${first.label}` : undefined}
          disabled={!first}
          onClick={() => first && goTo(row, first)}
        >
          <OpenPointGlyph kind={point.kind} className="dc-open-points-glyph" />
          <span className="dc-open-points-words">
            <span className="dc-open-points-kind">{OPEN_POINT_LABELS[point.kind]}</span>
            {point.context && <span className="dc-open-points-text">{point.context}</span>}
          </span>
        </button>
        <Button
          variant="quiet"
          className="dc-takeaways-remove dc-open-points-resolve"
          title="Resolve — settled, the marker goes"
          onClick={() => useEditorStore.getState().resolveOpenPoint(point.id)}
        >
          Resolve
        </Button>
      </div>
      <TargetLinks row={row} goTo={goTo} />
    </li>
  );
}

function ResolvedRowItem({ row, goTo }: { row: OpenPointRow; goTo: (row: OpenPointRow, target: TakeawayTarget) => void }) {
  const { point } = row;
  return (
    <li className="dc-takeaways-row dc-open-points-row" data-kind={point.kind} data-done="">
      <div className="dc-takeaways-line">
        <span className="dc-open-points-main" data-static="">
          <span className="dc-open-points-check" aria-hidden="true">
            <Icon name="check" size={11} />
          </span>
          <span className="dc-open-points-words">
            <span className="dc-open-points-kind">{OPEN_POINT_LABELS[point.kind]}</span>
            {point.context && <span className="dc-open-points-text">{point.context}</span>}
            {point.resolution && <span className="dc-open-points-resolution">{point.resolution}</span>}
          </span>
        </span>
        <Button variant="quiet" className="dc-takeaways-remove" title="Reopen" onClick={() => useEditorStore.getState().reopenOpenPoint(point.id)}>
          Reopen
        </Button>
        <Button
          variant="quiet"
          icon="trash"
          className="dc-takeaways-remove"
          aria-label="Delete resolved point"
          title="Delete"
          onClick={() => useEditorStore.getState().removeOpenPoint(point.id)}
        />
      </div>
      {row.targets.length > 0 && <TargetLinks row={row} goTo={goTo} />}
    </li>
  );
}
