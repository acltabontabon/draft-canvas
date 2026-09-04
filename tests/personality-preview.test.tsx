import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PersonalityPreview } from '../src/ui/personality/PersonalityPreview';
import { createNode } from '../src/document/factory';
import { describeContext, describeNode } from '../src/nodes/describe';
import { beginClipScope, emitDisplayList } from '../src/render/svg/emit';
import { serialize } from '../src/render/svg/element';
import { LIGHT } from '../src/render/theme/tokens';

/** jsdom normalizes self-closing tags (`<rect/>` → `<rect></rect>`) the moment markup is parsed
 *  into a real DOM, so a raw pre-parse `serialize()` string can never match a rendered element's
 *  `.innerHTML` as a plain substring — round-tripping both sides through a detached SVG element
 *  the same way `dangerouslySetInnerHTML` does sidesteps that formatting difference entirely. */
function roundTrip(markup: string): string {
  const probe = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  probe.innerHTML = markup;
  return probe.innerHTML;
}

describe('PersonalityPreview — reuses the real rendering pipeline, cannot drift from it', () => {
  it('renders a service outline for every preset without crashing', () => {
    for (const preset of ['clean', 'draft', 'sketch'] as const) {
      const { container } = render(<PersonalityPreview preset={preset} theme={LIGHT} />);
      const svg = container.querySelector('svg.dc-personality-preview');
      expect(svg).toBeTruthy();
      expect(svg!.querySelector('path,rect')).toBeTruthy();
    }
  });

  it("Clean's preview markup for its first service node matches describeNode's own output directly", () => {
    const { container } = render(<PersonalityPreview preset="clean" theme={LIGHT} />);
    // The preview's first `<g transform=...>` is node A — the edge (a plain `<path>`) paints
    // before it, per the "edges under nodes" ordering every other renderer uses.
    const renderedNodeA = container.querySelector('svg.dc-personality-preview g')!;

    // Same fixed id/position/size the preview itself uses for its first node, and the same clip
    // scope reset so the auto-incrementing clip-path id lines up with what the component's own
    // first-node call produces.
    beginClipScope('personality-preview-clean');
    const node = createNode({ type: 'service', id: 'personality-preview-clean-a', x: 4, y: 9, width: 30, height: 18 });
    const directMarkup = emitDisplayList(describeNode(node, describeContext(LIGHT, 'clean')))
      .map(serialize)
      .join('');

    expect(roundTrip(renderedNodeA.innerHTML)).toBe(roundTrip(directMarkup));
  });

  it('Draft and Sketch previews visibly differ from Clean and from each other', () => {
    const clean = render(<PersonalityPreview preset="clean" theme={LIGHT} />).container.querySelector(
      'svg.dc-personality-preview',
    )!.innerHTML;
    const draft = render(<PersonalityPreview preset="draft" theme={LIGHT} />).container.querySelector(
      'svg.dc-personality-preview',
    )!.innerHTML;
    const sketch = render(<PersonalityPreview preset="sketch" theme={LIGHT} />).container.querySelector(
      'svg.dc-personality-preview',
    )!.innerHTML;

    expect(draft).not.toBe(clean);
    expect(sketch).not.toBe(clean);
    expect(sketch).not.toBe(draft);
  });
});
