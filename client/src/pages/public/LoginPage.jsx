/**
 * Customer sign-in.
 *
 * The server checks the password and issues an httpOnly session cookie on
 * success; nothing is persisted client-side. A wrong password is answered with
 * the same generic message whether or not the address exists, and the server
 * applies its own throttle, so this form does not try to second-guess when a
 * lockout has been applied.
 */

import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AuthLayout } from './AuthLayout.jsx';
import { PublicHeader } from '../../components/Layout.jsx';
import { Alert, Button, SecretField, TextField } from '../../components/ui.jsx';
import { useSession } from '../../context/SessionContext.jsx';
import { useAction } from '../../lib/hooks.js';
import { IconLock, IconMail, IconShield } from '../../components/icons.jsx';

export default function LoginPage() {
  const session = useSession();
  const navigate = useNavigate();
  const location = useLocation();

  const [form, setForm] = useState({ email: '', password: '' });
  const [runLogin, loginPending, loginError] = useAction(session.login);

  const redirectTo = location.state?.from ?? '/dashboard';

  const update = (field) => (event) => {
    setForm((prev) => ({ ...prev, [field]: event.target.value }));
  };

  const submit = async (event) => {
    event.preventDefault();
    const result = await runLogin(form);
    if (!result) return;

    // A frozen account still signs in, but must not be sent to a screen that
    // offers transfers it cannot perform.
    const restrictions = result?.restrictions ?? [];
    navigate(restrictions.includes('frozen') ? '/dashboard?notice=frozen' : redirectTo, {
      replace: true,
    });
  };

  return (
    <div className="app-shell">
      <PublicHeader minimal />
      <main id="main" className="app-main">
        <AuthLayout
          title="Welcome back"
          subtitle="Sign in to your Northbridge account."
          variant="dark"
        >
          {location.state?.expired ? (
            <Alert tone="info" title="Your session expired">
              For your security you were signed out. Please sign in again.
            </Alert>
          ) : null}

          {loginError ? (
            <Alert tone="danger" title="We could not sign you in">
              {loginError.message}
            </Alert>
          ) : null}

          <form onSubmit={submit} noValidate>
            <TextField
              label="Email address"
              type="email"
              name="email"
              autoComplete="username"
              inputMode="email"
              required
              value={form.email}
              onChange={update('email')}
              error={loginError?.fieldErrors?.email}
              placeholder="you@example.com"
              icon={IconMail}
              autoFocus
            />

            <SecretField
              label="Password"
              name="password"
              autoComplete="current-password"
              required
              value={form.password}
              onChange={update('password')}
              error={loginError?.fieldErrors?.password}
              placeholder="Your password"
              maxLength={13}
              icon={IconLock}
              inline
            />

            <Button
              type="submit"
              variant="primary"
              size="lg"
              loading={loginPending}
              className="btn--block"
              icon={IconShield}
            >
              Sign in
            </Button>
          </form>
        </AuthLayout>
      </main>
    </div>
  );
}
