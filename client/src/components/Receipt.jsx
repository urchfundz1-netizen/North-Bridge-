/**
 * Printable transfer receipt.
 *
 * Renders `receipt.payload`, which the server froze when it issued the document.
 * Nothing here re-queries live data, so a receipt always reads exactly as it
 * did on the day it was issued even if the customer or bank is later edited.
 *
 * The same component backs the customer view and the admin view: if the two
 * ever disagreed, the printed document would be the thing that is wrong.
 *
 * A receipt is issued the moment the customer confirms their transfer PIN, so
 * this one component covers the whole life of a transfer. It arrives Pending
 * with the promised arrival window, and the same document is rewritten to
 * Approved, Rejected or Cancelled once the review is done. `transaction.final`
 * is the server's word for "this will never change again".
 */

import { Button } from './ui.jsx';
import { IconDownload, IconPrint } from './icons.jsx';

export function Receipt({ receipt, actions = true, className = '' }) {
  if (!receipt?.payload) return null;
  const { payload } = receipt;

  const tx = payload.transaction ?? {};
  // Fall back to the status for any document issued before `final` existed.
  const final = tx.final ?? tx.status === 'approved';
  // Nothing has left the account until the transfer settles, so the document
  // must not present a total as money already gone.
  const debited = payload.amounts?.debited ?? final;

  return (
    <article className={`receipt ${className}`}>
      <header className="receipt__head">
        <div>
          <div className="text-xs uppercase" style={{ letterSpacing: '0.1em', opacity: 0.8, fontWeight: 700 }}>
            {payload.bank?.name ?? 'Northbridge Bank'}
          </div>
          <div className="text-xl mt-1" style={{ fontWeight: 700 }}>
            Transfer Receipt
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs" style={{ opacity: 0.8 }}>
            Receipt number
          </div>
          <div className="mono strong">{payload.receiptNumber ?? receipt.receiptNumber}</div>
        </div>
      </header>

      {!final ? (
        <div
          className="text-xs"
          style={{
            padding: 'var(--space-2) var(--space-4)',
            background: 'var(--info-100)',
            color: 'var(--info-700)',
            fontWeight: 600,
            letterSpacing: '0.02em',
          }}
        >
          {tx.arrivalHint ?? 'Money will arrive within 24 hours.'}
          {tx.expectedArrivalBy ? ` Expected by ${formatStamp(tx.expectedArrivalBy)}.` : ''}
        </div>
      ) : null}

      <div className="receipt__body">
        <div className="receipt__grid">
          <Item label="Reference" value={<span className="mono">{tx.referenceNumber}</span>} />
          <Item label="Issued" value={formatStamp(payload.issuedAt)} />
          <Item label="Status" value={tx.statusLabel ?? tx.status} />
        </div>

        <div className="receipt__grid">
          <Item label="From" value={payload.customer?.name} />
          <Item label="From account" value={<span className="mono">{payload.customer?.accountNumber}</span>} />
          <Item label="Customer email" value={payload.customer?.email} />
        </div>

        <div className="receipt__grid">
          <Item label="Recipient" value={payload.recipient?.name} />
          <Item label="Recipient account" value={<span className="mono">{payload.recipient?.accountNumber}</span>} />
          <Item label="Destination bank" value={payload.recipient?.bank ?? '—'} />
          <Item label="Routing / SWIFT" value={<span className="mono">{payload.recipient?.routingNumber || payload.recipient?.swiftBic || '—'}</span>} />
          <Item label="IBAN" value={<span className="mono">{payload.recipient?.iban || '—'}</span>} />
          <Item label="Country" value={payload.recipient?.country || '—'} />
        </div>

        <div className="receipt__totals">
          <Row label="Transfer amount" value={payload.amounts?.amountFormatted} />
          <Row label="Processing fee" value={payload.amounts?.feeFormatted} />
          <Row
            label={debited ? 'Total debited' : 'Total'}
            value={payload.amounts?.totalDebitFormatted}
            strong
          />
        </div>

        <div className="receipt__grid">
          <Item label="Transfer type" value={tx.transferTypeLabel ?? tx.transferType} />
          <Item label="Requested" value={formatStamp(tx.requestedAt)} />
          <Item label="Settled" value={final ? formatStamp(tx.settledAt) : 'Not yet'} />
        </div>

        {payload.rejectionReason ? (
          <div style={{ paddingTop: 'var(--space-4)' }}>
            <Item label="Reason" value={payload.rejectionReason} />
          </div>
        ) : null}

        {payload.description ? (
          <div style={{ paddingTop: 'var(--space-4)' }}>
            <Item label="Description" value={payload.description} />
          </div>
        ) : null}
      </div>

      <footer className="receipt__foot">
        <div className="stack gap-1">
          {final ? (
            <>
              <span>
                Keep this receipt for your records. Funds settled once only; this document is the
                authoritative record of the transaction.
              </span>
              <span>
                Questions? Contact {payload.bank?.name ?? 'Northbridge Bank'} on{' '}
                {payload.bank?.supportPhone ?? '+1 (800) 555-0142'} or{' '}
                {payload.bank?.supportEmail ?? 'support@northbridge.bank'}.
              </span>
            </>
          ) : (
            <>
              <span>
                <strong>Your transfer PIN was confirmed</strong> when you submitted this transfer.
                No money has left your account yet, and you can withdraw the transfer at any time
                until it is approved.
              </span>
              <span>
                {tx.arrivalHint ?? 'Money will arrive within 24 hours.'} This receipt keeps its
                number as the transfer progresses.
              </span>
            </>
          )}
        </div>
      </footer>

      {actions ? (
        <div className="card__footer row gap-2 no-print">
          <Button variant="secondary" icon={IconPrint} onClick={() => window.print()}>
            Print
          </Button>
          <Button variant="secondary" icon={IconDownload} onClick={() => downloadReceipt(payload, receipt)}>
            Download
          </Button>
        </div>
      ) : null}
    </article>
  );
}

function Item({ label, value }) {
  return (
    <div className="receipt__item">
      <span className="receipt__label">{label}</span>
      <span className="receipt__value">{value || '—'}</span>
    </div>
  );
}

function Row({ label, value, strong }) {
  return (
    <div className={`receipt__total-row ${strong ? 'receipt__total-row--grand' : ''}`}>
      <span className={strong ? '' : 'muted'}>{label}</span>
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  );
}

function formatStamp(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

/**
 * Download the receipt as HTML rather than PDF: it prints from the same markup
 * as the screen, needs no client-side PDF library, and stays readable.
 */
function downloadReceipt(payload, receipt) {
  const amount = payload.amounts ?? {};
  const rows = [
    ['Receipt number', payload.receiptNumber ?? receipt.receiptNumber],
    ['Issued', formatStamp(payload.issuedAt)],
    ['Reference', payload.transaction?.referenceNumber],
    ['Status', payload.transaction?.statusLabel ?? payload.transaction?.status],
    ['From', payload.customer?.name],
    ['From account', payload.customer?.accountNumber],
    ['Recipient', payload.recipient?.name],
    ['Recipient account', payload.recipient?.accountNumber],
    ['Destination bank', payload.recipient?.bank],
    ['Routing / SWIFT', payload.recipient?.routingNumber || payload.recipient?.swiftBic],
    ['IBAN', payload.recipient?.iban],
    ['Transfer type', payload.transaction?.transferTypeLabel],
    ['Amount', amount.amountFormatted],
    ['Processing fee', amount.feeFormatted],
    ['Total debited', amount.totalDebitFormatted],
    ['Description', payload.description],
  ].filter(([, value]) => value);

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Receipt ${payload.receiptNumber ?? ''} - ${payload.bank?.name ?? 'Northbridge Bank'}</title>
<style>
  body { font-family: "Segoe UI", system-ui, sans-serif; color: #1f2a3a; margin: 40px; max-width: 720px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #55637a; font-size: 13px; margin-bottom: 24px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  td { padding: 9px 0; border-bottom: 1px solid #e2e7ee; vertical-align: top; }
  td:first-child { width: 38%; color: #55637a; }
  .total td { border-top: 2px solid #0d1524; border-bottom: 0; font-weight: 700; padding-top: 12px; }
  footer { margin-top: 28px; font-size: 12px; color: #55637a; border-top: 1px solid #e2e7ee; padding-top: 14px; }
</style>
</head>
<body>
  <h1>${escapeHtml(payload.bank?.name ?? 'Northbridge Bank')} — Transfer Receipt</h1>
  <p class="sub">${escapeHtml(payload.receiptNumber ?? receipt.receiptNumber ?? '')}</p>
  <table>
    ${rows
      .map(
        ([label, value]) =>
          `<tr${label === 'Total debited' ? ' class="total"' : ''}><td>${escapeHtml(label)}</td><td>${escapeHtml(String(value))}</td></tr>`,
      )
      .join('\n    ')}
  </table>
  <footer>
    Issued ${escapeHtml(formatStamp(payload.issuedAt))}. Funds settled once only; this document is the
    authoritative record of the transaction. Questions? Contact ${escapeHtml(payload.bank?.supportEmail ?? 'support@northbridge.bank')}.
  </footer>
</body>
</html>`;

  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `northbridge-receipt-${payload.receiptNumber ?? receipt.receiptNumber ?? 'receipt'}.html`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** Receipt data contains user-supplied names and descriptions. */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}