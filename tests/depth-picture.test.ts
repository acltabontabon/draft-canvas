import { afterEach, describe, expect, it, vi } from 'vitest';
import { pictureRoom, rectOfRoom, takePicture } from '../src/ui/Editor/depthRects';
import { createDocument } from '../src/document/factory';

afterEach(() => {
  document.body.replaceChildren();
  takePicture();
  vi.restoreAllMocks();
});

describe('room pictures', () => {
  it('preserves native DOMRect coordinates when no flight is active', () => {
    const frame = document.createElement('div');
    frame.className = 'dc-room';
    document.body.append(frame);
    vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue(new DOMRect(12, 24, 180, 90));
    expect(rectOfRoom()).toEqual({ x: 12, y: 24, width: 180, height: 90 });
  });

  it('bounds the number of room pictures carried through repeated reversals', () => {
    document.body.innerHTML = '<div class="react-flow"><div class="react-flow__viewport"></div><div class="dc-depth-ghost"></div></div>';
    let previous = document.querySelector('.dc-depth-ghost')!;
    for (let i = 0; i < 12; i += 1) {
      const layer = document.createElement('div');
      layer.className = 'dc-depth-remainder';
      previous.append(layer);
      previous = layer;
    }
    pictureRoom({ grid: false, room: createDocument('Repeated') });
    expect(takePicture()!.layer.querySelectorAll('.dc-depth-remainder')).toHaveLength(6);
  });

  it('keeps the visible camera of an interrupted flight and owns its SVG references', () => {
    document.body.innerHTML = `
      <div class="react-flow">
        <svg class="react-flow__background"><defs><pattern id="dots" /></defs><rect fill="url(#dots)" /></svg>
        <div class="react-flow__viewport" style="transform: translate(900px, 800px) scale(4)">
          <div class="react-flow__node" data-id="service"><div class="react-flow__handle"></div></div>
          <div class="dc-room"></div>
          <svg><defs><marker id="arrow" /><clipPath id="clip" /></defs>
            <path marker-end="url(#arrow)" clip-path="url(#clip)" />
            <use href="#arrow" />
          </svg>
        </div>
      </div>`;
    const viewport = document.querySelector<HTMLElement>('.react-flow__viewport')!;
    // WAAPI's visible pose differs from the inline landing camera. cloneNode omits the effect.
    const computed = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => element === viewport
      ? { transform: 'matrix(0.5, 0, 0, 0.5, 20, 30)', opacity: '0.4' } as CSSStyleDeclaration
      : computed(element, pseudo));

    pictureRoom({ grid: true, room: createDocument('Picture') });
    const picture = takePicture()!;
    const copy = picture.layer.querySelector<HTMLElement>('.react-flow__viewport')!;
    expect(copy.style.transform).toBe('matrix(0.5, 0, 0, 0.5, 20, 30)');
    expect(copy.style.opacity).toBe('0.4');
    expect(picture.layer.querySelector('[data-id], .react-flow__handle, .dc-room')).toBeNull();
    expect(picture.layer.querySelector('rect')?.getAttribute('fill')).toBe('url(#dots-picture)');
    expect(picture.layer.querySelector('path')?.getAttribute('marker-end')).toBe('url(#arrow-picture)');
    expect(picture.layer.querySelector('path')?.getAttribute('clip-path')).toBe('url(#clip-picture)');
    expect(picture.layer.querySelector('use')?.getAttribute('href')).toBe('#arrow-picture');
    expect(viewport.querySelector('#arrow')).not.toBeNull();
    expect(takePicture()).toBeNull();
  });
});
