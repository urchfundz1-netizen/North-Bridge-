/**
 * Activity.
 *
 * One destination for everything that happened on the account: the ledger
 * statement, the transfers still working through approval, and the receipt
 * archive. The three lists share one nav entry and are told apart by the `view`
 * parameter, which is held in the URL so a filtered list can be linked to or
 * survive a refresh.
 *
 * Each list keeps its own filters (`type`, `status`) but they share `page` and
 * `limit`; switching view therefore drops the page number and the filters that
 * belonged to the list being left, so a stale page never renders empty.
 */

import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AppShell } from '../../components/Layout.jsx';
import {
  AsyncBoundary,
  Card,
  EmptyState,
  PageHeader,
  Pagination,
  SelectField,
} from '../../components/ui.jsx';
import { LedgerRow } from '../../components/Transactions.jsx';
import TransferBrowser from '../../components/TransferBrowser.jsx';
import ReceiptArchive from '../../components/ReceiptArchive.jsx';
import { customerApi, pageParams } from '../../api/client.js';
import { useAsync } from '../../lib/hooks.js';
import { IconHistory, IconPrint, IconReceipt, IconTransfer } from '../../components/icons.jsx';

const VIEWS = [
  { value: 'statement', label: 'Statement', icon: IconHistory },
  { value: 'transfers', label: 'Transfers', icon: IconTransfer },
  { value: 'receipts', label: 'Receipts', icon: IconReceipt },
];

const ENTRY_TYPES = [
  { value: 'all', label: 'All activity' },
  { value: 'deposit', label: 'Deposits (funding)' },
  { value: 'transfer_principal', label: 'Transfers' },
  { value: 'transfer_fee', label: 'Transfer fees' },
  { value: 'adjustment', label: 'Adjustments' },
];

const PAGE_SIZES = [10, 20, 50];

export default function TransactionsPage() {
  const [params, setParams] = useSearchParams();
  const [limit, setLimit] = useState(Number(params.get('limit')) || 20);

  const view = VIEWS.some((option) => option.value === params.get('view'))
    ? params.get('view')
    : 'statement';

  const page = Math.max(1, Number(params.get('page')) || 1);
  const entryType = params.get('type') ?? 'all';

  const setParam = (key, value) => {
    const next = new URLSearchParams(params);
    if (value === null || value === '' || value === 'all') next.delete(key);
    else next.set(key, String(value));
    // Any filter change invalidates the current page number.
    if (key !== 'page') next.delete('page');
    setParams(next, { replace: true });
  };

  /**
   * Switching view clears the previous list's filters. They share `page` and
   * `limit`, so carrying `type=transfer_fee` into the receipt tab would strand
   * the user on page 3 of a one-page list.
   */
  const setView = (next) => {
    const query = new URLSearchParams();
    if (next !== 'statement') query.set('view', next);
    if (limit !== 20) query.set('limit', String(limit));
    setParams(query, { replace: true });
  };

  // Only the statement reads the ledger: the other views fetch their own list,
  // so there is no reason to pull entries the user cannot see.
  const statement = useAsync(
    () => customerApi.transactions({ entryType, ...pageParams(page, limit) }),
    [entryType, page, limit],
    { enabled: view === 'statement' },
  );

  const rows = statement.data?.items ?? [];

  return (
    <AppShell variant="customer">
      <div className="container page">
        <PageHeader
          title="Activity"
          subtitle="Every movement on your account, the transfers in review, and the receipts they produced."
        />

        <div className="tabs" role="tablist" aria-label="Activity views">
          {VIEWS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="tab"
              id={`activity-tab-${option.value}`}
              aria-selected={view === option.value}
              aria-controls="activity-panel"
              className={`tabs__tab ${view === option.value ? 'is-active' : ''}`}
              onClick={() => setView(option.value)}
            >
              <option.icon size={16} />
              {option.label}
            </button>
          ))}
        </div>

        <div id="activity-panel" role="tabpanel" aria-labelledby={`activity-tab-${view}`}>
          {view === 'transfers' ? (
            <TransferBrowser />
          ) : view === 'receipts' ? (
            <ReceiptArchive />
          ) : (
            <AsyncBoundary loading={statement.loading} error={statement.error} onRetry={statement.reload}>
              <Card
                title="Statement"
                subtitle={`${statement.data?.total ?? 0} entries`}
                actions={
                  <button type="button" className="btn btn--secondary btn--sm" onClick={() => window.print()}>
                    <IconPrint size={16} />
                    Print
                  </button>
                }
                bodyClassName="p0"
              >
                <div className="filter-bar" style={{ padding: 'var(--space-4) var(--space-5)', marginBottom: 0 }}>
                  <SelectField
                    label=""
                    aria-label="Filter by entry type"
                    value={entryType}
                    onChange={(event) => setParam('type', event.target.value)}
                    options={ENTRY_TYPES}
                    className="mb-0"
                  />
                </div>

                {rows.length === 0 ? (
                  <EmptyState
                    icon={IconHistory}
                    title="No matching entries"
                    description={
                      entryType === 'all'
                        ? 'Your account has no activity yet.'
                        : 'No entries of this type. Try a different filter.'
                    }
                  />
                ) : (
                  <div className="txn-list">
                    {rows.map((entry) => (
                      <LedgerRow key={entry.id} entry={entry} />
                    ))}
                  </div>
                )}

                <Pagination
                  page={statement.data?.page ?? 1}
                  totalPages={statement.data?.totalPages ?? 1}
                  total={statement.data?.total}
                  pageSize={limit}
                  pageSizeOptions={PAGE_SIZES}
                  onPageSizeChange={(next) => {
                    setLimit(next);
                    setParam('limit', next);
                  }}
                  onPageChange={(next) => setParam('page', next)}
                />
              </Card>
            </AsyncBoundary>
          )}
        </div>
      </div>
    </AppShell>
  );
}