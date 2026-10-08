/**
 * Admin overview.
 *
 * Read-only headline figures plus the two queues an administrator actually
 * works from: transfers awaiting review, and accounts that need attention.
 */

import { Link } from 'react-router-dom';
import { AppShell } from '../../components/Layout.jsx';
import {
  AsyncBoundary,
  Card,
  EmptyState,
  LinkButton,
  SectionTitle,
  Stat,
} from '../../components/ui.jsx';
import { adminApi } from '../../api/client.js';
import { useAsync } from '../../lib/hooks.js';
import { useSession } from '../../context/SessionContext.jsx';
import { formatCents, formatDateTime, humanize } from '../../lib/format.js';
import {
  IconArrowRight,
  IconChart,
  IconShield,
  IconTransfer,
  IconUsers,
} from '../../components/icons.jsx';

export default function AdminOverviewPage() {
  const session = useSession();
  const overview = useAsync(() => adminApi.overview(), []);

  const accounts = overview.data?.accounts;
  const transfers = overview.data?.transfers;
  const funding = overview.data?.funding;
  const activity = overview.data?.recentActivity ?? [];

  const attentionCount = (accounts?.locked ?? 0) + (accounts?.frozen ?? 0) + (transfers?.pending ?? 0);

  return (
    <AppShell variant="admin">
      <div className="container page">
        <header className="mb-6">
          <h1 className="text-2xl">Operations overview</h1>
          <p className="muted mt-1">
            Signed in as {session.admin?.fullName || session.admin?.email}
            {session.admin?.lastLoginAt ? ` · last sign-in ${formatDateTime(session.admin.lastLoginAt)}` : ''}
          </p>
        </header>

        <AsyncBoundary loading={overview.loading} error={overview.error} onRetry={overview.reload}>
          <div className="stack gap-6">
            {/* ---- Review queue CTA ---- */}
            {transfers?.pending > 0 ? (
              <Card>
                <div className="card__body">
                  <div className="row wrap gap-4" style={{ alignItems: 'center' }}>
                    <span
                      className="avatar avatar--md"
                      style={{ background: 'var(--warning-100)', color: 'var(--warning-700)' }}
                      aria-hidden="true"
                    >
                      <IconTransfer size={20} />
                    </span>
                    <div className="grow" style={{ minWidth: '200px' }}>
                      <div className="strong">
                        {transfers.pending} transfer{transfers.pending === 1 ? '' : 's'} awaiting review
                      </div>
                      <div className="text-sm muted">
                        Customers cannot send money until these are approved or rejected.
                      </div>
                    </div>
                    <LinkButton to="/admin/transfers?status=pending" variant="primary">
                      Review queue
                    </LinkButton>
                  </div>
                </div>
              </Card>
            ) : null}

            {/* ---- Figures ---- */}
            <div className="stat-grid">
              <Stat
                as={Link}
                to="/admin/customers"
                label="Accounts"
                value={accounts?.total ?? 0}
                hint={`${accounts?.active ?? 0} active`}
              />
              <Stat
                label="Total balances"
                value={formatCents(accounts?.totalBalanceCents ?? 0, { compact: true })}
                hint="Held across all accounts"
              />
              <Stat
                as={Link}
                to="/admin/transfers?status=approved"
                label="Settled value"
                value={formatCents(transfers?.settledValueCents ?? 0, { compact: true })}
                hint={`${transfers?.approved ?? 0} approved transfers`}
              />
              <Stat
                as={Link}
                to="/admin/customers"
                label="Needs attention"
                value={attentionCount}
                hint="Frozen, locked or pending"
                tone={attentionCount > 0 ? 'attention' : undefined}
              />
            </div>

            <div className="admin-two-column">
              {/* ---- Breakdown ---- */}
              <div className="stack gap-5">
                <Card title="Accounts by status">
                  <StatusBreakdown
                    total={accounts?.total ?? 0}
                    rows={[
                      { status: 'active', count: accounts?.active ?? 0, tone: 'success' },
                      { status: 'frozen', count: accounts?.frozen ?? 0, tone: 'warning' },
                      { status: 'locked', count: accounts?.locked ?? 0, tone: 'danger' },
                      { status: 'disabled', count: accounts?.disabled ?? 0, tone: 'neutral' },
                    ]}
                  />
                </Card>

                <Card title="Funding">
                  <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
                    <Stat
                      label="Total funded"
                      value={formatCents(funding?.totalFundedCents ?? 0, { compact: true })}
                      hint="Deposits issued by staff"
                    />
                    <Stat label="Deposits" value={funding?.count ?? 0} hint="Funding transactions" />
                  </div>
                  <p className="text-xs subtle mt-4">
                    Deposits are the only way a balance increases on this platform. Transfers and
                    adjustments can also move money out.
                  </p>
                </Card>
              </div>

              {/* ---- Recent activity ---- */}
              <Card
                title="Recent staff activity"
                subtitle="Newest entries in the audit log"
                actions={
                  <Link to="/admin/audit" className="text-sm strong">
                    Full log
                  </Link>
                }
                bodyClassName="p0"
              >
                {activity.length === 0 ? (
                  <EmptyState icon={IconChart} title="No activity recorded yet" />
                ) : (
                  <div className="txn-list">
                    {activity.map((entry) => (
                      <div className="txn" key={entry.id} style={{ cursor: 'default' }}>
                        <span className="txn__icon">
                          <IconShield size={16} />
                        </span>
                        <span className="txn__body">
                          <span className="txn__title">{humanize(entry.action)}</span>
                          <span className="txn__meta">
                            <span>{entry.actor?.email ?? entry.actor?.type}</span>
                            {entry.target?.label ? (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="mono">{entry.target.label}</span>
                              </>
                            ) : null}
                          </span>
                        </span>
                        <span className="txn__meta">{formatDateTime(entry.createdAt)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </div>

            <SectionTitle>Jump to</SectionTitle>
            <div className="tile-row">
              <Link className="tile" to="/admin/customers">
                <span className="tile__icon">
                  <IconUsers size={18} />
                </span>
                Customers
              </Link>
              <Link className="tile" to="/admin/transfers?status=pending">
                <span className="tile__icon">
                  <IconTransfer size={18} />
                </span>
                Review queue
              </Link>
              <Link className="tile" to="/admin/audit">
                <span className="tile__icon">
                  <IconShield size={18} />
                </span>
                Audit log
              </Link>
              <Link className="tile" to="/admin/settings">
                <span className="tile__icon">
                  <IconChart size={18} />
                </span>
                Settings
              </Link>
            </div>

            <p className="text-xs subtle">
              <IconArrowRight size={12} style={{ display: 'inline', verticalAlign: '-1px' }} /> Every
              figure on this page comes from a single <code className="mono">/api/admin/overview</code>{' '}
              read. Actions are performed on the detail screens, not here.
            </p>
          </div>
        </AsyncBoundary>
      </div>
    </AppShell>
  );
}

/** Horizontal proportional bars: a table of numbers alone is hard to scan. */
function StatusBreakdown({ total, rows }) {
  const max = Math.max(1, ...rows.map((row) => row.count));

  return (
    <div className="stack gap-3">
      {rows.map((row) => (
        <div key={row.status}>
          <div className="row gap-2 mb-1">
            <span className="text-sm grow">{humanize(row.status)}</span>
            <span className="text-sm strong">{row.count}</span>
            <span className="text-sm subtle" style={{ minWidth: '4ch', textAlign: 'right' }}>
              {total > 0 ? `${Math.round((row.count / total) * 100)}%` : '0%'}
            </span>
          </div>
          <div
            style={{
              height: 8,
              background: 'var(--surface-muted)',
              borderRadius: 'var(--radius-full)',
              overflow: 'hidden',
            }}
            role="img"
            aria-label={`${row.count} ${row.status} accounts`}
          >
            <div
              style={{
                width: `${(row.count / max) * 100}%`,
                height: '100%',
                background: `var(--${toneVar(row.tone)})`,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function toneVar(tone) {
  return { success: 'success-700', warning: 'warning-600', danger: 'danger-600', neutral: 'ink-400' }[tone];
}
