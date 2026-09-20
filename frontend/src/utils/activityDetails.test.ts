import { describe, it, expect } from 'vitest';
import { localizeActivityDetails } from './activityDetails';

const tFactory = (labels: Record<string, string>) =>
  ((key: string, opts?: Record<string, unknown>): string => {
    const template = labels[key] ?? key;
    if (!opts) return template;
    return template.replace(/\{\{(\w+)\}\}/g, (_, name) => {
      const v = opts[name];
      return v === undefined || v === null ? '' : String(v);
    });
  });

describe('localizeActivityDetails (s-1260 / PM review s-1258 P1-2)', () => {
  const t = tFactory({
    'settings.activities.details.statusFromTo': 'Status: {{from}} → {{to}}',
    'settings.activities.details.positionFromTo': 'Position: {{from}} → {{to}}',
    'settings.activities.details.reordered': 'Reordered {{count}} tasks',
    'settings.activities.details.statusLabel.todo': 'Backlog',
    'settings.activities.details.statusLabel.in_progress': 'In Progress',
    'settings.activities.details.statusLabel.testing': 'Testing',
    'settings.activities.details.statusLabel.review': 'Review',
    'settings.activities.details.statusLabel.done': 'Done',
  });

  it('returns empty string for empty / undefined input', () => {
    expect(localizeActivityDetails('', t)).toBe('');
    expect(localizeActivityDetails(undefined, t)).toBe('');
  });

  it('localizes English Status updates and maps both enums through the status labels', () => {
    const got = localizeActivityDetails("Status: 'in_progress' → 'review'", t);
    expect(got).toBe('Status: In Progress → Review');
  });

  it('localizes Chinese 状态 updates and maps both enums through the status labels', () => {
    const got = localizeActivityDetails("状态: 'todo' → 'in_progress'", t);
    expect(got).toBe('Status: Backlog → In Progress');
  });

  it('falls back to the raw value when neither side maps to a known enum', () => {
    const got = localizeActivityDetails("Status: 'in_progress' → 'review'", tFactory({}));
    expect(got).toBe("Status: 'in_progress' → 'review'");
  });

  it('localizes Position: … → … moves', () => {
    const got = localizeActivityDetails("Position: '5' → '1'", t);
    expect(got).toBe('Position: 5 → 1');
  });

  it('localizes 已重排 N 个任务 moves', () => {
    const got = localizeActivityDetails('已重排 7 个任务', t);
    expect(got).toBe('Reordered 7 tasks');
  });

  it('leaves unknown shapes untouched', () => {
    const raw = "device_code approved for client=kanban-cli";
    expect(localizeActivityDetails(raw, t)).toBe(raw);
  });
});