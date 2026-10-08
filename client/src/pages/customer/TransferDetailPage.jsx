/**
 * Transfer detail.
 *
 * Shows the full lifecycle of one transfer and, where one exists, its receipt.
 * The status banner is the point of the page: "pending" means no money has left
 * the account, and cancelling is offered only while that is true.
 *
 * A pending transfer renders a provisional confirmation rather than nothing, so
 * the customer has a document from the moment they submit. Only a settled
 * transfer gets a numbered receipt.
 */

import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AppShell } from '../../components/Layout.jsx';
import {
  Alert,
  AsyncBoundary,
  Button,
  Card,
  ConfirmDialog,
  DefinitionList,
  StatusBadge,
} from '../../components/ui.jsx';
import { Receipt } from '../../components/Receipt.jsx';
import { customerApi } from '../../api/client.js';
import { useAsync, useAction } from '../../lib/hooks.js';
import { IconArrowLeft, IconReceipt } from '../../components/icons.jsx';

const STATUS_EXPLAINER = {
  pending: {
    tone: 'info',
    title: 'Awaiting review',
    body: 'No money has left your account. Northbridge approves every transfer before it settles, and you can withdraw it at any time until then.',
  },
  approved: {
    tone: 'success',
    title: 'Settled',
    body: 'This transfer has been approved and the funds have been debited. Your receipt below now records the settlement.',
  },
  rejected: {
    tone: 'danger',
    title: 'Rejected',
    body: 'This transfer was declined during review. Your balance is unchanged and the reason is recorded on your receipt.',
  },
  cancelled: {
    tone: 'neutral',
    title: 'Cancelled',
    body: 'You withdrew this transfer before it was reviewed. No money moved. Your receipt below has been updated to show the cancellation.',
  },
};

export default function TransferDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [notice, setNotice] = useState(null);

  const transfer = useAsync(() => customerApi.transfer(id), [id]);
  const row = transfer.data?.transfer;

  const [cancel, cancelling, cancelError] = useAction(customerApi.cancelTransfer);

  /*
   * Every transfer has a receipt from the moment it was submitted, so this no
   * longer waits for settlement. Keyed on the status so that when an
   * administrator approves the transfer the document is refetched and the
   * customer sees the same receipt number move from Pending to Approved.
   */
  const receipt = useAsync(() => customerApi.receipt(id), [id, row?.status], { enabled: Boolean(row) });

  const explainer = row ? STATUS_EXPLAINER[row.status] : null;
  const canCancel = row?.status === 'pending';

  const confirmCancel = async () => {
    const result = await cancel(Number(id));
    setConfirmingCancel(false);
    if (!result) return;
    setNotice(result.message);
    transfer.reload();
  };

  return (
    <AppShell variant="customer">
      <div className="container page" style={{ maxWidth: 820 }}>
        <Link to="/transfers" className="row gap-2 text-sm muted mb-3">
          <IconArrowLeft size={16} />
          All transfers
        </Link>

        <AsyncBoundary loading={transfer.loading} error={transfer.error} onRetry={transfer.reload}>
          {row ? (
            <>
              <header className="row wrap gap-4 mb-6">
                <div className="grow">
                  <div className="row gap-3">
                    <h1 className="text-2xl">{row.recipient?.name}</h1>
                    <StatusBadge status={row.status} label={row.statusLabel} />
                  </div>
                  <p className="muted mt-1">
                    <span className="mono">{row.referenceNumber}</span>
                    <span aria-hidden="true"> · </span>
                    {row.transferTypeLabel}
                  </p>
                </div>
                <div className="text-right">
                  <div className="text-xs muted uppercase" style={{ letterSpacing: '0.08em' }}>
                    Amount
                  </div>
                  <div className="text-2xl bold">{row.amountFormatted}</div>
                </div>
              </header>

              {notice ? (
                <Alert tone="success" title="Transfer cancelled">
                  {notice}
                </Alert>
              ) : null}

              {explainer ? (
                <Alert tone={explainer.tone} title={explainer.title}>
                  {explainer.body}
                  {row.status === 'rejected' && row.rejectionReason ? (
                    <>
                      {' '}
                      <strong>Reason given:</strong> {row.rejectionReason}
                    </>
                  ) : null}
                </Alert>
              ) : null}

              {cancelError ? <Alert tone="danger">{cancelError.message}</Alert> : null}

              <div className="stack gap-5">
                <Card title="Transfer summary">
                  <DefinitionList
                    columns={2}
                    items={[
                      { label: 'Recipient', value: row.recipient?.name },
                      { label: 'Recipient account', value: <span className="mono">{row.recipient?.accountNumber}</span> },
                      { label: 'Destination bank', value: row.recipient?.bank },
                      { label: 'Transfer type', value: row.transferTypeLabel },
                      row.recipient?.routingNumber
                        ? { label: 'Routing number', value: <span className="mono">{row.recipient.routingNumber}</span> }
                        : null,
                      row.recipient?.swiftBic
                        ? { label: 'SWIFT / BIC', value: <span className="mono">{row.recipient.swiftBic}</span> }
                        : null,
                      row.recipient?.iban ? { label: 'IBAN', value: <span className="mono">{row.recipient.iban}</span> } : null,
                      { label: 'Description', value: row.description || '—' },
                    ]}
                  />

                  <div className="receipt__totals mt-4">
                    <div className="receipt__total-row">
                      <span className="muted">Transfer amount</span>
                      <span>{row.amountFormatted}</span>
                    </div>
                    <div className="receipt__total-row">
                      <span className="muted">Processing fee</span>
                      <span>{row.feeFormatted}</span>
                    </div>
                    <div className="receipt__total-row receipt__total-row--grand">
                      <span>Total debited</span>
                      <span>{row.totalDebitFormatted}</span>
                    </div>
                  </div>
                </Card>

                <Card title="Timeline">
                  <DefinitionList
                    columns={2}
                    items={[
                      { label: 'Submitted', value: stamp(row.requestedAt) },
                      { label: 'Reviewed', value: stamp(row.reviewedAt) },
                      { label: 'Settled', value: stamp(row.settledAt) },
                      { label: 'Cancelled', value: stamp(row.cancelledAt) },
                      row.receiptNumber ? { label: 'Receipt number', value: <span className="mono">{row.receiptNumber}</span> } : null,
                      row.reviewNote ? { label: 'Review note', value: row.reviewNote } : null,
                    ]}
                  />
                </Card>

                {/* ---- Receipt ----
                    Rendered for every status. The document exists from submit
                    time and carries its own status, so there is no separate
                    "confirmation" component to keep in step with this one. */}
                {receipt.loading ? (
                  <Card title="Receipt">
                    <div className="loading-block">
                      <span className="spinner" aria-hidden="true" />
                      <span>Preparing your receipt…</span>
                    </div>
                  </Card>
                ) : receipt.data?.receipt ? (
                  <div>
                    <div className="row gap-3 mb-3">
                      <IconReceipt size={20} className="muted" />
                      <h2 className="text-lg">Receipt</h2>
                    </div>
                    <Receipt receipt={receipt.data.receipt} />
                  </div>
                ) : receipt.error ? (
                  <Alert tone="warning" title="Receipt unavailable">
                    {receipt.error.message}
                  </Alert>
                ) : null}

                {canCancel ? (
                  <div className="row gap-2 no-print">
                    <Button
                      variant="secondary"
                      onClick={() => setConfirmingCancel(true)}
                    >
                      Cancel this transfer
                    </Button>
                    <Button variant="ghost" onClick={() => navigate('/transfer')}>
                      Send another
                    </Button>
                  </div>
                ) : null}
              </div>
            </>
          ) : null}
        </AsyncBoundary>
      </div>

      <ConfirmDialog
        open={confirmingCancel}
        onClose={() => setConfirmingCancel(false)}
        onConfirm={confirmCancel}
        loading={cancelling}
        title="Cancel this transfer?"
        confirmLabel="Cancel transfer"
        variant="danger"
        message={`Transfer ${row?.referenceNumber} to ${row?.recipient?.name} will be withdrawn. This cannot be undone.`}
      />
    </AppShell>
  );
}

function stamp(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

