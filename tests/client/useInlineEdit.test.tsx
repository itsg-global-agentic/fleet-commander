// =============================================================================
// Fleet Commander — useInlineEdit Hook Tests
// =============================================================================

import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useInlineEdit } from '../../src/client/hooks/useInlineEdit';

describe('useInlineEdit', () => {
  describe('initial state', () => {
    it('starts with isEditing false', () => {
      const { result } = renderHook(() => useInlineEdit(''));
      expect(result.current.isEditing).toBe(false);
    });

    it('starts with the provided default value', () => {
      const { result } = renderHook(() => useInlineEdit(42));
      expect(result.current.editValue).toBe(42);
    });

    it('provides an inputRef', () => {
      const { result } = renderHook(() => useInlineEdit('test'));
      expect(result.current.inputRef).toBeDefined();
      expect(result.current.inputRef.current).toBeNull();
    });
  });

  describe('startEdit', () => {
    it('sets isEditing to true', () => {
      const { result } = renderHook(() => useInlineEdit(''));
      act(() => {
        result.current.startEdit('hello');
      });
      expect(result.current.isEditing).toBe(true);
    });

    it('sets editValue to the provided current value', () => {
      const { result } = renderHook(() => useInlineEdit(''));
      act(() => {
        result.current.startEdit('hello');
      });
      expect(result.current.editValue).toBe('hello');
    });
  });

  describe('cancelEdit', () => {
    it('sets isEditing to false', () => {
      const { result } = renderHook(() => useInlineEdit(''));
      act(() => {
        result.current.startEdit('hello');
      });
      expect(result.current.isEditing).toBe(true);
      act(() => {
        result.current.cancelEdit();
      });
      expect(result.current.isEditing).toBe(false);
    });
  });

  describe('confirmEdit', () => {
    it('sets isEditing to false and returns the current editValue', () => {
      const { result } = renderHook(() => useInlineEdit(''));
      act(() => {
        result.current.startEdit('hello');
      });
      act(() => {
        result.current.setEditValue('world');
      });
      let confirmed: string | undefined;
      act(() => {
        confirmed = result.current.confirmEdit();
      });
      expect(result.current.isEditing).toBe(false);
      expect(confirmed).toBe('world');
    });
  });

  describe('setEditValue', () => {
    it('updates the edit value', () => {
      const { result } = renderHook(() => useInlineEdit(0));
      act(() => {
        result.current.startEdit(5);
      });
      act(() => {
        result.current.setEditValue(10);
      });
      expect(result.current.editValue).toBe(10);
    });
  });

  describe('double-fire guard', () => {
    it('returns null on second confirmEdit call (Enter + blur guard)', () => {
      const { result } = renderHook(() => useInlineEdit(''));
      act(() => {
        result.current.startEdit('hello');
      });
      let first: string | null | undefined;
      let second: string | null | undefined;
      act(() => {
        first = result.current.confirmEdit();
      });
      act(() => {
        second = result.current.confirmEdit();
      });
      expect(first).toBe('hello');
      expect(second).toBeNull();
    });

    it('resets the guard when startEdit is called again', () => {
      const { result } = renderHook(() => useInlineEdit(''));
      act(() => {
        result.current.startEdit('first');
      });
      act(() => {
        result.current.confirmEdit();
      });
      // Start a new edit session
      act(() => {
        result.current.startEdit('second');
      });
      let confirmed: string | null | undefined;
      act(() => {
        confirmed = result.current.confirmEdit();
      });
      expect(confirmed).toBe('second');
    });
  });

  describe('works with number type', () => {
    it('handles number editing workflow', () => {
      const { result } = renderHook(() => useInlineEdit<number>(5));
      // Start editing
      act(() => {
        result.current.startEdit(5);
      });
      expect(result.current.isEditing).toBe(true);
      expect(result.current.editValue).toBe(5);

      // Change value
      act(() => {
        result.current.setEditValue(10);
      });
      expect(result.current.editValue).toBe(10);

      // Confirm
      let confirmed: number | undefined;
      act(() => {
        confirmed = result.current.confirmEdit();
      });
      expect(confirmed).toBe(10);
      expect(result.current.isEditing).toBe(false);
    });
  });
});
