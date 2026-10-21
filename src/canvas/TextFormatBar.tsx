import { useState, type MouseEvent as ReactMouseEvent } from 'react';
import { ACCENTS, type Accent } from '../document/types';
import { MOD_SYMBOL } from '../lib/platform';
import type { Theme } from '../render/theme/tokens';
import { Button } from '../ui/common/Button';
import type { IconName } from '../ui/common/Icon';
import {
  colorSpan,
  insertBlock,
  insertLink,
  toggleInline,
  toggleLines,
  type BlockInsert,
  type InlineFormat,
  type LineFormat,
  type SourceEdit,
  type SourceSelection,
} from './markdownEditing';
import { activeTextEditor, applySourceEdit, selectionOf } from './textEditor';

interface Action {
  id: string;
  label: string;
  shortcut?: string;
  icon?: IconName;
  /** Shown instead of an icon: the format itself, set in that format. */
  glyph?: { text: string; style: React.CSSProperties };
  run: (selection: SourceSelection) => SourceEdit;
}

const inline = (format: InlineFormat) => (selection: SourceSelection) => toggleInline(selection, format);
const lines = (format: LineFormat) => (selection: SourceSelection) => toggleLines(selection, format);
const block = (kind: BlockInsert) => (selection: SourceSelection) => insertBlock(selection, kind);

const GROUPS: Action[][] = [
  [
    { id: 'bold', label: 'Bold', shortcut: `${MOD_SYMBOL}B`, glyph: { text: 'B', style: { fontWeight: 700 } }, run: inline('bold') },
    { id: 'italic', label: 'Italic', shortcut: `${MOD_SYMBOL}I`, glyph: { text: 'I', style: { fontStyle: 'italic', fontFamily: 'Georgia, serif' } }, run: inline('italic') },
    { id: 'strike', label: 'Strikethrough', shortcut: `${MOD_SYMBOL}⇧X`, glyph: { text: 'S', style: { textDecoration: 'line-through' } }, run: inline('strike') },
    { id: 'code', label: 'Inline code', shortcut: `${MOD_SYMBOL}E`, icon: 'code', run: inline('code') },
    { id: 'highlight', label: 'Highlight', shortcut: `${MOD_SYMBOL}⇧H`, icon: 'highlight', run: inline('highlight') },
    { id: 'link', label: 'Link', shortcut: `${MOD_SYMBOL}K`, icon: 'link', run: insertLink },
  ],
  [
    { id: 'h1', label: 'Heading 1', shortcut: `${MOD_SYMBOL}⌥1`, glyph: { text: 'H1', style: { fontWeight: 700, fontSize: 12 } }, run: lines('h1') },
    { id: 'h2', label: 'Heading 2', shortcut: `${MOD_SYMBOL}⌥2`, glyph: { text: 'H2', style: { fontWeight: 700, fontSize: 11 } }, run: lines('h2') },
  ],
  [
    { id: 'bullet', label: 'Bulleted list', shortcut: `${MOD_SYMBOL}⇧8`, icon: 'listBullet', run: lines('bullet') },
    { id: 'number', label: 'Numbered list', shortcut: `${MOD_SYMBOL}⇧7`, icon: 'listNumber', run: lines('number') },
    { id: 'task', label: 'Checklist', shortcut: `${MOD_SYMBOL}⇧9`, icon: 'listTask', run: lines('task') },
    { id: 'quote', label: 'Quote', icon: 'quote', run: lines('quote') },
  ],
  [
    { id: 'code-block', label: 'Code block', icon: 'codeBlock', run: block('code') },
    { id: 'callout', label: 'Callout', icon: 'info', run: block('callout') },
    { id: 'table', label: 'Table', icon: 'table', run: block('table') },
    { id: 'rule', label: 'Divider', icon: 'rule', run: block('rule') },
  ],
];

/** Pressing a button must not take focus from the editor: leaving it commits the edit. */
const keepEditorFocus = (event: ReactMouseEvent) => event.preventDefault();

/**
 * The Markdown format bar, in place of the element popover's own row while a Text element's words
 * are being edited. Every button writes Markdown into the editor, so what it does is visible in the
 * source and learnable from it — and an agent, a README or a paste can say the same thing.
 */
export function TextFormatBar({ theme }: { theme: Theme }) {
  const [colors, setColors] = useState(false);
  const apply = (run: (selection: SourceSelection) => SourceEdit) => {
    const textarea = activeTextEditor.current;
    if (!textarea) return;
    applySourceEdit(textarea, run(selectionOf(textarea)));
  };
  return (
    <div className="dc-format-bar" onMouseDown={keepEditorFocus}>
      <div className="dc-popover-row dc-format-row" role="toolbar" aria-label="Format text">
        {GROUPS.map((group, index) => (
          <div key={index} className="dc-format-group">
            {index > 0 && <span className="dc-popover-divider" aria-hidden="true" />}
            {group.map((action) => (
              <Button
                key={action.id}
                variant="quiet"
                icon={action.icon}
                // Out of the tab order: Tab inside the editor nests a list item, and focus leaving
                // the editor ends the edit. Every action has a shortcut or is one click away.
                tabIndex={-1}
                aria-label={action.label}
                title={action.shortcut ? `${action.label} (${action.shortcut})` : action.label}
                onClick={() => apply(action.run)}
              >
                {action.glyph && <span style={action.glyph.style}>{action.glyph.text}</span>}
              </Button>
            ))}
          </div>
        ))}
        <span className="dc-popover-divider" aria-hidden="true" />
        <Button
          variant="quiet"
          tabIndex={-1}
          aria-label="Text colour"
          aria-expanded={colors}
          title="Colour the selected words"
          onClick={() => setColors(!colors)}
        >
          <span className="dc-format-color-glyph" style={{ textDecorationColor: theme.accents.rose.chip }}>A</span>
        </Button>
      </div>
      {colors && (
        <div className="dc-popover-panel dc-swatches">
          {ACCENTS.map((accent: Accent) => (
            <button
              key={accent}
              type="button"
              tabIndex={-1}
              className="dc-swatch"
              title={accent === 'neutral' ? 'Default colour' : accent}
              aria-label={`Colour ${accent}`}
              style={{ background: theme.accents[accent].chip }}
              onClick={() => {
                apply((selection) => colorSpan(selection, accent));
                setColors(false);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
