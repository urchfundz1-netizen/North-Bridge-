/**
 * Customer transfer list with search, status filter and pagination.
 *
 * Extracted from the transfers screen so the Activity page can offer the same
 * list under one of its tabs. Status and pagination live in the URL so a link to
 * "my pending transfers" works and survives a refresh; search stays in local
 * state, debounced before it reaches the API, because typing should not push a
 * history entry per key.
 */

import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  AsyncBoundary,
  Card,
  EmptyState,
  Pagination,
  SelectField,
} from './ui.jsx';
import { TransferRow } from './Transactions.jsx';
import { customerApi, pageParams } from '../api/client.js';
import { useAsync, useDebounced } from '../lib/hooks.js';
import { TRANSFER_STATUS_OPTIONS } from '../lib/format.js';
import { IconSearch, IconTransfer } from './icons.jsx';

const PAGE_SIZES = [10, 20, 50];

export default function TransferBrowser({ defaultStatus = 'all' }) {
  const [params, setParams] = useSearchParams();
  const [limit, setLimit] = useState(Number(params.get('limit')) || 20);
  const [searchDraft, setSearchDraft] = useState('');
  const search = useDebounced(searchDraft, 350);

  const page = Math.max(1, Number(params.get('page')) || 1);
  const status = params.get('status') ?? defaultStatus;

  /** Update one URL parameter, resetting pagination unless it is the page. */
  const setParam = (key, value) => {
    const next = new URLSearchParams(params);
    if (value === null || value === '' || value === 'all') next.delete(key);
    else next.set(key, String(value));
    if (key !== 'page') next.delete('page');
    setParams(next, { replace: true });
  };

  // The debounced search is part of the request, not the URL.
  const transfers = useAsync(
    () => customerApi.transfers({ status, search, ...pageParams(page, limit) }),
    [status, search, page, limit],
  );

  const rows = transfers.data?.items ?? [];

  return (
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
              placeholder="Search recipient or reference"
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
            title={status === 'all' && !search ? 'No transfers yet' : 'No matching transfers'}
            description={
              status === 'all' && !search
                ? 'Transfers you submit will be listed here with their current status.'
                : 'Try a different status or clear your search.'
            }
            action={
              status === 'all' && !search ? (
                <Link className="btn btn--primary" to="/transfer">
                  Send your first transfer
                </Link>
              ) : null
            }
          />
        ) : (
          <div className="txn-list">
            {rows.map((transfer) => (
              <TransferRow key={transfer.id} transfer={transfer} to={`/transfers/${transfer.id}`} />
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
    </AsyncBoundary>
  );
}