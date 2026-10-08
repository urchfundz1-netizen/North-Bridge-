/**
 * Ledger and transfer list rows.
 *
 * `LedgerRow` renders `toLedgerEntry` output and `TransferRow` renders
 * `toTransfer` output. Both are used by the customer portal and the admin
 * console, which keeps a transaction's appearance identical in both places.
 */

import { Link } from 'react-router-dom';
import { StatusBadge } from './ui.jsx';
import {
  IconArrowRight,
  IconInbox,
  IconReceipt,
  IconTransfer,
} from './icons.jsx';
import { formatCents, formatDateTime, formatRelative } from '../lib/format.js';

const ENTRY_ICON = {
  deposit: IconInbox,
  adjustment: IconInbox,
  transfer_principal: IconTransfer,
  transfer_fee: IconTransfer,
};

/** One statement line. */
export function LedgerRow({ entry, to }) {
  const isCredit = entry.direction === 'credit';
  const Glyph = ENTRY_ICON[entry.type] ?? IconInbox;
  const Wrapper = to ? Link : 'div';

  return (
    <Wrapper
      className="txn"
      {...(to ? { to } : {})}
      style={to ? undefined : { cursor: 'default' }}
    >
      <span className={`txn__icon ${isCredit ? 'txn__icon--credit' : 'txn__icon--debit'}`}>
        <Glyph size={18} />
      </span>

      <span className="txn__body">
        <span className="txn__title">{entry.description || entry.typeLabel}</span>
        <span className="txn__meta">
          <span>{formatDateTime(entry.createdAt)}</span>
          <span aria-hidden="true">&middot;</span>
          <span>{entry.typeLabel}</span>
          {entry.referenceNumber ? (
            <>
              <span aria-hidden="true">&middot;</span>
              <span className="mono">{entry.referenceNumber}</span>
            </>
          ) : null}
          {entry.adminName ? (
            <>
              <span aria-hidden="true">&middot;</span>
              <span>by {entry.adminName}</span>
            </>
          ) : null}
        </span>
      </span>

      <span className="txn__amount">
        <span className={isCredit ? 'positive' : 'negative'}>
          {isCredit ? '+' : '−'}
          {formatCents(Math.abs(entry.amountCents))}
        </span>
        <span className="txn__meta" style={{ justifyContent: 'flex-end' }}>
          {formatRelative(entry.createdAt)}
        </span>
      </span>
    </Wrapper>
  );
}

/**
 * One transfer row. Customers link to their own transfer detail; in the admin
 * console the whole row is clickable via `onSelect` instead.
 */
export function TransferRow({ transfer, to, onSelect, showCustomer = false }) {
  const Wrapper = to ? Link : 'div';

  return (
    <Wrapper
      className="txn"
      {...(to ? { to } : {})}
      {...(onSelect
        ? { role: 'button', tabIndex: 0, onClick: () => onSelect(transfer), onKeyDown: (e) => e.key === 'Enter' && onSelect(transfer) }
        : {})}
      style={onSelect ? { cursor: 'pointer' } : undefined}
    >
      <span className={`txn__icon ${transfer.status === 'approved' ? 'txn__icon--credit' : 'txn__icon--debit'}`}>
        {transfer.status === 'approved' ? <IconReceipt size={18} /> : <IconTransfer size={18} />}
      </span>

      <span className="txn__body">
        <span className="txn__title">{transfer.recipient?.name ?? 'Recipient'}</span>
        <span className="txn__meta">
          <span className="mono">{transfer.recipient?.accountNumber}</span>
          {transfer.recipient?.bank ? (
            <>
              <span aria-hidden="true">&middot;</span>
              <span className="truncate">{transfer.recipient.bank}</span>
            </>
          ) : null}
          {showCustomer && transfer.customer ? (
            <>
              <span aria-hidden="true">&middot;</span>
              <span className="truncate">{transfer.customer.name}</span>
            </>
          ) : null}
        </span>
        <span className="txn__meta">
          <StatusBadge status={transfer.status} label={transfer.statusLabel} />
          <span className="mono">{transfer.referenceNumber}</span>
          <span>{formatDateTime(transfer.requestedAt)}</span>
        </span>
      </span>

      <span className="txn__amount">
        <span>−{transfer.amountFormatted}</span>
        <span className="txn__meta" style={{ justifyContent: 'flex-end' }}>
          fee {transfer.feeFormatted}
        </span>
      </span>

      {to ? <IconArrowRight size={16} className="subtle" /> : null}
    </Wrapper>
  );
}

/** Compact horizontal summary used above lists on mobile. */
export function StatementTotals({ statement }) {
  if (!statement) return null;
  return (
    <div className="stat-grid">
      <div className="stat">
        <span className="stat__label">Credited</span>
        <span className="stat__value positive">{formatCents(statement.creditedCents)}</span>
        <span className="stat__hint">Total incoming</span>
      </div>
      <div className="stat">
        <span className="stat__label">Debited</span>
        <span className="stat__value negative">{formatCents(statement.debitedCents)}</span>
        <span className="stat__hint">Total outgoing</span>
      </div>
      <div className="stat">
        <span className="stat__label">Entries</span>
        <span className="stat__value">{statement.entryCount}</span>
        <span className="stat__hint">On this account</span>
      </div>
      <div className="stat">
        <span className="stat__label">Net</span>
        <span className={`stat__value ${statement.creditedCents - statement.debitedCents >= 0 ? 'positive' : 'negative'}`}>
          {formatCents(statement.creditedCents - statement.debitedCents, { showSign: true })}
        </span>
        <span className="stat__hint">Credited less debited</span>
      </div>
    </div>
  );
}