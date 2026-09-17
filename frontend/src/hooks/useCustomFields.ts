import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CustomField } from '../types/kanban';

const STORAGE_PREFIX = 'customFields:';

/**
 * s-1197: per-board custom field definitions. The backend `tasks.meta`
 * JSON already accepts arbitrary K-V, so the *definitions* (type, chip
 * color, select options) live client-side. We keep them in localStorage
 * keyed by boardId; the same key pattern is used by `useFilters` for
 * filter presets, so the cross-cutting concern of "UI metadata persisted
 * per-board" stays consistent.
 */
export interface UseCustomFieldsReturn {
  customFields: CustomField[];
  upsertField: (field: CustomField) => void;
  removeField: (id: string) => void;
  clearFields: () => void;
}

export function useCustomFields(boardId: string | null | undefined): UseCustomFieldsReturn {
  const storageKey = boardId ? `${STORAGE_PREFIX}${boardId}` : null;

  const [customFields, setCustomFields] = useState<CustomField[]>(() => {
    if (!storageKey) return [];
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as CustomField[]) : [];
    } catch {
      return [];
    }
  });

  // React to board switches: when `boardId` changes we re-read the
  // stored definitions for the new board. Without this the hook would
  // keep showing the previous board's fields after a board selector
  // change, which is the bug pattern flagged by the PR review of
  // earlier localStorage-backed hooks.
  useEffect(() => {
    if (!storageKey) {
      setCustomFields([]);
      return;
    }
    try {
      const raw = localStorage.getItem(storageKey);
      const parsed = raw ? JSON.parse(raw) : [];
      setCustomFields(Array.isArray(parsed) ? (parsed as CustomField[]) : []);
    } catch {
      setCustomFields([]);
    }
  }, [storageKey]);

  // Persist on change. Only write when we have a valid board; we don't
  // want a transient null boardId (e.g. during board deletion) to wipe
  // another board's entries.
  useEffect(() => {
    if (!storageKey) return;
    localStorage.setItem(storageKey, JSON.stringify(customFields));
  }, [storageKey, customFields]);

  const upsertField = useCallback((field: CustomField) => {
    setCustomFields(prev => {
      const idx = prev.findIndex(f => f.id === field.id);
      if (idx === -1) return [...prev, field];
      const next = prev.slice();
      next[idx] = field;
      return next;
    });
  }, []);

  const removeField = useCallback((id: string) => {
    setCustomFields(prev => prev.filter(f => f.id !== id));
  }, []);

  const clearFields = useCallback(() => {
    setCustomFields([]);
  }, []);

  return useMemo(
    () => ({ customFields, upsertField, removeField, clearFields }),
    [customFields, upsertField, removeField, clearFields],
  );
}