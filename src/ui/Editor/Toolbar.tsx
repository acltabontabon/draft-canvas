import { useLayoutEffect, useRef } from 'react';
import { BrandMark } from '../common/BrandMark';
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
  const headerRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const header = headerRef.current;
    const editor = header?.closest<HTMLElement>('.dc-editor');
    if (!header || !editor) return;
    // Wrapped names grow the header. Extend the dotted sheet beneath its actual height too;
    // a fixed bar-height left a blank strip behind the title's second line.
    const update = (height: number) => editor.style.setProperty('--dc-toolbar-height', `${height}px`);
    update(header.getBoundingClientRect().height);
    if (typeof ResizeObserver === 'undefined') return () => editor.style.removeProperty('--dc-toolbar-height');
    const observer = new ResizeObserver(([entry]) => {
      update(entry?.borderBoxSize?.[0]?.blockSize ?? header.getBoundingClientRect().height);
    });
    observer.observe(header);
    return () => {
      observer.disconnect();
      editor.style.removeProperty('--dc-toolbar-height');
    };
  }, []);

  return (
    <TooltipGroup>
      {/* Three grid tracks, not `space-between`: the outer two are equal fractions, so the rail
          holds a stable optical centre instead of sliding left and right as the canvas title or
          the active flow's name changes length. */}
      <header ref={headerRef} className="dc-toolbar">
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
