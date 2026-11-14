/**
 * What a name typed for a new participant could mean, best guess first — offered, never assumed.
 *
 * Three things, all read from what the app already knows: a shape that is already on the canvas
 * under that name (the participant then stands for it), a technology the catalogue recognises
 * ("Kafka" is a topic), and the five kinds of shape a participant can be, ranked by the same words
 * the shape picker understands ("user" finds an Actor, "db" a Data Store). The one a plain Enter
 * takes is marked, so it is always visible before it is chosen.
 */
import { displayNameFor } from '../../document/factory';
import { isLinkable, participantFromNode } from '../../document/sequenceLinks';
import { shapeForTechnology, technologyStart } from '../../document/technologyKind';
import type { DraftNode, DraftSequence, SeqParticipant, SeqParticipantType } from '../../document/types';
import { ALL_PRESETS, searchPresets, type Preset } from '../../lib/presets';
import { GENERIC_TECHNOLOGY_ICON, technologyIcon, technologySuggestions } from '../../nodes/technology';

export interface ParticipantOption {
  key: string;
  label: string;
  /** What choosing it does, in a few words. */
  hint: string;
  participant: Omit<SeqParticipant, 'id'>;
}

const KINDS: SeqParticipantType[] = ['service', 'actor', 'database', 'queue', 'component'];
const isKind = (preset: Preset): boolean => (KINDS as string[]).includes(preset.type) && !preset.technology;

function ofKind(type: SeqParticipantType, name: string): Omit<SeqParticipant, 'id'> {
  return { name, type };
}

export function participantOptions(
  query: string,
  nodes: readonly DraftNode[],
  sequence: DraftSequence,
): { options: ParticipantOption[]; preferred: number } {
  const name = query.replace(/\s+/g, ' ').trim();
  const lower = name.toLowerCase();
  const options: ParticipantOption[] = [];
  let preferred = -1;

  // Shapes on the canvas, not already standing in this sequence.
  const linked = new Set(sequence.participants.map((participant) => participant.ref).filter(Boolean));
  const shapes = nodes
    .filter((node) => isLinkable(node) && !linked.has(node.id))
    .map((node) => ({ node, title: displayNameFor(node).replace(/\s+/g, ' ').trim() }))
    .filter((entry) => entry.title && (lower === '' || entry.title.toLowerCase().includes(lower)))
    .sort((a, b) => Number(b.title.toLowerCase().startsWith(lower)) - Number(a.title.toLowerCase().startsWith(lower)))
    .slice(0, 4);
  for (const { node, title } of shapes) {
    if (!isLinkable(node)) continue;
    if (lower !== '' && title.toLowerCase() === lower && preferred < 0) preferred = options.length;
    options.push({ key: `shape:${node.id}`, label: title, hint: 'On the canvas — stays linked to it', participant: participantFromNode(node, '') });
  }

  // A technology the catalogue knows by this name.
  if (lower.length >= 2) {
    // The name is itself a product the catalogue knows ("Kafka", "postgres"): that is the best guess.
    const recognised = technologyIcon(name);
    const exact = recognised && recognised !== GENERIC_TECHNOLOGY_ICON ? recognised.slug : null;
    const suggestions = technologySuggestions(name);
    const offered = [
      ...suggestions.filter((entry) => entry.icon.slug === exact),
      ...suggestions.filter((entry) => entry.icon.slug !== exact && entry.value.toLowerCase().startsWith(lower)),
    ].slice(0, 2);
    for (const suggestion of offered) {
      const shape = shapeForTechnology(suggestion.value);
      const type = (shape?.type ?? 'service') as SeqParticipantType;
      const label = ALL_PRESETS.find((preset) => preset.type === type)?.label ?? 'Service';
      const known = suggestion.icon.slug === exact;
      if (known && preferred < 0) preferred = options.length;
      options.push({
        key: `technology:${suggestion.value}`,
        label: suggestion.value,
        hint: `${label} built with ${suggestion.value}`,
        // Named as it was typed when the typing was the product's own name; as the product otherwise.
        participant: { name: known ? name : suggestion.value, type, ...technologyStart(type, suggestion.value) },
      });
    }
  }

  // The kinds of shape, those the name suggests first.
  const suggested = lower === '' ? [] : searchPresets(name).filter(isKind).map((preset) => preset.type as SeqParticipantType);
  const ordered = [...new Set([...suggested, ...KINDS])];
  if (preferred < 0) preferred = options.length;
  for (const type of ordered) {
    const preset = ALL_PRESETS.find((entry) => entry.type === type && isKind(entry));
    options.push({ key: `kind:${type}`, label: preset?.label ?? type, hint: preset?.hint ?? '', participant: ofKind(type, name) });
  }
  return { options, preferred };
}
