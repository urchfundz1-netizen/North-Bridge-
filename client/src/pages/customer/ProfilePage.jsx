/**
 * Profile: identity, contact details, address, and picture.
 *
 * The email and date of birth are shown read-only. Changing an email needs a
 * re-verification flow this build does not have, so presenting an editable
 * control that silently does nothing would be worse than showing the value.
 */

import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AppShell } from '../../components/Layout.jsx';
import {
  Alert,
  AsyncBoundary,
  Avatar,
  Button,
  Card,
  DefinitionList,
  StatusBadge,
  TextField,
} from '../../components/ui.jsx';
import { customerApi } from '../../api/client.js';
import { useAsync, useAction } from '../../lib/hooks.js';
import { formatDateTime } from '../../lib/format.js';
import { useSession } from '../../context/SessionContext.jsx';
import { IconCamera, IconLock } from '../../components/icons.jsx';

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp'];

export default function ProfilePage() {
  const session = useSession();
  const fileInputRef = useRef(null);

  const [form, setForm] = useState(null);
  const [notice, setNotice] = useState(null);
  const [pictureError, setPictureError] = useState(null);

  const profile = useAsync(() => customerApi.profile(), []);
  const customer = profile.data?.customer ?? session.customer;

  const [save, saving, saveError] = useAction(customerApi.updateProfile);
  const [upload, uploading, uploadError] = useAction(customerApi.uploadPicture);

  /** Seed the editable form from the loaded profile exactly once. */
  const seed = profile.data?.customer;
  const address = seed?.address ?? {};
  const values = form ?? {
    fullName: seed?.fullName ?? '',
    phone: seed?.phone ?? '',
    addressLine1: address.line1 ?? '',
    addressLine2: address.line2 ?? '',
    city: address.city ?? '',
    stateRegion: address.stateRegion ?? '',
    postalCode: address.postalCode ?? '',
    country: address.country ?? '',
  };

  const update = (field) => (event) => {
    setNotice(null);
    setForm((prev) => ({ ...values, ...prev, [field]: event.target.value }));
  };

  const dirty =
    form !== null &&
    ['fullName', 'phone', 'addressLine1', 'addressLine2', 'city', 'stateRegion', 'postalCode', 'country'].some(
      (field) => (form[field] ?? '') !== (values[field] ?? ''),
    );

  const submit = async (event) => {
    event.preventDefault();
    const result = await save(form ?? values);
    if (!result) return;
    setForm(null);
    setNotice(result.message);
    profile.reload();
  };

  const onPickPicture = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = ''; // allow re-picking the same file
    if (!file) return;

    setPictureError(null);
    if (!ACCEPTED.includes(file.type)) {
      setPictureError('Choose a JPG, PNG or WebP image.');
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setPictureError('Images must be 2 MB or smaller.');
      return;
    }

    const result = await upload(file);
    if (!result) return;
    // The URL contains a random suffix, so a plain refresh is enough to bust
    // the browser cache for the new image.
    session.patchIdentity({ profilePicture: result.profilePicture });
    setNotice(result.message);
    profile.reload();
  };

  return (
    <AppShell variant="customer">
      <div className="container page" style={{ maxWidth: 860 }}>
        <header className="mb-6">
          <h1 className="text-2xl">Profile</h1>
          <p className="muted mt-1">Your identity, contact details and picture.</p>
        </header>

        <AsyncBoundary loading={profile.loading} error={profile.error} onRetry={profile.reload}>
          {customer ? (
            <div className="stack gap-5">
              {notice ? <Alert tone="success">{notice}</Alert> : null}
              {saveError ? <Alert tone="danger">{saveError.message}</Alert> : null}
              {uploadError ? <Alert tone="danger">{uploadError.message}</Alert> : null}
              {pictureError ? <Alert tone="warning">{pictureError}</Alert> : null}

              {/* ---- Picture ---- */}
              <Card>
                <div className="row wrap gap-5" style={{ alignItems: 'center' }}>
                  <Avatar src={customer.profilePicture} alt={customer.fullName} size="xl" />

                  <div className="grow" style={{ minWidth: '200px' }}>
                    <h2 className="text-lg">{customer.fullName}</h2>
                    <p className="muted text-sm mt-1">
                      <span className="mono">{customer.accountNumber}</span>
                    </p>
                    <div className="row gap-2 mt-2">
                      <StatusBadge status={customer.status} />
                      <span className="text-sm muted">
                        Opened {formatDateTime(customer.createdAt)}
                      </span>
                    </div>
                  </div>

                  <div className="no-print">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept={ACCEPTED.join(',')}
                      onChange={onPickPicture}
                      className="visually-hidden"
                      id="picture-input"
                    />
                    <Button
                      variant="secondary"
                      icon={IconCamera}
                      loading={uploading}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      Change picture
                    </Button>
                  </div>
                </div>
                <p className="text-xs subtle mt-4">
                  JPG, PNG or WebP, up to 2 MB. Your picture is only visible to you and Northbridge
                  staff.
                </p>
              </Card>

              {/* ---- Read-only identity ---- */}
              <Card title="Verified identity">
                <DefinitionList
                  columns={2}
                  items={[
                    { label: 'Email address', value: customer.email },
                    { label: 'Date of birth', value: formatDateTime(customer.dateOfBirth).split(',')[0] },
                    { label: 'Account number', value: <span className="mono">{customer.accountNumber}</span> },
                    { label: 'Account type', value: customer.accountType.charAt(0).toUpperCase() + customer.accountType.slice(1) },
                  ]}
                />
                <p className="text-xs subtle mt-4">
                  To change your email address or date of birth, contact Northbridge support. These
                  details identify your account and cannot be edited here.
                </p>
              </Card>

              {/* ---- Editable details ---- */}
              <Card title="Contact and address">
                <form onSubmit={submit} noValidate>
                  <TextField
                    label="Full name"
                    required
                    autoComplete="name"
                    value={values.fullName}
                    onChange={update('fullName')}
                  />

                  <TextField
                    label="Phone"
                    type="tel"
                    required
                    autoComplete="tel"
                    inputMode="tel"
                    value={values.phone}
                    onChange={update('phone')}
                  />

                  <TextField
                    label="Address line 1"
                    required
                    autoComplete="address-line1"
                    value={values.addressLine1}
                    onChange={update('addressLine1')}
                  />
                  <TextField
                    label="Address line 2"
                    autoComplete="address-line2"
                    value={values.addressLine2}
                    onChange={update('addressLine2')}
                  />

                  <div className="grid-2">
                    <TextField
                      label="City"
                      required
                      autoComplete="address-level2"
                      value={values.city}
                      onChange={update('city')}
                    />
                    <TextField
                      label="State or region"
                      required
                      autoComplete="address-level1"
                      value={values.stateRegion}
                      onChange={update('stateRegion')}
                    />
                  </div>

                  <div className="grid-2">
                    <TextField
                      label="Postal code"
                      required
                      autoComplete="postal-code"
                      value={values.postalCode}
                      onChange={update('postalCode')}
                    />
                    <TextField
                      label="Country"
                      required
                      autoComplete="country-name"
                      value={values.country}
                      onChange={update('country')}
                    />
                  </div>

                  <div className="row gap-2 mt-2">
                    <Button type="submit" variant="primary" loading={saving} disabled={!dirty}>
                      Save changes
                    </Button>
                    {dirty ? (
                      <Button type="button" variant="ghost" onClick={() => setForm(null)}>
                        Discard
                      </Button>
                    ) : null}
                  </div>
                </form>
              </Card>

              <Card title="Security">
                <p className="text-sm muted">
                  Your sign-in password and your transfer PIN are separate credentials stored as
                  separate hashes. Changing one never changes the other.
                </p>
                <div className="row gap-2 mt-4">
                  <Link className="btn btn--secondary" to="/security">
                    <IconLock size={17} />
                    Password and transfer PIN
                  </Link>
                </div>
              </Card>
            </div>
          ) : null}
        </AsyncBoundary>
      </div>
    </AppShell>
  );
}
