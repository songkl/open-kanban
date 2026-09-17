import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCustomFields } from './useCustomFields';
import type { CustomField } from '@/types/kanban';

const STORAGE_KEY = 'customFields:board-1';

const sampleField: CustomField = {
  id: 'f-1',
  name: 'Severity',
  type: 'single-select',
  color: '#ef4444',
  options: ['low', 'medium', 'high'],
};

describe('useCustomFields', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('returns empty list when no storage entry exists', () => {
    const { result } = renderHook(() => useCustomFields('board-1'));
    expect(result.current.customFields).toEqual([]);
  });

  it('loads existing fields from localStorage on mount', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([sampleField]));
    const { result } = renderHook(() => useCustomFields('board-1'));
    expect(result.current.customFields).toEqual([sampleField]);
  });

  it('upsertField adds a new field', () => {
    const { result } = renderHook(() => useCustomFields('board-1'));
    act(() => result.current.upsertField(sampleField));
    expect(result.current.customFields).toEqual([sampleField]);
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    expect(stored).toEqual([sampleField]);
  });

  it('upsertField replaces an existing field with the same id', () => {
    const { result } = renderHook(() => useCustomFields('board-1'));
    act(() => result.current.upsertField(sampleField));
    const updated: CustomField = { ...sampleField, name: 'Severity (renamed)' };
    act(() => result.current.upsertField(updated));
    expect(result.current.customFields).toHaveLength(1);
    expect(result.current.customFields[0].name).toBe('Severity (renamed)');
  });

  it('removeField deletes by id and persists', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([sampleField, { ...sampleField, id: 'f-2', name: 'Other' }]));
    const { result } = renderHook(() => useCustomFields('board-1'));
    expect(result.current.customFields).toHaveLength(2);
    act(() => result.current.removeField('f-1'));
    expect(result.current.customFields).toHaveLength(1);
    expect(result.current.customFields[0].id).toBe('f-2');
  });

  it('clearFields empties the list', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([sampleField]));
    const { result } = renderHook(() => useCustomFields('board-1'));
    act(() => result.current.clearFields());
    expect(result.current.customFields).toEqual([]);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')).toEqual([]);
  });

  it('returns empty list when boardId is null', () => {
    const { result } = renderHook(() => useCustomFields(null));
    expect(result.current.customFields).toEqual([]);
  });

  it('reads the new board key when boardId changes', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([sampleField]));
    localStorage.setItem('customFields:board-2', JSON.stringify([{ ...sampleField, id: 'f-2', name: 'Other' }]));
    const { result, rerender } = renderHook(({ boardId }: { boardId: string }) => useCustomFields(boardId), {
      initialProps: { boardId: 'board-1' },
    });
    expect(result.current.customFields[0].id).toBe('f-1');
    rerender({ boardId: 'board-2' });
    expect(result.current.customFields[0].id).toBe('f-2');
  });

  it('tolerates corrupted localStorage payloads', () => {
    localStorage.setItem(STORAGE_KEY, 'not-json');
    const { result } = renderHook(() => useCustomFields('board-1'));
    expect(result.current.customFields).toEqual([]);
  });

  it('ignores non-array localStorage payloads', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ not: 'an array' }));
    const { result } = renderHook(() => useCustomFields('board-1'));
    expect(result.current.customFields).toEqual([]);
  });
});