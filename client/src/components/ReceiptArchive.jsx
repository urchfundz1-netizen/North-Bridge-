/**
 * Receipt archive list.
 *
 * Lists only settled transfers, because a receipt is issued at settlement. The
 * full document is rendered inline rather than in a separate route so it can be
 * printed without a page change. Lives in its own component so the Activity page
 * can offer it as a tab rather than the customer needing a second nav link.
 */

import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Alert,
  AsyncBoundary,
  Card,
  EmptyState,
  Pagination,
} from './ui.jsx';
import { Receipt } from './Receipt.jsx';
import { customerApi, pageParams } from '../api/client.js';
import { useAsync } from '../lib/hooks.js';
import { formatDateTime } from '../lib/format.js';
import { IconChevronDown, IconReceipt } from './icons.jsx';

const PAGE_SIZES = [10, 20, 50];

export default function ReceiptArchive() {
  const [params, setParams] = useSearchParams();
  const [expanded, setExpanded] = useState(null);
  const page = Math.max(1, Number(params.get('page')) || 1);
  const limit = Number(params.get('limit')) || 20;

  const receipts = useAsync(() => customerApi.receipts(pageParams(page, limit)), [page, limit]);
  const rows = receipts.data?.items ?? [];

  const setParam = (key, value) => {
    const next = new URLSearchParams(params);
    if (!value) next.delete(key);
    else next.set(key, String(value));
    if (key !== 'page') next.delete('page');
    setParams(next, { replace: true });
  };

  // Fetch the full document only for the row the user expands.
  const detail = useAsync(
    () => (expanded ? customerApi.receipt(expanded) : Promise.resolve(null)),
    [expanded],
    { enabled: Boolean(expanded) },
  );

  return (
    <AsyncBoundary loading={receipts.loading} error={receipts.error} onRetry={receipts.reload}>
      <div className="stack gap-5">
        {rows.length === 0 ? (
          <Card>
            <EmptyState
              icon={IconReceipt}
              title="No receipts yet"
              description="A receipt is issued automatically once a transfer is approved. They will collect here."
              action={
                <Link className="btn btn--primary" to="/transfer">
                  Send a transfer
                </Link>
              }
            />
          </Card>
        ) : (
          <Card bodyClassName="p0">
            <div className="txn-list">
              {rows.map((row) => {
                const isOpen = expanded === row.transferId;
                return (
                  <div key={row.id}>
                    <button
                      type="button"
                      className="txn"
                      onClick={() => setExpanded(isOpen ? null : row.transferId)}
                      aria-expanded={isOpen}
                      style={{ width: '100%', border: 0, background: 'none', textAlign: 'left' }}
                    >
                      <span className="txn__icon txn__icon--credit">
                        <IconReceipt size={18} />
                      </span>
                      <span className="txn__body">
                        <span className="txn__title">{row.recipient_name ?? 'Transfer'}</span>
                        <span className="txn__meta">
                          <span className="mono">{row.receipt_number}</span>
                          <span aria-hidden="true">&middot;</span>
                          <span>{formatDateTime(row.issued_at)}</span>
                        </span>
                      </span>
                      <span className="txn__amount">
                        {formatCentsSafe(row.amount_cents)}
                        <span className="txn__meta" style={{ justifyContent: 'flex-end' }}>
                          fee {formatCentsSafe(row.fee_cents)}
                        </span>
                      </span>
                      <IconChevronDown
                        size={16}
                        className="subtle"
                        style={{ transform: isOpen ? 'rotate(180deg)' : 'none', transition: 'transform 200ms' }}
                      />
                    </button>

                    {isOpen ? (
                      <div style={{ padding: '0 var(--space-5) var(--space-5)' }}>
                        {detail.loading ? (
                          <div className="loading-block">
                            <span className="spinner" aria-hidden="true" />
                            <span>Loading receipt…</span>
                          </div>
                        ) : detail.error ? (
                          <Alert tone="warning">{detail.error.message}</Alert>
                        ) : detail.data?.receipt ? (
                          <Receipt receipt={detail.data.receipt} />
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>

            <Pagination
              page={receipts.data?.page ?? 1}
              totalPages={receipts.data?.totalPages ?? 1}
              total={receipts.data?.total}
              pageSize={limit}
              pageSizeOptions={PAGE_SIZES}
              onPageSizeChange={(next) => setParam('limit', next)}
              onPageChange={(next) => setParam('page', next)}
            />
          </Card>
        )}

        <Alert tone="info" title="Receipts are frozen">
          Each receipt is a snapshot taken when the transfer settled. If your account details
          change later, an issued receipt still reads exactly as it did on the day.
        </Alert>
      </div>
    </AsyncBoundary>
  );
}

/**
 * The archive list is a lighter SQL projection than the ledger serialiser, so it
 * arrives with snake_case columns rather than the usual camelCase shape. Format
 * it here rather than duplicating a whole serialiser on the client.
 */
function formatCentsSafe(cents) {
  const amount = (Number(cents) || 0) / 100;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
}