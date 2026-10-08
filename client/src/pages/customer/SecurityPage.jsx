/**
 * Security settings: password, transfer PIN, and account standing.
 *
 * Changing the transfer PIN requires the current password *and* the current PIN,
 * so a hijacked unlocked session still cannot re-point future payments.
 */

import { useState } from 'react';
import { AppShell } from '../../components/Layout.jsx';
import {
  Alert,
  AsyncBoundary,
  Button,
  Card,
  ConfirmDialog,
  SecretField,
  StatusBadge,
} from '../../components/ui.jsx';
import { customerApi } from '../../api/client.js';
import { useAsync, useAction } from '../../lib/hooks.js';
import { formatDateTime } from '../../lib/format.js';
import { useSession } from '../../context/SessionContext.jsx';
import { IconLock, IconShield } from '../../components/icons.jsx';

export default function SecurityPage() {
  const session = useSession();
  const profile = useAsync(() => customerApi.profile(), []);

  const [passwordForm, setPasswordForm] = useState({
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  });
  const [pinForm, setPinForm] = useState({
    currentPassword: '',
    currentTransferPin: '',
    newTransferPin: '',
    confirmTransferPin: '',
  });
  const [passwordNotice, setPasswordNotice] = useState(null);
  const [pinNotice, setPinNotice] = useState(null);

  const [savePassword, savingPassword, passwordError] = useAction(customerApi.changePassword);
  const [savePin, savingPin, pinError] = useAction(customerApi.changeTransferPin);

  const [freezeOpen, setFreezeOpen] = useState(false);


  const customer = profile.data?.customer ?? session.customer;
  const isFrozen = customer?.status === 'frozen';

  const passwordErrors = passwordError?.fieldErrors ?? {};
  const pinErrors = pinError?.fieldErrors ?? {};

  const submitPassword = async (event) => {
    event.preventDefault();
    const result = await savePassword(passwordForm);
    if (!result) return;
    setPasswordForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
    setPasswordNotice(result.message);
  };

  const submitPin = async (event) => {
    event.preventDefault();
    const result = await savePin(pinForm);
    if (!result) return;
    setPinForm({ currentPassword: '', currentTransferPin: '', newTransferPin: '', confirmTransferPin: '' });
    setPinNotice(result.message);
  };

  return (
    <AppShell variant="customer">
      <div className="container page" style={{ maxWidth: 820 }}>
        <header className="mb-6">
          <h1 className="text-2xl">Security</h1>
          <p className="muted mt-1">
            Manage the two credentials that protect your account and your money.
          </p>
        </header>

        <AsyncBoundary loading={profile.loading} error={profile.error} onRetry={profile.reload}>
          <div className="stack gap-5">
            {/* ---- Account standing ---- */}
            <Card title="Account standing">
              <div className="row wrap gap-3">
                <StatusBadge status={customer?.status} />
                <span className="text-sm muted">
                  {isFrozen
                    ? 'Outgoing transfers are paused. You can still sign in and view your balance.'
                    : 'Your account is fully operational.'}
                </span>
              </div>

              {customer?.statusReason ? (
                <Alert tone="info" className="mt-4">
                  {customer.statusReason}
                </Alert>
              ) : null}

              {customer?.transferPinLockedUntil ? (
                <Alert tone="warning" className="mt-4" title="Transfer PIN temporarily locked">
                  Too many incorrect attempts. Try again after{' '}
                  {formatDateTime(customer.transferPinLockedUntil)}.
                </Alert>
              ) : null}

              <div className="row gap-2 mt-4">
                {isFrozen ? (
                  <p className="text-sm muted">
                    To resume outgoing transfers, ask Northbridge support to lift the freeze.
                  </p>
                ) : (
                  <Button variant="secondary" onClick={() => setFreezeOpen(true)}>
                    Freeze outgoing transfers
                  </Button>
                )}
              </div>

              {customer?.status === 'locked' || customer?.status === 'disabled' ? (
                <Alert tone="danger" className="mt-4" title={`Account ${customer.status}`}>
                  Contact Northbridge support to restore access to your account.
                </Alert>
              ) : null}
            </Card>

            {/* ---- Password ---- */}
            <Card
              title="Sign-in password"
              subtitle="Used to access the portal"
            >
              {passwordNotice ? <Alert tone="success">{passwordNotice}</Alert> : null}
              {passwordError ? <Alert tone="danger">{passwordError.message}</Alert> : null}

              <form onSubmit={submitPassword} noValidate>
                <SecretField
                  label="Current password"
                  required
                  autoComplete="current-password"
                  value={passwordForm.currentPassword}
                  onChange={(event) => {
                    setPasswordNotice(null);
                    setPasswordForm((prev) => ({ ...prev, currentPassword: event.target.value }));
                  }}
                  error={passwordErrors.currentPassword}
                />

                <SecretField
                  label="New password"
                  required
                  autoComplete="new-password"
                  value={passwordForm.newPassword}
                  onChange={(event) => {
                    setPasswordNotice(null);
                    setPasswordForm((prev) => ({ ...prev, newPassword: event.target.value }));
                  }}
                  error={passwordErrors.newPassword}
                  hint="At least 12 characters, with an uppercase letter, a lowercase letter, a number and a symbol"
                />

                <SecretField
                  label="Confirm new password"
                  required
                  autoComplete="new-password"
                  value={passwordForm.confirmPassword}
                  onChange={(event) => {
                    setPasswordNotice(null);
                    setPasswordForm((prev) => ({ ...prev, confirmPassword: event.target.value }));
                  }}
                  error={
                    passwordErrors.confirmPassword ??
                    (passwordForm.confirmPassword &&
                    passwordForm.confirmPassword !== passwordForm.newPassword
                      ? 'Passwords do not match.'
                      : undefined)
                  }
                />

                <Button type="submit" variant="primary" loading={savingPassword} icon={IconLock}>
                  Update password
                </Button>
              </form>
            </Card>

            {/* ---- Transfer PIN ---- */}
            <Card
              title="Transfer PIN"
              subtitle="Required to send money"
            >
              {pinNotice ? <Alert tone="success">{pinNotice}</Alert> : null}
              {pinError ? <Alert tone="danger">{pinError.message}</Alert> : null}

              <Alert tone="info" title="Both credentials are required">
                Changing your transfer PIN needs your password and your current PIN. This stops
                anyone with access to an unlocked device from re-pointing your future payments.
              </Alert>

              <form onSubmit={submitPin} noValidate>
                <SecretField
                  label="Current password"
                  required
                  autoComplete="current-password"
                  value={pinForm.currentPassword}
                  onChange={(event) => {
                    setPinNotice(null);
                    setPinForm((prev) => ({ ...prev, currentPassword: event.target.value }));
                  }}
                  error={pinErrors.currentPassword}
                />

                <SecretField
                  label="Current transfer PIN"

                  revealLabel="PIN"
required
                                    inputMode="numeric"
                  maxLength={4}
                  value={pinForm.currentTransferPin}
                  onChange={(event) => {
                    setPinNotice(null);
                    setPinForm((prev) => ({
                      ...prev,
                      currentTransferPin: event.target.value.replace(/\D/g, '').slice(0, 4),
                    }));
                  }}
                  error={pinErrors.currentTransferPin}
                  inputClassName="pin-input"
                  placeholder="0000"
                />

                <SecretField
                  label="New transfer PIN"

                  revealLabel="PIN"
required
                                    inputMode="numeric"
                  maxLength={4}
                  value={pinForm.newTransferPin}
                  onChange={(event) => {
                    setPinNotice(null);
                    setPinForm((prev) => ({
                      ...prev,
                      newTransferPin: event.target.value.replace(/\D/g, '').slice(0, 4),
                    }));
                  }}
                  error={
                    pinErrors.newTransferPin ??
                    (pinForm.newTransferPin && pinForm.newTransferPin === pinForm.currentTransferPin
                      ? 'Choose a PIN different from your current one.'
                      : undefined)
                  }
                  inputClassName="pin-input"
                  placeholder="0000"
                  hint="Exactly 4 digits"
                />

                <SecretField
                  label="Confirm new transfer PIN"

                  revealLabel="PIN"
required
                                    inputMode="numeric"
                  maxLength={4}
                  value={pinForm.confirmTransferPin}
                  onChange={(event) => {
                    setPinNotice(null);
                    setPinForm((prev) => ({
                      ...prev,
                      confirmTransferPin: event.target.value.replace(/\D/g, '').slice(0, 4),
                    }));
                  }}
                  error={
                    pinErrors.confirmTransferPin ??
                    (pinForm.confirmTransferPin &&
                    pinForm.confirmTransferPin !== pinForm.newTransferPin
                      ? 'Transfer PINs do not match.'
                      : undefined)
                  }
                  inputClassName="pin-input"
                  placeholder="0000"
                />

                <Button type="submit" variant="primary" loading={savingPin} icon={IconShield}>
                  Update transfer PIN
                </Button>
              </form>
            </Card>
          </div>
        </AsyncBoundary>
      </div>

      <ConfirmDialog
        open={freezeOpen}
        onClose={() => setFreezeOpen(false)}
        onConfirm={() => {
          setFreezeOpen(false);
        }}
        title="Freeze outgoing transfers?"
        confirmLabel="I understand"
        cancelLabel="Cancel"
        message="Contact Northbridge support to have the freeze lifted. This page cannot change the state of your account."
      />
    </AppShell>
  );
}
