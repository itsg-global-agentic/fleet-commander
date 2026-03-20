import { useState, useEffect, useRef, useCallback } from 'react';
import { MoreHorizontalIcon } from './Icons';

// ---------------------------------------------------------------------------
// OverflowMenu — three-dot kebab dropdown for secondary actions
// ---------------------------------------------------------------------------

export interface OverflowMenuItem {
  label: string;
  onClick: () => void;
  /** If true, renders the label in red (for destructive actions) */
  danger?: boolean;
}

interface OverflowMenuProps {
  items: OverflowMenuItem[];
}

export function OverflowMenu({ items }: OverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const toggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setOpen((prev) => !prev);
  }, []);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open]);

  return (
    <div ref={menuRef} className="relative">
      <button
        onClick={toggle}
        className="p-1 rounded text-dark-muted hover:text-dark-text hover:bg-dark-border/30 transition-colors"
        title="More actions"
      >
        <MoreHorizontalIcon size={16} />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-20 min-w-[140px] bg-dark-surface border border-dark-border rounded-lg shadow-lg py-1">
          {items.map((item) => (
            <button
              key={item.label}
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                item.onClick();
              }}
              className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${
                item.danger
                  ? 'text-[#F85149] hover:bg-[#F85149]/10'
                  : 'text-dark-muted hover:text-dark-text hover:bg-dark-border/30'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
