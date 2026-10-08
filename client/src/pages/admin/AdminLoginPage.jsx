/**
 * Admin sign-in.
 *
 * Deliberately visually distinct from the customer portal: a darker header, a
 * "Staff only" badge, and no link back into the retail experience. An admin
 * session and a customer session are stored in separate cookies, so signing in
 * here does not disturb a customer's own session in the same browser.
 */

import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PublicHeader } from '../../components/Layout.jsx';
import { Alert, Button, Card, SecretField, TextField } from '../../components/ui.jsx';
import { useSession } from '../../context/SessionContext.jsx';
import { useAction } from '../../lib/hooks.js';
import { IconArrowLeft, IconLock, IconShield } from '../../components/icons.jsx';

export default function AdminLoginPage() {
  const session = useSession();
  const navigate = useNavigate();

  const [form, setForm] = useState({ email: '', password: '' });
  const [runLogin, pending, error] = useAction(session.login);

  const submit = async (event) => {
    event.preventDefault();
    const result = await runLogin(form);
    if (!result) return;
    navigate('/admin', { replace: true });
  };

  const fieldErrors = error?.fieldErrors ?? {};

  return (
    <div className="app-shell">
      <PublicHeader minimal />
      <main id="main" className="app-main">
        <div className="container page">
          <div style={{ maxWidth: 440, margin: '0 auto' }}>
            <Link to="/" className="row gap-2 text-sm muted mb-4">
              <IconArrowLeft size={16} />
              Back to Northbridge
            </Link>

            <Card>
              <div className="card__body">
                <div className="row gap-3 mb-4">
                  <span
                    className="avatar avatar--md"
                    style={{ background: 'var(--navy-900)', color: 'var(--white)' }}
                    aria-hidden="true"
                  >
                    <IconShield size={20} />
                  </span>
                  <div>
                    <h1 className="text-xl">Admin console</h1>
                    <p className="text-sm muted">Staff access only</p>
                  </div>
                </div>

                {error ? (
                  <Alert tone="danger" title="Sign-in failed">
                    {error.message}
                  </Alert>
                ) : null}

                <form onSubmit={submit} noValidate>
                  <TextField
                    label="Staff email"
                    type="email"
                    required
                    autoComplete="username"
                    inputMode="email"
                    value={form.email}
                    onChange={(event) => {
                      setForm((prev) => ({ ...prev, email: event.target.value }));
                    }}
                    error={fieldErrors.email}
                    placeholder="admin@northbridge.bank"
                    autoFocus
                  />

                  <SecretField
                    label="Password"
                    required
                    autoComplete="current-password"
                    value={form.password}
                    onChange={(event) => {
                      setForm((prev) => ({ ...prev, password: event.target.value }));
                    }}
                    error={fieldErrors.password}
                  />

                  <Button type="submit" variant="primary" size="lg" className="btn--block" loading={pending} icon={IconLock}>
                    Sign in to console
                  </Button>
                </form>
              </div>

              <footer className="card__footer">
                <p className="text-xs subtle text-center">
                  Every action taken in this console is recorded in the audit log with your staff
                  account, the time and the reason you give.
                </p>
              </footer>
            </Card>

            <p className="text-sm muted mt-6 text-center">
              Are you a customer?{' '}
              <Link to="/login" style={{ fontWeight: 600 }}>
                Sign in to your account
              </Link>
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
