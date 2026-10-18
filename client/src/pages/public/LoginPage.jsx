/**
 * Customer sign-in.
 *
 * Sign-in is deliberately two steps. The password is checked first; if it holds,
 * the server reserves a 6-digit code for the attempt and issues a challenge
 * instead of a session. Only the code step creates the session cookie, so a
 * leaked password on its own cannot sign anyone in.
 *
 * The cookie is issued by the server; nothing is persisted client-side. A wrong
 * password is answered with the same generic message whether or not the address
 * exists, and the server applies its own throttle, so this form does not try to
 * second-guess when a lockout has been applied.
 */

import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { AuthLayout } from './AuthLayout.jsx';
import { PublicHeader } from '../../components/Layout.jsx';
import { Alert, Button, SecretField, TextField } from '../../components/ui.jsx';
import { useSession } from '../../context/SessionContext.jsx';
import { useAction } from '../../lib/hooks.js';
import { IconArrowLeft, IconLock, IconMail, IconShield } from '../../components/icons.jsx';

const OTP_LENGTH = 6;

export default function LoginPage() {
  const session = useSession();
  const navigate = useNavigate();
  const location = useLocation();

  const [form, setForm] = useState({ email: '', password: '' });
  const [challenge, setChallenge] = useState(null);
  const [code, setCode] = useState('');

  const [runLogin, loginPending, loginError, resetLoginError] = useAction(session.login);
  const [runVerify, verifyPending, verifyError, resetVerifyError] = useAction(
    session.verifyLoginOtp,
  );

  const redirectTo = location.state?.from ?? '/dashboard';

  const finish = (result) => {
    // A frozen account still signs in, but must not be sent to a screen that
    // offers transfers it cannot perform.
    const restrictions = result?.restrictions ?? [];
    navigate(restrictions.includes('frozen') ? '/dashboard?notice=frozen' : redirectTo, {
      replace: true,
    });
  };

  const update = (field) => (event) => {
    resetLoginError();
    setForm((prev) => ({ ...prev, [field]: event.target.value }));
  };

  const submitCredentials = async (event) => {
    event.preventDefault();
    const result = await runLogin(form);
    if (!result) return;

    // The password checked out but no session exists yet: move on to the code.
    if (result.otpRequired) {
      setChallenge({ challengeId: result.challengeId, email: result.email });
      setCode('');
      return;
    }

    finish(result);
  };

  const submitCode = async (event) => {
    event.preventDefault();
    if (code.length !== OTP_LENGTH) return;
    const result = await runVerify(challenge.challengeId, code);
    if (!result) return;
    finish(result);
  };

  const useAnotherAccount = () => {
    resetVerifyError();
    setChallenge(null);
    setCode('');
  };

  const fieldErrors = loginError?.fieldErrors ?? {};
  const codeError = verifyError?.fieldErrors?.code;
  const onCodeStep = Boolean(challenge);

  return (
    <div className="app-shell">
      <PublicHeader minimal />
      <main id="main" className="app-main">
        <AuthLayout
          title={onCodeStep ? 'Enter your sign-in code' : 'Welcome back'}
          subtitle={
            onCodeStep
              ? `We sent a 6-digit code to ${challenge.email}. Enter it to finish signing in.`
              : 'Sign in to your Northbridge account.'
          }
          variant="dark"
        >
          {!onCodeStep && location.state?.expired ? (
            <Alert tone="info" title="Your session expired">
              For your security you were signed out. Please sign in again.
            </Alert>
          ) : null}

          {onCodeStep ? (
            <>
              {verifyError ? <Alert tone="danger">{verifyError.message}</Alert> : null}

              <form onSubmit={submitCode} noValidate>
                <TextField
                  label="6-digit code"
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]*"
                  maxLength={OTP_LENGTH}
                  required
                  value={code}
                  onChange={(event) => {
                    resetVerifyError();
                    setCode(event.target.value.replace(/\D/g, '').slice(0, OTP_LENGTH));
                  }}
                  error={codeError}
                  hint="The code expires 10 minutes after you sign in."
                  placeholder="000000"
                  icon={IconShield}
                  autoFocus
                />

                <Button
                  type="submit"
                  variant="primary"
                  size="lg"
                  loading={verifyPending}
                  disabled={code.length !== OTP_LENGTH}
                  className="btn--block"
                  icon={IconLock}
                >
                  Verify and sign in
                </Button>
              </form>

              <p className="text-sm muted mt-6 text-center">
                <button type="button" className="link-button" onClick={useAnotherAccount}>
                  <IconArrowLeft size={16} aria-hidden="true" /> Use a different account
                </button>
              </p>
            </>
          ) : (
            <>
              {loginError ? (
                <Alert tone="danger" title="We could not sign you in">
                  {loginError.message}
                </Alert>
              ) : null}

              <form onSubmit={submitCredentials} noValidate>
                <TextField
                  label="Email address"
                  type="email"
                  name="email"
                  autoComplete="username"
                  inputMode="email"
                  required
                  value={form.email}
                  onChange={update('email')}
                  error={fieldErrors.email}
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
                  error={fieldErrors.password}
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
                  Continue
                </Button>
              </form>

              <p className="text-sm muted mt-6 text-center">
                Staff member?{' '}
                <Link to="/admin/login" style={{ fontWeight: 600 }}>
                  Open the admin console
                </Link>
              </p>
            </>
          )}
        </AuthLayout>
      </main>
    </div>
  );
}
