import { create } from 'zustand';
import { createId } from '../document/ids';
import { canonicalStyle, HAND_PRESETS, STYLE_LIMITS, type DocumentStyle, type HandPreset } from '../document/style';
import { readPreference, removePreference, writePreference } from '../lib/preferences';
import { isProfileId, MAX_PROFILES, readProfiles, readShapeStarts, removeProfile, shapeStartOf, writeProfile, writeShapeStarts, type ShapeStart, type ShapeStarts, type StyleProfile } from '../storage/styleProfiles';
import { KIND_FIELDS, STYLE_KINDS } from '../document/style';
import type { DraftNode, DraftNodeType } from '../document/types';

export type { ShapeStart, StyleProfile } from '../storage/styleProfiles';

/**
 * The styles this person has made, and which one is theirs right now.
 *
 * A device preference, never part of a diagram: a new diagram is stamped with a copy of the style
 * in use (`deviceStyle`), and from then on carries its own. Changing a style here changes no
 * diagram that already has one; that takes an explicit "Use my style in this diagram".
 *
 * The three built-in styles are not stored. While none of the person's own is in use, the style in
 * use is the built-in for the drawing hand this device prefers (`PersonalityProvider`), exactly the
 * preference it has always been.
 */
export interface StyleState {
  /** The person's own styles, oldest first. */
  profiles: readonly StyleProfile[];
  /** The id of the one in use, or `null` while a built-in style is. */
  activeId: string | null;
  /** Whether the stored styles have been read yet. */
  loaded: boolean;
  load: () => Promise<void>;
  /** Uses one of the person's own styles, or with `null` goes back to the built-in ones. */
  select: (id: string | null) => void;
  /** Keeps `style` as a new style of the person's own and uses it. `null` when no more can be kept. */
  add: (name: string, style: DocumentStyle) => string | null;
  /** Changes one of the person's own styles. */
  update: (id: string, recipe: (style: DocumentStyle) => DocumentStyle) => void;
  rename: (id: string, name: string) => void;
  remove: (id: string) => void;
  /** How a new shape of each type starts, where the person has said (`ShapeStart`). */
  starts: ShapeStarts;
  /** Says how new shapes of `type` start, or with `null` goes back to the built-in start. */
  setStart: (type: DraftNodeType, start: ShapeStart | null) => void;
}

const ACTIVE_KEY = 'style-profile';

const BUILTIN_NAMES: Record<HandPreset, string> = { clean: 'Clean', draft: 'Draft', sketch: 'Sketch' };

const BUILTIN: Record<HandPreset, DocumentStyle> = {
  clean: Object.freeze({ v: 1, name: BUILTIN_NAMES.clean, hand: Object.freeze({ base: 'clean' }) }) as DocumentStyle,
  draft: Object.freeze({ v: 1, name: BUILTIN_NAMES.draft, hand: Object.freeze({ base: 'draft' }) }) as DocumentStyle,
  sketch: Object.freeze({ v: 1, name: BUILTIN_NAMES.sketch, hand: Object.freeze({ base: 'sketch' }) }) as DocumentStyle,
};

/** One of the three built-in styles, as a diagram would carry it. The same object every time. */
export function builtinProfileStyle(hand: HandPreset): DocumentStyle {
  return BUILTIN[hand];
}

const cleanName = (name: string): string => name.replace(/\s+/g, ' ').trim().slice(0, STYLE_LIMITS.maxNameLength);

function storedActive(): string | null {
  const stored = readPreference(ACTIVE_KEY);
  return isProfileId(stored) ? stored : null;
}

function remember(id: string | null): void {
  if (id) writePreference(ACTIVE_KEY, id);
  else removePreference(ACTIVE_KEY);
}

/** Styles deleted this session, so a read of storage that was already under way cannot bring one back. */
const removed = new Set<string>();

export const useStyleStore = create<StyleState>((set, get) => ({
  profiles: [],
  activeId: storedActive(),
  loaded: false,

  async load() {
    if (get().loaded) return;
    const [stored, starts] = await Promise.all([readProfiles(), readShapeStarts()]);
    // What happened while the read was under way wins over what it found: a style made or changed
    // in the first moments stays as it is now, and one deleted then stays deleted.
    const now = get().profiles;
    const profiles = [...stored.filter((profile) => !removed.has(profile.id) && !now.some((other) => other.id === profile.id)), ...now];
    const activeId = get().activeId;
    // A style that is gone (cleared storage, another device's preference) is simply not in use.
    const active = activeId && profiles.some((profile) => profile.id === activeId) ? activeId : null;
    if (active !== activeId) remember(active);
    // Said before the read finished wins over what was stored, type by type.
    set({ profiles, activeId: active, starts: { ...starts, ...get().starts }, loaded: true });
  },

  select(id) {
    const next = id && get().profiles.some((profile) => profile.id === id) ? id : null;
    if (next === get().activeId) return;
    remember(next);
    set({ activeId: next });
  },

  add(name, style) {
    if (get().profiles.length >= MAX_PROFILES) return null;
    const label = cleanName(name) || 'My style';
    const checked = canonicalStyle({ ...style, name: label });
    if (!checked) return null;
    const profile: StyleProfile = { id: createId('p'), name: label, style: checked, updatedAt: Date.now() };
    remember(profile.id);
    set({ profiles: [...get().profiles, profile], activeId: profile.id });
    void writeProfile(profile);
    return profile.id;
  },

  update(id, recipe) {
    const current = get().profiles.find((profile) => profile.id === id);
    if (!current) return;
    const checked = canonicalStyle({ ...recipe(current.style), name: current.name });
    if (!checked || JSON.stringify(checked) === JSON.stringify(current.style)) return;
    const profile: StyleProfile = { ...current, style: checked, updatedAt: Date.now() };
    set({ profiles: get().profiles.map((other) => (other.id === id ? profile : other)) });
    void writeProfile(profile);
  },

  rename(id, name) {
    const current = get().profiles.find((profile) => profile.id === id);
    const label = cleanName(name);
    if (!current || !label || label === current.name) return;
    const style = canonicalStyle({ ...current.style, name: label }) ?? current.style;
    const profile: StyleProfile = { ...current, name: label, style, updatedAt: Date.now() };
    set({ profiles: get().profiles.map((other) => (other.id === id ? profile : other)) });
    void writeProfile(profile);
  },

  starts: {},

  setStart(type, start) {
    const starts = { ...get().starts };
    const checked = start ? shapeStartOf(type, start) : null;
    if (checked) starts[type] = checked;
    else delete starts[type];
    set({ starts });
    void writeShapeStarts(starts);
  },

  remove(id) {
    if (!get().profiles.some((profile) => profile.id === id)) return;
    removed.add(id);
    const activeId = get().activeId === id ? null : get().activeId;
    if (activeId !== get().activeId) remember(activeId);
    set({ profiles: get().profiles.filter((profile) => profile.id !== id), activeId });
    void removeProfile(id);
  },
}));

/** The style in use, given the drawing hand this device prefers for when none of the person's own is. */
export function activeStyleOf(state: Pick<StyleState, 'profiles' | 'activeId'>, hand: HandPreset): DocumentStyle {
  const own = state.activeId ? state.profiles.find((profile) => profile.id === state.activeId) : undefined;
  return own?.style ?? BUILTIN[hand];
}

/**
 * The style a new diagram starts with: the one in use on this device, readable outside React.
 * The drawing hand comes from the preference `PersonalityProvider` keeps, so this agrees with the
 * screen even before the stored styles have been read.
 */
export function deviceStyle(): DocumentStyle {
  const stored = readPreference('personality');
  const hand = (HAND_PRESETS as readonly string[]).includes(stored ?? '') ? (stored as HandPreset) : 'clean';
  return activeStyleOf(useStyleStore.getState(), hand);
}

/** What a shape says about itself that a new one of its type could start with. */
export function shapeStartFrom(node: DraftNode): ShapeStart | null {
  const field = (KIND_FIELDS as Partial<Record<DraftNodeType, keyof DraftNode>>)[node.type];
  const kind = field ? node[field] : undefined;
  // What every shape of its type starts as anyway is nothing to remember: the first kind, no
  // colour, an actor with no frame.
  return shapeStartOf(node.type, {
    accent: node.accent === 'neutral' ? undefined : node.accent,
    kind: kind === STYLE_KINDS[node.type][0] ? undefined : kind,
    frame: node.actorFrame === 'borderless' ? undefined : node.actorFrame,
  });
}

/**
 * The fields a new shape of `type` starts with, where the person has said so. Empty otherwise.
 * A shape picked by a name of its own (a "load balancer", a technology) already says what it is:
 * its caller leaves these out.
 */
export function shapeStartFields(type: DraftNodeType): Partial<DraftNode> {
  const start = useStyleStore.getState().starts[type];
  if (!start) return {};
  const field = (KIND_FIELDS as Partial<Record<DraftNodeType, keyof DraftNode>>)[type];
  return {
    ...(start.accent ? { accent: start.accent } : {}),
    ...(start.kind && field ? ({ [field]: start.kind } as Partial<DraftNode>) : {}),
    ...(start.frame ? { actorFrame: start.frame } : {}),
  };
}
