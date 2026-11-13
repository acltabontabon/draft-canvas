import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { createNode } from '../src/document/factory';
import { shapeForTechnology, technologyKindPatch, technologyStart } from '../src/document/technologyKind';
import { ALL_PRESETS, searchPresets } from '../src/lib/presets';
import { useEditorStore } from '../src/store/editorStore';
import { useUiStore } from '../src/store/uiStore';
import { Toolbar } from '../src/ui/Editor/Toolbar';
import { SERVICE_STACKS, technologyShapes, UNLISTED_TECHNOLOGIES } from '../src/ui/Editor/toolbar/technologyShapes';

/**
 * The rail keeps the shapes a diagram reaches for constantly; the rest are in the shape picker at
 * its end, where every shape is spelled out. Shortening the rail must not make any shape harder to
 * find, so these pin both halves: what is on the rail, and that the picker names all of it.
 */

function renderToolbar() {
  render(<Toolbar title="Untitled canvas" onTitleChange={() => {}} onBack={() => {}} onPresent={() => {}} onExport={() => {}} />);
}

const rail = () => screen.getByRole('toolbar', { name: 'Create' });

beforeEach(() => {
  useEditorStore.setState({ history: { past: [], future: [] } });
  useUiStore.setState({ armed: null });
});

describe('searchPresets', () => {
  it('is the whole vocabulary, in order, for an empty query', () => {
    expect(searchPresets('  ')).toEqual(ALL_PRESETS);
  });

  it('finds a shape by the other names people use for it', () => {
    expect(searchPresets('cache').map((preset) => preset.id)).toEqual(['database']);
    expect(searchPresets('kafka').map((preset) => preset.id)).toEqual(['queue']);
    expect(searchPresets('user')[0]?.id).toBe('actor');
  });

  it('puts a name that starts with the query ahead of one that only mentions it', () => {
    // "Code" is a name; "config" is only something Code is used for.
    expect(searchPresets('co').map((preset) => preset.id).slice(0, 2)).toEqual(['code', 'component']);
  });

  it('needs every word of the query', () => {
    expect(searchPresets('data store').map((preset) => preset.id)).toContain('database');
    expect(searchPresets('data zebra')).toEqual([]);
  });
});

describe('technologyShapes', () => {
  it('offers the shape a technology is, with the kind it implies', () => {
    expect(technologyShapes('kafka')[0]).toMatchObject({ label: 'Apache Kafka', type: 'queue', technology: 'Apache Kafka', hint: 'Queue · Topic' });
    expect(technologyShapes('redis')[0]).toMatchObject({ label: 'Redis', type: 'database', hint: 'Data Store · Cache' });
    expect(technologyShapes('postgres')[0]).toMatchObject({ label: 'PostgreSQL', type: 'database', hint: 'Data Store · SQL' });
    expect(technologyShapes('stripe')[0]).toMatchObject({ label: 'Stripe', type: 'service', hint: 'Service · External' });
  });

  it('offers a technology it knows no shape for as what a Service is built with, and says so', () => {
    expect(technologyShapes('spring boot')[0]).toMatchObject({ label: 'Spring Boot', type: 'service', hint: 'Service · built with Spring Boot' });
  });

  it('guesses only for a technology named outright, and never when told a shape has that name', () => {
    // The logo catalog is thousands of brands; a prefix of one is not a request for it.
    expect(technologyShapes('zeb')).toEqual([]);
    expect(technologyShapes('post').every((preset) => !preset.hint.includes('built with'))).toBe(true);
    expect(technologyShapes('go')[0]).toMatchObject({ label: 'Go', hint: 'Service · built with Go' });
    expect(technologyShapes('go', { guess: false }).some((preset) => preset.label === 'Go')).toBe(false);
  });

  it('offers what services are built with from the first letters, as a Service', () => {
    expect(technologyShapes('spring')).toContainEqual(expect.objectContaining({ label: 'Spring Boot', type: 'service', hint: 'Service · built with Spring Boot' }));
    // The catalog's own disambiguation stays on the shape, not in the list.
    expect(technologyShapes('spring')[0]).toMatchObject({ label: 'Spring', technology: 'Spring (spring)' });
    expect(technologyShapes('rus')[0]).toMatchObject({ label: 'Rust', type: 'service', technology: 'Rust' });
    // No logo for it in the catalog: still offered, with the neutral mark.
    expect(technologyShapes('java')).toContainEqual(expect.objectContaining({ label: 'Java', type: 'service' }));
    // Still on offer when the word also starts a shape's name: "no" is a Note and Node.js.
    expect(technologyShapes('no', { guess: false }).map((preset) => preset.label)).toContain('Node.js');
    // None of them is a shape of its own, or it would belong to `technologyKind.ts` instead.
    for (const name of SERVICE_STACKS) expect(shapeForTechnology(name), name).toBeNull();
    expect(new Set(SERVICE_STACKS).size).toBe(SERVICE_STACKS.length);
  });

  it('knows the cloud services the logo catalog has no mark for', () => {
    expect(technologyShapes('sqs')[0]).toMatchObject({ label: 'Amazon SQS', type: 'queue', hint: 'Queue · Queue' });
    expect(technologyShapes('s3')[0]).toMatchObject({ label: 'Amazon S3', type: 'database', hint: 'Data Store · Object Storage' });
    for (const name of UNLISTED_TECHNOLOGIES) expect(shapeForTechnology(name), name).not.toBeNull();
  });

  it('stays out of the way of a query too short or too unlike a technology to mean one', () => {
    expect(technologyShapes('k')).toEqual([]);
    expect(technologyShapes('zzzzqq')).toEqual([]);
    expect(technologyShapes('junction')).toEqual([]);
  });

  it('starts the shape the way typing the technology onto it would', () => {
    expect(technologyStart('queue', 'Apache Kafka')).toEqual({ technology: 'Apache Kafka', queueKind: 'topic', kindOrigin: 'technology' });
    // RabbitMQ is a plain queue: nothing to move, nothing to mark.
    expect(technologyStart('queue', 'RabbitMQ')).toEqual({ technology: 'RabbitMQ' });
    expect(technologyStart('service', 'Spring Boot')).toEqual({ technology: 'Spring Boot' });
  });

  it('makes a shape that still follows its technology', () => {
    const node = createNode({ type: 'queue', x: 0, y: 0, ...technologyStart('queue', 'Apache Kafka') });
    expect(node).toMatchObject({ technology: 'Apache Kafka', queueKind: 'topic', kindOrigin: 'technology' });
    // Swapped for a plain queue, the kind goes back with it: it was never picked by hand.
    expect(technologyKindPatch(node, 'RabbitMQ')).toEqual({ queueKind: 'queue', kindOrigin: undefined });
  });
});

describe('create rail and shape picker', () => {
  it('keeps the everyday shapes on the rail and the rest behind Shapes', () => {
    renderToolbar();
    const names = within(rail()).getAllByRole('button').map((button) => button.getAttribute('aria-label'));
    expect(names).toEqual(['Select', 'Text', 'Note', 'Boundary', 'Service', 'Data Store', 'Queue', 'Actor', 'All shapes']);
  });

  it('names every shape in the picker, with what it is for and its key', async () => {
    const user = userEvent.setup();
    renderToolbar();
    await user.click(screen.getByRole('button', { name: 'All shapes' }));

    const picker = screen.getByRole('dialog', { name: 'All shapes' });
    expect(screen.getByRole('combobox', { name: 'Search shapes' })).toHaveFocus();
    const options = within(picker).getAllByRole('option');
    expect(options).toHaveLength(ALL_PRESETS.length);
    for (const [index, preset] of ALL_PRESETS.entries()) {
      expect(options[index]).toHaveTextContent(preset.label);
      expect(options[index]).toHaveTextContent(preset.hint);
      expect(options[index]).toHaveTextContent(preset.shortcut);
    }
  });

  it('searches as you type and arms the match on Enter', async () => {
    const user = userEvent.setup();
    renderToolbar();
    await user.click(screen.getByRole('button', { name: 'All shapes' }));
    await user.keyboard('cache');

    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('option', { selected: true })).toHaveTextContent('Data Store');

    await user.keyboard('{Enter}');
    expect(useUiStore.getState().armed?.id).toBe('database');
    expect(screen.queryByRole('dialog', { name: 'All shapes' })).not.toBeInTheDocument();
    // It has a button of its own: that one is pressed, and Shapes stays Shapes.
    expect(screen.getByRole('button', { name: 'Data Store' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'All shapes' })).toBeInTheDocument();
  });

  it('shows a shape with no button of its own in the Shapes slot while it is in hand', async () => {
    const user = userEvent.setup();
    renderToolbar();
    await user.click(screen.getByRole('button', { name: 'All shapes' }));
    await user.click(screen.getByRole('option', { name: /Junction/ }));

    expect(useUiStore.getState().armed?.id).toBe('ellipse');
    const slot = screen.getByRole('button', { name: 'Junction — all shapes' });
    expect(slot).toHaveAttribute('aria-pressed', 'true');
    // The rail's one tab stop is the tool in hand, wherever it is shown.
    expect(slot.tabIndex).toBe(0);
    expect(within(rail()).getAllByRole('button').filter((button) => button.tabIndex === 0)).toHaveLength(1);
  });

  it('finds a technology by name and arms the shape it is', async () => {
    const user = userEvent.setup();
    renderToolbar();
    await user.click(screen.getByRole('button', { name: 'All shapes' }));
    await user.keyboard('kafka');

    // The technology is the more exact answer, so it leads; the plain Queue is still offered.
    expect(screen.getByRole('option', { selected: true })).toHaveTextContent('Apache Kafka');
    expect(screen.getByRole('option', { selected: true })).toHaveTextContent('Queue · Topic');
    expect(screen.getByRole('option', { name: /^Queue/ })).toBeInTheDocument();

    await user.keyboard('{Enter}');
    expect(useUiStore.getState().armed).toMatchObject({ type: 'queue', technology: 'Apache Kafka' });
    expect(screen.getByRole('button', { name: 'Apache Kafka — all shapes' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('moves through the list with the arrow keys', async () => {
    const user = userEvent.setup();
    renderToolbar();
    await user.click(screen.getByRole('button', { name: 'All shapes' }));
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(useUiStore.getState().armed?.id).toBe(ALL_PRESETS[2]!.id);
  });

  it('says so when nothing matches, and Escape hands focus back to the rail', async () => {
    const user = userEvent.setup();
    renderToolbar();
    const trigger = screen.getByRole('button', { name: 'All shapes' });
    await user.click(trigger);
    await user.keyboard('zzzebra');

    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByRole('status')).toHaveTextContent('No shape or technology goes by “zzzebra”');

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'All shapes' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(useUiStore.getState().armed).toBeNull();
  });
});
