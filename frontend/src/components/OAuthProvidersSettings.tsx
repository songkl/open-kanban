import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { authApi } from '../services/api';
import { showErrorToast } from './ErrorToast';
import type {
  OAuthProvider,
  OAuthProviderCreate,
  OAuthProviderUpdate
} from '@/types/kanban';

interface ProviderFormState {
  providerId: string;
  name: string;
  type: string;
  enabled: boolean;
  position: number;
  clientId: string;
  clientSecret: string;
  scopes: string;
  authEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string;
  issuer: string;
  extraConfig: string;
}

const PROVIDER_TYPES = ['google', 'github', 'wecom', 'feishu', 'dingtalk', 'oidc'];

const EMPTY_FORM: ProviderFormState = {
  providerId: '',
  name: '',
  type: 'oidc',
  enabled: true,
  position: 0,
  clientId: '',
  clientSecret: '',
  scopes: 'openid email profile',
  authEndpoint: '',
  tokenEndpoint: '',
  userinfoEndpoint: '',
  issuer: '',
  extraConfig: '{}'
};

function formFromProvider(p: OAuthProvider): ProviderFormState {
  return {
    providerId: p.providerId,
    name: p.name,
    type: p.type,
    enabled: p.enabled,
    position: p.position,
    clientId: p.clientId,
    clientSecret: '',
    scopes: p.scopes,
    authEndpoint: p.authEndpoint,
    tokenEndpoint: p.tokenEndpoint,
    userinfoEndpoint: p.userinfoEndpoint,
    issuer: p.issuer,
    extraConfig: p.extraConfig && p.extraConfig !== '{}' ? p.extraConfig : '{}'
  };
}

const providerIdRegex = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;
const scopeTokenRegex = /^[a-z0-9._:-]{1,64}$/;

function isValidHttpUrl(raw: string): boolean {
  if (!raw) return true;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (!u.hostname) return false;
    if (u.protocol === 'http:') {
      const h = u.hostname;
      if (h !== 'localhost' && h !== '127.0.0.1' && h !== '::1') return false;
    }
    return true;
  } catch {
    return false;
  }
}

interface FormErrors {
  providerId?: string;
  name?: string;
  type?: string;
  clientId?: string;
  clientSecret?: string;
  scopes?: string;
  authEndpoint?: string;
  tokenEndpoint?: string;
  userinfoEndpoint?: string;
  issuer?: string;
  extraConfig?: string;
}

function validateForm(form: ProviderFormState, isEdit: boolean): FormErrors {
  const errors: FormErrors = {};
  if (!isEdit) {
    if (!providerIdRegex.test(form.providerId.trim())) {
      errors.providerId = 'oauth.admin.providers.errors.providerIdFormat';
    }
  }
  if (!form.name.trim()) {
    errors.name = 'oauth.admin.providers.errors.nameRequired';
  }
  if (!PROVIDER_TYPES.includes(form.type)) {
    errors.type = 'oauth.admin.providers.errors.typeRequired';
  }
  if (!form.clientId.trim()) {
    errors.clientId = 'oauth.admin.providers.errors.clientIdRequired';
  }
  if (form.scopes.trim()) {
    const tokens = form.scopes.trim().split(/\s+/);
    for (const tok of tokens) {
      if (!scopeTokenRegex.test(tok)) {
        errors.scopes = 'oauth.admin.providers.errors.invalidScopes';
        break;
      }
    }
  }
  if (!isValidHttpUrl(form.authEndpoint)) {
    errors.authEndpoint = 'oauth.admin.providers.errors.invalidUrl';
  }
  if (!isValidHttpUrl(form.tokenEndpoint)) {
    errors.tokenEndpoint = 'oauth.admin.providers.errors.invalidUrl';
  }
  if (!isValidHttpUrl(form.userinfoEndpoint)) {
    errors.userinfoEndpoint = 'oauth.admin.providers.errors.invalidUrl';
  }
  if (form.type === 'oidc' && !form.issuer.trim()) {
    errors.issuer = 'oauth.admin.providers.errors.issuerRequired';
  } else if (form.issuer.trim() && !isValidHttpUrl(form.issuer)) {
    errors.issuer = 'oauth.admin.providers.errors.invalidUrl';
  }
  if (form.extraConfig.trim() && form.extraConfig.trim() !== '{}') {
    try {
      JSON.parse(form.extraConfig);
    } catch {
      errors.extraConfig = 'oauth.admin.providers.errors.invalidJson';
    }
  }
  return errors;
}

function hasErrors(errors: FormErrors): boolean {
  return Object.values(errors).some((v) => Boolean(v));
}

export function OAuthProvidersSettings() {
  const { t } = useTranslation();
  const [providers, setProviders] = useState<OAuthProvider[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>('');
  const [editing, setEditing] = useState<{ provider: OAuthProvider | null; form: ProviderFormState } | null>(null);
  const [formErrors, setFormErrors] = useState<FormErrors>({});
  const [saving, setSaving] = useState(false);

  const refresh = async () => {
    setLoading(true);
    setError('');
    try {
      const list = await authApi.getOAuthProviders();
      setProviders(list);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const sortedProviders = useMemo(
    () => [...providers].sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt)),
    [providers]
  );

  const openCreate = () => {
    setEditing({ provider: null, form: { ...EMPTY_FORM } });
    setFormErrors({});
  };

  const openEdit = (p: OAuthProvider) => {
    setEditing({ provider: p, form: formFromProvider(p) });
    setFormErrors({});
  };

  const closeForm = () => {
    setEditing(null);
    setFormErrors({});
  };

  const handleToggleEnabled = async (p: OAuthProvider) => {
    try {
      const updated = await authApi.updateOAuthProvider(p.id, { enabled: !p.enabled });
      setProviders((prev) => prev.map((row) => (row.id === p.id ? updated : row)));
      setError('');
      showErrorToast(
        updated.enabled ? t('oauth.admin.providers.providerEnabled') : t('oauth.admin.providers.providerDisabled'),
        'info'
      );
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handleDelete = async (p: OAuthProvider) => {
    if (!window.confirm(t('oauth.admin.providers.confirmDelete', { provider: p.name || p.providerId }))) return;
    try {
      await authApi.deleteOAuthProvider(p.id);
      setProviders((prev) => prev.filter((row) => row.id !== p.id));
      showErrorToast(t('oauth.admin.providers.providerDeleted'), 'info');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handleSave = async () => {
    if (!editing) return;
    const isEdit = editing.provider !== null;
    const errors = validateForm(editing.form, isEdit);
    setFormErrors(errors);
    if (hasErrors(errors)) return;

    setSaving(true);
    try {
      if (isEdit && editing.provider) {
        const update: OAuthProviderUpdate = {
          name: editing.form.name.trim(),
          type: editing.form.type,
          enabled: editing.form.enabled,
          position: editing.form.position,
          clientId: editing.form.clientId.trim(),
          scopes: editing.form.scopes.trim(),
          authEndpoint: editing.form.authEndpoint.trim(),
          tokenEndpoint: editing.form.tokenEndpoint.trim(),
          userinfoEndpoint: editing.form.userinfoEndpoint.trim(),
          issuer: editing.form.issuer.trim(),
          extraConfig: editing.form.extraConfig.trim() || '{}'
        };
        if (editing.form.clientSecret.trim()) {
          update.clientSecret = editing.form.clientSecret.trim();
        }
        const updated = await authApi.updateOAuthProvider(editing.provider.id, update);
        setProviders((prev) => prev.map((row) => (row.id === updated.id ? updated : row)));
        showErrorToast(t('oauth.admin.providers.providerUpdated'), 'info');
      } else {
        const create: OAuthProviderCreate = {
          providerId: editing.form.providerId.trim(),
          name: editing.form.name.trim(),
          type: editing.form.type,
          enabled: editing.form.enabled,
          position: editing.form.position,
          clientId: editing.form.clientId.trim(),
          scopes: editing.form.scopes.trim(),
          authEndpoint: editing.form.authEndpoint.trim(),
          tokenEndpoint: editing.form.tokenEndpoint.trim(),
          userinfoEndpoint: editing.form.userinfoEndpoint.trim(),
          issuer: editing.form.issuer.trim(),
          extraConfig: editing.form.extraConfig.trim() || '{}'
        };
        if (editing.form.clientSecret.trim()) {
          create.clientSecret = editing.form.clientSecret.trim();
        }
        const created = await authApi.createOAuthProvider(create);
        setProviders((prev) => [...prev, created]);
        showErrorToast(t('oauth.admin.providers.providerCreated'), 'info');
      }
      closeForm();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const updateFormField = <K extends keyof ProviderFormState>(key: K, value: ProviderFormState[K]) => {
    setEditing((prev) => {
      if (!prev) return prev;
      return { ...prev, form: { ...prev.form, [key]: value } };
    });
  };

  return (
    <div className="space-y-4" data-testid="oauth-providers-settings">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold text-zinc-800 dark:text-zinc-100">
            {t('oauth.admin.providers.title')}
          </h3>
          <p className="text-sm text-zinc-500 dark:text-zinc-500">
            {t('oauth.admin.providers.subtitle')}
          </p>
        </div>
        <button
          type="button"
          onClick={openCreate}
          className="rounded-md bg-blue-500 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600"
          data-testid="oauth-provider-add"
        >
          {t('oauth.admin.providers.add')}
        </button>
      </div>

      {error && (
        <div
          className="rounded-md bg-red-50 p-3 text-sm text-red-600 dark:bg-red-900/30 dark:text-red-400"
          role="alert"
        >
          {error}
        </div>
      )}

      {loading && providers.length === 0 && (
        <p className="py-8 text-center text-sm text-zinc-500 dark:text-zinc-500">
          {t('oauth.admin.loading')}
        </p>
      )}

      {!loading && sortedProviders.length === 0 && (
        <div className="rounded-md border border-dashed border-zinc-300 dark:border-zinc-600 p-6 text-center text-sm text-zinc-500 dark:text-zinc-500">
          {t('oauth.admin.providers.empty')}
        </div>
      )}

      <div className="space-y-3">
        {sortedProviders.map((p) => (
          <div
            key={p.id}
            className="rounded-lg border border-zinc-200 dark:border-zinc-700 p-4"
            data-testid="oauth-provider-row"
            data-provider-id={p.providerId}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-zinc-800 dark:text-zinc-100">{p.name || p.providerId}</span>
                  <span className="rounded bg-zinc-100 dark:bg-zinc-700 px-1.5 py-0.5 font-mono text-xs text-zinc-600 dark:text-zinc-300">
                    {p.providerId}
                  </span>
                  <span className="rounded bg-blue-50 px-1.5 py-0.5 text-xs text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
                    {t(`oauth.admin.providers.typeLabels.${p.type}`, p.type)}
                  </span>
                  <span
                    className={`rounded px-1.5 py-0.5 text-xs ${
                      p.enabled
                        ? 'bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300'
                        : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-700 dark:text-zinc-400'
                    }`}
                    data-testid="oauth-provider-status"
                  >
                    {p.enabled ? t('oauth.admin.providers.enabledBadge') : t('oauth.admin.providers.disabledBadge')}
                  </span>
                  <span
                    className={`rounded px-1.5 py-0.5 text-xs ${
                      p.secretSet
                        ? 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
                        : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-700 dark:text-zinc-400'
                    }`}
                    data-testid="oauth-provider-secret-status"
                  >
                    {p.secretSet
                      ? t('oauth.admin.providers.secretSet')
                      : t('oauth.admin.providers.secretUnset')}
                  </span>
                </div>
                <div className="font-mono text-xs text-zinc-500 dark:text-zinc-500 break-all">{p.clientId}</div>
                {p.scopes && (
                  <div className="text-xs text-zinc-500 dark:text-zinc-500">{p.scopes}</div>
                )}
              </div>
              <div className="flex flex-col items-end gap-2">
                <button
                  type="button"
                  role="switch"
                  aria-checked={p.enabled}
                  onClick={() => handleToggleEnabled(p)}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                    p.enabled ? 'bg-blue-600' : 'bg-zinc-300 dark:bg-zinc-600'
                  }`}
                  data-testid="oauth-provider-toggle"
                  data-provider-id={p.providerId}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      p.enabled ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => openEdit(p)}
                    className="rounded bg-blue-50 px-3 py-1 text-sm text-blue-600 hover:bg-blue-100 dark:bg-blue-900/30 dark:text-blue-300 dark:hover:bg-blue-900/50"
                    data-testid="oauth-provider-edit"
                  >
                    {t('common.edit')}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(p)}
                    className="rounded bg-red-50 px-3 py-1 text-sm text-red-600 hover:bg-red-100 dark:bg-red-900/30 dark:text-red-300 dark:hover:bg-red-900/50"
                    data-testid="oauth-provider-delete"
                  >
                    {t('common.delete')}
                  </button>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {editing && (
        <ProviderFormModal
          isEdit={editing.provider !== null}
          form={editing.form}
          errors={formErrors}
          saving={saving}
          onChange={updateFormField}
          onSave={handleSave}
          onCancel={closeForm}
        />
      )}
    </div>
  );
}

function ProviderFormModal({
  isEdit,
  form,
  errors,
  saving,
  onChange,
  onSave,
  onCancel
}: {
  isEdit: boolean;
  form: ProviderFormState;
  errors: FormErrors;
  saving: boolean;
  onChange: <K extends keyof ProviderFormState>(key: K, value: ProviderFormState[K]) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const titleId = 'oauth-provider-form-title';
  const subtitleId = 'oauth-provider-form-subtitle';

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/50"
        onClick={onCancel}
        data-testid="oauth-provider-modal-overlay"
      />
      <form
        onSubmit={onSubmit}
        className="relative z-10 w-full max-w-2xl rounded-xl bg-white dark:bg-zinc-800 p-6 shadow max-h-[90vh] overflow-y-auto"
        data-testid="oauth-provider-form"
      >
        <h2 id={titleId} className="mb-1 text-lg font-semibold text-zinc-800 dark:text-zinc-100">
          {isEdit ? t('oauth.admin.providers.edit') : t('oauth.admin.providers.add')}
        </h2>
        <p id={subtitleId} className="mb-4 text-sm text-zinc-500 dark:text-zinc-500">
          {t('oauth.admin.providers.subtitle')}
        </p>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            label={t('oauth.admin.providers.fields.providerId')}
            help={t('oauth.admin.providers.fields.providerIdHelp')}
            error={errors.providerId ? t(errors.providerId) : undefined}
          >
            <input
              type="text"
              value={form.providerId}
              disabled={isEdit}
              onChange={(e) => onChange('providerId', e.target.value)}
              className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:bg-zinc-100 disabled:text-zinc-500 dark:bg-zinc-700 dark:text-zinc-100 dark:disabled:bg-zinc-700 dark:disabled:text-zinc-500"
              data-testid="oauth-provider-field-providerId"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>

          <Field
            label={t('oauth.admin.providers.fields.name')}
            help={t('oauth.admin.providers.fields.nameHelp')}
            error={errors.name ? t(errors.name) : undefined}
          >
            <input
              type="text"
              value={form.name}
              onChange={(e) => onChange('name', e.target.value)}
              className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:bg-zinc-700 dark:text-zinc-100"
              data-testid="oauth-provider-field-name"
              autoComplete="off"
            />
          </Field>

          <Field
            label={t('oauth.admin.providers.fields.type')}
            help={t('oauth.admin.providers.fields.typeHelp')}
            error={errors.type ? t(errors.type) : undefined}
          >
            <select
              value={form.type}
              onChange={(e) => onChange('type', e.target.value)}
              className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:bg-zinc-700 dark:text-zinc-100"
              data-testid="oauth-provider-field-type"
            >
              {PROVIDER_TYPES.map((ptype) => (
                <option key={ptype} value={ptype}>
                  {t(`oauth.admin.providers.typeLabels.${ptype}`, ptype)}
                </option>
              ))}
            </select>
          </Field>

          <Field label={t('oauth.admin.providers.fields.position')}>
            <input
              type="number"
              value={form.position}
              onChange={(e) => onChange('position', Number(e.target.value) || 0)}
              className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:bg-zinc-700 dark:text-zinc-100"
              data-testid="oauth-provider-field-position"
            />
          </Field>

          <Field
            label={t('oauth.admin.providers.fields.clientId')}
            error={errors.clientId ? t(errors.clientId) : undefined}
          >
            <input
              type="text"
              value={form.clientId}
              onChange={(e) => onChange('clientId', e.target.value)}
              className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:bg-zinc-700 dark:text-zinc-100"
              data-testid="oauth-provider-field-clientId"
              autoComplete="off"
            />
          </Field>

          <Field
            label={t('oauth.admin.providers.fields.clientSecret')}
            help={
              isEdit
                ? t('oauth.admin.providers.secretSetHelp')
                : t('oauth.admin.providers.secretUnsetHelp')
            }
          >
            <input
              type="password"
              value={form.clientSecret}
              onChange={(e) => onChange('clientSecret', e.target.value)}
              placeholder={
                isEdit
                  ? t('oauth.admin.providers.secretSet')
                  : t('oauth.admin.providers.secretUnset')
              }
              className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-3 py-2 font-mono text-sm focus:border-blue-500 focus:outline-none dark:bg-zinc-700 dark:text-zinc-100"
              data-testid="oauth-provider-field-clientSecret"
              autoComplete="new-password"
            />
          </Field>

          <Field
            label={t('oauth.admin.providers.fields.scopes')}
            help={t('oauth.admin.providers.fields.scopesHelp')}
            error={errors.scopes ? t(errors.scopes) : undefined}
          >
            <input
              type="text"
              value={form.scopes}
              onChange={(e) => onChange('scopes', e.target.value)}
              className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-3 py-2 font-mono text-sm focus:border-blue-500 focus:outline-none dark:bg-zinc-700 dark:text-zinc-100"
              data-testid="oauth-provider-field-scopes"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>

          <div />

          <Field
            label={t('oauth.admin.providers.fields.authEndpoint')}
            error={errors.authEndpoint ? t(errors.authEndpoint) : undefined}
          >
            <input
              type="text"
              value={form.authEndpoint}
              onChange={(e) => onChange('authEndpoint', e.target.value)}
              className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-3 py-2 font-mono text-sm focus:border-blue-500 focus:outline-none dark:bg-zinc-700 dark:text-zinc-100"
              data-testid="oauth-provider-field-authEndpoint"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>

          <Field
            label={t('oauth.admin.providers.fields.tokenEndpoint')}
            error={errors.tokenEndpoint ? t(errors.tokenEndpoint) : undefined}
          >
            <input
              type="text"
              value={form.tokenEndpoint}
              onChange={(e) => onChange('tokenEndpoint', e.target.value)}
              className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-3 py-2 font-mono text-sm focus:border-blue-500 focus:outline-none dark:bg-zinc-700 dark:text-zinc-100"
              data-testid="oauth-provider-field-tokenEndpoint"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>

          <Field
            label={t('oauth.admin.providers.fields.userinfoEndpoint')}
            error={errors.userinfoEndpoint ? t(errors.userinfoEndpoint) : undefined}
          >
            <input
              type="text"
              value={form.userinfoEndpoint}
              onChange={(e) => onChange('userinfoEndpoint', e.target.value)}
              className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-3 py-2 font-mono text-sm focus:border-blue-500 focus:outline-none dark:bg-zinc-700 dark:text-zinc-100"
              data-testid="oauth-provider-field-userinfoEndpoint"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>

          <Field
            label={t('oauth.admin.providers.fields.issuer')}
            help={
              form.type === 'oidc'
                ? t('oauth.admin.providers.fields.issuerRequiredForOidc')
                : undefined
            }
            error={errors.issuer ? t(errors.issuer) : undefined}
          >
            <input
              type="text"
              value={form.issuer}
              onChange={(e) => onChange('issuer', e.target.value)}
              className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-3 py-2 font-mono text-sm focus:border-blue-500 focus:outline-none dark:bg-zinc-700 dark:text-zinc-100"
              data-testid="oauth-provider-field-issuer"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>

          <div className="sm:col-span-2">
            <Field
              label={t('oauth.admin.providers.fields.extraConfig')}
              help={t('oauth.admin.providers.fields.extraConfigHelp')}
              error={errors.extraConfig ? t(errors.extraConfig) : undefined}
            >
              <textarea
                value={form.extraConfig}
                onChange={(e) => onChange('extraConfig', e.target.value)}
                rows={4}
                className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-3 py-2 font-mono text-sm focus:border-blue-500 focus:outline-none dark:bg-zinc-700 dark:text-zinc-100"
                data-testid="oauth-provider-field-extraConfig"
                spellCheck={false}
              />
            </Field>
          </div>

          <div className="sm:col-span-2">
            <label className="flex items-center justify-between rounded-lg border border-zinc-200 dark:border-zinc-700 p-3 cursor-pointer">
              <div>
                <div className="text-sm font-medium text-zinc-800 dark:text-zinc-100">
                  {form.enabled
                    ? t('oauth.admin.providers.enabledBadge')
                    : t('oauth.admin.providers.disabledBadge')}
                </div>
                <div className="text-xs text-zinc-500 dark:text-zinc-500">
                  {t('oauth.admin.providers.subtitle')}
                </div>
              </div>
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => onChange('enabled', e.target.checked)}
                className="h-5 w-5 rounded border-zinc-300 text-blue-600 focus:ring-blue-500 dark:border-zinc-600"
                data-testid="oauth-provider-field-enabled"
              />
            </label>
          </div>
        </div>

        <p className="mt-4 rounded-md bg-amber-50 p-3 text-xs text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
          {t('oauth.admin.providers.secretWriteOnlyHelp')}
        </p>

        <div className="mt-6 flex gap-2">
          <button
            type="submit"
            disabled={saving}
            className="flex-1 rounded-md bg-blue-500 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600 disabled:bg-zinc-300"
            data-testid="oauth-provider-save"
          >
            {saving ? t('common.loading') : t('common.save')}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 rounded-md bg-zinc-100 dark:bg-zinc-700 px-4 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-600"
            data-testid="oauth-provider-cancel"
          >
            {t('common.cancel')}
          </button>
        </div>
      </form>
    </div>
  );
}

function Field({
  label,
  help,
  error,
  children
}: {
  label: string;
  help?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">{label}</label>
      {children}
      {help && <p className="text-xs text-zinc-500 dark:text-zinc-500">{help}</p>}
      {error && (
        <p className="text-xs text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
