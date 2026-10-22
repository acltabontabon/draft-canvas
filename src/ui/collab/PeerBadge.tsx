import type { LinkState } from '../../collab/protocol';
import { initialsOf } from './collabCopy';

interface PeerBadgeProps {
  name: string;
  /** Index into the peer palette (`--dc-peer-0`…`--dc-peer-7`); the owner is always 0. */
  color: number;
  link?: LinkState;
  size?: 'small' | 'regular';
}

/**
 * A person, as a round badge in their session colour with their initials. The initials are what
 * identify them — colour is a second cue, never the only one — and a connection in trouble dims.
 */
export function PeerBadge({ name, color, link = 'live', size = 'regular' }: PeerBadgeProps) {
  return (
    <span className="dc-peer-badge" data-peer-color={color % 8} data-link={link} data-size={size} aria-hidden="true">
      {initialsOf(name)}
    </span>
  );
}
