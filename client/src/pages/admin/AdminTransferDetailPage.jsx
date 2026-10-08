/**
 * Admin transfer review screen.
 *
 * Where approval and rejection happen. The customer's balance is shown alongside
 * the transfer so an approver can see immediately whether the funds will be
 * available, and both actions require a typed reason or note that is written to
 * the audit log.
 */

import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AppShell } from '../../components/Layout.jsx';
import {
  Alert,
  AsyncBoundary,
  Avatar,
  Button,
  Card,
  ConfirmDialog,
  DefinitionList,
  StatusBadge,
  TextAreaField,
} from '../../components/ui.jsx';
import { Receipt } from '../../components/Receipt.jsx';
import { adminApi } from '../../api/client.js';
import { useAsync, useAction } from '../../lib/hooks.js';
import { formatDateTime } from '../../lib/format.js';
import { IconArrowLeft, IconCheck, IconReceipt, IconX } from '../../components/icons.jsx';

export default function AdminTransferDetailPage() {
  const { id } = useParams();
  const [dialog, setDialog] = useState(null);
  const [note, setNote] = useState('');
  const [outcome, setOutcome] = useState(null);

  const detail = useAsync(() => adminApi.transfer(id), [id]);
  const transfer = detail.data?.transfer;

  const [approve, approving, approveError] = useAction(adminApi.approveTransfer);
  const [reject, rejecting, rejectError] = useAction(adminApi.rejectTransfer);

  const reload = () => {
    detail.reload();
    setOutcome(null);
  };

  const confirmApprove = async () => {
    const result = await approve(Number(id), note.trim() || undefined);
    setDialog(null);
    if (!result) return;
    setNote('');
    setOutcome({ tone: 'success', title: 'Approved', message: result.message, receipt: result.receipt });
    reload();
  };

  const confirmReject = async () => {
    const result = await reject(Number(id), note.trim() || undefined);
    setDialog(null);
    if (!result) return;
    setNote('');
    setOutcome({
      tone: result.transfer.status === 'rejected' ? 'info' : 'warning',
      title: 'Rejected',
      message: result.message,
    });
    reload();
  };

  const isPending = transfer?.status === 'pending';

  return (
    <AppShell variant="admin">
      <div className="container page" style={{ maxWidth: 860 }}>
        <Link to="/admin/transfers" className="row gap-2 text-sm muted mb-3">
          <IconArrowLeft size={16} />
          Review queue
        </Link>

        <AsyncBoundary loading={detail.loading} error={detail.error} onRetry={detail.reload}>
          {transfer ? (
            <>
              <header className="row wrap gap-4 mb-6">
                <div className="grow">
                  <div className="row wrap gap-3">
                    <h1 className="text-2xl">{transfer.amountFormatted}</h1>
                    <StatusBadge status={transfer.status} label={transfer.statusLabel} />
                  </div>
                  <p className="muted mt-1">
                    <span className="mono">{transfer.referenceNumber}</span>
                    <span aria-hidden="true"> · </span>
                    {transfer.transferTypeLabel}
                    <span aria-hidden="true"> · </span>
                    requested {formatDateTime(transfer.requestedAt)}
                  </p>
                </div>

                {isPending ? (
                  <div className="row gap-2 no-print">
                    <Button variant="secondary" icon={IconX} onClick={() => setDialog('reject')}>
                      Reject
                    </Button>
                    <Button variant="accent" icon={IconCheck} onClick={() => setDialog('approve')}>
                      Approve & settle
                    </Button>
                  </div>
                ) : null}
              </header>

              {outcome ? (
                <Alert tone={outcome.tone} title={outcome.title}>
                  {outcome.message}
                </Alert>
              ) : null}
              {approveError ? <Alert tone="danger">{approveError.message}</Alert> : null}
              {rejectError ? <Alert tone="danger">{rejectError.message}</Alert> : null}

              {isPending ? (
                <Alert tone="info" title="Funds have not moved yet">
                  Approving debits the customer&#39;s account, credits the destination and issues a
                  receipt in one transaction. Rejecting leaves the balance untouched and requires a
                  reason.
                </Alert>
              ) : null}

              {transfer.status === 'approved' ? (
                <Alert tone="success" title="Settled">
                  This transfer has been approved. The receipt below is a frozen snapshot of the
                  settlement.
                </Alert>
              ) : null}

              <div className="stack gap-5">
                {/* ---- Customer ---- */}
                {transfer.customer ? (
                  <Card title="Customer">
                    <div className="row gap-4">
                      <Avatar name={transfer.customer.name} alt={transfer.customer.name} size="lg" />
                      <div className="grow" style={{ minWidth: 0 }}>
                        <Link to={`/admin/customers/${transfer.customer.id}`} className="strong">
                          {transfer.customer.name}
                        </Link>
                        <div className="text-sm muted">{transfer.customer.email}</div>
                        <div className="mt-2">
                          <StatusBadge status={transfer.customer.status} />
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="datalist__label">Account</div>
                        <div className="mono">{transfer.customer.accountNumber}</div>
                      </div>
                    </div>
                  </Card>
                ) : null}

                {/* ---- Recipient & amounts ---- */}
                <div className="admin-two-column">
                  <Card title="Recipient">
                    <DefinitionList
                      items={[
                        { label: 'Name', value: transfer.recipient?.name },
                        { label: 'Account number', value: <span className="mono">{transfer.recipient?.accountNumber}</span> },
                        { label: 'Bank', value: transfer.recipient?.bank },
                        { label: 'Transfer type', value: transfer.transferTypeLabel },
                        transfer.recipient?.routingNumber
                          ? { label: 'Routing number', value: <span className="mono">{transfer.recipient.routingNumber}</span> }
                          : null,
                        transfer.recipient?.swiftBic
                          ? { label: 'SWIFT / BIC', value: <span className="mono">{transfer.recipient.swiftBic}</span> }
                          : null,
                        transfer.recipient?.iban
                          ? { label: 'IBAN', value: <span className="mono">{transfer.recipient.iban}</span> }
                          : null,
                        { label: 'Description', value: transfer.description || '—' },
                      ]}
                    />
                  </Card>

                  <Card title="Amounts">
                    <div className="receipt__totals">
                      <div className="receipt__total-row">
                        <span className="muted">Transfer amount</span>
                        <span>{transfer.amountFormatted}</span>
                      </div>
                      <div className="receipt__total-row">
                        <span className="muted">Processing fee</span>
                        <span>{transfer.feeFormatted}</span>
                      </div>
                      <div className="receipt__total-row receipt__total-row--grand">
                        <span>Total to debit</span>
                        <span>{transfer.totalDebitFormatted}</span>
                      </div>
                    </div>

                    <div className="divider" />

                    <DefinitionList
                      items={[
                        { label: 'Submitted', value: formatDateTime(transfer.requestedAt) },
                        { label: 'Reviewed', value: transfer.reviewedAt ? formatDateTime(transfer.reviewedAt) : '—' },
                        { label: 'Settled', value: transfer.settledAt ? formatDateTime(transfer.settledAt) : '—' },
                        { label: 'Approval required', value: transfer.requiresApproval ? 'Yes' : 'No' },
                        transfer.reviewNote ? { label: 'Review note', value: transfer.reviewNote } : null,
                        transfer.rejectionReason ? { label: 'Rejection reason', value: transfer.rejectionReason } : null,
                      ]}
                    />
                  </Card>
                </div>

                {/* ---- Receipt ---- */}
                {transfer.status === 'approved' ? (
                  <div>
                    <div className="row gap-3 mb-3">
                      <IconReceipt size={20} className="muted" />
                      <h2 className="text-lg">Issued receipt</h2>
                    </div>
                    <AdminReceipt transferId={transfer.id} fallbackNumber={transfer.receiptNumber} />
                  </div>
                ) : null}
              </div>
            </>
          ) : null}
        </AsyncBoundary>
      </div>

      {/* ---- Approve ---- */}
      <ConfirmDialog
        open={dialog === 'approve'}
        onClose={() => setDialog(null)}
        onConfirm={confirmApprove}
        loading={approving}
        title="Approve this transfer?"
        confirmLabel="Approve and settle"
        variant="accent"
        message={
          transfer
            ? `${transfer.amountFormatted} plus a ${transfer.feeFormatted} fee will be debited from account ${
                transfer.customer?.accountNumber ?? ''
              } and the funds will settle. A receipt is issued automatically.`
            : ''
        }
      >
        <TextAreaField
          label="Review note (optional)"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          maxLength={240}
          placeholder="Recorded in the audit log"
        />
      </ConfirmDialog>

      {/* ---- Reject ---- */}
      <ConfirmDialog
        open={dialog === 'reject'}
        onClose={() => setDialog(null)}
        onConfirm={confirmReject}
        loading={rejecting}
        requireReason
        reason={note}
        onReasonChange={setNote}
        reasonLabel="Reason for rejection"
        title="Reject this transfer?"
        confirmLabel="Reject transfer"
        variant="danger"
        message={
          transfer
            ? `${transfer.amountFormatted} will not be moved. The customer is told the transfer was declined and sees your reason.`
            : ''
        }
      />
    </AppShell>
  );
}

/**
 * The approve response already carries the receipt, but a transfer approved in an
 * earlier session needs its own fetch, so this is a thin standalone loader.
 */
function AdminReceipt({ transferId, fallbackNumber }) {
  const receipt = useAsync(() => adminApi.transferReceipt(transferId), [transferId]);

  if (receipt.loading) {
    return (
      <Card>
        <div className="loading-block">
          <span className="spinner" aria-hidden="true" />
          <span>Loading receipt…</span>
        </div>
      </Card>
    );
  }

  if (receipt.error) {
    return (
      <Alert tone="warning" title="Receipt not available">
        {receipt.error.message}
        {fallbackNumber ? ` (receipt ${fallbackNumber})` : ''}
      </Alert>
    );
  }

  if (!receipt.data?.receipt) {
    return (
      <Alert tone="warning" title="No receipt issued">
        A receipt is generated automatically when a transfer settles.
      </Alert>
    );
  }

  return <Receipt receipt={receipt.data.receipt} />;
}

