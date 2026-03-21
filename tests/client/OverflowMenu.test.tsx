// =============================================================================
// Fleet Commander — OverflowMenu Component Tests
// =============================================================================

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { OverflowMenu, type OverflowMenuItem } from '../../src/client/components/OverflowMenu';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OverflowMenu', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const items: OverflowMenuItem[] = [
    { label: 'Edit', onClick: vi.fn() },
    { label: 'Delete', onClick: vi.fn(), danger: true },
  ];

  it('renders the trigger button', () => {
    render(<OverflowMenu items={items} />);
    expect(screen.getByTitle('More actions')).toBeInTheDocument();
  });

  it('does not show menu items by default', () => {
    render(<OverflowMenu items={items} />);
    expect(screen.queryByText('Edit')).not.toBeInTheDocument();
    expect(screen.queryByText('Delete')).not.toBeInTheDocument();
  });

  it('shows menu items when trigger is clicked', () => {
    render(<OverflowMenu items={items} />);
    fireEvent.click(screen.getByTitle('More actions'));
    expect(screen.getByText('Edit')).toBeInTheDocument();
    expect(screen.getByText('Delete')).toBeInTheDocument();
  });

  it('hides menu when trigger is clicked again (toggle)', () => {
    render(<OverflowMenu items={items} />);
    const trigger = screen.getByTitle('More actions');
    fireEvent.click(trigger);
    expect(screen.getByText('Edit')).toBeInTheDocument();
    fireEvent.click(trigger);
    expect(screen.queryByText('Edit')).not.toBeInTheDocument();
  });

  it('calls onClick handler when a menu item is clicked', () => {
    const editFn = vi.fn();
    const menuItems: OverflowMenuItem[] = [
      { label: 'Edit', onClick: editFn },
    ];
    render(<OverflowMenu items={menuItems} />);
    fireEvent.click(screen.getByTitle('More actions'));
    fireEvent.click(screen.getByText('Edit'));
    expect(editFn).toHaveBeenCalledTimes(1);
  });

  it('closes the menu after clicking a menu item', () => {
    const menuItems: OverflowMenuItem[] = [
      { label: 'Edit', onClick: vi.fn() },
    ];
    render(<OverflowMenu items={menuItems} />);
    fireEvent.click(screen.getByTitle('More actions'));
    fireEvent.click(screen.getByText('Edit'));
    expect(screen.queryByText('Edit')).not.toBeInTheDocument();
  });

  it('applies danger styling for danger items', () => {
    render(<OverflowMenu items={items} />);
    fireEvent.click(screen.getByTitle('More actions'));
    const deleteBtn = screen.getByText('Delete');
    expect(deleteBtn.className).toContain('text-[#F85149]');
  });

  it('closes menu on Escape key', () => {
    render(<OverflowMenu items={items} />);
    fireEvent.click(screen.getByTitle('More actions'));
    expect(screen.getByText('Edit')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText('Edit')).not.toBeInTheDocument();
  });

  it('closes menu on click outside', () => {
    render(<OverflowMenu items={items} />);
    fireEvent.click(screen.getByTitle('More actions'));
    expect(screen.getByText('Edit')).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText('Edit')).not.toBeInTheDocument();
  });
});
