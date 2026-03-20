import { useState, useCallback, useRef } from 'react';

// ---------------------------------------------------------------------------
// useInlineEdit — encapsulates inline editing state for a single field
// ---------------------------------------------------------------------------

export interface InlineEditState<T> {
  isEditing: boolean;
  editValue: T;
  inputRef: React.RefObject<HTMLInputElement | null>;
  startEdit: (currentValue: T) => void;
  cancelEdit: () => void;
  /** Returns the current value and ends editing. Returns null on duplicate calls
   *  (e.g. Enter key followed by blur) so callers can skip the second save. */
  confirmEdit: () => T | null;
  setEditValue: (value: T) => void;
}

/**
 * Custom hook to manage inline editing state for a single field.
 * Each editable field (model, maxTeams, etc.) gets its own hook instance,
 * eliminating parent-level state management and prop drilling.
 */
export function useInlineEdit<T>(defaultValue: T): InlineEditState<T> {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState<T>(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);
  const committedRef = useRef(false);

  const startEdit = useCallback((currentValue: T) => {
    setEditValue(currentValue);
    setIsEditing(true);
    committedRef.current = false;
    setTimeout(() => inputRef.current?.focus(), 50);
  }, []);

  const cancelEdit = useCallback(() => {
    setIsEditing(false);
    committedRef.current = false;
  }, []);

  const confirmEdit = useCallback((): T | null => {
    if (committedRef.current) return null; // guard against Enter + blur double-fire
    committedRef.current = true;
    setIsEditing(false);
    return editValue;
  }, [editValue]);

  return {
    isEditing,
    editValue,
    inputRef,
    startEdit,
    cancelEdit,
    confirmEdit,
    setEditValue,
  };
}
