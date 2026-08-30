import { useEffect } from 'react';
import { nodeIndex } from '../../store/selectors';
import { useEditorStore } from '../../store/editorStore';
import { tokenizeCode } from '../../render/code/highlight';
import { CODE_THEMES, colorForScope } from '../../render/code/theme';
import { useTheme } from '../theme/useTheme';
import type { ExplainController } from '../../presentation/useExplain';
import { Button } from '../common/Button';

/**
 * The walkthrough control. Present while stepping through ordered connections,
 * and the only chrome visible in presentation mode.
 */
export function ExplainBar({ explain }: { explain: ExplainController }) {
  const document = useEditorStore((state) => state.document);
  const mode = useEditorStore((state) => state.mode);
  const setMode = useEditorStore((state) => state.setMode);

  useEffect(() => {
    if (!explain.active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowRight' || event.key === ' ') {
        event.preventDefault();
        explain.next();
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        explain.previous();
      } else if (event.key === 'Escape') {
        explain.stop();
        if (mode === 'present') setMode('edit');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [explain, mode, setMode]);

  if (!explain.active || !explain.current) return null;

  const nodes = nodeIndex(document.nodes);
  const source = nodes.get(explain.current.edge.source);
  const target = nodes.get(explain.current.edge.target);
  const details = explain.current.edge.details;

  return (
    <div className="dc-explain" role="region" aria-label="Walkthrough">
      {details && <DetailPanel language={details.language} code={details.code} />}

      <div className="dc-explain-bar">
        <span className="dc-explain-count">
          Step {explain.step} / {explain.steps.length}
        </span>
        <span className="dc-explain-flow">
          <strong>{source?.text || 'Untitled'}</strong>
          <span className="dc-explain-arrow" aria-hidden="true">
            →
          </span>
          <strong>{target?.text || 'Untitled'}</strong>
          {explain.current.edge.label && (
            <em className="dc-explain-label">{explain.current.edge.label}</em>
          )}
        </span>
        <span className="dc-inspector-divider" />
        <Button
          icon="back"
          variant="quiet"
          aria-label="Previous step"
          disabled={explain.step <= 1}
          onClick={explain.previous}
        />
        <Button
          icon="forward"
          variant="quiet"
          aria-label="Next step"
          disabled={explain.step >= explain.steps.length}
          onClick={explain.next}
        />
        <Button
          variant="quiet"
          onClick={() => {
            explain.stop();
            if (mode === 'present') setMode('edit');
          }}
        >
          Exit
        </Button>
      </div>
    </div>
  );
}

/**
 * Expandable technical detail attached to a connection — a payload, a header
 * block, an error. It stays out of the canvas so the diagram remains readable,
 * and appears only for the step being explained.
 */
function DetailPanel({ language, code }: { language: Parameters<typeof tokenizeCode>[1]; code: string }) {
  const { name } = useTheme();
  const theme = CODE_THEMES[name];
  const lines = tokenizeCode(code, language);

  return (
    <div className="dc-explain-detail">
      <pre>
        <code>
          {lines.map((line, index) => (
            <span className="dc-code-line" key={index}>
              {line.length === 0 ? (
                '\n'
              ) : (
                <>
                  {line.map((token, tokenIndex) => (
                    <span key={tokenIndex} style={{ color: colorForScope(theme, token.scope) }}>
                      {token.text}
                    </span>
                  ))}
                  {'\n'}
                </>
              )}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}
