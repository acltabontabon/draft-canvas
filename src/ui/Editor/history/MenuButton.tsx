import { useCallback, useRef, useState } from 'react';
import type { IconName } from '../../common/Icon';
import { Button } from '../../common/Button';
import { Tooltip } from '../../common/Tooltip';
import { ToolbarMenu, type ToolbarMenuItem } from '../toolbar/ToolbarMenu';

/**
 * A quiet button that opens one of the editor's own menus, so history's occasional choices sit
 * behind a single control instead of crowding the strip.
 */
export function MenuButton({ icon, label, items, placement = 'above' }: { icon: IconName; label: string; items: () => ToolbarMenuItem[]; placement?: 'above' | 'below' }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ rect: DOMRect; trigger: HTMLElement } | null>(null);
  const close = useCallback(() => {
    setMenu(null);
    ref.current?.focus();
  }, []);
  const wrapped = menu
    ? items().map((item) => ({
        ...item,
        onSelect: () => {
          close();
          item.onSelect();
        },
      }))
    : [];
  return (
    <>
      <Tooltip content={{ title: label }}>
        {(tip) => (
          <Button
            ref={ref}
            variant="quiet"
            icon={icon}
            aria-label={label}
            aria-haspopup="menu"
            aria-expanded={menu !== null}
            active={menu !== null}
            onClick={(event) => {
              const trigger = event.currentTarget;
              setMenu((open) => (open ? null : { rect: trigger.getBoundingClientRect(), trigger }));
            }}
            {...tip}
          />
        )}
      </Tooltip>
      {menu && <ToolbarMenu label={label} anchorRect={menu.rect} trigger={menu.trigger} items={wrapped} onDismiss={close} placement={placement} />}
    </>
  );
}
