/**
 * Admin: open an account on a customer's behalf.
 *
 * Mirrors the customer registration form minus the terms checkbox, because the
 * staff member is the one accepting responsibility for the entry. The transfer
 * PIN may be omitted: if it is, the server generates one and returns it once so
 * it can be passed on out of band. Only the PIN's hash is ever stored.
 */

import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AppShell } from '../../components/Layout.jsx';
import {
  Alert,
  Button,
  Card,
  RadioCardGroup,
  SelectField,
  TextField,
} from '../../components/ui.jsx';
import { adminApi } from '../../api/client.js';
import { useAction } from '../../lib/hooks.js';
import { ACCOUNT_TYPE_OPTIONS } from '../../lib/format.js';
import { IconArrowLeft, IconCheck, IconPlus } from '../../components/icons.jsx';

const COUNTRIES = [
  'United States',
  'Canada',
  'United Kingdom',
  'Ireland',
  'Germany',
  'France',
  'Spain',
  'Italy',
  'Nigeria',
  'Kenya',
  'South Africa',
  'India',
  'Singapore',
  'Australia',
  'New Zealand',
];

const INITIAL = {
  fullName: '',
  dateOfBirth: '',
  email: '',
  phone: '',
  addressLine1: '',
  addressLine2: '',
  city: '',
  stateRegion: '',
  postalCode: '',
  country: 'United States',
  accountType: 'checking',
  password: '',
  transferPin: '',
};

function passwordChecks(password) {
  return [
    { label: 'At least 12 characters', met: password.length >= 12 },
    { label: 'A lowercase letter', met: /[a-z]/.test(password) },
    { label: 'An uppercase letter', met: /[A-Z]/.test(password) },
    { label: 'A number', met: /[0-9]/.test(password) },
    { label: 'A symbol', met: /[^A-Za-z0-9]/.test(password) },
  ];
}

export default function AdminNewCustomerPage() {
  const navigate = useNavigate();
  const [form, setForm] = useState(INITIAL);
  const [generatedPin, setGeneratedPin] = useState(null);

  const [submit, pending, error] = useAction(adminApi.createCustomer);

  const checks = useMemo(() => passwordChecks(form.password), [form.password]);
  const passwordOk = checks.every((check) => check.met);
  const fieldErrors = error?.fieldErrors ?? {};

  const update = (field) => (event) => {
    setForm((prev) => ({ ...prev, [field]: event.target.value }));
  };

  const submitForm = async (event) => {
    event.preventDefault();

    const payload = { ...form };
    // Blank PIN means "let the server generate one".
    if (!payload.transferPin.trim()) delete payload.transferPin;
    if (!payload.addressLine2.trim()) delete payload.addressLine2;

    const result = await submit(payload);
    if (!result) return;

    if (result.generatedTransferPin) {
      setGeneratedPin(result.generatedTransferPin);
    } else {
      navigate(`/admin/customers/${result.customer.id}`, { replace: true });
    }
  };

  /* ---- Success: generated PIN must be shown once ---- */
  if (generatedPin) {
    return (
      <AppShell variant="admin">
        <div className="container page" style={{ maxWidth: 560 }}>
          <Card>
            <div className="card__body text-center">
              <span
                className="avatar avatar--lg"
                style={{ margin: '0 auto var(--space-4)', background: 'var(--success-100)', color: 'var(--success-700)' }}
                aria-hidden="true"
              >
                <IconCheck size={28} />
              </span>
              <h1 className="text-xl">Account created</h1>
              <p className="muted mt-2">{form.fullName} can now sign in with the password you set.</p>

              <Alert tone="warning" className="mt-6" title="Transfer PIN — shown once">
                Only a hash of this PIN was stored, so it cannot be retrieved later. Read it out to
                the customer now, or have them set their own from the security page once signed in.
              </Alert>

              <div
                className="card mt-4"
                style={{ background: 'var(--surface-muted)' }}
              >
                <div className="card__body">
                  <div className="datalist__label">Generated transfer PIN</div>
                  <div className="text-3xl mono bold mt-2" style={{ letterSpacing: '0.2em' }}>
                    {generatedPin}
                  </div>
                </div>
              </div>

              <div className="row gap-3 mt-6" style={{ justifyContent: 'center' }}>
                <Button variant="primary" onClick={() => setGeneratedPin(null)}>
                  Create another
                </Button>
              </div>
            </div>
          </Card>
        </div>
      </AppShell>
    );
  }

  /* ---- Form ---- */
  return (
    <AppShell variant="admin">
      <div className="container page" style={{ maxWidth: 760 }}>
        <Link to="/admin/customers" className="row gap-2 text-sm muted mb-3">
          <IconArrowLeft size={16} />
          All customers
        </Link>

        <header className="mb-6">
          <h1 className="text-2xl">Open a customer account</h1>
          <p className="muted mt-1">
            Record the customer&#39;s details and set their initial sign-in password.
          </p>
        </header>

        {error ? <Alert tone="danger" title="Could not create the account">{error.message}</Alert> : null}

        <Card>
          <form onSubmit={submitForm} noValidate>
            <div className="card__body">
              <fieldset className="fieldset">
                <legend className="fieldset__legend">Identity</legend>

                <TextField
                  label="Full name"
                  required
                  value={form.fullName}
                  onChange={update('fullName')}
                  error={fieldErrors.fullName}
                />
                <div className="grid-2">
                  <TextField
                    label="Date of birth"
                    type="date"
                    required
                    value={form.dateOfBirth}
                    onChange={update('dateOfBirth')}
                    error={fieldErrors.dateOfBirth}
                    max={new Date().toISOString().slice(0, 10)}
                  />
                  <TextField
                    label="Phone"
                    type="tel"
                    required
                    inputMode="tel"
                    value={form.phone}
                    onChange={update('phone')}
                    error={fieldErrors.phone}
                  />
                </div>
                <TextField
                  label="Email address"
                  type="email"
                  required
                  inputMode="email"
                  value={form.email}
                  onChange={update('email')}
                  error={fieldErrors.email}
                />
              </fieldset>

              <fieldset className="fieldset">
                <legend className="fieldset__legend">Address</legend>

                <TextField
                  label="Address line 1"
                  required
                  value={form.addressLine1}
                  onChange={update('addressLine1')}
                  error={fieldErrors.addressLine1}
                />
                <TextField
                  label="Address line 2"
                  value={form.addressLine2}
                  onChange={update('addressLine2')}
                  error={fieldErrors.addressLine2}
                />
                <div className="grid-2">
                  <TextField
                    label="City"
                    required
                    value={form.city}
                    onChange={update('city')}
                    error={fieldErrors.city}
                  />
                  <TextField
                    label="State or region"
                    required
                    value={form.stateRegion}
                    onChange={update('stateRegion')}
                    error={fieldErrors.stateRegion}
                  />
                </div>
                <div className="grid-2">
                  <TextField
                    label="Postal code"
                    required
                    value={form.postalCode}
                    onChange={update('postalCode')}
                    error={fieldErrors.postalCode}
                  />
                  <SelectField
                    label="Country"
                    required
                    value={form.country}
                    onChange={update('country')}
                    options={COUNTRIES.map((country) => ({ value: country, label: country }))}
                    error={fieldErrors.country}
                  />
                </div>
              </fieldset>

              <fieldset className="fieldset">
                <legend className="fieldset__legend">Account</legend>
                <RadioCardGroup
                  legend="Account type"
                  name="accountType"
                  value={form.accountType}
                  onChange={(value) => setForm((prev) => ({ ...prev, accountType: value }))}
                  options={ACCOUNT_TYPE_OPTIONS}
                  columns={3}
                />
              </fieldset>

              <fieldset className="fieldset">
                <legend className="fieldset__legend">Credentials</legend>

                <TextField
                  label="Initial sign-in password"
                  type="text"
                  required
                  autoComplete="off"
                  value={form.password}
                  onChange={update('password')}
                  error={fieldErrors.password}
                  hint="Share this with the customer over a channel you trust. They can change it from the security page."
                />

                <ul className="stack gap-1 mb-4" aria-live="polite">
                  {checks.map((check) => (
                    <li
                      key={check.label}
                      className={`text-xs ${check.met ? 'positive' : 'subtle'}`}
                      style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}
                    >
                      <IconCheck size={13} style={{ opacity: check.met ? 1 : 0.25 }} />
                      {check.label}
                    </li>
                  ))}
                </ul>

                <TextField
                  label="Transfer PIN (optional)"
                  inputMode="numeric"
                  maxLength={4}
                  value={form.transferPin}
                  onChange={(event) =>
                    setForm((prev) => ({
                      ...prev,
                      transferPin: event.target.value.replace(/\D/g, '').slice(0, 4),
                    }))
                  }
                  error={fieldErrors.transferPin}
                  inputClassName="pin-input"
                  placeholder="0000"
                  hint="Leave blank to have Northbridge generate one. If you supply a PIN it must differ from the password."
                />
              </fieldset>
            </div>

            <div className="card__footer">
              <div className="row gap-2">
                <Button type="submit" variant="primary" icon={IconPlus} loading={pending} disabled={!passwordOk}>
                  Create account
                </Button>
                <Button type="button" variant="ghost" onClick={() => navigate('/admin/customers')} disabled={pending}>
                  Cancel
                </Button>
              </div>
            </div>
          </form>
        </Card>

        <Alert tone="info" title="After creation">
          The account starts at a zero balance. Use “Fund account” on the customer record to issue
          an opening deposit — that is the only way a balance increases on this platform.
        </Alert>
      </div>
    </AppShell>
  );
}