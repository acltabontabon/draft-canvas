/**
 * The styles a person has made their own, kept in their own IndexedDB database
 * (`draft-canvas-styles`) apart from diagrams: clearing one never touches the other, and the
 * diagram library's database never has to change shape for them.
 *
 * Every read tolerates a missing or blocked database: without storage a style still works for the
 * session, it just isn't remembered. Whatever is read is checked like a style from a file, so a
 * record an older build or another tab wrote can never reach a renderer unchecked.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { normalizeStyle, STYLE_KINDS, STYLE_LIMITS, type DocumentStyle } from '../document/style';
import { ACCENTS, ACTOR_FRAMES, NODE_TYPES, type Accent, type ActorFrame, type DraftNodeType } from '../document/types';
import { isRecord } from '../lib/isRecord';

const STYLE_DB_NAME = 'draft-canvas-styles';
const STYLE_DB_VERSION = 2;

/** How many styles one device keeps. A person has a handful; this is room for a collector. */
export const MAX_PROFILES = 60;

export interface StyleProfile {
  id: string;
  name: string;
  style: DocumentStyle;
  updatedAt: number;
}

/**
 * How a new shape of one type starts, when the person has said: its colour and its kind. What
 * "Save as my default Service" keeps. A starting point for new shapes only: nothing here is read
 * when a shape is drawn, so it is no part of any style or any diagram.
 */
export interface ShapeStart {
  accent?: Accent;
  kind?: string;
  frame?: ActorFrame;
}

export type ShapeStarts = Partial<Record<DraftNodeType, ShapeStart>>;

interface StyleDb extends DBSchema {
  profiles: { key: string; value: StyleProfile };
  meta: { key: string; value: unknown };
}

let opening: Promise<IDBPDatabase<StyleDb> | null> | null = null;

function database(): Promise<IDBPDatabase<StyleDb> | null> {
  opening ??= openDB<StyleDb>(STYLE_DB_NAME, STYLE_DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('profiles')) db.createObjectStore('profiles', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    },
  }).catch(() => {
    opening = null;
    return null;
  });
  return opening;
}

/** Forgets the open database, so a test that swaps `indexedDB` starts from an empty one. */
export function __resetStyleDbForTests(): void {
  opening = null;
}

const PROFILE_ID = /^p_[0-9A-Za-z]{6,40}$/;

export const isProfileId = (value: unknown): value is string => typeof value === 'string' && PROFILE_ID.test(value);

/** A stored record made safe to use, or `null` when it is not a style at all. */
function profileOf(raw: unknown): StyleProfile | null {
  if (!isRecord(raw) || !isProfileId(raw.id)) return null;
  const style = normalizeStyle(raw.style).style;
  if (!style) return null;
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, STYLE_LIMITS.maxNameLength) : '';
  return { id: raw.id, name: name || style.name || 'My style', style, updatedAt: typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0 };
}

/** Every style kept on this device, oldest first. Empty when there are none or nothing can be read. */
export async function readProfiles(): Promise<StyleProfile[]> {
  try {
    const rows = (await (await database())?.getAll('profiles')) ?? [];
    return rows
      .map(profileOf)
      .filter((profile): profile is StyleProfile => profile !== null)
      .sort((a, b) => a.updatedAt - b.updatedAt || a.id.localeCompare(b.id))
      .slice(0, MAX_PROFILES);
  } catch {
    return [];
  }
}

export async function writeProfile(profile: StyleProfile): Promise<void> {
  try {
    await (await database())?.put('profiles', profile);
  } catch {
    // Not remembered; the style still works for this session.
  }
}

export async function removeProfile(id: string): Promise<void> {
  try {
    await (await database())?.delete('profiles', id);
  } catch {
    // Already gone, or nothing to remove it from.
  }
}

/** One type's start, checked: a colour and a kind this version knows, or nothing. */
export function shapeStartOf(type: DraftNodeType, raw: unknown): ShapeStart | null {
  if (!isRecord(raw)) return null;
  const start: ShapeStart = {};
  if (typeof raw.accent === 'string' && (ACCENTS as readonly string[]).includes(raw.accent)) start.accent = raw.accent as Accent;
  if (typeof raw.kind === 'string' && STYLE_KINDS[type].includes(raw.kind)) start.kind = raw.kind;
  if (type === 'actor' && typeof raw.frame === 'string' && (ACTOR_FRAMES as readonly string[]).includes(raw.frame)) start.frame = raw.frame as ActorFrame;
  return Object.keys(start).length > 0 ? start : null;
}

export async function readShapeStarts(): Promise<ShapeStarts> {
  try {
    const raw = await (await database())?.get('meta', 'shapeStarts');
    const out: ShapeStarts = {};
    if (!isRecord(raw)) return out;
    for (const type of NODE_TYPES) {
      const start = shapeStartOf(type, raw[type]);
      if (start) out[type] = start;
    }
    return out;
  } catch {
    return {};
  }
}

export async function writeShapeStarts(starts: ShapeStarts): Promise<void> {
  try {
    await (await database())?.put('meta', starts, 'shapeStarts');
  } catch {
    // Not remembered; it still holds for this session.
  }
}
