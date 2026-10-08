/**
 * Admin customer list.
 *
 * Server-side search and filters, so the table stays responsive as the
 * customer base grows. The search box is debounced locally rather than pushed
 * through the URL, matching the customer transfer list.
 *
 * Status changes and funding are available straight from a row. An
 * administrator triaging a list should not have to open each customer to stop
 * a payment or credit an account, but both actions are irreversible enough to
 * need a reason and a confirmation, so the row opens the same dialogs the
 * detail screen uses rather than acting immediately.
 */

import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AppShell } from '../../components/Layout.jsx';
import {
  Alert,
  AsyncBoundary,
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  ErrorNotice,
  LinkButton,
  Modal,
  PageHeader,
  Pagination,
  SelectField,
  StatusBadge,
  TextField,
} from '../../components/ui.jsx';
import { adminApi, pageParams, parseAmount } from '../../api/client.js';
import { useAction, useAsync, useDebounced } from '../../lib/hooks.js';
import { availableStatusActions, findStatusTarget, statusConsequence } from '../../lib/account-status.js';
import { formatCents, formatDateTime } from '../../lib/format.js';
import {
  IconInbox,
  IconPlus,
  IconSearch,
  IconSettings,
  IconUsers,
} from '../../components/icons.jsx';

const PAGE_SIZES = [20, 50, 100];

const STATUS_FILTERS = [
  { value: 'all', label: 'All statuses' },
  { value: 'active', label: 'Active' },
  { value: 'frozen', label: 'Frozen' },
  { value: 'locked', label: 'Locked' },
  { value: 'disabled', label: 'Disabled' },
];

const TYPE_FILTERS = [
  { value: 'all', label: 'All types' },
  { value: 'checking', label: 'Checking' },
  { value: 'savings', label: 'Savings' },
  { value: 'premium', label: 'Premium' },
];

const COLUMNS = [
  {
    key: 'fullName',
    header: 'Customer',
    render: (row) => (
      <div>
        <Link to={`/admin/customers/${row.id}`} className="strong">
          {row.fullName}
        </Link>
        <div className="text-xs subtle">{row.email}</div>
      </div>
    ),
  },
  {
    key: 'accountNumber',
    header: 'Account',
    render: (row) => <span className="mono text-sm">{row.accountNumber}</span>,
  },
  {
    key: 'accountType',
    header: 'Type',
    render: (row) => <span className="text-sm">{row.accountType}</span>,
  },
  { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
  {
    key: 'balanceCents',
    header: 'Balance',
    align: 'right',
    render: (row) => <span className="strong">{formatCents(row.balanceCents)}</span>,
  },
  {
    key: 'lastLoginAt',
    header: 'Last sign-in',
    align: 'right',
    render: (row) => (
      <span className="text-sm subtle">{row.lastLoginAt ? formatDateTime(row.lastLoginAt) : 'Never'}</span>
    ),
  },
];

export default function AdminCustomersPage() {
  const [params, setParams] = useSearchParams();
  const [limit, setLimit] = useState(Number(params.get('limit')) || 20);
  const [searchDraft, setSearchDraft] = useState(params.get('search') ?? '');
  const search = useDebounced(searchDraft, 350);

  const page = Math.max(1, Number(params.get('page')) || 1);
  const status = params.get('status') ?? 'all';
  const accountType = params.get('type') ?? 'all';

  /* ---- Row actions ---- */

  // `dialog` is a single value rather than several booleans so only one panel
  // can ever be open: {kind:'menu'|'status'|'fund', customer, ...}.
  const [dialog, setDialog] = useState(null);
  const [form, setForm] = useState({});
  const [notice, setNotice] = useState(null);
  const [run, pending, actionError, resetError] = useAction(async (fn) => fn());

  const openDialog = (next, initialForm = {}) => {
    resetError();
    setForm(initialForm);
    setDialog(next);
  };

  const closeDialog = () => {
    setDialog(null);
    resetError();
  };

  const customers = useAsync(
    () => adminApi.customers({ status, accountType, search, ...pageParams(page, limit) }),
    [status, accountType, search, page, limit],
  );

  const submitStatus = async () => {
    const result = await run(async () => {
      if ((form.reason ?? '').trim().length < 5) {
        throw new Error('Give a reason of at least 5 characters; it is recorded in the audit log.');
      }
      return adminApi.setStatus(dialog.customer.id, dialog.status, form.reason.trim());
    });
    if (!result) return;
    closeDialog();
    setNotice(result.message);
    customers.reload();
  };

  const submitFunding = async () => {
    const result = await run(async () => {
      const parsed = parseAmount(form.amount);
      if (!parsed) throw new Error('Enter a valid amount, for example 500.00.');
      return adminApi.fundAccount(dialog.customer.id, {
        amount: parsed.value,
        description: form.description?.trim() || undefined,
        reference: form.reference?.trim() || undefined,
      });
    });
    if (!result) return;
    closeDialog();
    setNotice(result.message);
    customers.reload();
  };

  // Built here rather than at module scope because the actions column needs the
  // dialog opener.
  const columns = [
    ...COLUMNS,
    {
      key: 'actions',
      header: 'Actions',
      width: '1%',
      render: (row) => (
        <Button
          variant="secondary"
          size="sm"
          icon={IconSettings}
          // Labelled per row: twenty identical "Manage" buttons would give a
          // screen reader nothing to tell apart.
          aria-label={`Manage account ${row.accountNumber}`}
          onClick={() => openDialog({ kind: 'menu', customer: row })}
        >
          Manage
        </Button>
      ),
    },
  ];

  const setParam = (key, value) => {
    const next = new URLSearchParams(params);
    if (!value || value === 'all') next.delete(key);
    else next.set(key, String(value));
    if (key !== 'page') next.delete('page');
    setParams(next, { replace: true });
  };

  return (
    <AppShell variant="admin">
      <div className="container page">
        <PageHeader
          title="Customers"
          subtitle="Search, review and manage every account on the platform."
          actions={
            <LinkButton to="/admin/customers/new" variant="primary" icon={IconPlus}>
              New account
            </LinkButton>
          }
        />

        {notice ? (
          <Alert tone="success" className="mb-4">
            {notice}
          </Alert>
        ) : null}

        <AsyncBoundary loading={customers.loading} error={customers.error} onRetry={customers.reload}>
          <Card bodyClassName="p0">
            <div className="filter-bar" style={{ padding: 'var(--space-4) var(--space-5)', marginBottom: 0 }}>
              <div className="search-field">
                <IconSearch size={16} className="search-field__icon" />
                <input
                  className="input"
                  type="search"
                  value={searchDraft}
                  onChange={(event) => setSearchDraft(event.target.value)}
                  placeholder="Name, email or account number"
                  aria-label="Search customers"
                />
              </div>

              <SelectField
                label=""
                aria-label="Filter by status"
                value={status}
                onChange={(event) => setParam('status', event.target.value)}
                options={STATUS_FILTERS}
                className="mb-0"
              />

              <SelectField
                label=""
                aria-label="Filter by account type"
                value={accountType}
                onChange={(event) => setParam('type', event.target.value)}
                options={TYPE_FILTERS}
                className="mb-0"
              />
            </div>

            <DataTable
              columns={columns}
              rows={customers.data?.items ?? []}
              empty="No customers match these filters."
              footer={
                <Pagination
                  page={customers.data?.page ?? 1}
                  totalPages={customers.data?.totalPages ?? 1}
                  total={customers.data?.total}
                  pageSize={limit}
                  pageSizeOptions={PAGE_SIZES}
                  onPageSizeChange={(next) => {
                    setLimit(next);
                    setParam('limit', next);
                  }}
                  onPageChange={(next) => setParam('page', next)}
                />
              }
            />
          </Card>

          <p className="text-xs subtle mt-4 row gap-2">
            <IconUsers size={14} />
            {customers.data?.total ?? 0} account{customers.data?.total === 1 ? '' : 's'} on file.
            Use <strong>Manage</strong> on a row to fund an account or change its status, or open a customer
            to review their full statement.
          </p>
        </AsyncBoundary>
      </div>

      {/* ---- Action menu: opened from a row ---- */}
      <Modal
        open={dialog?.kind === 'menu'}
        onClose={closeDialog}
        title={dialog?.customer?.fullName ?? 'Manage account'}
        subtitle={
          dialog?.customer
            ? `${dialog.customer.accountNumber} · ${formatCents(dialog.customer.balanceCents)}`
            : undefined
        }
      >
        <div className="stack gap-5">
          <div>
            <h3 className="text-sm strong">Move money</h3>
            <p className="text-xs subtle mt-1 mb-3">
              Credits the balance and writes a matching entry to the customer&#39;s statement.
            </p>
            <Button
              variant="primary"
              icon={IconInbox}
              onClick={() =>
                openDialog({ kind: 'fund', customer: dialog.customer }, { amount: '', description: '', reference: '' })
              }
            >
              Fund this account
            </Button>
          </div>

          <div>
            <h3 className="text-sm strong">Account status</h3>
            <p className="text-xs subtle mt-1 mb-3">
              Currently {dialog?.customer?.status}. Every change needs a reason and is written to the
              audit log.
            </p>
            <div className="stack gap-2">
              {availableStatusActions(dialog?.customer?.status).map((action) => (
                <Button
                  key={action.status}
                  variant={action.tone}
                  onClick={() =>
                    openDialog({ kind: 'status', customer: dialog.customer, status: action.status }, { reason: '' })
                  }
                >
                  {action.label}
                </Button>
              ))}
            </div>
          </div>

          <div className="row gap-2">
            <Link to={`/admin/customers/${dialog?.customer?.id}`} className="btn btn--ghost">
              Open full profile
            </Link>
          </div>
        </div>
      </Modal>

      {/* ---- Status confirmation ---- */}
      <ConfirmDialog
        open={dialog?.kind === 'status'}
        onClose={closeDialog}
        onConfirm={submitStatus}
        loading={pending}
        requireReason
        reason={form.reason ?? ''}
        onReasonChange={(value) => setForm((prev) => ({ ...prev, reason: value }))}
        reasonLabel="Reason for this change"
        title={`Change status to ${dialog?.status ?? ''}`}
        confirmLabel="Apply change"
        variant={findStatusTarget(dialog?.status)?.tone ?? 'danger'}
        message={statusConsequence(dialog?.customer?.fullName, dialog?.status)}
      >
        {actionError ? <ErrorNotice error={actionError} /> : null}
      </ConfirmDialog>

      {/* ---- Funding ---- */}
      <Modal
        open={dialog?.kind === 'fund'}
        onClose={closeDialog}
        title="Fund this account"
        subtitle={
          dialog?.customer
            ? `${dialog.customer.fullName} · ${dialog.customer.accountNumber}`
            : undefined
        }
        footer={
          <>
            <Button variant="secondary" onClick={closeDialog} disabled={pending}>
              Cancel
            </Button>
            <Button variant="accent" onClick={submitFunding} loading={pending} icon={IconInbox}>
              Deposit funds
            </Button>
          </>
        }
      >
        {actionError ? <ErrorNotice error={actionError} /> : null}
        <TextField
          label="Amount"
          required
          inputMode="decimal"
          placeholder="0.00"
          value={form.amount ?? ''}
          onChange={(event) => setForm((prev) => ({ ...prev, amount: event.target.value }))}
          hint={
            dialog?.customer
              ? `New balance would be ${formatCents(dialog.customer.balanceCents + (parseAmount(form.amount)?.cents ?? 0))}.`
              : undefined
          }
        />
        <TextField
          label="Description"
          value={form.description ?? ''}
          onChange={(event) => setForm((prev) => ({ ...prev, description: event.target.value }))}
          maxLength={240}
          placeholder="e.g. Opening deposit"
          hint="Shown on the customer&#39;s statement"
        />
        <TextField
          label="External reference"
          value={form.reference ?? ''}
          onChange={(event) => setForm((prev) => ({ ...prev, reference: event.target.value }))}
          maxLength={64}
          placeholder="Optional cheque or wire reference"
        />
      </Modal>
    </AppShell>
  );
}
