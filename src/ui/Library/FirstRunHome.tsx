import { useEffect, useId, useRef } from 'react';
import { PRODUCT } from '../../product';
import type { StarterId } from '../../starters';
import type { DocumentSession } from '../../store/useDocumentSession';
import { MOD_SYMBOL } from '../../lib/platform';
import { Button } from '../common/Button';
import { Icon } from '../common/Icon';
import { LibraryBrand } from './LibraryBrand';
import { LocalNote } from './LocalNote';
import { SelectionChrome } from './SelectionChrome';
import { StarterGrid } from './StarterGrid';
import { useStarters } from './useStarters';
import { isImeKeyEvent } from '../../lib/isEditableTarget';

/**
 * The home screen for a library with nothing in it — the first thing anyone sees, so it does one
 * job: get them drawing. A blank canvas to start on, an import for a file someone sent, and the
 * primary starters for a head start — in that order and at those weights, and nothing that
 * describes the product instead of being it.
 *
 * Enter on an otherwise unfocused page starts a blank canvas — the ↵ on the sheet says so, and
 * disappears the moment anything else on the page holds focus (where Enter means that thing).
 */
export function FirstRunHome({ session, onImport }: { session: DocumentSession; onImport: () => void }) {
  const sheetRef = useRef<HTMLButtonElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const importHintId = useId();

  const startBlank = () => void session.newDocument();
  const starters = useStarters();
  const startFrom = (id: StarterId) => void session.newDocument(undefined, id);
  const newDocument = useRef(session.newDocument);
  useEffect(() => {
    newDocument.current = session.newDocument;
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || event.repeat || event.defaultPrevented || isImeKeyEvent(event)) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (event.target !== document.body && event.target !== document.documentElement) return;
      if (document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      void newDocument.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const note = <LocalNote durable={session.durable} repository={session.repository} />;
  // A note that has to warn moves up out of the footer, where it can't be missed.
  const warn = !session.durable;

  return (
    <div className="dc-home">
      <div className="dc-home-inner">
        <header className="dc-home-head">
          <LibraryBrand />
          <Motto text={PRODUCT.motto} />
          <p className="dc-home-tagline">{PRODUCT.tagline}</p>
        </header>

        <div className="dc-home-stage">
          <div className="dc-home-start">
            <button
              ref={sheetRef}
              type="button"
              className="dc-sheet"
              aria-label="New canvas"
              onClick={startBlank}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowRight' && event.key !== 'ArrowDown') return;
                const first = gridRef.current?.querySelector<HTMLButtonElement>('.dc-starter');
                if (!first) return;
                event.preventDefault();
                first.focus();
              }}
            >
              <span className="dc-sheet-crops" aria-hidden="true">
                <span data-at="nw" />
                <span data-at="ne" />
                <span data-at="se" />
                <span data-at="sw" />
              </span>
              <SelectionChrome />
              <span className="dc-sheet-pill">
                <Icon name="plus" size={15} />
                New canvas
                <kbd aria-hidden="true">↵</kbd>
              </span>
            </button>
            <Button variant="quiet" icon="upload" className="dc-home-import" onClick={onImport} aria-describedby={importHintId}>
              Import <span className="dc-home-import-ext">.draftcanvas</span>
            </Button>
            <span id={importHintId} className="dc-sr-only">
              Opens a .draftcanvas or .json file exported from Draft Canvas, or a secure .dcenc export.
            </span>
          </div>

          <div className="dc-home-starters">
            <p className="dc-home-starters-label">Or start from an architecture</p>
            {starters ? (
              <StarterGrid starters={starters.PRIMARY_STARTERS} onStart={startFrom} onExitStart={() => sheetRef.current?.focus()} gridRef={gridRef} />
            ) : (
              <div className="dc-starter-grid-pending" aria-hidden="true" />
            )}
            <p className="dc-home-more dc-muted">
              More architectures and patterns are in the command palette once a canvas is open: press{' '}
              <kbd>{MOD_SYMBOL}</kbd>
              <kbd>K</kbd> and type a name.
            </p>
          </div>
        </div>

        {warn && <div className="dc-home-warn">{note}</div>}
      </div>

      {!warn && (
        <footer className="dc-home-status">
          <div className="dc-home-status-inner">{note}</div>
        </footer>
      )}
    </div>
  );
}

/**
 * The big line, set as setup and punchline: every sentence but the last quieter, the last one on
 * its own line at full strength — so the eye lands on the instruction.
 */
export function Motto({ text }: { text: string }) {
  const sentences = text.match(/[^.!?]+[.!?]+/g)?.map((sentence) => sentence.trim()) ?? [text];
  const punchline = sentences.pop() ?? text;
  return (
    <p className="dc-home-motto">
      {sentences.length > 0 && <span className="dc-home-motto-setup">{sentences.join(' ')} </span>}
      <span className="dc-home-motto-punch">{punchline}</span>
    </p>
  );
}
