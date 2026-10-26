/**
 * Admin - one-time codes.
 *
 * Because no email or SMS provider is wired up, a customer who reaches a
 * one-time-code step cannot be sent their code. This is the other half of both
 * flows: the code minted for a pending sign-in or transfer is shown here so a
 * member of staff can read it back to the customer ("fetch the OTP").
 *
 * Read-only on purpose. Codes are produced by the sign-in and transfer flows
 * and live on the challenge itself; nothing here writes to the database.
 */

import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AppShell } from '../../components/Layout.jsx';
import {
  AsyncBoundary,
  Button,
  Card,
  DataTable,
  PageHeader,
  Pagination,
  SectionTitle,
  SelectField,
  Stat,
  StatusBadge,
} from '../../components/ui.jsx';
import { adminApi, pageParams } from '../../api/client.js';
import { useAsync, useDebounced } from '../../lib/hooks.js';
import { formatDateTime, humanize } from '../../lib/format.js';
import { IconSearch } from '../../components/icons.jsx';

const LIMIT = 25;

const CHALLENGE_FILTERS = [
  { value: 'pending', label: 'Awaiting a code' },
  { value: 'all', label: 'All challenges' },
  { value: 'consumed', label: 'Completed' },
  { value: 'expired', label: 'Expired' },
  { value: 'failed', label: 'Failed' },
];

const PURPOSE_FILTERS = [
  { value: 'all', label: 'All code types' },
  { value: 'login', label: 'Sign-in' },
  { value: 'transfer', label: 'Transfer' },
];

const CHALLENGE_TONES = {
  pending: 'warning',
  consumed: 'success',
  expired: 'neutral',
  failed: 'danger',
};

const PURPOSE_LABELS = {
  login: 'Sign-in',
  transfer: 'Transfer',
};

export default function AdminOtpPage() {
  const [params, setParams] = useSearchParams();
  const [copied, setCopied] = useState(null);

  const [searchDraft, setSearchDraft] = useState(params.get('q') ?? '');
  const search = useDebounced(searchDraft, 350);

  const page = Math.max(1, Number(params.get('p')) || 1);
  const status = params.get('s') ?? 'pending';
  const purpose = params.get('t') ?? 'all';

  const setParam = (key, value, pageKey) => {
    const next = new URLSearchParams(params);
    if (!value || value === 'all') next.delete(key);
    else next.set(key, String(value));
    next.delete(pageKey);
    setParams(next, { replace: true });
  };

  const stats = useAsync(() => adminApi.otpStats(), []);
  const challenges = useAsync(
    () => adminApi.otpChallenges({ status, purpose, search, ...pageParams(page, LIMIT) }),
    [status, purpose, search, page],
  );

  const copyCode = async (code) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(code);
      setTimeout(() => setCopied((current) => (current === code ? null : current)), 1500);
    } catch {
      setCopied(null);
    }
  };

  const columns = [
    {
      key: 'code',
      header: 'Code',
      render: (row) => (
        <span className="row gap-2">
          <span className="mono strong" style={{ fontSize: 'var(--text-lg)', letterSpacing: '0.15em' }}>
            {row.code}
          </span>
          <Button variant="ghost" size="sm" onClick={() => copyCode(row.code)}>
            {copied === row.code ? 'Copied' : 'Copy'}
          </Button>
        </span>
      ),
    },
    {
      key: 'purpose',
      header: 'Type',
      render: (row) => (
        <StatusBadge
          status={row.purpose}
          tone={row.purpose === 'transfer' ? 'info' : 'success'}
          label={PURPOSE_LABELS[row.purpose] ?? 'Sign-in'}
        />
      ),
    },
    {
      key: 'customerEmail',
      header: 'Customer',
      render: (row) => (
        <div>
          <div className="text-sm">{row.customerEmail ?? '—'}</div>
          {row.customerId ? <div className="text-xs subtle mono">#{row.customerId}</div> : null}
        </div>
      ),
    },
    {
      key: 'createdAt',
      header: 'Requested',
      render: (row) => (
        <span className="text-sm" style={{ whiteSpace: 'nowrap' }}>
          {formatDateTime(row.createdAt)}
        </span>
      ),
    },
    {
      key: 'expiresAt',
      header: 'Expires',
      render: (row) => (
        <span className="text-sm" style={{ whiteSpace: 'nowrap' }}>
          {formatDateTime(row.expiresAt)}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => (
        <StatusBadge
          status={row.status}
          tone={CHALLENGE_TONES[row.status] ?? 'neutral'}
          label={humanize(row.status)}
        />
      ),
    },
  ];

  return (
    <AppShell variant="admin">
      <div className="container page">
        <PageHeader
          title="One-time codes"
          subtitle="Read back the one-time code for a customer who is signing in or authorising a transfer, then relay it to them."
        />

        {stats.data ? (
          <div className="stat-grid mb-6">
            <Stat
              label="Awaiting a code"
              value={stats.data.pendingChallenges}
              hint="Pending sign-ins and transfers"
            />
            <Stat
              label="Sign-in codes"
              value={stats.data.pendingSignIn}
              hint="Pending sign-in attempts"
            />
            <Stat
              label="Transfer codes"
              value={stats.data.pendingTransfer}
              hint="Pending transfer authorisations"
            />
            <Stat
              label="Total attempts"
              value={stats.data.totalChallenges}
              hint="All one-time codes"
            />
          </div>
        ) : null}

        {/* ---- Challenges ---- */}
        <SectionTitle>Code requests</SectionTitle>
        <AsyncBoundary loading={challenges.loading} error={challenges.error} onRetry={challenges.reload}>
          <Card bodyClassName="p0">
            <div className="filter-bar" style={{ padding: 'var(--space-4) var(--space-5)', marginBottom: 0 }}>
              <div className="search-field">
                <IconSearch size={16} className="search-field__icon" />
                <input
                  className="input"
                  type="search"
                  value={searchDraft}
                  onChange={(event) => {
                    setSearchDraft(event.target.value);
                    setParam('q', event.target.value, 'p');
                  }}
                  placeholder="Email, code or customer id"
                  aria-label="Search one-time codes"
                />
              </div>

              <SelectField
                label=""
                aria-label="Filter by code type"
                value={purpose}
                onChange={(event) => setParam('t', event.target.value, 'p')}
                options={PURPOSE_FILTERS}
                className="mb-0"
              />

              <SelectField
                label=""
                aria-label="Filter by status"
                value={status}
                onChange={(event) => setParam('s', event.target.value, 'p')}
                options={CHALLENGE_FILTERS}
                className="mb-0"
              />
            </div>

            <DataTable
              columns={columns}
              rows={challenges.data?.items ?? []}
              rowKey={(row) => row.challengeId}
              empty="No one-time codes match these filters."
              footer={
                <Pagination
                  page={challenges.data?.page ?? 1}
                  totalPages={challenges.data?.totalPages ?? 1}
                  total={challenges.data?.total}
                  onPageChange={(next) => setParam('p', next, 'p')}
                />
              }
            />
          </Card>
        </AsyncBoundary>
      </div>
    </AppShell>
  );
}
