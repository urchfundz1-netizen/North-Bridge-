/**
 * Admin sign-in.
 *
 * Shares the customer sign-in's mobile layout so both entry points read the
 * same way. It stays visually distinct through the shield avatar, the
 * "Staff access only" subtitle and no link back into the retail experience.
 * An admin session and a customer session are stored in separate cookies, so
 * signing in here does not disturb a customer's own session in the same
 * browser.
 */

import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AuthLayout } from '../public/AuthLayout.jsx';
import { PublicHeader } from '../../components/Layout.jsx';
import { Alert, Button, SecretField, TextField } from '../../components/ui.jsx';
import { useSession } from '../../context/SessionContext.jsx';
import { useAction } from '../../lib/hooks.js';
import { IconLock, IconMail, IconShield } from '../../components/icons.jsx';

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
        <AuthLayout
          title="Admin console"
          subtitle="Staff access only"
          variant="dark"
          avatar={IconShield}
        >
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
              icon={IconMail}
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
              icon={IconLock}
              inline
            />

            <Button type="submit" variant="primary" size="lg" className="btn--block" loading={pending} icon={IconLock}>
              Sign in to console
            </Button>
          </form>

          <p className="text-sm muted mt-6 text-center">
            Are you a customer?{' '}
            <Link to="/login" style={{ fontWeight: 600 }}>
              Sign in to your account
            </Link>
          </p>
        </AuthLayout>
      </main>
    </div>
  );
}
