import { Button } from '../common/Button';
import { Tooltip, TooltipGroup } from '../common/Tooltip';
import { CreateRail } from './toolbar/CreateRail';
import { DiagramTitleField } from './toolbar/DiagramTitleField';
import { ToolbarActions } from './toolbar/ToolbarActions';
import { toolbarLabel, toolbarTooltip } from './toolbar/toolbarTooltips';

interface ToolbarProps {
  title: string;
  onTitleChange: (title: string) => void;
  /** Absent when there's nothing to go back to (an embedded host's single file). */
  onBack?: () => void;
  onPresent: () => void;
  onExport: () => void;
  /** A shared diagram on screen (`uiStore.readOnly`): no renaming, no create tools. The editor
   *  store's own guard is what protects the document; this just stops offering what it refuses. */
  readOnly?: boolean;
}

/**
 * One slim bar. Everything else is contextual.
 *
 * A permanent property inspector would cost thirty percent of the canvas to
 * show controls that are wrong for whatever is selected most of the time.
 */
export function Toolbar({
  title,
  onTitleChange,
  onBack,
  onPresent,
  onExport,
  readOnly = false,
}: ToolbarProps) {
  return (
    <TooltipGroup>
      {/* Three grid tracks, not `space-between`: the outer two are equal fractions, so the rail
          holds a stable optical centre instead of sliding left and right as the canvas title or
          the active flow's name changes length. */}
      <header className="dc-toolbar">
        <div className="dc-toolbar-lead">
          {onBack && (
            <Tooltip content={toolbarTooltip('back')}>
              {(tip) => (
                <Button
                  icon="back"
                  variant="quiet"
                  onClick={onBack}
                  aria-label={toolbarLabel('back')}
                  {...tip}
                />
              )}
            </Tooltip>
          )}
          <DiagramTitleField title={title} onTitleChange={onTitleChange} readOnly={readOnly} />
        </div>

        {readOnly ? <div aria-hidden="true" /> : <CreateRail />}

        <ToolbarActions onPresent={onPresent} onExport={onExport} />
      </header>
    </TooltipGroup>
  );
}
