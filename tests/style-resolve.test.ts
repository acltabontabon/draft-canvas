import { describe, expect, it } from 'vitest';
import { createEdge, createNode } from '../src/document/factory';
import { HAND_PRESETS } from '../src/document/style';
import { NODE_TYPES } from '../src/document/types';
import { describeEdge } from '../src/edges/describe';
import { describeContext, describeNode, sizingContext } from '../src/nodes/describe';
import { PERSONALITY_PROFILES } from '../src/render/roughness/presets';
import { builtinStyle, styleFrom } from '../src/render/style/resolve';
import { StaticTextMeasurer } from '../src/render/text/measure';
import { DARK, LIGHT } from '../src/render/theme/tokens';
import { PERSONALITY_PRESETS } from '../src/theme/usePersonality';

describe('the built-in styles', () => {
  it('are the three drawing hands a device can prefer', () => {
    expect([...PERSONALITY_PRESETS]).toEqual([...HAND_PRESETS]);
    expect([...HAND_PRESETS]).toEqual(['clean', 'draft', 'sketch']);
  });

  it('carry the hand each preset has always had', () => {
    for (const preset of HAND_PRESETS) expect(builtinStyle(preset).hand).toBe(PERSONALITY_PROFILES[preset]);
    // What used to be a table of its own beside the boundary describer.
    expect(HAND_PRESETS.map((preset) => builtinStyle(preset).hand.boundaryBoost)).toEqual([1, 1.4, 1.7]);
  });

  it('are the same object every time, so they are safe as memo dependencies', () => {
    for (const preset of HAND_PRESETS) {
      expect(builtinStyle(preset)).toBe(builtinStyle(preset));
      expect(styleFrom(preset)).toBe(builtinStyle(preset));
      expect(styleFrom(builtinStyle(preset))).toBe(builtinStyle(preset));
    }
    expect(new Set(HAND_PRESETS.map((preset) => builtinStyle(preset).key)).size).toBe(HAND_PRESETS.length);
  });

  it('default to Clean', () => {
    expect(styleFrom()).toBe(builtinStyle('clean'));
    expect(describeContext(LIGHT).style).toBe(builtinStyle('clean'));
  });
});

describe('a renderer given a style', () => {
  it('draws every shape exactly as it does when given the preset by name', () => {
    for (const preset of HAND_PRESETS) {
      for (const type of NODE_TYPES) {
        const node = createNode({ id: `n-${type}`, type, x: 0, y: 0, text: 'Label' });
        expect(describeNode(node, describeContext(DARK, builtinStyle(preset))), `${type} ${preset}`).toEqual(describeNode(node, describeContext(DARK, preset)));
      }
    }
  });

  it('draws a connector exactly as it does when given the preset by name', () => {
    const a = createNode({ id: 'a', type: 'service', x: 0, y: 0, text: 'A' });
    const b = createNode({ id: 'b', type: 'service', x: 400, y: 160, text: 'B' });
    const edge = createEdge({ id: 'e', source: 'a', target: 'b' });
    const nodes = new Map([a, b].map((node) => [node.id, node]));
    const base = { theme: DARK, measurer: new StaticTextMeasurer(), showSequence: false };
    for (const preset of HAND_PRESETS) {
      expect(describeEdge(edge, nodes, { ...base, style: builtinStyle(preset) }), preset).toEqual(describeEdge(edge, nodes, { ...base, preset }));
    }
    // A style wins over a preset named beside it.
    expect(describeEdge(edge, nodes, { ...base, style: builtinStyle('sketch'), preset: 'clean' })).toEqual(describeEdge(edge, nodes, { ...base, preset: 'sketch' }));
  });
});

describe('sizing', () => {
  it('never depends on the theme on screen or on how this device draws', () => {
    const context = sizingContext();
    expect(context.theme).toBe(LIGHT);
    expect(context.style).toBe(builtinStyle('clean'));
  });
});
