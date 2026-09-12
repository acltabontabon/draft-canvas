import { Button } from '../common/Button';
import { Tooltip, TooltipGroup } from '../common/Tooltip';
import { CreateRail } from './toolbar/CreateRail';
import { DiagramTitleField } from './toolbar/DiagramTitleField';
import { ToolbarActions } from './toolbar/ToolbarActions';
import { toolbarLabel, toolbarTooltip } from './toolbar/toolbarTooltips';

interface ToolbarProps {
  title: string;
  onTitleChange: (title: string) => void;
  onBack: () => void;
  onPresent: () => void;
  onExport: () => void;
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
}: ToolbarProps) {
  return (
    <TooltipGroup>
      {/* Three grid tracks, not `space-between`: the outer two are equal fractions, so the rail
          holds a stable optical centre instead of sliding left and right as the canvas title or
          the active flow's name changes length. */}
      <header className="dc-toolbar">
        <div className="dc-toolbar-lead">
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
          <DiagramTitleField title={title} onTitleChange={onTitleChange} />
        </div>

        <CreateRail />

        <ToolbarActions onPresent={onPresent} onExport={onExport} />
      </header>
    </TooltipGroup>
  );
}
