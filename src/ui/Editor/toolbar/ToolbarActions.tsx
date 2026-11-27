import { useCallback, useMemo, useRef, useState } from 'react';
import { flowIsPlayable } from '../../../document/flow';
import { count } from '../../../lib/plural';
import { WALK_OF_DIAGRAM, WALK_OF_SELECTION, walkOfDiagram, walkOfSelection } from '../../../presentation/walk';
import { useEditorStore } from '../../../store/editorStore';
import { useUiStore } from '../../../store/uiStore';
import { Button } from '../../common/Button';
import { Tooltip } from '../../common/Tooltip';
import { FindReplaceHost } from '../FindReplaceDialog';
import { CollabControl } from '../../collab/CollabControl';
import { ShareButton } from './ShareButton';
import { ToolbarMenu, type ToolbarMenuItem } from './ToolbarMenu';
import { toolbarLabel, toolbarTooltip } from './toolbarTooltips';

/** The most flows the menu lists by name; the rest are a panel away. */
const MENU_FLOWS = 10;

interface ToolbarActionsProps {
  /** Present: what it decides for itself, or a flow or walk asked for by id. */
  onPresent: (flowId?: string) => void;
  onExport: () => void;
}

/**
 * The header's right side holds only what you reach for while explaining a system: the story
 * (Present, with the Flows panel beside it) and Share, with a live session's faces. Everything else
 * found a better place — undo and redo beside the zoom controls, help (shortcuts, guides, About)
 * behind the "?" in the status bar with Canvas settings beside it, and what acts on the whole
 * diagram (Arrange, Find and replace) a right-click on the canvas away; all of it in ⌘K, and on the
 * desktop in the menu bar.
 */
export function ToolbarActions({ onPresent, onExport }: ToolbarActionsProps) {
  const readOnly = useUiStore((state) => Boolean(state.readOnly));
  const collaborative = useUiStore((state) => state.readOnly?.collaborative === true);
  const flowPanelOpen = useUiStore((state) => state.flowPanelOpen);
  const setFlowPanelOpen = useUiStore((state) => state.setFlowPanelOpen);
  const activeFlowTitle = useEditorStore((state) =>
    state.selectedFlowId ? state.document.flows.find((flow) => flow.id === state.selectedFlowId)?.title : undefined,
  );
  // What Present will do, said before it is pressed: a selection that makes a story is walked
  // instead of the active flow (`presentation/walk.ts`), and the button says so while that holds.
  // Whether it makes one is a question of which connectors join what, never of where anything
  // sits — so it is asked again when the selection or the connectors change, and not on every
  // frame of a drag, which replaces the shapes but neither of those.
  const selection = useEditorStore((state) => state.selection);
  const edges = useEditorStore((state) => state.document.edges);
  const shapeCount = useEditorStore((state) => state.document.nodes.length);
  const presentsSelection = useMemo(
    () =>
      (selection.nodes.length > 0 || selection.edges.length > 0) &&
      walkOfSelection({ nodes: useEditorStore.getState().document.nodes, edges }, selection) !== null,
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- shapeCount stands in for the shapes, see above.
    [selection, edges, shapeCount],
  );

  // Everything Present can walk, a click away from Present itself: the selection, the whole
  // diagram, each flow the file holds — and the Flows panel, where flows are made and edited.
  // Worked out when the menu opens, never while it is shut.
  const menuRef = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ rect: DOMRect; trigger: HTMLElement; items: ToolbarMenuItem[] } | null>(null);
  const closeMenu = useCallback(() => {
    setMenu(null);
    menuRef.current?.focus();
  }, []);
  const menuItems = (): ToolbarMenuItem[] => {
    const choose = (action: () => void) => () => {
      closeMenu();
      action();
    };
    const { document, selection: picked } = useEditorStore.getState();
    const ofSelection = walkOfSelection(document, picked);
    const ofDiagram = walkOfDiagram(document);
    const flows = document.flows.filter((flow) => flowIsPlayable(document, flow));
    return [
      ...(ofSelection
        ? [
            {
              id: 'selection',
              icon: 'present' as const,
              label: 'Selection',
              detail: `${ofSelection.flow.title} · ${count(ofSelection.flow.steps.length, 'step')}`,
              onSelect: choose(() => onPresent(WALK_OF_SELECTION)),
            },
          ]
        : []),
      ...(ofDiagram
        ? [
            {
              id: 'diagram',
              icon: 'present' as const,
              label: 'Whole diagram',
              detail: `Following the arrows · ${count(ofDiagram.flow.steps.length, 'step')}`,
              onSelect: choose(() => onPresent(WALK_OF_DIAGRAM)),
            },
          ]
        : []),
      ...flows.slice(0, MENU_FLOWS).map((flow) => ({
        id: `flow:${flow.id}`,
        icon: 'flow' as const,
        label: flow.title,
        detail: `Flow · ${count(flow.steps.length, 'step')}`,
        onSelect: choose(() => onPresent(flow.id)),
      })),
      {
        id: 'flows',
        icon: 'pencil' as const,
        // Named and keyed as the palette names it.
        label: flowPanelOpen ? 'Hide flows' : 'Show flows',
        shortcut: 'F',
        detail: flows.length > MENU_FLOWS ? `All ${flows.length} flows: trace, rename, reorder` : 'Trace, rename and reorder flows',
        onSelect: choose(() => setFlowPanelOpen(!flowPanelOpen)),
      },
    ];
  };

  return (
    <div className="dc-toolbar-trail">
      {/* The story, in one split button: Present plays what it judges best — the active flow's name
          riding inside, since that is what it will walk through — and the caret beside it lists
          everything else it could walk, with the Flows panel last. A flow glyph used to sit there
          and open the panel alone, which asked a newcomer to know what a flow was before they
          could find one. Present is momentary, so it has no active state to fake. */}
      <div className="dc-toolbar-modes dc-story" role="group" aria-label="Flows and presenting">
        <Tooltip content={presentsSelection ? { ...toolbarTooltip('present'), title: 'Present selection' } : toolbarTooltip('present')}>
          {(tip) => (
            <Button
              icon="present"
              variant="ghost"
              className="dc-toolbar-mode dc-story-play"
              data-presents={presentsSelection ? 'selection' : undefined}
              // Wrapped, never passed straight through: `onPresent` takes an optional flow id,
              // and a bare `onClick={onPresent}` hands it the click event instead — truthy, so
              // the presentation would start on a flow that doesn't exist and quietly do nothing.
              onClick={() => onPresent()}
              // The flow it will play is in its name too, as it is on the button: "Present" alone
              // left a screen reader not knowing which flow, and a speech user's "Present Checkout"
              // matching nothing.
              aria-label={presentsSelection ? 'Present selection' : activeFlowTitle ? `${toolbarLabel('present')} ${activeFlowTitle}` : toolbarLabel('present')}
              {...tip}
            >
              <span className="dc-mode-label">{presentsSelection ? 'Present selection' : 'Present'}</span>
              {activeFlowTitle && !presentsSelection && (
                <>
                  <span className="dc-flow-toggle-sep" aria-hidden="true">
                    ·
                  </span>
                  <span className="dc-flow-toggle-title">{activeFlowTitle}</span>
                </>
              )}
            </Button>
          )}
        </Tooltip>
        <Tooltip content={toolbarTooltip('presentMenu')}>
          {(tip) => (
            <Button
              ref={menuRef}
              icon="down"
              variant="ghost"
              active={menu !== null || flowPanelOpen}
              // `dc-flow-toggle`: the Flows panel hands focus back here when it closes.
              className="dc-toolbar-mode dc-story-flows dc-flow-toggle"
              aria-haspopup="menu"
              aria-expanded={menu !== null}
              aria-label={toolbarLabel('presentMenu')}
              onClick={(event) => {
                const trigger = event.currentTarget;
                setMenu((open) => (open ? null : { rect: trigger.getBoundingClientRect(), trigger, items: menuItems() }));
              }}
              {...tip}
            />
          )}
        </Tooltip>
        {menu && (
          <ToolbarMenu
            label="What to present"
            heading="Present"
            className="dc-present-menu"
            anchorRect={menu.rect}
            trigger={menu.trigger}
            items={menu.items}
            onDismiss={closeMenu}
          />
        )}
      </div>

      {/* Who is here (a live session's faces), then the one filled button: how the diagram
          reaches anyone else. */}
      <div className="dc-toolbar-share">
        {(!readOnly || collaborative) && <CollabControl />}
        <ShareButton onExport={onExport} />
      </div>

      {/* The dialog lives with the toolbar; the host also owns the ⌘H chord. */}
      <FindReplaceHost />
    </div>
  );
}
