import { useMemo } from 'react';
import { peekSubject } from '../../presentation/presentationAttachments';
import { useEditorStore } from '../../store/editorStore';
import { selectEdge, selectNode } from '../../store/selectors';
import { PresentationCallout } from './PresentationCallout';
import { useAttachmentPeek } from './useAttachmentPeek';
import { useCalloutPresence } from './useCalloutPresence';

/**
 * While editing: the shape or connector the pointer rests on tells its notes and code beside it, in the same
 * callout Presentation Mode uses (`PresentationCallout`) — so reading what a shape carries takes no
 * click, and the attachment tab's popover stays what it is, the place to edit them.
 *
 *   pointer at rest (`useAttachmentPeek`) → subject (`peekSubject`) → presence → `PresentationCallout`
 *
 * Transient like every callout: never saved, undone or exported. Mounted only while editing.
 */
export function AttachmentPeekLayer() {
  const peek = useAttachmentPeek(true);
  // Watched only while something is being told — editing never re-renders this layer otherwise.
  const host = useEditorStore((state) =>
    peek ? (peek.hostKind === 'edge' ? selectEdge : selectNode)(state.document, peek.hostId) : undefined,
  );
  const hostKind = peek?.hostKind;
  const subject = useMemo(() => (host && hostKind ? peekSubject(hostKind, host) : null), [host, hostKind]);
  const { current, leaving, settle } = useCalloutPresence(subject);
  const shown = [leaving, current].filter((entry) => entry !== null);

  return (
    <>
      {shown.map((entry) => (
        <PresentationCallout key={entry.key} subject={entry} leaving={entry === leaving} onSettled={settle} variant="peek" />
      ))}
    </>
  );
}
