/**
 * Cards.
 *
 * The account is a Northbridge checking line, and this screen presents the
 * debit card that draws on it. The card number is derived from the account
 * number so the same account always shows the same card, and it is masked by
 * default - revealing it is an explicit action, never the opening state.
 */

import { useState } from 'react';
import { AppShell } from '../../components/Layout.jsx';
import {
  AsyncBoundary,
  Button,
  Card,
  DefinitionList,
  StatusBadge,
} from '../../components/ui.jsx';
import { customerApi } from '../../api/client.js';
import { useAsync } from '../../lib/hooks.js';
import { formatDate } from '../../lib/format.js';
import { useSession } from '../../context/SessionContext.jsx';
import { IconCard, IconEye } from '../../components/icons.jsx';

/** Card numbers are printed in four groups of four. */
function groupCardNumber(digits) {
  return String(digits ?? '').replace(/(\d{4})(?=\d)/g, '$1 ').trim();
}

/** Mask all but the last four digits, keeping the four-group rhythm. */
function maskCardNumber(digits) {
  const value = String(digits ?? '');
  if (value.length <= 4) return value;
  return `•••• •••• •••• ${value.slice(-4)}`;
}

/**
 * Derive a stable 16-digit card number from the 10-digit account number.
 * The account is the source of truth; the card number is a presentation of it,
 * so a customer sees the same card on every visit without a second data model.
 * The remaining digits come from a small deterministic hash of the account
 * number, then a Luhn-applicable check digit is appended.
 */
function cardNumberFor(accountNumber) {
  const digits = String(accountNumber ?? '').replace(/\D/g, '');
  if (!digits) return '';

  let hash = 0;
  for (const char of digits) {
    hash = (hash * 31 + char.charCodeAt(0)) % 10 ** 9;
  }

  const filler = String(hash).padStart(9, '0').slice(0, 5);
  const base = `${digits}${filler}`.slice(0, 15).padStart(15, '0');

  const sum = [...base].reduce((total, digit, index) => {
    const value = Number(digit) * (index % 2 === 0 ? 2 : 1);
    return total + (value > 9 ? value - 9 : value);
  }, 0);

  return `${base}${(10 - (sum % 10)) % 10}`;
}

/** Expiry: five years after the account was opened, printed as MM/YY. */
function expiryFor(createdAt) {
  const issued = createdAt ? new Date(createdAt) : new Date();
  const expires = new Date(Number.isNaN(issued.getTime()) ? Date.now() : issued.getTime());
  expires.setFullYear(expires.getFullYear() + 5);
  return {
    month: String(expires.getMonth() + 1).padStart(2, '0'),
    year: String(expires.getFullYear()).slice(-2),
  };
}

export default function CardsPage() {
  const session = useSession();
  const profile = useAsync(() => customerApi.profile(), []);
  const [revealed, setRevealed] = useState(false);

  const customer = profile.data?.customer ?? session.customer;
  const accountNumber = customer?.accountNumber ?? '';
  const cardNumber = cardNumberFor(accountNumber);
  const expiry = expiryFor(customer?.createdAt);

  return (
    <AppShell variant="customer">
      <div className="container page" style={{ maxWidth: 760 }}>
        <AsyncBoundary loading={profile.loading} error={profile.error} onRetry={profile.reload}>
          {/* ---- Card face ---- */}
          <section className="payment-card mb-6" aria-label="Debit card">
            <header className="payment-card__top">
              <span className="payment-card__brand">Northbridge</span>
              <IconCard size={26} className="payment-card__logo" />
            </header>

            <div className="payment-card__chip" aria-hidden="true" />

            <p className="payment-card__number">
              {revealed ? groupCardNumber(cardNumber) : maskCardNumber(cardNumber)}
            </p>

            <footer className="payment-card__foot">
              <div className="payment-card__field">
                <span className="payment-card__field-label">Card holder</span>
                <span className="payment-card__field-value">
                  {customer?.fullName ?? 'Northbridge customer'}
                </span>
              </div>
              <div className="payment-card__field">
                <span className="payment-card__field-label">Expires</span>
                <span className="payment-card__field-value">
                  {expiry.month}/{expiry.year}
                </span>
              </div>
            </footer>
          </section>

          <div className="row wrap gap-2 mb-6">
            <Button
              variant="secondary"
              icon={IconEye}
              onClick={() => setRevealed((value) => !value)}
            >
              {revealed ? 'Hide card details' : 'Show card details'}
            </Button>
          </div>

          {/* ---- Details ---- */}
          <div className="stack gap-5">
            <Card title="Card details" subtitle="Treat these like cash - never share them.">
              <DefinitionList
                items={[
                  {
                    label: 'Card number',
                    value: (
                      <span className="card-number-row">
                        {revealed ? groupCardNumber(cardNumber) : maskCardNumber(cardNumber)}
                        <button
                          type="button"
                          className="card-number-row__toggle"
                          onClick={() => setRevealed((value) => !value)}
                          aria-label={revealed ? 'Hide card number' : 'Show card number'}
                        >
                          <IconEye size={16} />
                        </button>
                      </span>
                    ),
                  },
                  { label: 'Card holder', value: customer?.fullName ?? '--' },
                  { label: 'Expires', value: `${expiry.month}/${expiry.year}` },
                  { label: 'Linked account', value: accountNumber || '--' },
                  { label: 'Card type', value: 'Debit' },
                  {
                    label: 'Opened',
                    value: customer?.createdAt ? formatDate(customer.createdAt) : '--',
                  },
                ]}
                columns={2}
              />
            </Card>

            <Card title="Card status">
              <div className="row wrap gap-3">
                <StatusBadge status={customer?.status} />
                <span className="text-sm muted">
                  {customer?.status === 'active'
                    ? 'Your card is active and can be used for purchases and transfers.'
                    : 'Card use follows your account status. Contact Northbridge support to restore access.'}
                </span>
              </div>
            </Card>
          </div>
        </AsyncBoundary>
      </div>
    </AppShell>
  );
}
