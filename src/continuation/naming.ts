import type { DraftNode } from '../document/types';
import type { FragmentNodeSpec } from './types';

/**
 * The one name continuation derives instead of the factory default: a Worker consuming a queue the
 * user named "Billing Queue" is "Billing Worker". Deliberately that narrow — a queue explicitly
 * named for what it carries is the only place a name says unambiguously what its consumer is.
 * Everything else keeps the factory default (queues and DLQs stay unnamed, by design).
 *
 * `undefined` means "use the default".
 */
export function derivedName(host: DraftNode | FragmentNodeSpec | undefined, spec: FragmentNodeSpec): string | undefined {
  if (!host || !('id' in host) || host.type !== 'queue' || host.deliveryRole !== undefined) return undefined;
  if (spec.type !== 'service' || spec.serviceKind !== 'worker') return undefined;
  const stem = host.text?.trim().match(/^(.+?)\s+queue$/i)?.[1];
  return stem ? `${stem} Worker` : undefined;
}
