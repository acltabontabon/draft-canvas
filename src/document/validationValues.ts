import { isFiniteNumber } from '../lib/math';
import { LIMITS } from './limits';
import { cleanText } from './sanitize';

export const finite = (value: unknown, fallback: number): number => (isFiniteNumber(value) ? value : fallback);


export function text(value: unknown, max: number): string | undefined {
  return typeof value === 'string' ? cleanText(value, max) : undefined;
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

export function oneOfOptional<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

export function safeId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > LIMITS.maxIdLength) return null;
  return trimmed;
}
