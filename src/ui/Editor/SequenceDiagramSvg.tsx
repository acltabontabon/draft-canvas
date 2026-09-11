/**
 * The Sequence Diagram's live preview — a small, hand-drawn SVG built directly from
 * `computeSequenceLayout`, reusing Draft Canvas's own theme tokens/text specs rather than a
 * third-party renderer. Deliberately not using `render/svg/element.ts`'s shared `SvgEl` tree: that
 * exists to keep the live canvas and an exported-file SVG byte-identical, which is irrelevant here
 * — there is exactly one output path (this preview), no image export in V1.
 */
import { useMemo } from 'react';
import { accentOf } from '../../render/theme/tokens';
import { cssFont, FONTS } from '../../render/text/fonts';
import { computeSequenceLayout, HEADER_HEIGHT, TOP_MARGIN, type SequenceModel } from '../../sequence';
import { useThemeValue } from '../theme/useTheme';

const ARROW_MARKER_CLOSED = 'dc-sequence-arrow-closed';
const ARROW_MARKER_OPEN = 'dc-sequence-arrow-open';
/** How far a self-referencing message's loop bulges to the right of its lifeline. */
const SELF_LOOP_WIDTH = 36;

export function SequenceDiagramSvg({ model }: { model: SequenceModel }) {
  const theme = useThemeValue();
  const layout = useMemo(() => computeSequenceLayout(model), [model]);

  return (
    <svg
      className="dc-sequence-svg"
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      width={layout.width}
      height={layout.height}
      role="img"
      aria-label={`Sequence diagram for ${model.flowTitle}`}
    >
      <defs>
        <marker
          id={ARROW_MARKER_CLOSED}
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M0,0 L10,5 L0,10 z" fill={theme.edge} />
        </marker>
        <marker
          id={ARROW_MARKER_OPEN}
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M1,1 L9,5 L1,9" fill="none" stroke={theme.edge} strokeWidth={1.5} />
        </marker>
      </defs>

      {layout.participants.map((p) => (
        <g key={p.id}>
          <line
            x1={p.x}
            y1={TOP_MARGIN + HEADER_HEIGHT}
            x2={p.x}
            y2={layout.lifelineBottom}
            stroke={theme.border}
            strokeDasharray="3 3"
          />
          <rect
            x={p.x - p.boxWidth / 2}
            y={TOP_MARGIN}
            width={p.boxWidth}
            height={HEADER_HEIGHT}
            rx={6}
            fill={theme.surfaceRaised}
            stroke={theme.borderStrong}
          />
          <text
            x={p.x}
            y={TOP_MARGIN + HEADER_HEIGHT / 2}
            textAnchor="middle"
            dominantBaseline="central"
            fill={theme.text}
            style={{ font: cssFont(FONTS.nodeLabel) }}
          >
            {participantLabel(model, p.id)}
          </text>
        </g>
      ))}

      {layout.messages.map((m) => {
        const color = m.accent ? accentOf(theme, m.accent).line : theme.edge;
        const marker = m.interaction === 'async' ? ARROW_MARKER_OPEN : ARROW_MARKER_CLOSED;
        const dashed = m.interaction === 'response';
        const label = messageLabel(model, m.id);
        const isSelfLoop = m.fromX === m.toX;

        return (
          <g key={m.id}>
            {isSelfLoop ? (
              <path
                d={`M${m.fromX},${m.y} h${SELF_LOOP_WIDTH} v14 h-${SELF_LOOP_WIDTH}`}
                fill="none"
                stroke={color}
                strokeDasharray={dashed ? '4 3' : undefined}
                markerEnd={`url(#${marker})`}
              />
            ) : (
              <line
                x1={m.fromX}
                y1={m.y}
                x2={m.toX}
                y2={m.y}
                stroke={color}
                strokeDasharray={dashed ? '4 3' : undefined}
                markerEnd={`url(#${marker})`}
              />
            )}
            <rect
              x={(isSelfLoop ? m.fromX + SELF_LOOP_WIDTH / 2 : m.labelX) - m.labelWidth / 2 - 4}
              y={m.y - 20}
              width={m.labelWidth + 8}
              height={14}
              fill={theme.edgeLabelBg}
            />
            <text
              x={isSelfLoop ? m.fromX + SELF_LOOP_WIDTH / 2 : m.labelX}
              y={m.y - 13}
              textAnchor="middle"
              dominantBaseline="central"
              fill={theme.textMuted}
              style={{ font: cssFont(FONTS.connectorCaption) }}
            >
              {label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function participantLabel(model: SequenceModel, id: string): string {
  return model.participants.find((p) => p.id === id)?.label ?? '';
}

function messageLabel(model: SequenceModel, orderId: string): string {
  return model.messages.find((m) => String(m.order) === orderId)?.label ?? '';
}
