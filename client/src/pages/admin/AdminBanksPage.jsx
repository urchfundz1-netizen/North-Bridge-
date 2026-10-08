/**
 * Admin bank catalogue.
 *
 * The catalogue directly controls what customers can select as a destination,
 * so deactivation is the only destructive action available here. Retiring a bank
 * hides it from new transfers; past transfers keep their stored snapshot of the
 * bank name, so historical records are unaffected.
 */

import { useState } from 'react';
import { AppShell } from '../../components/Layout.jsx';
import {
  Alert,
  AsyncBoundary,
  Button,
  Card,
  DataTable,
  Modal,
  PageHeader,
  StatusBadge,
  TextAreaField,
  TextField,
} from '../../components/ui.jsx';
import { adminApi } from '../../api/client.js';
import { useAsync, useAction } from '../../lib/hooks.js';
import { useSession } from '../../context/SessionContext.jsx';
import { IconPlus } from '../../components/icons.jsx';

const EMPTY_BANK = {
  name: '',
  code: '',
  country: 'United States',
  routingNumberLength: '',
  supportsLocal: true,
  supportsInternational: true,
  supportsWire: true,
  isActive: true,
  reason: '',
};

const CAPABILITIES = [
  { key: 'supportsLocal', label: 'Local transfers' },
  { key: 'supportsInternational', label: 'International' },
  { key: 'supportsWire', label: 'Wire / ACH' },
];

export default function AdminBanksPage() {
  const session = useSession();
  const [dialog, setDialog] = useState(null);
  const [form, setForm] = useState(EMPTY_BANK);
  const [notice, setNotice] = useState(null);
  const [includeInactive, setIncludeInactive] = useState(true);

  // Editing the catalogue changes the destination options offered to every
  // customer, so the server reserves writes for superadmins. Hide the controls
  // rather than letting a teller discover the refusal by clicking them.
  const canManage = session.admin?.role === 'superadmin';

  const banks = useAsync(() => adminApi.banks({ includeInactive }), [includeInactive]);

  const [execute, pending, actionError] = useAction((fn) => fn());

  const closeDialog = () => {
    setDialog(null);
    setForm(EMPTY_BANK);
  };

  const openCreate = () => {
    setForm(EMPTY_BANK);
    setDialog({ mode: 'create' });
  };

  const openEdit = (bank) => {
    setForm({
      name: bank.name,
      code: bank.code ?? '',
      country: bank.country ?? '',
      routingNumberLength: bank.routingNumberLength ?? '',
      supportsLocal: bank.supportsLocal,
      supportsInternational: bank.supportsInternational,
      supportsWire: bank.supportsWire,
      isActive: bank.isActive,
      reason: '',
    });
    setDialog({ mode: 'edit', id: bank.id });
  };

  const openDeactivate = (bank) => {
    setForm({ ...EMPTY_BANK, name: bank.name, reason: '' });
    setDialog({ mode: 'deactivate', id: bank.id, bank });
  };

  const submitCreate = async () => {
    const result = await execute(async () => {
      if (form.name.trim().length < 2) throw new Error('Enter the bank name.');
      const payload = {
        name: form.name.trim(),
        country: form.country.trim() || 'United States',
        supportsLocal: form.supportsLocal,
        supportsInternational: form.supportsInternational,
        supportsWire: form.supportsWire,
        isActive: form.isActive,
      };
      if (form.code.trim()) payload.code = form.code.trim();
      if (form.routingNumberLength) payload.routingNumberLength = Number(form.routingNumberLength);
      if (form.reason.trim()) payload.reason = form.reason.trim();
      return adminApi.createBank(payload);
    });
    if (!result) return;
    closeDialog();
    setNotice(result.message);
    banks.reload();
  };

  const submitEdit = async () => {
    const result = await execute(async () => {
      if (form.name.trim().length < 2) throw new Error('Enter the bank name.');
      const payload = {
        name: form.name.trim(),
        country: form.country.trim() || 'United States',
        supportsLocal: form.supportsLocal,
        supportsInternational: form.supportsInternational,
        supportsWire: form.supportsWire,
        isActive: form.isActive,
      };
      if (form.code.trim()) payload.code = form.code.trim();
      if (form.routingNumberLength) payload.routingNumberLength = Number(form.routingNumberLength);
      if (form.reason.trim()) payload.reason = form.reason.trim();
      return adminApi.updateBank(dialog.id, payload);
    });
    if (!result) return;
    closeDialog();
    setNotice(result.message);
    banks.reload();
  };

  const submitDeactivate = async () => {
    const result = await execute(async () => {
      if (!form.reason.trim()) throw new Error('Give a reason for retiring this bank.');
      return adminApi.deactivateBank(dialog.id, form.reason.trim());
    });
    if (!result) return;
    closeDialog();
    setNotice(result.message);
    banks.reload();
  };

  const columns = [
    { key: 'name', header: 'Bank', render: (row) => <span className="strong">{row.name}</span> },
    { key: 'code', header: 'Code', render: (row) => <span className="mono text-sm">{row.code || '—'}</span> },
    { key: 'country', header: 'Country' },
    {
      key: 'routingNumberLength',
      header: 'Routing digits',
      align: 'right',
      render: (row) => <span className="text-sm">{row.routingNumberLength ?? '—'}</span>,
    },
    {
      key: 'capabilities',
      header: 'Supports',
      render: (row) => (
        <span className="row wrap gap-1">
          {row.supportsLocal ? <span className="badge badge--info">Local</span> : null}
          {row.supportsInternational ? <span className="badge badge--info">Intl</span> : null}
          {row.supportsWire ? <span className="badge badge--info">Wire</span> : null}
        </span>
      ),
    },
    {
      key: 'isActive',
      header: 'Status',
      render: (row) => (
        <StatusBadge
          status={row.isActive ? 'active' : 'inactive'}
          label={row.isActive ? 'Available' : 'Retired'}
        />
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (row) =>
        canManage ? (
          <div className="row gap-2" style={{ justifyContent: 'flex-end' }}>
            <Button variant="secondary" size="sm" onClick={() => openEdit(row)}>
              Edit
            </Button>
            {row.isActive ? (
              <Button variant="ghost" size="sm" onClick={() => openDeactivate(row)}>
                Retire
              </Button>
            ) : null}
          </div>
        ) : null,
    },
  ];

  return (
    <AppShell variant="admin">
      <div className="container page">
        <PageHeader
          title="Bank catalogue"
          subtitle="Destination banks customers may choose when sending a transfer."
          actions={
            canManage ? (
              <Button variant="primary" icon={IconPlus} onClick={openCreate}>
                Add bank
              </Button>
            ) : null
          }
        />

        {notice ? <Alert tone="success">{notice}</Alert> : null}

        {!canManage ? (
          <Alert tone="info" title="Read-only">
            Only a superadmin can change the bank catalogue. You can review every entry, including
            retired banks.
          </Alert>
        ) : null}

        <AsyncBoundary loading={banks.loading} error={banks.error} onRetry={banks.reload}>
          <Card bodyClassName="p0">
            <div className="filter-bar" style={{ padding: 'var(--space-4) var(--space-5)', marginBottom: 0 }}>
              <label className="row gap-2 text-sm" style={{ cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={includeInactive}
                  onChange={(event) => setIncludeInactive(event.target.checked)}
                />
                Include retired banks
              </label>
            </div>

            <DataTable
              columns={columns}
              rows={banks.data?.banks ?? []}
              empty="No banks in the catalogue."
              fixed
            />
          </Card>

          <Alert tone="info" title="Retiring is not deleting">
            A retired bank disappears from the customer&#39;s destination list, but existing transfers
            and receipts keep the bank name they recorded at the time.
          </Alert>
        </AsyncBoundary>
      </div>

      {/* ---- Create / edit ---- */}
      <Modal
        open={dialog?.mode === 'create' || dialog?.mode === 'edit'}
        onClose={closeDialog}
        title={dialog?.mode === 'edit' ? 'Edit bank' : 'Add a bank'}
        footer={
          <>
            <Button variant="secondary" onClick={closeDialog} disabled={pending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={pending}
              onClick={dialog?.mode === 'edit' ? submitEdit : submitCreate}
            >
              {dialog?.mode === 'edit' ? 'Save changes' : 'Add bank'}
            </Button>
          </>
        }
      >
        {actionError ? <Alert tone="danger">{actionError.message}</Alert> : null}

        <TextField
          label="Bank name"
          required
          value={form.name}
          onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
          placeholder="e.g. Northbridge Bank"
        />
        <div className="grid-2">
          <TextField
            label="Short code"
            value={form.code}
            onChange={(event) => setForm((prev) => ({ ...prev, code: event.target.value }))}
            maxLength={20}
            hint="Optional routing code"
          />
          <TextField
            label="Country"
            required
            value={form.country}
            onChange={(event) => setForm((prev) => ({ ...prev, country: event.target.value }))}
          />
        </div>
        <TextField
          label="Routing number length"
          type="number"
          min={3}
          max={12}
          value={form.routingNumberLength}
          onChange={(event) => setForm((prev) => ({ ...prev, routingNumberLength: event.target.value }))}
          hint="Used to validate the routing number a customer enters. Leave blank if not applicable."
        />

        <fieldset className="fieldset mt-4">
          <legend className="fieldset__legend">Transfer types supported</legend>
          <div className="stack gap-2">
            {CAPABILITIES.map((capability) => (
              <label key={capability.key} className="row gap-2" style={{ cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={form[capability.key]}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, [capability.key]: event.target.checked }))
                  }
                />
                {capability.label}
              </label>
            ))}
          </div>
        </fieldset>

        <TextAreaField
          label="Reason (optional)"
          value={form.reason}
          onChange={(event) => setForm((prev) => ({ ...prev, reason: event.target.value }))}
          maxLength={240}
          placeholder="Recorded in the audit log"
        />
      </Modal>

      {/* ---- Retire ---- */}
      <Modal
        open={dialog?.mode === 'deactivate'}
        onClose={closeDialog}
        title="Retire this bank?"
        footer={
          <>
            <Button variant="secondary" onClick={closeDialog} disabled={pending}>
              Cancel
            </Button>
            <Button variant="danger" loading={pending} onClick={submitDeactivate}>
              Retire bank
            </Button>
          </>
        }
      >
        {actionError ? <Alert tone="danger">{actionError.message}</Alert> : null}
        <Alert tone="warning" title="Customers will no longer see this bank">
          <strong>{dialog?.bank?.name}</strong> will be hidden from the destination list in the
          customer transfer form. Existing transfers and issued receipts are unaffected.
        </Alert>
        <TextAreaField
          label="Reason"
          required
          value={form.reason}
          onChange={(event) => setForm((prev) => ({ ...prev, reason: event.target.value }))}
          maxLength={240}
          placeholder="e.g. Institution merged into another bank"
          hint="Recorded in the audit log"
        />
      </Modal>
    </AppShell>
  );
}

