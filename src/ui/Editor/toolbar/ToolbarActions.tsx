import { useEditorStore } from '../../../store/editorStore';
import { useUiStore } from '../../../store/uiStore';
import { Button } from '../../common/Button';
import { Tooltip } from '../../common/Tooltip';
import { FindReplaceHost } from '../FindReplaceDialog';
import { CollabControl } from '../../collab/CollabControl';
import { ShareButton } from './ShareButton';
import { toolbarLabel, toolbarTooltip } from './toolbarTooltips';

interface ToolbarActionsProps {
  onPresent: () => void;
  onExport: () => void;
}

/**
 * The header's right side holds only what you reach for while explaining a system: the story
 * (Present, with the Flows panel beside it) and Share, with a live session's faces. Everything else
 * found a better place — undo and redo beside the zoom controls, help (shortcuts, guides, About)
 * behind the "?" in the status bar, and what acts on the whole diagram (Arrange, Find and replace,
 * Canvas settings) a right-click on the canvas away; all of it in ⌘K, and on the desktop in the
 * menu bar.
 */
export function ToolbarActions({ onPresent, onExport }: ToolbarActionsProps) {
  const readOnly = useUiStore((state) => Boolean(state.readOnly));
  const collaborative = useUiStore((state) => state.readOnly?.collaborative === true);
  const flowPanelOpen = useUiStore((state) => state.flowPanelOpen);
  const setFlowPanelOpen = useUiStore((state) => state.setFlowPanelOpen);
  const activeFlowTitle = useEditorStore((state) =>
    state.selectedFlowId ? state.document.flows.find((flow) => flow.id === state.selectedFlowId)?.title : undefined,
  );

  return (
    <div className="dc-toolbar-trail">
      {/* The story, in one joined control: Present plays it — the active flow's name riding inside,
          since that is what Present will walk through — and the flow glyph beside it opens the
          Flows panel, tinted while it is open. Two words and a loose flow name used to sit here as
          three separate things. Present is momentary, so it has no active state to fake. */}
      <div className="dc-toolbar-modes dc-story" role="group" aria-label="Flows and presenting">
        <Tooltip content={toolbarTooltip('present')}>
          {(tip) => (
            <Button
              icon="present"
              variant="ghost"
              className="dc-toolbar-mode dc-story-play"
              // Wrapped, never passed straight through: `onPresent` takes an optional flow id,
              // and a bare `onClick={onPresent}` hands it the click event instead — truthy, so
              // the presentation would start on a flow that doesn't exist and quietly do nothing.
              onClick={() => onPresent()}
              aria-label={toolbarLabel('present')}
              {...tip}
            >
              <span className="dc-mode-label">Present</span>
              {activeFlowTitle && (
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
        <Tooltip content={toolbarTooltip('flows')}>
          {(tip) => (
            <Button
              icon="flow"
              variant="ghost"
              active={flowPanelOpen}
              // `dc-flow-toggle`: the Flows panel hands focus back here when it closes.
              className="dc-toolbar-mode dc-story-flows dc-flow-toggle"
              onClick={() => setFlowPanelOpen(!flowPanelOpen)}
              aria-label={toolbarLabel('flows')}
              {...tip}
            />
          )}
        </Tooltip>
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
