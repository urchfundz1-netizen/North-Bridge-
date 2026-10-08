/**
 * Admin transfer review queue.
 *
 * Defaults to pending and oldest-first, because the oldest queued transfer is
 * the one a customer is most likely to be waiting on. Every row links into the
 * detail screen where approval actually happens.
 */

import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AppShell } from '../../components/Layout.jsx';
import {
  Alert,
  AsyncBoundary,
  Card,
  EmptyState,
  PageHeader,
  Pagination,
  SelectField,
  Stat,
} from '../../components/ui.jsx';
import { TransferRow } from '../../components/Transactions.jsx';
import { adminApi, pageParams } from '../../api/client.js';
import { useAsync, useDebounced } from '../../lib/hooks.js';
import { formatCents, TRANSFER_STATUS_OPTIONS } from '../../lib/format.js';
import { IconSearch, IconTransfer } from '../../components/icons.jsx';

const PAGE_SIZES = [20, 50, 100];

export default function AdminTransfersPage() {
  const [params, setParams] = useSearchParams();
  const [limit, setLimit] = useState(Number(params.get('limit')) || 20);
  const [searchDraft, setSearchDraft] = useState('');
  const search = useDebounced(searchDraft, 350);

  const page = Math.max(1, Number(params.get('page')) || 1);
  const status = params.get('status') ?? 'pending';

  const setParam = (key, value) => {
    const next = new URLSearchParams(params);
    if (!value || value === 'all') next.delete(key);
    else next.set(key, String(value));
    if (key !== 'page') next.delete('page');
    setParams(next, { replace: true });
  };

  const stats = useAsync(() => adminApi.transferStats(), []);
  const transfers = useAsync(
    () => adminApi.transfers({ status, search, ...pageParams(page, limit) }),
    [status, search, page, limit],
  );

  const rows = transfers.data?.items ?? [];

  return (
    <AppShell variant="admin">
      <div className="container page">
        <PageHeader
          title="Transfer review"
          subtitle="Approve or reject customer transfers. Approval settles the money; rejection leaves the customer's balance untouched."
        />

        <div className="stat-grid mb-5">
          <Stat
            label="Awaiting review"
            value={stats.data?.stats?.pending ?? 0}
            hint="Blocking customer funds"
            tone={(stats.data?.stats?.pending ?? 0) > 0 ? 'attention' : undefined}
          />
          <Stat label="Approved" value={stats.data?.stats?.approved ?? 0} hint="All time" />
          <Stat label="Rejected" value={stats.data?.stats?.rejected ?? 0} hint="All time" />
          <Stat
            label="Settled value"
            value={formatCents(stats.data?.stats?.settledValueCents ?? 0, { compact: true })}
            hint="Approved transfers"
          />
        </div>

        <AsyncBoundary loading={transfers.loading} error={transfers.error} onRetry={transfers.reload}>
          <Card bodyClassName="p0">
            <div className="filter-bar" style={{ padding: 'var(--space-4) var(--space-5)', marginBottom: 0 }}>
              <div className="search-field">
                <IconSearch size={16} className="search-field__icon" />
                <input
                  className="input"
                  type="search"
                  value={searchDraft}
                  onChange={(event) => setSearchDraft(event.target.value)}
                  placeholder="Reference, recipient or customer"
                  aria-label="Search transfers"
                />
              </div>

              <SelectField
                label=""
                aria-label="Filter by status"
                value={status}
                onChange={(event) => setParam('status', event.target.value)}
                options={TRANSFER_STATUS_OPTIONS}
                className="mb-0"
              />
            </div>

            {rows.length === 0 ? (
              <EmptyState
                icon={IconTransfer}
                title={status === 'pending' ? 'The review queue is clear' : 'No matching transfers'}
                description={
                  status === 'pending'
                    ? 'Every customer transfer has been dealt with.'
                    : 'Try a different status or search term.'
                }
              />
            ) : (
              <div className="txn-list">
                {rows.map((transfer) => (
                  <TransferRow
                    key={transfer.id}
                    transfer={transfer}
                    to={`/admin/transfers/${transfer.id}`}
                    showCustomer
                  />
                ))}
              </div>
            )}

            <Pagination
              page={transfers.data?.page ?? 1}
              totalPages={transfers.data?.totalPages ?? 1}
              total={transfers.data?.total}
              pageSize={limit}
              pageSizeOptions={PAGE_SIZES}
              onPageSizeChange={(next) => {
                setLimit(next);
                setParam('limit', next);
              }}
              onPageChange={(next) => setParam('page', next)}
            />
          </Card>

          <Alert tone="info" title="Approving is safe to retry">
            Approval runs in a single database transaction guarded by the transfer&#39;s status. If two
            staff members approve the same transfer, the second request is told it was already
            processed instead of deducting the money twice.
          </Alert>
        </AsyncBoundary>
      </div>
    </AppShell>
  );
}

