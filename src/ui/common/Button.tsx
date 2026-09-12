import type { ComponentPropsWithRef, ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

interface ButtonProps extends ComponentPropsWithRef<'button'> {
  icon?: IconName;
  variant?: 'ghost' | 'solid' | 'quiet' | 'danger';
  /** A toggle's on state. Announced as `aria-pressed` unless the button is a disclosure instead
   *  (it passes `aria-expanded` or `aria-haspopup`), where "active" just means "its thing is open". */
  active?: boolean;
  children?: ReactNode;
}

export function Button({
  icon,
  variant = 'ghost',
  active,
  children,
  className,
  ...rest
}: ButtonProps) {
  const iconOnly = children === undefined;
  const isDisclosure = rest['aria-expanded'] !== undefined || rest['aria-haspopup'] !== undefined;
  return (
    <button
      type="button"
      className={['dc-button', `dc-button-${variant}`, className].filter(Boolean).join(' ')}
      data-active={active ? 'true' : undefined}
      data-icon-only={iconOnly ? 'true' : undefined}
      // An icon-only button has no visible text of its own to name it — fall back to its
      // `title`, same text a sighted user already reads as a tooltip, unless the caller already
      // gave it an explicit `aria-label` (which must keep winning, so this is computed before
      // `...rest` spreads).
      aria-label={rest['aria-label'] ?? (iconOnly ? rest.title : undefined)}
      aria-pressed={active === undefined || isDisclosure ? undefined : active}
      {...rest}
    >
      {icon && <Icon name={icon} />}
      {children}
    </button>
  );
}
