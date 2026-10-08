/**
 * Admin audit log.
 *
 * Append-only by construction: the database blocks updates and deletes on this
 * table, and the server exposes no route that writes one. What an administrator
 * can do here is only read and filter it.
 */

import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AppShell } from '../../components/Layout.jsx';
import {
  Alert,
  AsyncBoundary,
  Card,
  DataTable,
  Modal,
  PageHeader,
  Pagination,
  SelectField,
} from '../../components/ui.jsx';
import { adminApi, pageParams } from '../../api/client.js';
import { useAsync, useDebounced } from '../../lib/hooks.js';
import { formatDateTime, humanize } from '../../lib/format.js';
import { IconSearch } from '../../components/icons.jsx';

const PAGE_SIZES = [25, 50, 100];

const ACTOR_FILTERS = [
  { value: 'all', label: 'All actors' },
  { value: 'admin', label: 'Administrators' },
  { value: 'customer', label: 'Customers' },
  { value: 'system', label: 'System' },
];

export default function AdminAuditPage() {
  const [params, setParams] = useSearchParams();
  const [limit, setLimit] = useState(Number(params.get('limit')) || 50);
  const [searchDraft, setSearchDraft] = useState(params.get('search') ?? '');
  const [inspecting, setInspecting] = useState(null);
  const search = useDebounced(searchDraft, 350);

  const page = Math.max(1, Number(params.get('page')) || 1);
  const action = params.get('action') ?? '';
  const actorType = params.get('actorType') ?? 'all';

  const setParam = (key, value) => {
    const next = new URLSearchParams(params);
    if (!value || value === 'all') next.delete(key);
    else next.set(key, String(value));
    if (key !== 'page') next.delete('page');
    setParams(next, { replace: true });
  };

  const actions = useAsync(() => adminApi.auditActions(), []);
  const logs = useAsync(
    () => adminApi.auditLogs({ action, actorType, search, ...pageParams(page, limit) }),
    [action, actorType, search, page, limit],
  );

  const columns = [
    {
      key: 'createdAt',
      header: 'When',
      render: (row) => (
        <span className="text-sm" style={{ whiteSpace: 'nowrap' }}>
          {formatDateTime(row.createdAt)}
        </span>
      ),
    },
    {
      key: 'action',
      header: 'Action',
      render: (row) => (
        <div>
          <span className="strong text-sm">{humanize(row.action)}</span>
          <div className="text-xs subtle mono">{row.action}</div>
        </div>
      ),
    },
    {
      key: 'actor',
      header: 'Who',
      render: (row) => (
        <div>
          <div className="text-sm">{row.actor?.email ?? row.actor?.type ?? 'system'}</div>
          <div className="text-xs subtle">{humanize(row.actor?.type)}</div>
        </div>
      ),
    },
    {
      key: 'target',
      header: 'Target',
      render: (row) => (
        <div>
          <div className="text-sm">{row.target?.label ?? humanize(row.target?.type)}</div>
          {row.target?.id ? <div className="text-xs subtle mono">#{row.target.id}</div> : null}
        </div>
      ),
    },
    {
      key: 'reason',
      header: 'Reason',
      render: (row) => (
        <span className="text-sm subtle truncate" style={{ display: 'block', maxWidth: '22ch' }}>
          {row.reason || '—'}
        </span>
      ),
    },
    {
      key: 'ipAddress',
      header: 'IP',
      align: 'right',
      render: (row) => <span className="mono text-xs subtle">{row.ipAddress ?? '—'}</span>,
    },
  ];

  return (
    <AppShell variant="admin">
      <div className="container page">
        <PageHeader
          title="Audit log"
          subtitle="Every recorded action, with the actor, the target, the reason and the origin."
        />

        <AsyncBoundary loading={logs.loading} error={logs.error} onRetry={logs.reload}>
          <Card bodyClassName="p0">
            <div className="filter-bar" style={{ padding: 'var(--space-4) var(--space-5)', marginBottom: 0 }}>
              <div className="search-field">
                <IconSearch size={16} className="search-field__icon" />
                <input
                  className="input"
                  type="search"
                  value={searchDraft}
                  onChange={(event) => setSearchDraft(event.target.value)}
                  placeholder="Action, email, target or reason"
                  aria-label="Search audit log"
                />
              </div>

              <SelectField
                label=""
                aria-label="Filter by action"
                value={action}
                onChange={(event) => setParam('action', event.target.value)}
                options={[
                  { value: '', label: 'All actions' },
                  ...(actions.data?.actions ?? []).map((name) => ({ value: name, label: humanize(name) })),
                ]}
                className="mb-0"
              />

              <SelectField
                label=""
                aria-label="Filter by actor type"
                value={actorType}
                onChange={(event) => setParam('actorType', event.target.value)}
                options={ACTOR_FILTERS}
                className="mb-0"
              />
            </div>

            <DataTable
              columns={columns}
              rows={logs.data?.items ?? []}
              empty="No audit entries match these filters."
              onRowClick={setInspecting}
              footer={
                <Pagination
                  page={logs.data?.page ?? 1}
                  totalPages={logs.data?.totalPages ?? 1}
                  total={logs.data?.total}
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

          <Alert tone="info" title="This table cannot be edited">
            The database itself rejects updates and deletes against <code className="mono">audit_logs</code>,
            and the API exposes no route that can. Entries can only be added, never removed.
          </Alert>
        </AsyncBoundary>
      </div>

      {/* ---- Row inspector ---- */}
      <Modal
        open={Boolean(inspecting)}
        onClose={() => setInspecting(null)}
        title={inspecting ? humanize(inspecting.action) : ''}
        subtitle={inspecting ? formatDateTime(inspecting.createdAt) : undefined}
      >
        {inspecting ? (
          <div className="stack gap-4">
            <dl className="datalist">
              <div className="datalist__item">
                <dt className="datalist__label">Action</dt>
                <dd className="datalist__value mono">{inspecting.action}</dd>
              </div>
              <div className="datalist__item">
                <dt className="datalist__label">Actor</dt>
                <dd className="datalist__value">
                  {inspecting.actor?.email ?? '—'}{' '}
                  <span className="subtle">({humanize(inspecting.actor?.type)})</span>
                </dd>
              </div>
              <div className="datalist__item">
                <dt className="datalist__label">Actor id</dt>
                <dd className="datalist__value mono">{inspecting.actor?.id ?? '—'}</dd>
              </div>
              <div className="datalist__item">
                <dt className="datalist__label">Target</dt>
                <dd className="datalist__value">
                  {inspecting.target?.label ?? humanize(inspecting.target?.type)}
                  {inspecting.target?.id ? ` #${inspecting.target.id}` : ''}
                </dd>
              </div>
              <div className="datalist__item">
                <dt className="datalist__label">IP address</dt>
                <dd className="datalist__value mono">{inspecting.ipAddress ?? '—'}</dd>
              </div>
              <div className="datalist__item">
                <dt className="datalist__label">User agent</dt>
                <dd className="datalist__value text-xs subtle">{inspecting.userAgent ?? '—'}</dd>
              </div>
            </dl>

            {inspecting.reason ? (
              <div>
                <span className="datalist__label">Reason given</span>
                <p className="mt-1">{inspecting.reason}</p>
              </div>
            ) : null}

            {inspecting.metadata ? (
              <div>
                <span className="datalist__label">Metadata</span>
                <pre
                  className="mono text-xs mt-2"
                  style={{
                    background: 'var(--surface-muted)',
                    padding: 'var(--space-3)',
                    borderRadius: 'var(--radius)',
                    overflowX: 'auto',
                    fontSize: 'var(--text-xs)',
                  }}
                >
                  {JSON.stringify(inspecting.metadata, null, 2)}
                </pre>
              </div>
            ) : null}
          </div>
        ) : null}
      </Modal>
    </AppShell>
  );
}

