import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TechnologyInput } from '../src/canvas/TechnologyInput';

describe('technology typeahead', () => {
  it('filters aliases and commits a canonical name with its existing version by keyboard', () => {
    const commit = vi.fn();
    render(<TechnologyInput value="" onCommit={commit} />);
    const field = screen.getByRole('combobox', { name: 'Technology' });
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: 'post 16' } });
    expect(screen.getByRole('option', { name: 'PostgreSQL 16' })).toBeVisible();
    expect(commit).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(commit).toHaveBeenCalledExactlyOnceWith('PostgreSQL 16');
    expect(field).toHaveValue('PostgreSQL 16');
  });

  it('uses arrows to choose a different branded match and supports pointer selection', () => {
    const commit = vi.fn();
    render(<TechnologyInput value="" onCommit={commit} />);
    const field = screen.getByRole('combobox', { name: 'Technology' });
    fireEvent.change(field, { target: { value: 'sql' } });
    const options = screen.getAllByRole('option');
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    expect(options[1]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(field).toHaveAttribute('aria-expanded', 'false');
    expect(commit).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: 'rab' } });
    fireEvent.click(screen.getByRole('option', { name: 'RabbitMQ' }));
    expect(commit).toHaveBeenCalledExactlyOnceWith('RabbitMQ');
  });

  it('allows custom values and clearing without inventing branded suggestions', () => {
    const commit = vi.fn();
    render(<TechnologyInput value="PostgreSQL" onCommit={commit} />);
    const field = screen.getByRole('combobox');
    fireEvent.change(field, { target: { value: 'Our internal engine' } });
    expect(screen.queryByRole('option')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('generic icon');
    fireEvent.blur(field);
    expect(commit).toHaveBeenLastCalledWith('Our internal engine');
    fireEvent.change(field, { target: { value: '' } });
    fireEvent.blur(field);
    expect(commit).toHaveBeenLastCalledWith('');
  });

  it('does not accept a suggestion while confirming an IME composition', () => {
    const commit = vi.fn();
    render(<TechnologyInput value="" onCommit={commit} />);
    const field = screen.getByRole('combobox');
    fireEvent.change(field, { target: { value: 'post' } });
    fireEvent.keyDown(field, { key: 'Enter', keyCode: 229 });
    expect(commit).not.toHaveBeenCalled();
    expect(field).toHaveValue('post');
  });
});
