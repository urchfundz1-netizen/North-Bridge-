/**
 * Customer registration.
 *
 * Field names map 1:1 onto the server's `registerSchema`, so any rejection comes
 * back keyed by the same name the field uses. Client-side checks are limited to
 * confirming the two secrets match, because duplicating the server's password
 * policy rules would let the two drift apart.
 */

import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AuthLayout } from './AuthLayout.jsx';
import { PublicHeader } from '../../components/Layout.jsx';
import { Alert, Button, RadioCardGroup, SecretField, TextField } from '../../components/ui.jsx';
import { useAction } from '../../lib/hooks.js';
import { useSession } from '../../context/SessionContext.jsx';
import { ACCOUNT_TYPE_OPTIONS } from '../../lib/format.js';
import { IconCheck } from '../../components/icons.jsx';

const INITIAL = {
  fullName: '',
  email: '',
  accountType: 'checking',
  password: '',
  confirmPassword: '',
  transferPin: '',
  confirmTransferPin: '',
  acceptTerms: false,
};

/** Live feedback for the password rules the server enforces. */
function passwordChecks(password) {
  return [
    { label: 'At least 12 characters', met: password.length >= 12 },
    { label: 'A lowercase letter', met: /[a-z]/.test(password) },
    { label: 'An uppercase letter', met: /[A-Z]/.test(password) },
    { label: 'A number', met: /[0-9]/.test(password) },
    { label: 'A symbol', met: /[^A-Za-z0-9]/.test(password) },
  ];
}

export default function RegisterPage() {
  const navigate = useNavigate();
  const session = useSession();
  const [form, setForm] = useState(INITIAL);
  const [submit, pending, error, resetError] = useAction(session.register);

  const checks = useMemo(() => passwordChecks(form.password), [form.password]);
  const fieldErrors = error?.fieldErrors ?? {};

  const update = (field) => (event) => {
    resetError();
    const value = event?.target?.type === 'checkbox' ? event.target.checked : event?.target?.value;
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const mismatches = {
    confirmPassword:
      form.confirmPassword && form.confirmPassword !== form.password
        ? 'Passwords do not match.'
        : undefined,
    confirmTransferPin:
      form.confirmTransferPin && form.confirmTransferPin !== form.transferPin
        ? 'Transfer PINs do not match.'
        : undefined,
    transferPin:
      form.transferPin && form.transferPin === form.password
        ? 'Your transfer PIN must differ from your password.'
        : undefined,
  };

  const submitForm = async (event) => {
    event.preventDefault();
    const result = await submit(form);
    if (!result) return;
    // Registration signs the customer in server-side, so go straight to the
    // dashboard and let them add a profile picture from the profile page.
    navigate('/dashboard?welcome=1', { replace: true });
  };

  return (
    <div className="app-shell">
      <PublicHeader minimal />
      <main id="main" className="app-main">
        <AuthLayout
          title="Open your account"
          subtitle="It takes about two minutes. You will be signed in as soon as it is created."
        >
          {error ? (
            <Alert tone="danger" title="We could not open your account">
              {error.message}
            </Alert>
          ) : null}

          <form onSubmit={submitForm} noValidate>
            <fieldset className="fieldset">
              <legend className="fieldset__legend">About you</legend>

              <TextField
                label="Full name"
                required
                autoComplete="name"
                value={form.fullName}
                onChange={update('fullName')}
                error={fieldErrors.fullName}
                placeholder="Enter your name"
              />

              <TextField
                label="Email address"
                type="email"
                required
                autoComplete="email"
                inputMode="email"
                value={form.email}
                onChange={update('email')}
                error={fieldErrors.email}
                placeholder="you@example.com"
                hint="Used for sign-in and receipts"
              />
            </fieldset>

            <fieldset className="fieldset">
              <legend className="fieldset__legend">Account</legend>

              <RadioCardGroup
                legend="Account type"
                name="accountType"
                value={form.accountType}
                onChange={(value) => {
                  resetError();
                  setForm((prev) => ({ ...prev, accountType: value }));
                }}
                options={ACCOUNT_TYPE_OPTIONS}
                columns={3}
              />
              {fieldErrors.accountType ? (
                <span className="field__error" role="alert">
                  {fieldErrors.accountType}
                </span>
              ) : null}
            </fieldset>

            <fieldset className="fieldset">
              <legend className="fieldset__legend">Security</legend>

              <SecretField
                label="Password"
                required
                autoComplete="new-password"
                value={form.password}
                onChange={update('password')}
                error={fieldErrors.password}
                hint="Used to sign in to this portal"
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

              <SecretField
                label="Confirm password"
                required
                autoComplete="new-password"
                value={form.confirmPassword}
                onChange={update('confirmPassword')}
                error={fieldErrors.confirmPassword ?? mismatches.confirmPassword}
              />

              <SecretField
                label="4-digit transfer PIN"

                revealLabel="PIN"
                required
                inputMode="numeric"
                autoComplete="off"
                maxLength={4}
                pattern="[0-9]{4}"
                value={form.transferPin}
                onChange={(event) => {
                  resetError();
                  // Keep it to digits as the user types rather than rejecting the
                  // paste afterwards.
                  setForm((prev) => ({
                    ...prev,
                    transferPin: event.target.value.replace(/\D/g, '').slice(0, 4),
                  }));
                }}
                error={fieldErrors.transferPin ?? mismatches.transferPin}
                inputClassName="pin-input"
                placeholder="0000"
                hint="Required to send money. Must differ from your password."
              />

              <SecretField
                label="Confirm transfer PIN"

                revealLabel="PIN"
                required
                inputMode="numeric"
                autoComplete="off"
                maxLength={4}
                value={form.confirmTransferPin}
                onChange={(event) => {
                  resetError();
                  setForm((prev) => ({
                    ...prev,
                    confirmTransferPin: event.target.value.replace(/\D/g, '').slice(0, 4),
                  }));
                }}
                error={fieldErrors.confirmTransferPin ?? mismatches.confirmTransferPin}
                inputClassName="pin-input"
                placeholder="0000"
              />
            </fieldset>

            <div className="field">
              <label className="radio-card" htmlFor="acceptTerms">
                <input
                  id="acceptTerms"
                  type="checkbox"
                  checked={form.acceptTerms}
                  onChange={update('acceptTerms')}
                />
                <span className="radio-card__body">
                  <span className="radio-card__title">I accept the account terms</span>
                  <span className="radio-card__desc">
                    I confirm the details above are accurate and accept the account terms.
                  </span>
                </span>
              </label>
              {fieldErrors.acceptTerms ? (
                <span className="field__error" role="alert">
                  {fieldErrors.acceptTerms}
                </span>
              ) : null}
            </div>

            <Button
              type="submit"
              variant="primary"
              size="lg"
              className="btn--block"
              loading={pending}
              disabled={!form.acceptTerms}
            >
              Create account
            </Button>

            <p className="text-xs subtle mt-3 text-center">
              Your password and transfer PIN are hashed separately. Neither is ever sent back to your
              browser.
            </p>
          </form>

          <p className="text-sm muted mt-6 text-center">
            Already have an account?{' '}
            <Link to="/login" style={{ fontWeight: 600 }}>
              Sign in
            </Link>
          </p>
        </AuthLayout>
      </main>
    </div>
  );
}
