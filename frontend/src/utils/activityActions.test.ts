import { describe, it, expect } from 'vitest';
import { humanizeAction, resolveActivityActionLabel } from './activityActions';

describe('humanizeAction', () => {
  it('returns an empty string for empty input', () => {
    expect(humanizeAction('')).toBe('');
  });

  it('renders SCREAMING_CASE enums in Title Case', () => {
    expect(humanizeAction('CREATE_TASK')).toBe('Create Task');
  });

  it('handles the DEVICE_* actions flagged by s-1257 P0-1', () => {
    expect(humanizeAction('DEVICE_APPROVE')).toBe('Device Approved');
    expect(humanizeAction('DEVICE_CODE')).toBe('Device Code');
    expect(humanizeAction('DEVICE_CREATE')).toBe('Device Created');
  });

  it('uses a past-tense verb form when the enum ends in a known verb', () => {
    expect(humanizeAction('OAUTH_CLIENT_DELETE')).toBe('Oauth Client Deleted');
    expect(humanizeAction('OAUTH_CLIENT_REGISTER')).toBe('Oauth Client Registered');
    expect(humanizeAction('WEBHOOK_TEST')).toBe('Webhook Tested');
    expect(humanizeAction('WEBHOOK_ROTATE')).toBe('Webhook Rotated');
    expect(humanizeAction('BULK_PERMISSION_GRANT')).toBe('Bulk Permission Granted');
  });

  it('accepts hyphens as separators as well as underscores', () => {
    expect(humanizeAction('OAUTH-PROVIDER-UPDATE')).toBe('Oauth Provider Updated');
  });

  it('keeps unknown verbs in their original form (Title Cased)', () => {
    expect(humanizeAction('LOGIN')).toBe('Login');
    expect(humanizeAction('BOARD_IMPORT')).toBe('Board Import');
  });
});

describe('resolveActivityActionLabel', () => {
  const makeT = (table: Record<string, string>) => (key: string) => table[key];
  const makeI18n = (table: Record<string, string>) => ({
    exists: (key: string) => Object.prototype.hasOwnProperty.call(table, key),
  });

  it('returns the i18n string when the key exists and is non-empty', () => {
    const t = makeT({ 'settings.activities.DEVICE_APPROVE': '设备批准' });
    const i18n = makeI18n({ 'settings.activities.DEVICE_APPROVE': '设备批准' });
    expect(resolveActivityActionLabel('DEVICE_APPROVE', t, i18n)).toBe('设备批准');
  });

  it('falls back to humanizeAction when the key is missing', () => {
    const t = makeT({});
    const i18n = makeI18n({});
    expect(resolveActivityActionLabel('DEVICE_APPROVE', t, i18n)).toBe('Device Approved');
  });

  it('falls back to humanizeAction when the i18n value is the empty string', () => {
    const t = makeT({ 'settings.activities.DEVICE_APPROVE': '' });
    const i18n = makeI18n({ 'settings.activities.DEVICE_APPROVE': '' });
    expect(resolveActivityActionLabel('DEVICE_APPROVE', t, i18n)).toBe('Device Approved');
  });
});
