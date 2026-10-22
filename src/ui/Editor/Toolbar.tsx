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
                // The Draft Canvas mark is the way home: back to your diagrams.
                <Button variant="quiet" className="dc-brand-mark" onClick={onBack} aria-label={toolbarLabel('back')} {...tip}>
                  <BrandMark />
                </Button>
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

/** The Draft Canvas mark — two boxes and the connector between them — as the app and installers draw it. */
function BrandMark() {
  return (
    <svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true" focusable="false">
      <rect className="dc-brand-tile" width="32" height="32" rx="8" />
      <rect x="6" y="8" width="11" height="7" rx="2" fill="none" stroke="#5fd6c9" strokeWidth="2" />
      <rect x="15" y="18" width="11" height="7" rx="2" fill="none" stroke="#8b9099" strokeWidth="2" />
      <path d="M11.5 15.5v3.5h4" fill="none" stroke="#5fd6c9" strokeWidth="1.6" />
    </svg>
  );
}
