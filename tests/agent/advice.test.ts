import { describe, expect, it } from 'vitest';
import { technologyAdvice } from '../../src/agent/advice';
import { productNamedIn } from '../../src/nodes/technology';

/** An agent that writes a phrase for an element's technology is told the product name that shows its logo. */

describe('technology advice', () => {
  it('names the product a plain-marked technology starts with', () => {
    expect(productNamedIn('Spring Boot modular monolith')).toBe('Spring Boot');
    expect(productNamedIn('Kafka event bus')).toBe('Apache Kafka');
    // Already showing its logo: nothing to say.
    expect(productNamedIn('Spring Boot 3 modular monolith (Java 21)')).toBeUndefined();
    expect(productNamedIn('PostgreSQL 16')).toBeUndefined();
    // Nothing known first, or too short to be sure it's the brand.
    expect(productNamedIn('In-house rules engine')).toBeUndefined();
    expect(productNamedIn('Go service')).toBeUndefined();
  });

  it('gives the update that fixes each, a few at a time', () => {
    const [advice] = technologyAdvice([
      { id: 'c_lib', technology: 'Spring Boot modular monolith' },
      { id: 'c_db', technology: 'PostgreSQL 16' },
      { id: 'c_x', technology: 'Custom thing' },
    ]);
    expect(advice).toContain('"c_lib"');
    expect(advice).toContain('{"op":"update","id":"c_lib","set":{"technology":"Spring Boot"}}');
    expect(advice).not.toContain('c_db');
    expect(advice).not.toContain('c_x');
    expect(technologyAdvice([{ id: 'c_db', technology: 'PostgreSQL 16' }])).toEqual([]);
  });
});
