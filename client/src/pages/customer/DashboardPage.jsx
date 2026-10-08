/**
 * Customer dashboard.
 *
 * One `/api/account/summary` round trip fills the whole screen. A frozen or
 * disabled account renders the same layout with transfers replaced by an
 * explanation, rather than hiding the page - the customer still needs to see
 * their balance and history.
 */

import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AppShell } from '../../components/Layout.jsx';
import {
  Alert,
  AsyncBoundary,

  Card,
  LinkButton,


  StatusBadge,
} from '../../components/ui.jsx';
import { LedgerRow } from '../../components/Transactions.jsx';
import {
  IconArrowRight,
  IconCheckCircle,
  IconHistory,
  IconSparkle,
  IconTransfer,
} from '../../components/icons.jsx';
import { customerApi } from '../../api/client.js';
import { useAsync, useOnline } from '../../lib/hooks.js';
import { formatCents, formatDateTime } from '../../lib/format.js';

export default function DashboardPage() {
  const [params] = useSearchParams();
  const online = useOnline();
  // Pending transfers are a detail most visits never need, so the panel that
  // holds them - counts included - starts closed. The subtitle keeps both
  // figures visible while collapsed, so a hidden panel never hides the fact
  // that something is waiting.
  const [reviewOpen, setReviewOpen] = useState(false);


  const summary = useAsync(() => customerApi.summary(), []);
  const customer = summary.data?.customer;
  const rules = summary.data?.rules;

  const isFrozen = customer?.status === 'frozen';
  const isBlocked = customer?.status === 'locked' || customer?.status === 'disabled';
  const pendingTotal = summary.data?.pendingTransfers?.total ?? 0;
  const receiptCount = summary.data?.receiptCount ?? 0;

  return (
    <AppShell variant="customer">
      <div className="container page">
        {!online ? (
          <Alert tone="warning" title="You are offline">
            Figures below were loaded before the connection dropped. Actions will fail until you are
            back online.
          </Alert>
        ) : null}

        {params.get('welcome') ? (
          <Alert tone="success" title="Your account is open">
            Welcome to Northbridge. Add a profile picture from your profile page whenever you are
            ready.
          </Alert>
        ) : null}

        {params.get('notice') === 'frozen' || isFrozen ? (
          <Alert tone="warning" title="Your account is frozen">
            You can sign in and review your balance and history, but outgoing transfers are disabled
            until an administrator lifts the freeze.
          </Alert>
        ) : null}

        {isBlocked ? (
          <Alert tone="danger" title={`Your account is ${customer.status}`}>
            {customer.statusReason || 'Contact Northbridge support to restore access.'}
          </Alert>
        ) : null}

        <AsyncBoundary loading={summary.loading} error={summary.error} onRetry={summary.reload}>
          {customer ? (
            <>
              <header className="row wrap gap-4 mb-6">
                <div className="grow">
                  <h1 className="text-2xl">Good to see you, {firstName(customer.fullName)}</h1>
                  <p className="muted mt-1">
                    Last signed in{' '}
                    {customer.lastLoginAt ? formatDateTime(customer.lastLoginAt) : 'this session'}
                  </p>
                </div>
              </header>

              {/* ---- Balance hero ---- */}
              <section className="balance-hero mb-6">
                <div className="row wrap gap-4" style={{ alignItems: 'flex-start' }}>
                  <div className="grow">
                    <div className="balance-hero__label">Available balance</div>
                    <div className="balance-hero__amount">{customer.balanceFormatted}</div>
                    <p className="balance-hero__identity mono">
                      {customer.accountNumber}
                      <span aria-hidden="true"> · </span>
                      {titleCase(customer.accountType)} account
                    </p>
                  </div>
                  <div className="row gap-2 no-print">
                    <LinkButton to="/transfer" variant="accent" icon={IconTransfer} size="lg">
                      Transfer
                    </LinkButton>
                    <LinkButton to="/transactions" variant="onDark" icon={IconHistory} size="lg">
                      Activity
                    </LinkButton>
                  </div>
                </div>

                <div className="balance-hero__meta">
                  <div className="balance-hero__meta-item">
                    <span className="balance-hero__meta-label">Credited to date</span>
                    <span className="balance-hero__meta-value">
                      {formatCents(summary.data.statement?.creditedCents)}
                    </span>
                  </div>
                  <div className="balance-hero__meta-item">
                    <span className="balance-hero__meta-label">Debited to date</span>
                    <span className="balance-hero__meta-value">
                      {formatCents(summary.data.statement?.debitedCents)}
                    </span>
                  </div>
                </div>

                <div className="balance-hero__status">
                  <StatusBadge status={customer.status} />
                </div>
              </section>

              {/* ---- Quick actions ---- */}
              <section className="tile-row mb-6 no-print" aria-label="Quick actions">
                <Link className="tile" to="/transfer">
                  <span className="tile__icon">
                    <IconTransfer size={18} />
                  </span>
                  Send money
                </Link>
                <Link className="tile" to="/transactions">
                  <span className="tile__icon">
                    <IconHistory size={18} />
                  </span>
                  Activity
                </Link>
                <Link className="tile" to="/profile">
                  <span className="tile__icon">
                    <IconSparkle size={18} />
                  </span>
                  Profile
                </Link>
              </section>

              <div
                style={{
                  display: 'grid',
                  gap: 'var(--space-5)',
                  gridTemplateColumns: '1fr',
                }}
                className="dashboard-columns"
              >
                {/* ---- Recent activity ---- */}
                <Card
                  title="Recent activity"
                  subtitle="Most recent movements on your account"
                  actions={
                    <Link to="/transactions" className="text-sm strong">
                      Full statement
                    </Link>
                  }
                  bodyClassName="p0"
                >
                  {summary.data.recentTransactions.length === 0 ? (
                    <div className="empty-state">
                      <IconHistory size={48} className="empty-state__icon" />
                      <p className="strong" style={{ color: 'var(--ink-800)' }}>
                        No activity yet
                      </p>
                      <p className="text-sm mt-1">
                        Once your account is funded, every movement will appear here.
                      </p>
                    </div>
                  ) : (
                    <div className="txn-list">
                      {summary.data.recentTransactions.map((entry) => (
                        <LedgerRow key={entry.id} entry={entry} />
                      ))}
                    </div>
                  )}
                </Card>

                {/* ---- Review activity ---- */}
                <Card
                  title="Review activity"
                  subtitle={
                    reviewOpen
                      ? 'Transfers waiting on approval and receipts you can download'
                      : `${pendingTotal} ${pendingTotal === 1 ? 'transfer' : 'transfers'} waiting · ${receiptCount} ${receiptCount === 1 ? 'receipt' : 'receipts'} issued`
                  }
                  actions={
                    <Link to="/transactions?view=transfers&status=pending" className="text-sm strong">
                      Review all
                    </Link>
                  }
                  toggle={{
                    expanded: reviewOpen,
                    onToggle: () => setReviewOpen((open) => !open),
                    controls: 'review-activity-details',
                  }}
                  // Collapsed, the body is empty: drop its padding so the card
                  // closes up to a single disclosure row.
                  bodyClassName={reviewOpen ? '' : 'p0'}
                >
                  {reviewOpen ? (
                    <div id="review-activity-details">
                      {/* Plain figures, not links: the card's "Review all" action is
                          the one way out, and both lists live under Activity. */}
                      <div className="card-summary">
                        <div className="card-summary__item card-summary__item--row">
                          <span className="card-summary__group">
                            <span className="card-summary__label">Pending review</span>
                            <span className="card-summary__value">
                              {pendingTotal} {pendingTotal === 1 ? 'transfer' : 'transfers'}
                            </span>
                          </span>
                          <span className="card-summary__group">
                            <span className="card-summary__label">Receipts</span>
                            <span className="card-summary__value">{receiptCount}</span>
                          </span>
                        </div>
                      </div>

                      <div className="review-details">
                        <h3 className="review-details__title">
                          Awaiting review
                          <span className="review-details__count">
                            {pendingTotal} transfer{pendingTotal === 1 ? '' : 's'} submitted but not yet
                            approved
                          </span>
                        </h3>
                        {pendingTotal === 0 ? (
                          <div className="empty-state">
                            <IconCheckCircle size={44} className="empty-state__icon" />
                            <p className="strong" style={{ color: 'var(--ink-800)' }}>
                              Nothing waiting
                            </p>
                            <p className="text-sm mt-1">
                              Every transfer you have submitted has been approved.
                            </p>
                          </div>
                        ) : (
                          <>
                            <div className="txn-list txn-list--inset">
                              {summary.data.pendingTransfers.rows.map((transfer) => (
                                <Link className="txn" key={transfer.id} to={`/transfers/${transfer.id}`}>
                                  <span className="txn__icon txn__icon--debit">
                                    <IconTransfer size={18} />
                                  </span>
                                  <span className="txn__body">
                                    <span className="txn__title">{transfer.recipient?.name}</span>
                                    <span className="txn__meta">
                                      <span className="mono">{transfer.referenceNumber}</span>
                                      <span aria-hidden="true">·</span>
                                      <span>Submitted {formatDateTime(transfer.requestedAt)}</span>
                                    </span>
                                  </span>
                                  <span className="txn__amount">−{transfer.amountFormatted}</span>
                                  <IconArrowRight size={16} className="subtle" />
                                </Link>
                              ))}
                            </div>
                            <p className="text-xs subtle mt-4">
                              Funds leave your account only once Northbridge approves the transfer. You
                              can withdraw a pending transfer at any time before then.
                            </p>
                          </>
                        )}
                      </div>
                    </div>
                  ) : null}
                </Card>

                {/* ---- Account standing ---- */}
                <div className="stack gap-5">
                  <Card title="Account details">
                    <dl className="datalist">
                      <div className="datalist__item">
                        <dt className="datalist__label">Account number</dt>
                        <dd className="datalist__value mono">{customer.accountNumber}</dd>
                      </div>
                      <div className="datalist__item">
                        <dt className="datalist__label">Account type</dt>
                        <dd className="datalist__value">{titleCase(customer.accountType)}</dd>
                      </div>
                      <div className="datalist__item">
                        <dt className="datalist__label">Status</dt>
                        <dd className="datalist__value">
                          <StatusBadge status={customer.status} />
                        </dd>
                      </div>
                      <div className="datalist__item">
                        <dt className="datalist__label">Opened</dt>
                        <dd className="datalist__value">{formatDateTime(customer.createdAt)}</dd>
                      </div>
                    </dl>
                  </Card>

                  <Card title="Transfer limits">
                    <dl className="datalist">
                      <div className="datalist__item">
                        <dt className="datalist__label">Minimum</dt>
                        <dd className="datalist__value">{formatCents(rules?.minTransferCents)}</dd>
                      </div>
                      <div className="datalist__item">
                        <dt className="datalist__label">Maximum</dt>
                        <dd className="datalist__value">{formatCents(rules?.maxTransferCents)}</dd>
                      </div>
                      <div className="datalist__item">
                        <dt className="datalist__label">Processing fee</dt>
                        <dd className="datalist__value">{formatCents(rules?.transferFeeCents)}</dd>
                      </div>
                      <div className="datalist__item">
                        <dt className="datalist__label">Approval</dt>
                        <dd className="datalist__value">
                          {rules?.requireApproval ? 'Required before funds move' : 'Immediate'}
                        </dd>
                      </div>
                    </dl>
                    <p className="text-xs subtle mt-4">
                      Need to stop outgoing payments? You can{' '}
                      <Link to="/security">freeze your account</Link> at any time.
                    </p>
                  </Card>

                  {!summary.data.recentTransactions.length ? (
                    <Alert tone="info" title="Waiting on funding">
                      This platform does not self-fund accounts. Ask a Northbridge administrator to
                      credit your account to start transferring.
                    </Alert>
                  ) : null}

                  {customer.transferPinLockedUntil ? (
                    <Alert tone="warning" title="Transfer PIN temporarily locked">
                      Too many incorrect PIN attempts. Wait until{' '}
                      {formatDateTime(customer.transferPinLockedUntil)} before trying again.
                    </Alert>
                  ) : null}
                </div>
              </div>
            </>
          ) : null}
        </AsyncBoundary>
      </div>
    </AppShell>
  );
}

function firstName(fullName = '') {
  return String(fullName).trim().split(/\s+/)[0] || 'there';
}

function titleCase(value = '') {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

