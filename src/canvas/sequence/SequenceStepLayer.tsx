import { memo, useEffect, useMemo } from 'react';
import { sequenceFlow } from '../../document/sequenceFlow';
import type { DraftNode } from '../../document/types';
import { describeContext, describeSequenceMessages, sequenceLayoutFor } from '../../nodes/describe';
import { sequenceAttachmentChips, sequenceLifelines } from '../../nodes/sequence';
import { getMeasurer } from '../../render/text/measure';
import { beginClipScope, emitDisplayList } from '../../render/svg/emit';
import type { Theme } from '../../render/theme/tokens';
import type { PersonalityPreset } from '../../theme/usePersonality';
import { selectSequenceMessage } from '../../store/selectors';
import { useEditorStore } from '../../store/editorStore';
import { sequenceActions } from '../../store/sequenceActions';
import { useUiStore } from '../../store/uiStore';
import { SvgSurface } from '../SvgSurface';

/**
 * A sequence being presented, one message at a time.
 *
 * The sequence itself is dimmed (`canvas.css`), and over it are drawn, from the very shapes it is
 * made of: everything said so far, quietly, and the message being said now, at full strength, with
 * the heads of the two participants it runs between. So the picture is never a different drawing
 * of the sequence — it is the same one, lit a row at a time.
 *
 * Branches are told in the order they are drawn; that a `par`'s branches run alongside each other
 * is said in the step's caption, and nothing here draws one branch as following another.
 *
 * Presentation chrome: it never reaches the display list, so it is never exported.
 */
export const SequenceStepLayer = memo(function SequenceStepLayer({
  node,
  step,
  theme,
  preset,
}: {
  node: DraftNode;
  /** The step being told, counted from 1. */
  step: number;
  theme: Theme;
  preset: PersonalityPreset;
}) {
  const messageId = sequenceFlow(node).steps[step - 1]?.id;
  const message = useEditorStore((state) => messageId ? selectSequenceMessage(state.document, node.id, messageId) : undefined);
  const count = message?.attachments?.length ?? 0;
  const layout = sequenceLayoutFor(node, describeContext(theme, preset));
  const row = count ? layout.messages.find((entry) => entry.id === messageId) : undefined;
  const chips = row && message?.attachments ? sequenceAttachmentChips(row, message.attachments, layout.width, getMeasurer()) : [];
  useEffect(() => () => {
    const ui = useUiStore.getState();
    const open = ui.openAttachmentDetail;
    if (open?.hostKind === 'message' && open.hostId === node.id && open.messageId === messageId) ui.setOpenAttachmentDetail(null);
  }, [node.id, messageId]);
  const lifelines = useMemo(() => emitDisplayList({
    width: node.width,
    height: node.height,
    shapes: sequenceLifelines(layout, theme),
  }), [node.width, node.height, layout, theme]);
  const layers = useMemo(() => {
    const ids = sequenceFlow(node).steps.map((entry) => entry.id);
    const now = ids[step - 1];
    if (!now) return null;
    const ctx = describeContext(theme, preset);
    const draw = (scope: string, only: ReadonlySet<string>) => {
      if (only.size === 0) return null;
      beginClipScope(`${scope}-${node.id}`);
      return emitDisplayList({ width: node.width, height: node.height, shapes: describeSequenceMessages(node, ctx, only) });
    };
    return { told: draw('seq-told', new Set(ids.slice(0, step - 1))), now: draw('seq-now', new Set([now])) };
  }, [node, step, theme, preset]);
  if (!layers) return null;
  return (
    <>
      <SvgSurface className="dc-seq-present-lifelines" width={node.width} height={node.height}>
        {lifelines}
      </SvgSurface>
      {layers.told && (
        <SvgSurface className="dc-seq-told" width={node.width} height={node.height}>
          {layers.told}
        </SvgSurface>
      )}
      {messageId && chips.map((chip, index) => {
        const attachment = message!.attachments![index]!;
        return <button
          key={attachment.id}
          type="button"
          className="dc-seq-attachment-hit nodrag nopan"
          style={{ left: chip.x, top: chip.y, width: chip.w, height: chip.h }}
          aria-label={`View attached ${attachment.type === 'code' ? 'code' : 'note'} for current message`}
          onClick={(event) => { event.stopPropagation(); sequenceActions.showAttachments(node.id, messageId, attachment.id); }}
        />;
      })}
      {layers.now && (
        // Remounted for each step, so its arrival plays once per message and never again.
        <SvgSurface key={step} className="dc-seq-now" width={node.width} height={node.height}>
          {layers.now}
        </SvgSurface>
      )}
    </>
  );
});
