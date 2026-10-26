import { useState } from 'react';
import { AppShell } from '../../components/Layout.jsx';
import { Alert, Button, Card, PageHeader, TextField } from '../../components/ui.jsx';
import { IconPlus } from '../../components/icons.jsx';

function parseExpiry(value) {
  const match = String(value ?? '').trim().match(/^(\d{2})\s*\/\s*(\d{2})$/);
  if (!match) return null;

  const month = Number(match[1]);
  const year = 2000 + Number(match[2]);
  if (month < 1 || month > 12) return null;

  const expires = new Date(year, month, 1);
  if (expires <= new Date()) return null;

  return { month: match[1], year: match[2] };
}

const EMPTY_FORM = { holder: '', number: '', expiry: '', cvv: '' };

export default function LinkCardPage() {
  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState({});
  const [notice, setNotice] = useState(null);
  const secure = typeof window !== 'undefined' && window.location.protocol === 'https:';

  const update = (field) => (event) => {
    setForm((current) => ({ ...current, [field]: event.target.value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
    setNotice(null);
  };

  const submit = (event) => {
    event.preventDefault();

    const digits = form.number.replace(/\D/g, '');
    const expiry = parseExpiry(form.expiry);
    const nextErrors = {};

    if (!form.holder.trim()) nextErrors.holder = 'Enter the name printed on the card.';
    if (!/^\d{13,19}$/.test(digits)) nextErrors.number = 'Enter a valid card number.';
    if (!expiry) nextErrors.expiry = 'Use MM/YY and a date in the future.';
    if (!/^\d{3,4}$/.test(form.cvv)) nextErrors.cvv = 'Enter the 3 or 4 digit security code.';

    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      setNotice(null);
      return;
    }

    setForm(EMPTY_FORM);
    setErrors({});
    setNotice(`Card ending in ${digits.slice(-4)} linked for this session.`);
  };

  return (
    <AppShell variant="customer">
      <div className="container page" style={{ maxWidth: 560 }}>
        <PageHeader
          title="Link another card"
          subtitle="Add a debit or credit card you want to use with your Northbridge account."
        />

        <Card>
          {!secure ? (
            <Alert tone="warning" title="Secure connection required">
              Card linking is only available over HTTPS. Open Northbridge through a secure connection
              to enter card details.
            </Alert>
          ) : null}

          {secure && notice ? <Alert tone="success">{notice}</Alert> : null}

          {secure ? (
            <>
              <form onSubmit={submit} noValidate autoComplete="off">
            <TextField
              label="Name on card"
              autoComplete="off"
              value={form.holder}
              onChange={update('holder')}
              error={errors.holder}
              required
            />

            <TextField
              label="Card number"
              inputMode="numeric"
              autoComplete="off"
              maxLength={23}
              placeholder="1234 5678 9012 3456"
              value={form.number}
              onChange={update('number')}
              error={errors.number}
              required
            />

            <div className="grid-2">
              <TextField
                label="Expiry (MM/YY)"
                inputMode="numeric"
                autoComplete="off"
                maxLength={5}
                placeholder="09/28"
                value={form.expiry}
                onChange={update('expiry')}
                error={errors.expiry}
                required
              />
              <TextField
                label="Security code"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                maxLength={4}
                value={form.cvv}
                onChange={update('cvv')}
                error={errors.cvv}
                required
              />
            </div>

            <div className="row wrap gap-2 mt-4">
              <Button type="submit" icon={IconPlus}>
                Link card
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setForm(EMPTY_FORM);
                  setErrors({});
                  setNotice(null);
                }}
              >
                Clear
              </Button>
            </div>
              </form>

              <p className="text-xs subtle mt-4">
                The security code is never kept. Contact Northbridge support if a card will not link.
              </p>
            </>
          ) : null}
        </Card>
      </div>
    </AppShell>
  );
}
