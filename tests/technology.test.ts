import { describe, expect, it } from 'vitest';
import { createDocument, createNode } from '../src/document/factory';
import { describeContext, describeNode, naturalArchitectureSize } from '../src/nodes/describe';
import { nodeReading } from '../src/nodes/readings';
import { GENERIC_TECHNOLOGY_ICON, nodeTechnologyIcon, technologyIcon, technologyMarkBounds, technologySuggestions } from '../src/nodes/technology';
import { dataStoreGlyphBounds } from '../src/document/dataStoreGeometry';
import { DARK, LIGHT } from '../src/render/theme/tokens';
import { renderDocumentSvg } from '../src/render/svg/document';
import { emitDisplayList } from '../src/render/svg/emit';
import { serialize } from '../src/render/svg/element';

describe('bundled technology recognition', () => {
  it.each([
    ['PostgreSQL', 'postgresql'], [' postgres 16.2 ', 'postgresql'], ['POSTGRESQL v16', 'postgresql'],
    ['Node.js 22', 'nodedotjs'], ['nodejs', 'nodedotjs'], ['Spring   Boot 3.4.1', 'springboot'],
    ['RabbitMQ 4', 'rabbitmq'], ['Redis 7.x', 'redis'], ['Kafka', 'apachekafka'],
    ['.NET 8', 'dotnet'], ['MySQL 8.4', 'mysql'], ['MariaDB', 'mariadb'], ['MongoDB', 'mongodb'],
    ['SQLite', 'sqlite'], ['Python', 'python'], ['React', 'react'], ['NGINX', 'nginx'],
    ['Docker', 'docker'], ['K8s', 'kubernetes'], ['Go 1.23', 'go'], ['TypeScript', 'typescript'],
  ])('recognizes %s without changing its text', (value, slug) => {
    expect(technologyIcon(value)?.slug).toBe(slug);
  });

  it.each(['InternalDB', 'PostgreSQL-compatible', 'PostgreSQL and Redis', 'Node.js / React', 'Spring Boot 3 on Kubernetes', 'Go service'])('uses a neutral mark for ambiguous or custom technology %s', (value) => {
    expect(technologyIcon(value)).toBe(GENERIC_TECHNOLOGY_ICON);
  });

  it.each([undefined, '', '   '])('draws no mark for an empty technology %s', (value) => {
    expect(technologyIcon(value)).toBeUndefined();
  });

  it('suggests only matching brands, without duplicates, preserving versions', () => {
    expect(technologySuggestions('post 16').map((suggestion) => suggestion.value)).toEqual(['PostgreSQL 16']);
    expect(technologySuggestions('mongo').map((suggestion) => suggestion.value)).toEqual(['MongoDB']);
    expect(technologySuggestions('InternalDB')).toEqual([]);
    expect(technologySuggestions('Node.js / React')).toEqual([]);
    expect(technologySuggestions('')).toHaveLength(6);
  });
});

describe('Quiet corner rendering', () => {
  for (const type of ['service', 'database', 'queue', 'actor', 'component'] as const) {
    it(`keeps a ${type}'s size, name, role and description while replacing only its technology line`, () => {
      const node = createNode({ type, x: 10, y: 20, text: 'Orders', technology: 'PostgreSQL 16', description: 'Stores orders.' });
      const ctx = describeContext(LIGHT);
      const natural = naturalArchitectureSize(node, ctx);
      expect(natural.fits).toBe(true);
      const sized = { ...node, width: natural.width, height: natural.height };
      const svg = emitDisplayList(describeNode(sized, ctx)).map(serialize).join('');
      expect(svg).toContain('<title>PostgreSQL 16</title>');
      expect(svg).toContain(nodeTechnologyIcon(node)!.path);
      expect(svg).toContain('Orders');
      expect(svg).toContain('Stores orders.');
      expect(svg).not.toContain('[PostgreSQL');
      expect(node.technology).toBe('PostgreSQL 16');
      expect(nodeReading(node)).toContain('PostgreSQL 16');
      expect(describeNode(sized, ctx)).toMatchObject({ width: sized.width, height: sized.height });
    });
  }

  it('does not grow a service merely to fit a recognized technology', () => {
    const node = createNode({ type: 'service', x: 0, y: 0, text: 'Orders', technology: 'PostgreSQL 16' });
    expect(naturalArchitectureSize(node, describeContext(LIGHT))).toMatchObject({ width: node.width, height: node.height, fits: true });
  });

  it('uses the same generic path on canvas and export, preserving all custom text in details', () => {
    const node = createNode({ type: 'service', x: 0, y: 0, technology: 'Internal engine / Redis 7' });
    const { svg } = renderDocumentSvg({ ...createDocument('Custom technology'), nodes: [node] });
    expect(svg).toContain(GENERIC_TECHNOLOGY_ICON.path);
    expect(svg).toContain('<title>Internal engine / Redis 7</title>');
    expect(svg).not.toContain('[Internal engine');
    expect(nodeTechnologyIcon(node)).toBe(GENERIC_TECHNOLOGY_ICON);
  });

  it.each([LIGHT, DARK])('uses muted theme ink in $name without a badge background', (theme) => {
    const node = createNode({ type: 'service', x: 0, y: 0, technology: 'Redis' });
    const mark = describeNode(node, describeContext(theme)).shapes.at(-1);
    expect(mark).toMatchObject({ t: 'group', title: 'Redis', children: [{ t: 'path', fill: theme.textMuted }] });
  });

  it('attaches to the data-store glyph as it scales, independently of document position', () => {
    const node = createNode({ type: 'database', x: -300, y: 900, width: 240, height: 220, technology: 'Postgres' });
    const glyph = dataStoreGlyphBounds({ ...node, x: 0, y: 0 });
    expect(technologyMarkBounds(node)).toMatchObject({ x: glyph.right + 9, y: glyph.top + 2 });
  });

  it('never adds a technology mark to annotation or boundary shapes', () => {
    for (const type of ['note', 'text', 'code', 'group', 'ellipse'] as const) {
      const node = { ...createNode({ type, x: 0, y: 0 }), technology: 'PostgreSQL' };
      expect(technologyMarkBounds(node)).toBeUndefined();
    }
  });

  it('embeds the same local path and full technology in a zero-padding SVG export', () => {
    const node = createNode({ type: 'service', x: -100, y: -200, technology: 'Node.js 22' });
    const { svg, width } = renderDocumentSvg({ ...createDocument('Technology'), nodes: [node] }, { padding: 0 });
    expect(svg).toContain(technologyIcon(node.technology)!.path);
    expect(svg).toContain('<title>Node.js 22</title>');
    expect(width).toBe(node.width + 25);
    expect(svg).not.toMatch(/<image|(?:href|src)="https?:|\[Node\.js/);
  });
});
