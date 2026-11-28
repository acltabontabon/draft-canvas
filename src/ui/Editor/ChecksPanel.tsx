import { useCallback, useMemo } from 'react';
import { focusCanvas } from '../../canvas/canvasFocus';
import { usePopoverPresence } from '../../canvas/usePopoverPresence';
import type { Finding, Severity } from '../../checks/finding';
import { navigateToElement, navigateToRoom } from '../../commands/depthNavigation';
import type { CommandContext } from '../../commands/types';
import { ownerAt, viewOf } from '../../depth/tree';
import type { DraftDocument } from '../../document/types';
import { isImeKeyEvent } from '../../lib/isEditableTarget';
import { count } from '../../lib/plural';
import { checksOf } from '../../store/checks';
import { fileOf, useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import { Button } from '../common/Button';

/**
 * Checks: what the drawing itself says is unfinished or tangled, across every view, each one a way
 * to the shape or connector it is about.
 *
 * It grows out of the status bar's count, in the same corner as Open points, and like the outage
 * walk it is a view: nothing here is saved, undone, shared or exported, and it changes nothing by
 * itself. A finding is something to look at, not a verdict; the diagram is the person's to change.
 *
 * Only the drawing is read. Whether the evidence a diagram cites still holds is checked against a
 * repository, from the command line.
 */

const EXIT_MS = 140;

/** A word for each severity, so the list never tells them apart by colour alone. */
const SEVERITY_WORD: Record<Severity, string> = { error: 'Problem', warning: 'Worth a look', info: 'Note' };

export function ChecksPanel({ buildCommandContext }: { buildCommandContext: () => CommandContext }) {
  const open = useUiStore((state) => state.checksPanelOpen);
  const presenting = useEditorStore((state) => state.mode === 'present');
  const { mounted, closing } = usePopoverPresence(open && !presenting, EXIT_MS);
  if (!mounted) return null;
  const close = () => {
    useUiStore.getState().setChecksPanelOpen(false);
    focusCanvas();
  };
  return (
    <div
      className="dc-points dc-checks"
      data-mode="panel"
      data-closing={closing || undefined}
      data-dc-keyboard-region=""
      role="complementary"
      aria-label="Checks"
      // A keyboard region stands the editor's own keys down, so the panel answers Escape itself.
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented || isImeKeyEvent(event)) return;
        event.stopPropagation();
        close();
      }}
    >
      <div className="dc-points-header">
        <strong className="dc-points-title">Checks</strong>
        <Button variant="quiet" icon="close" aria-label="Close checks" onClick={close} />
      </div>
      <ChecksBody buildCommandContext={buildCommandContext} />
    </div>
  );
}

/** Where a finding points: the first of its subjects that is a shape or a connector of its view. */
function targetOf(file: DraftDocument, finding: Finding): { kind: 'node' | 'edge'; id: string; path: string[] } | undefined {
  const path = finding.room ?? [];
  const view = viewOf(file, path);
  if (!view) return undefined;
  for (const id of finding.subjects) {
    if (view.nodes.some((node) => node.id === id)) return { kind: 'node', id, path };
    if (view.edges.some((edge) => edge.id === id)) return { kind: 'edge', id, path };
  }
  return undefined;
}

function ChecksBody({ buildCommandContext }: { buildCommandContext: () => CommandContext }) {
  // Read once per edit, never per frame: `checksOf` also keeps its answer across a move or a restyle.
  const revision = useEditorStore((state) => state.revision);
  const { file, checks } = useMemo(() => {
    void revision;
    const current = fileOf(useEditorStore.getState());
    return { file: current, checks: checksOf(current) };
  }, [revision]);

  const goTo = useCallback(
    async (finding: Finding) => {
      const current = fileOf(useEditorStore.getState());
      const target = targetOf(current, finding);
      if (target) await navigateToElement(target, buildCommandContext);
      else await navigateToRoom(finding.room ?? []);
    },
    [buildCommandContext],
  );

  const { error, warning, info } = checks.counts;
  return (
    <>
      <div className="dc-points-scroll">
        {checks.findings.length === 0 ? (
          <p className="dc-points-empty">Nothing found. Checks read the drawing as it stands: a queue nothing consumes, parts that call each other in a loop, connectors that lead nowhere.</p>
        ) : (
          <ul className="dc-points-list">
            {checks.findings.map((finding) => {
              const owner = finding.room?.length ? ownerAt(file, finding.room) : undefined;
              const where = owner ? (owner.text?.split('\n')[0]?.trim() || 'another view') : undefined;
              return (
                <li key={finding.id} className="dc-points-row dc-checks-row" data-severity={finding.severity}>
                  <button type="button" className="dc-checks-main" title="Go to it" onClick={() => void goTo(finding)}>
                    <span className="dc-checks-glyph" aria-hidden="true" />
                    <span className="dc-checks-words">
                      <span className="dc-checks-kind">
                        {SEVERITY_WORD[finding.severity]}
                        {where && <span className="dc-points-room">in {where}</span>}
                      </span>
                      <span className="dc-checks-text">{finding.message}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div className="dc-points-foot">
        <span className="dc-muted dc-points-hint">
          {checks.findings.length === 0
            ? 'Read from the drawing alone'
            : [error ? count(error, 'problem') : '', warning ? `${warning} worth a look` : '', info ? count(info, 'note') : ''].filter(Boolean).join(' · ')}
        </span>
      </div>
    </>
  );
}
