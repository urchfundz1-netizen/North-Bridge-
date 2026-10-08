/**
 * Admin customer detail.
 *
 * One screen carrying everything a staff member needs about an account:
 * identity, balance, status controls, funding, adjustments, the full statement,
 * transfer history, and the funding record.
 *
 * Every action that changes money or access requires a typed reason, which the
 * server writes to the audit log alongside the staff member's identity.
 */

import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AppShell } from '../../components/Layout.jsx';
import {
  Alert,
  AsyncBoundary,
  Avatar,
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  DefinitionList,
  Modal,
  Pagination,
  StatusBadge,
  TextAreaField,
  TextField,
} from '../../components/ui.jsx';
import { LedgerRow } from '../../components/Transactions.jsx';
import { adminApi, parseAmount, parseSignedAmount, pageParams } from '../../api/client.js';
import { useAsync, useAction } from '../../lib/hooks.js';
import { statusConsequence } from '../../lib/account-status.js';
import { formatCents, formatDateTime, humanize } from '../../lib/format.js';
import {
  IconArrowLeft,
  IconCamera,
  IconInbox,
  IconLock,
  IconSparkle,
} from '../../components/icons.jsx';


const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp'];

const FUNDING_HISTORY_COLUMNS = [
  { key: 'createdAt', header: 'Date', render: (row) => <span className="text-sm">{formatDateTime(row.createdAt)}</span> },
  { key: 'description', header: 'Description', render: (row) => row.description || <span className="subtle">—</span> },
  { key: 'amountCents', header: 'Amount', align: 'right', render: (row) => <span className="positive strong">+{formatCents(row.amountCents)}</span> },
  { key: 'balanceAfterCents', header: 'Balance after', align: 'right', render: (row) => formatCents(row.balanceAfterCents) },
  { key: 'administeredBy', header: 'By', render: (row) => <span className="text-sm">{row.administeredBy ?? '—'}</span> },
  { key: 'reference', header: 'Reference', render: (row) => <span className="mono text-xs">{row.reference ?? '—'}</span> },
];

const TRANSFER_COLUMNS = [
  {
    key: 'recipientName',
    header: 'Recipient',
    render: (row) => (
      <div>
        <Link to={`/admin/transfers/${row.id}`} className="strong text-sm">
          {row.recipientName}
        </Link>
        <div className="text-xs subtle truncate">{row.recipientBank}</div>
      </div>
    ),
  },
  { key: 'referenceNumber', header: 'Reference', render: (row) => <span className="mono text-xs">{row.referenceNumber}</span> },
  { key: 'amountCents', header: 'Amount', align: 'right', render: (row) => formatCents(row.amountCents) },
  { key: 'feeCents', header: 'Fee', align: 'right', render: (row) => <span className="subtle">{formatCents(row.feeCents)}</span> },
  { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
  { key: 'requestedAt', header: 'Requested', align: 'right', render: (row) => <span className="text-sm subtle">{formatDateTime(row.requestedAt)}</span> },
];

export default function AdminCustomerDetailPage() {
  const { id } = useParams();
  const fileInputRef = useRef(null);

  const [tab, setTab] = useState('statement');
  const [page, setPage] = useState(1);
  const [notice, setNotice] = useState(null);

  const detail = useAsync(() => adminApi.customer(id), [id]);
  const customer = detail.data?.customer;

  const statement = useAsync(
    () => adminApi.customerTransactions(id, pageParams(page, 20)),
    [id, page],
    { enabled: tab === 'statement' },
  );

  const [dialog, setDialog] = useState(null);
  const [form, setForm] = useState({});


  /**
   * One action runner for every money-moving dialog. Validation lives *inside*
   * `execute` so a local failure and a server rejection surface through the same
   * error path, and the dialog stays open in both cases.
   */
  const [execute, pending, actionError, resetActionError] = useAction((fn) => fn());

  const closeDialog = () => {
    setDialog(null);
    setForm({});
    resetActionError();
  };

  /** Opening any dialog clears the previous failure, so it is never misread as
   *  belonging to the action now on screen. */
  const openDialog = (next, initial = {}) => {
    resetActionError();
    setForm(initial);
    setDialog(next);
  };

  /* ---- Funding ---- */
  const openFunding = () => {
    openDialog('fund', { amount: '', description: '', reference: '' });
  };

  const submitFunding = async () => {
    const result = await execute(async () => {
      const parsed = parseAmount(form.amount);
      if (!parsed) throw new Error('Enter a valid amount, for example 500.00.');
      return adminApi.fundAccount(id, {
        amount: parsed.value,
        description: form.description?.trim() || undefined,
        reference: form.reference?.trim() || undefined,
      });
    });
    if (!result) return;
    setDialog(null);
    setNotice(result.message);
    detail.reload();
    statement.reload();
  };

  /* ---- Adjustment ---- */
  const openAdjustment = () => {
    openDialog('adjust', { amount: '', reason: '' });
  };

  const submitAdjustment = async () => {
    const result = await execute(async () => {
      const parsed = parseSignedAmount(form.amount);
      if (!parsed) throw new Error('Enter a signed amount, for example -25.00 or 25.00.');
      if (!form.reason || form.reason.trim().length < 5) {
        throw new Error('Give a reason of at least 5 characters; it is recorded in the audit log.');
      }
      return adminApi.adjustBalance(id, { amount: parsed.value, reason: form.reason.trim() });
    });
    if (!result) return;
    setDialog(null);
    setNotice(result.message);
    detail.reload();
    statement.reload();
  };

  /* ---- Status ---- */
  const openStatus = (status) => {
    openDialog(`status:${status}`, { status, reason: '' });
  };

  const submitStatus = async () => {
    const result = await execute(async () => {
      if (!form.reason || form.reason.trim().length < 5) {
        throw new Error('Give a reason of at least 5 characters; it is recorded in the audit log.');
      }
      return adminApi.setStatus(id, form.status, form.reason.trim());
    });
    if (!result) return;
    setDialog(null);
    setNotice(result.message);
    detail.reload();
  };

  /* ---- Picture ---- */
  // The upload needs its own pending flag because `execute` is already reserved
  // for the money-moving dialogs, and the button that shows the spinner must not
  // share state with an open dialog.
  const [uploading, setUploading] = useState(false);

  const onPickPicture = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    const result = await execute(async () => {
      if (!ACCEPTED.includes(file.type)) throw new Error('Choose a JPG, PNG or WebP image.');
      if (file.size > MAX_IMAGE_BYTES) throw new Error('Images must be 2 MB or smaller.');
      setUploading(true);
      return adminApi.uploadPicture(Number(id), file);
    });
    setUploading(false);
    if (!result) return;
    setNotice(result.message);
    detail.reload();
  };

  const summary = detail.data?.summary;

  return (
    <AppShell variant="admin">
      <div className="container page">
        <Link to="/admin/customers" className="row gap-2 text-sm muted mb-3">
          <IconArrowLeft size={16} />
          All customers
        </Link>

        <AsyncBoundary loading={detail.loading} error={detail.error} onRetry={detail.reload}>
          {customer ? (
            <>
              {/* ---- Identity header ---- */}
              <header className="row wrap gap-5 mb-6">
                <Avatar src={customer.profilePicture} alt={customer.fullName} size="xl" />

                <div className="grow" style={{ minWidth: '220px' }}>
                  <div className="row wrap gap-3">
                    <h1 className="text-2xl">{customer.fullName}</h1>
                    <StatusBadge status={customer.status} />
                  </div>
                  <p className="muted mt-1">
                    <span className="mono">{customer.accountNumber}</span>
                    <span aria-hidden="true"> · </span>
                    {humanize(customer.accountType)} account
                    <span aria-hidden="true"> · </span>
                    opened {formatDateTime(customer.createdAt)}
                  </p>
                  {customer.email ? (
                    <p className="text-sm mt-1">
                      <a href={`mailto:${customer.email}`}>{customer.email}</a>
                      {customer.phone ? <span className="subtle"> · {customer.phone}</span> : null}
                    </p>
                  ) : null}
                </div>

                <div className="row gap-2 no-print">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept={ACCEPTED.join(',')}
                    onChange={onPickPicture}
                    className="visually-hidden"
                    id="admin-picture-input"
                  />
                  <Button
                    variant="secondary"
                    icon={IconCamera}
                    loading={uploading}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    Picture
                  </Button>
                  <Button variant="accent" icon={IconInbox} onClick={openFunding}>
                    Fund account
                  </Button>
                </div>
              </header>

              {notice ? <Alert tone="success">{notice}</Alert> : null}
              {actionError && !dialog ? <Alert tone="danger">{actionError.message}</Alert> : null}

              {customer.status !== 'active' && customer.statusReason ? (
                <Alert tone="warning" title={`Status is ${customer.status}`}>
                  {customer.statusReason}
                  {customer.statusChangedAt ? ` (since ${formatDateTime(customer.statusChangedAt)})` : ''}
                </Alert>
              ) : null}

              {customer.failedLoginAttempts > 0 || customer.lockedUntil ? (
                <Alert tone="warning" title="Sign-in attempts">
                  {customer.failedLoginAttempts} failed attempt
                  {customer.failedLoginAttempts === 1 ? '' : 's'} recorded
                  {customer.lockedUntil ? ` · locked until ${formatDateTime(customer.lockedUntil)}` : ''}.
                </Alert>
              ) : null}

              <div className="stat-grid mb-5">
                <div className="stat">
                  <span className="stat__label">Balance</span>
                  <span className="stat__value">{customer.balanceFormatted}</span>
                  <span className="stat__hint">Current available funds</span>
                </div>
                <div className="stat">
                  <span className="stat__label">Credited to date</span>
                  <span className="stat__value positive">{formatCents(summary?.creditedCents ?? 0, { compact: true })}</span>
                  <span className="stat__hint">All ledger credits</span>
                </div>
                <div className="stat">
                  <span className="stat__label">Debited to date</span>
                  <span className="stat__value negative">{formatCents(summary?.debitedCents ?? 0, { compact: true })}</span>
                  <span className="stat__hint">All ledger debits</span>
                </div>
                <div className="stat">
                  <span className="stat__label">Last sign-in</span>
                  <span className="stat__value" style={{ fontSize: 'var(--text-md)' }}>
                    {customer.lastLoginAt ? formatDateTime(customer.lastLoginAt) : 'Never'}
                  </span>
                  <span className="stat__hint">Successful session</span>
                </div>
              </div>

              <div className="admin-two-column">
                <div className="stack gap-5">
                  {/* ---- Statement ---- */}
                  <Card
                    title="Statement"
                    subtitle={`${summary?.entryCount ?? 0} entries`}
                    actions={
                      <div className="row gap-1">
                        <TabButton active={tab === 'statement'} onClick={() => setTab('statement')}>
                          Entries
                        </TabButton>
                        <TabButton active={tab === 'transfers'} onClick={() => setTab('transfers')}>
                          Transfers
                        </TabButton>
                        <TabButton active={tab === 'funding'} onClick={() => setTab('funding')}>
                          Funding
                        </TabButton>
                      </div>
                    }
                    bodyClassName={tab === 'statement' ? 'p0' : undefined}
                  >
                    {tab === 'statement' ? (
                      statement.loading ? (
                        <div className="loading-block">
                          <span className="spinner" aria-hidden="true" />
                          <span>Loading statement…</span>
                        </div>
                      ) : statement.error ? (
                        <div style={{ padding: 'var(--space-5)' }}>
                          <Alert tone="danger">{statement.error.message}</Alert>
                        </div>
                      ) : (statement.data?.items ?? []).length === 0 ? (
                        <div className="empty-state">
                          <p className="strong" style={{ color: 'var(--ink-800)' }}>
                            No ledger entries yet
                          </p>
                          <p className="text-sm mt-1">Fund the account to create the first deposit.</p>
                        </div>
                      ) : (
                        <>
                          <div className="txn-list">
                            {statement.data.items.map((entry) => (
                              <LedgerRow key={entry.id} entry={entry} />
                            ))}
                          </div>
                          <Pagination
                            page={statement.data.page}
                            totalPages={statement.data.totalPages}
                            total={statement.data.total}
                            pageSize={20}
                            onPageChange={setPage}
                          />
                        </>
                      )
                    ) : null}

                    {tab === 'transfers' ? (
                      <DataTable
                        columns={TRANSFER_COLUMNS}
                        rows={detail.data?.transfers ?? []}
                        empty="This customer has not submitted any transfers."
                      />
                    ) : null}

                    {tab === 'funding' ? (
                      <DataTable
                        columns={FUNDING_HISTORY_COLUMNS}
                        rows={detail.data?.fundingHistory ?? []}
                        empty="No deposits have been issued to this account."
                      />
                    ) : null}
                  </Card>
                </div>

                {/* ---- Controls ---- */}
                <div className="stack gap-5">
                  <Card title="Record">
                    <DefinitionList
                      items={[
                        { label: 'Date of birth', value: formatDateTime(customer.dateOfBirth).split(',')[0] },
                        {
                          label: 'Address',
                          value: [
                            customer.address?.line1,
                            customer.address?.line2,
                            customer.address?.city,
                            customer.address?.stateRegion,
                            customer.address?.postalCode,
                            customer.address?.country,
                          ]
                            .filter(Boolean)
                            .join(', '),
                        },
                        { label: 'Transfer PIN locked until', value: customer.transferPinLockedUntil ? formatDateTime(customer.transferPinLockedUntil) : '—' },
                        { label: 'Record updated', value: formatDateTime(customer.updatedAt) },
                      ]}
                    />
                  </Card>

                  <Card title="Account controls" subtitle="Every change requires a reason">
                    <div className="stack gap-2">
                      {customer.status === 'active' ? (
                        <Button variant="secondary" onClick={() => openStatus('frozen')} icon={IconLock}>
                          Freeze account
                        </Button>
                      ) : null}
                      {customer.status !== 'active' ? (
                        <Button variant="accent" onClick={() => openStatus('active')} icon={IconSparkle}>
                          Reactivate account
                        </Button>
                      ) : null}
                      {customer.status !== 'locked' ? (
                        <Button variant="secondary" onClick={() => openStatus('locked')}>
                          Lock sign-in
                        </Button>
                      ) : null}
                      {customer.status !== 'disabled' ? (
                        <Button variant="secondary" onClick={() => openStatus('disabled')}>
                          Disable account
                        </Button>
                      ) : null}
                      <Button variant="danger" onClick={openAdjustment}>
                        Adjust balance
                      </Button>
                    </div>
                    <p className="text-xs subtle mt-4">
                      Frozen accounts can still sign in and view balances but cannot send money.
                      Locked and disabled accounts cannot sign in at all.
                    </p>
                  </Card>
                </div>
              </div>
            </>
          ) : null}
        </AsyncBoundary>
      </div>

      {/* ---- Funding dialog ---- */}
      <Modal
        open={dialog === 'fund'}
        onClose={closeDialog}
        title="Fund this account"
        subtitle={customer ? `${customer.fullName} · ${customer.accountNumber}` : undefined}
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
        {actionError ? <Alert tone="danger">{actionError.message}</Alert> : null}
        <TextField
          label="Amount"
          required
          inputMode="decimal"
          placeholder="0.00"
          value={form.amount ?? ''}
          onChange={(event) => setForm((prev) => ({ ...prev, amount: event.target.value }))}
          hint={
            customer
              ? `New balance would be ${formatCents(customer.balanceCents + (parseAmount(form.amount)?.cents ?? 0))}.`
              : undefined
          }
        />
        <TextField
          label="Description"
          value={form.description ?? ''}
          onChange={(event) => setForm((prev) => ({ ...prev, description: event.target.value }))}
          maxLength={240}
          placeholder="e.g. Opening deposit"
          hint="Shown on the customer's statement"
        />
        <TextField
          label="External reference"
          value={form.reference ?? ''}
          onChange={(event) => setForm((prev) => ({ ...prev, reference: event.target.value }))}
          maxLength={64}
          placeholder="Optional cheque or wire reference"
        />
      </Modal>

      {/* ---- Adjustment dialog ---- */}
      <Modal
        open={dialog === 'adjust'}
        onClose={closeDialog}
        title="Adjust balance"
        subtitle="Use a negative amount to deduct, positive to credit."
        footer={
          <>
            <Button variant="secondary" onClick={closeDialog} disabled={pending}>
              Cancel
            </Button>
            <Button variant="danger" onClick={submitAdjustment} loading={pending}>
              Apply adjustment
            </Button>
          </>
        }
      >
        {actionError ? <Alert tone="danger">{actionError.message}</Alert> : null}
        <Alert tone="warning" title="This moves money">
          An adjustment is not a transfer: no receipt is issued and the customer&#39;s transfer limits do
          not apply. Use funding for deposits.
        </Alert>
        <TextField
          label="Amount"
          required
          inputMode="decimal"
          placeholder="-25.00"
          value={form.amount ?? ''}
          onChange={(event) => setForm((prev) => ({ ...prev, amount: event.target.value }))}
          hint={
            customer && parseSignedAmount(form.amount)
              ? `New balance would be ${formatCents(customer.balanceCents + parseSignedAmount(form.amount).cents)}.`
              : 'Prefix with - to deduct'
          }
        />
        <TextAreaField
          label="Reason"
          required
          value={form.reason ?? ''}
          onChange={(event) => setForm((prev) => ({ ...prev, reason: event.target.value }))}
          maxLength={240}
          placeholder="e.g. Reversal of a duplicate funding entry"
          hint="Recorded in the audit log"
        />
      </Modal>

      {/* ---- Status dialog ---- */}
      <ConfirmDialog
        open={typeof dialog === 'string' && dialog.startsWith('status:')}
        onClose={closeDialog}
        onConfirm={submitStatus}
        loading={pending}
        requireReason
        reason={form.reason ?? ''}
        onReasonChange={(value) => setForm((prev) => ({ ...prev, reason: value }))}
        reasonLabel="Reason for this change"
        title={`Change status to ${dialog?.split(':')[1] ?? ''}`}
        confirmLabel="Apply change"
        variant={dialog === 'status:active' ? 'accent' : 'danger'}
        message={statusMessage(customer, dialog?.split(':')[1])}
      >
        {actionError ? <Alert tone="danger">{actionError.message}</Alert> : null}
      </ConfirmDialog>
    </AppShell>
  );
}

function TabButton({ active, onClick, children }) {
  return (
    <button
      type="button"
      className={`btn btn--sm ${active ? 'btn--primary' : 'btn--secondary'}`}
      onClick={onClick}
      aria-pressed={active}
    >
      {children}
    </button>
  );
}

function statusMessage(customer, status) {
  return statusConsequence(customer?.fullName, status);
}

