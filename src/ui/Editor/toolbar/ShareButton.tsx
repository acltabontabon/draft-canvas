import { useCallback, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { hostKind } from '../../../host/hostInfo';
import { copyShareLink } from '../../../share';
import { useCollabStore } from '../../../store/collabStore';
import { fileWithLiveViewport, useEditorStore } from '../../../store/editorStore';
import { useUiStore } from '../../../store/uiStore';
import { Button } from '../../common/Button';
import { Tooltip } from '../../common/Tooltip';
import { ToolbarMenu, type ToolbarMenuItem } from './ToolbarMenu';
import { toolbarLabel, toolbarTooltip } from './toolbarTooltips';

/**
 * Every way the diagram reaches someone else, behind one word everybody already knows. Before, that
 * was two unlabelled icons (people, an arrow down) that said nothing about each other; now the one
 * button that leaves the canvas is the one that is filled in, and what it offers is spelled out:
 * draw together live, export a copy, or send a read-only link.
 */
export function ShareButton({ onExport }: { onExport: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ rect: DOMRect; trigger: HTMLElement } | null>(null);
  const readOnly = useUiStore((state) => Boolean(state.readOnly));
  const collaborative = useUiStore((state) => state.readOnly?.collaborative === true);
  const title = useEditorStore((state) => state.document.metadata.title);
  const { role, people } = useCollabStore(
    useShallow((state) => ({ role: state.role, people: state.peers.filter((peer) => peer.link !== 'gone').length + 1 })),
  );

  const close = useCallback(() => {
    setMenu(null);
    ref.current?.focus();
  }, []);
  const choose = (action: () => void) => () => {
    setMenu(null);
    action();
  };

  const live = role !== 'off';
  const items: ToolbarMenuItem[] = [
    // A share link's read-only copy has nobody to draw with.
    ...(!readOnly || collaborative
      ? [
          {
            id: 'live',
            icon: 'people' as const,
            label: live ? `Live session · ${people} ${people === 1 ? 'person' : 'people'}` : 'Draw together, live',
            detail: live ? 'Who’s here, invites, and what each person can do' : 'Invite people to edit with you in real time',
            onSelect: choose(() => useUiStore.getState().setCollabOpen(true)),
          },
        ]
      : []),
    {
      id: 'export',
      icon: 'export' as const,
      label: 'Export',
      detail: 'An image, an editable file, or architecture source',
      onSelect: choose(onExport),
    },
    // The web app only: the desktop app's address is its own window, not a page anyone else can open.
    ...(hostKind()
      ? []
      : [
          {
            id: 'link',
            icon: 'link' as const,
            label: 'Copy read-only link',
            detail: 'The whole diagram travels inside the link — nothing is uploaded',
            onSelect: choose(() => void copyShareLink(fileWithLiveViewport(useEditorStore.getState()), useUiStore.getState().notify)),
          },
        ]),
  ];

  return (
    <>
      <Tooltip content={toolbarTooltip('share')}>
        {(tip) => (
          <Button
            ref={ref}
            variant="solid"
            className="dc-share-button"
            active={menu !== null}
            aria-haspopup="menu"
            aria-expanded={menu !== null}
            onClick={(event) => {
              const trigger = event.currentTarget;
              setMenu((open) => (open ? null : { rect: trigger.getBoundingClientRect(), trigger }));
            }}
            {...tip}
          >
            {toolbarLabel('share')}
          </Button>
        )}
      </Tooltip>
      {menu && (
        <ToolbarMenu
          label="Share"
          heading={`Share “${title.trim() || 'Untitled canvas'}”`}
          className="dc-share-menu"
          anchorRect={menu.rect}
          trigger={menu.trigger}
          items={items}
          onDismiss={close}
        />
      )}
    </>
  );
}
