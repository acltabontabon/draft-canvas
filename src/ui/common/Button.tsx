import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: IconName;
  variant?: 'ghost' | 'solid' | 'quiet' | 'danger';
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
  return (
    <button
      type="button"
      className={['dc-button', `dc-button-${variant}`, className].filter(Boolean).join(' ')}
      data-active={active ? 'true' : undefined}
      data-icon-only={children === undefined ? 'true' : undefined}
      {...rest}
    >
      {icon && <Icon name={icon} />}
      {children}
    </button>
  );
}
