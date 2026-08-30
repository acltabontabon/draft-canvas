import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createNode } from '../src/document/factory';
import { SvgSurface } from '../src/canvas/SvgSurface';
import { renderNodeSvgChildren } from '../src/render/svg/document';

/**
 * The canvas paints node content by injecting the SVG string produced by the
 * shared serializer. That is safe only because the serializer escapes
 * everything, so it is worth proving with a real DOM rather than trusting it.
 */
function renderNode(node: Parameters<typeof renderNodeSvgChildren>[0]) {
  const children = renderNodeSvgChildren(node, 'dark');
  return render(
    <div data-testid="host">
      <SvgSurface width={node.width} height={node.height}>
        {children}
      </SvgSurface>
    </div>,
  );
}

describe('code cards render content, never markup', () => {
  it('shows syntax-highlighted code as text', () => {
    const node = createNode({
      type: 'code',
      x: 0,
      y: 0,
      width: 420,
      height: 200,
      language: 'json',
      code: '{\n  "accountId": "123",\n  "status": "CANCELLED"\n}',
    });
    renderNode(node);

    const host = screen.getByTestId('host');
    expect(host.textContent).toContain('accountId');
    expect(host.textContent).toContain('CANCELLED');
    expect(host.querySelectorAll('tspan').length).toBeGreaterThan(3);
  });

  it('does not execute a script tag pasted into a code card', () => {
    const node = createNode({
      type: 'code',
      x: 0,
      y: 0,
      width: 420,
      height: 200,
      language: 'java',
      code: '<script>globalThis.__pwnedByCodeCard = true</script>',
    });
    renderNode(node);

    const host = screen.getByTestId('host');
    expect(host.querySelectorAll('script')).toHaveLength(0);
    expect((globalThis as Record<string, unknown>).__pwnedByCodeCard).toBeUndefined();
    // The text is still shown, because it is content the user wants to explain.
    expect(host.textContent).toContain('script');
  });

  it('does not create elements from markup in a node label', () => {
    const node = createNode({
      type: 'card',
      x: 0,
      y: 0,
      text: '<img src=x onerror="globalThis.__pwnedByLabel = true">',
    });
    renderNode(node);

    const host = screen.getByTestId('host');
    expect(host.querySelectorAll('img')).toHaveLength(0);
    expect((globalThis as Record<string, unknown>).__pwnedByLabel).toBeUndefined();
    expect(host.textContent).toContain('img src=x');
  });

  it('does not let an attribute-breaking payload out of a text node', () => {
    const node = createNode({
      type: 'card',
      x: 0,
      y: 0,
      text: '" onload="globalThis.__pwnedByAttr = true" x="',
    });
    renderNode(node);

    const svg = screen.getByTestId('host').querySelector('svg')!;
    for (const el of svg.querySelectorAll('*')) {
      expect(el.hasAttribute('onload')).toBe(false);
    }
    expect((globalThis as Record<string, unknown>).__pwnedByAttr).toBeUndefined();
  });

  it('renders a note with its kind label and body', () => {
    const node = createNode({
      type: 'note',
      x: 0,
      y: 0,
      width: 220,
      height: 120,
      text: 'What happens if the CMS times out?',
      noteKind: 'question',
    });
    renderNode(node);

    const host = screen.getByTestId('host');
    expect(host.textContent).toContain('QUESTION');
    // Text is laid out as one <text> per line, so the body is reassembled the
    // same way a reader sees it rather than as one run-together string.
    const lines = [...host.querySelectorAll('text')].map((el) => el.textContent);
    expect(lines.join(' ')).toContain('What happens if the CMS times out?');
    expect(lines.join(' ')).not.toContain('…');
  });

  it('produces no content for a node with nothing in it', () => {
    const node = createNode({ type: 'text', x: 0, y: 0, text: '' });
    renderNode(node);
    expect(screen.getByTestId('host').querySelectorAll('text')).toHaveLength(0);
  });
});
