/**
 * Transfer flow.
 *
 * Three steps, each of which must be completed before the next:
 *
 *   1. Recipient  - type, destination bank, and the account details.
 *   2. Amount     - server-priced quote, so the fee shown is the fee charged.
 *   3. Confirm    - transfer PIN entry, then an irreversible submission.
 *
 * The PIN is entered on its own step rather than at the end of step 1 so it is
 * never sitting in the DOM while the user is still editing the amount.
 *
 * `idempotencyKey` is generated once per attempt and reused across retries. If
 * the response is lost in transit and the user taps submit again, the server
 * returns the original transfer instead of creating a second one.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AppShell } from '../../components/Layout.jsx';
import {
  Alert,
  Button,
  Card,
  RadioCardGroup,
  SecretField,
  SelectField,
  Steps,
  TextAreaField,
  TextField,
} from '../../components/ui.jsx';
import { IconArrowLeft, IconArrowRight, IconLock } from '../../components/icons.jsx';
import { customerApi, parseAmount } from '../../api/client.js';
import { useAsync, useAction } from '../../lib/hooks.js';
import { Receipt } from '../../components/Receipt.jsx';
import { formatCents, TRANSFER_TYPE_OPTIONS } from '../../lib/format.js';
import { useSession } from '../../context/SessionContext.jsx';

const STEPS = ['Recipient', 'Amount', 'Confirm'];

const INITIAL_FORM = {
  transferType: 'local',
  recipientName: '',
  recipientAccountNumber: '',
  recipientBankId: '',
  recipientRoutingNumber: '',
  recipientIban: '',
  recipientSwiftBic: '',
  recipientCountry: '',
  amount: '',
  description: '',
};

export default function TransferPage() {
  const session = useSession();
  const navigate = useNavigate();

  const [step, setStep] = useState(1);
  const [form, setForm] = useState(INITIAL_FORM);
  const [pin, setPin] = useState('');
  const [quote, setQuote] = useState(null);
  const [created, setCreated] = useState(null);
  const idempotencyKeyRef = useRef(null);

  const customer = session.customer;
  const canTransfer = customer?.status === 'active';

  const banks = useAsync(
    () => customerApi.banks({ transferType: form.transferType }),
    [form.transferType],
  );

  const [fetchQuote, quoting, quoteError] = useAction(customerApi.quoteTransfer);
  const [submitTransfer, submitting, submitError] = useAction(customerApi.createTransfer);

  // A fresh idempotency key per attempt, reused if a retry is needed.
  useEffect(() => {
    idempotencyKeyRef.current = crypto.randomUUID();
  }, []);

  const update = (field) => (event) => {
    setForm((prev) => {
      const next = { ...prev, [field]: event.target.value };
      // Destination-specific fields only make sense for their own transfer type,
      // and leaving stale values would be sent to the server on submit.
      if (field === 'transferType') {
        next.recipientBankId = '';
        next.recipientRoutingNumber = '';
        next.recipientIban = '';
        next.recipientSwiftBic = '';
        next.recipientCountry = '';
      }
      return next;
    });
    // Any change invalidates the previous quote.
    setQuote(null);
  };

  const selectedBank = useMemo(
    () => banks.data?.banks?.find((bank) => String(bank.id) === String(form.recipientBankId)) ?? null,
    [banks.data, form.recipientBankId],
  );

  const amount = useMemo(() => parseAmount(form.amount), [form.amount]);

  const step1Valid =
    form.recipientName.trim().length >= 2 &&
    form.recipientAccountNumber.replace(/\s/g, '').length >= 3 &&
    Boolean(form.recipientBankId);

  const step2Valid =
    Boolean(amount) &&
    amount.cents >= (banks.data?.rules?.minTransferCents ?? 100) &&
    amount.cents <= (banks.data?.rules?.maxTransferCents ?? 50_000_000);

  /**
   * Step 1 only collects the recipient. Pricing happens on step 2, because the
   * fee depends on the amount and there is no amount to price yet.
   */
  const goToAmount = (event) => {
    event.preventDefault();
    if (!step1Valid) return;
    setQuote(null);
    setStep(2);
  };

  /**
   * Refetch the quote the moment the amount is valid so the customer sees the fee
   * and their remaining balance before committing to the review step. Debounced so
   * typing "1250.00" does not fire seven requests.
   */
  useEffect(() => {
    if (step !== 2 || !step2Valid) return undefined;
    const timer = setTimeout(async () => {
      const result = await fetchQuote(quotePayload(form));
      if (result?.quote) setQuote(result.quote);
    }, 400);
    return () => clearTimeout(timer);
    // `fetchQuote` is stable (customerApi.quoteTransfer is a module method), so
    // the form fields are the only things that should retrigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, step2Valid, form.recipientName, form.recipientAccountNumber, form.recipientBankId, form.recipientRoutingNumber, form.recipientIban, form.recipientSwiftBic, form.recipientCountry, form.amount]);

  /**
   * Re-quote immediately before showing the review step. The debounced quote may
   * be seconds old, and the fee shown on the confirmation screen has to be the fee
   * the server will charge.
   */
  const goToConfirm = async (event) => {
    event.preventDefault();
    if (!step2Valid) return;
    const result = await fetchQuote(quotePayload(form));
    if (!result?.quote) return;
    setQuote(result.quote);
    setStep(3);
  };

  const confirm = async (event) => {
    event.preventDefault();
    const result = await submitTransfer({
      ...quotePayload(form),
      transferPin: pin,
      idempotencyKey: idempotencyKeyRef.current,
    });
    if (!result?.transfer) return;
    // The receipt travels back with the transfer, so the confirmation screen has
    // a real document to show without a second request that could fail and
    // leave the customer staring at an empty page.
    setCreated({ transfer: result.transfer, outcome: result.outcome, receipt: result.receipt });
  };

  /* ---- Success screen ---- */
  if (created) {
    const { transfer, receipt } = created;
    return (
      <AppShell variant="customer">
        <div className="container page" style={{ maxWidth: 680 }}>
          {/*
            Nothing but the receipt. The customer has just confirmed their PIN
            and asked to be handed the document, so the summary card, the
            step-complete heading and the "funds have not left your account yet"
            alert are all deliberately absent: every one of them restated a
            field the receipt already carries, and the banner in particular
            duplicated the footer's warning in a second place.
          */}
          <Receipt receipt={receipt} />

          <div className="row wrap gap-3 mt-6" style={{ justifyContent: 'center' }}>
            <Button variant="primary" icon={IconArrowRight} onClick={() => navigate(`/transfers/${transfer.id}`)}>
              View transfer
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setCreated(null);
                setForm(INITIAL_FORM);
                setPin('');
                setQuote(null);
                setStep(1);
              }}
            >
              Send another
            </Button>
          </div>
        </div>
      </AppShell>
    );
  }

  /* ---- Wizard ---- */
  return (
    <AppShell variant="customer">
      <div className="container page" style={{ maxWidth: 760 }}>
        <header className="mb-6">
          <Link to="/dashboard" className="row gap-2 text-sm muted" style={{ marginBottom: 'var(--space-3)' }}>
            <IconArrowLeft size={16} />
            Back to overview
          </Link>
          <h1 className="text-2xl">Send a transfer</h1>
          <p className="muted mt-1">
            {canTransfer
              ? 'You will see the exact total leaving your account before anything is submitted.'
              : 'Outgoing transfers are currently unavailable on your account.'}
          </p>
        </header>

        {!canTransfer ? (
          <Alert tone="danger" title={`Account ${customer?.status ?? 'unavailable'}`}>
            {customer?.status === 'frozen'
              ? 'Your account is frozen, so outgoing transfers are paused. You can still view balances and history.'
              : customer?.statusReason || 'Please contact Northbridge support.'}
          </Alert>
        ) : null}

        <Steps current={step} steps={STEPS} />

        <Card>
          {/* ---------- Step 1: recipient ---------- */}
          {step === 1 ? (
            <form onSubmit={goToAmount} noValidate>
              <div className="card__body">
                {banks.error ? (
                  <Alert tone="danger" title="Could not load banks">
                    {banks.error.message}
                  </Alert>
                ) : null}

                <RadioCardGroup
                  legend="Transfer type"
                  name="transferType"
                  value={form.transferType}
                  onChange={(value) => {
                    setForm((prev) => ({ ...prev, transferType: value }));
                    setQuote(null);
                  }}
                  options={TRANSFER_TYPE_OPTIONS}
                  columns={3}
                />

                <TextField
                  label="Recipient name"
                  required
                  value={form.recipientName}
                  onChange={update('recipientName')}
                  placeholder="Exactly as it appears on their account"
                  maxLength={120}
                />

                <SelectField
                  label="Destination bank"
                  required
                  value={form.recipientBankId}
                  onChange={update('recipientBankId')}
                  options={banks.data?.banks?.map((bank) => ({ value: String(bank.id), label: bank.name })) ?? []}
                  placeholder={banks.loading ? 'Loading banks…' : 'Select a bank'}
                  disabled={banks.loading || !banks.data?.banks?.length}
                  hint={
                    !banks.loading && banks.data?.banks?.length === 0
                      ? 'No bank currently supports this transfer type.'
                      : undefined
                  }
                />

                <TextField
                  label="Recipient account number"
                  required
                  value={form.recipientAccountNumber}
                  onChange={update('recipientAccountNumber')}
                  placeholder="0000 0000 0000 0000"
                  className="mono"
                  maxLength={34}
                  autoComplete="off"
                />

                {selectedBank?.routingNumberLength ? (
                  <TextField
                    label="Routing number"
                    value={form.recipientRoutingNumber}
                    onChange={update('recipientRoutingNumber')}
                    hint={`${selectedBank.name} uses a ${selectedBank.routingNumberLength}-digit routing number`}
                    className="mono"
                    maxLength={34}
                    autoComplete="off"
                  />
                ) : null}

                {form.transferType === 'international' ? (
                  <div className="grid-2">
                    <TextField
                      label="IBAN"
                      value={form.recipientIban}
                      onChange={update('recipientIban')}
                      className="mono"
                      maxLength={34}
                      autoComplete="off"
                    />
                    <TextField
                      label="SWIFT / BIC"
                      value={form.recipientSwiftBic}
                      onChange={update('recipientSwiftBic')}
                      className="mono"
                      maxLength={11}
                      autoComplete="off"
                    />
                  </div>
                ) : null}

                {form.transferType !== 'local' ? (
                  <TextField
                    label="Recipient country"
                    value={form.recipientCountry}
                    onChange={update('recipientCountry')}
                    placeholder="e.g. United Kingdom"
                    maxLength={80}
                    autoComplete="off"
                  />
                ) : null}
              </div>

              <div className="card__footer">
                <div className="row gap-2">
                  <Button variant="secondary" disabled={!step1Valid} type="submit" icon={IconArrowRight}>
                    Continue
                  </Button>
                </div>
              </div>
            </form>
          ) : null}

          {/* ---------- Step 2: amount ---------- */}
          {step === 2 ? (
            <form onSubmit={goToConfirm} noValidate>
              <div className="card__body">
                <TextField
                  label="Amount to send"
                  required
                  type="text"
                  inputMode="decimal"
                  value={form.amount}
                  onChange={update('amount')}
                  placeholder="0.00"
                  hint={
                    banks.data?.rules
                      ? `Between ${formatCents(banks.data.rules.minTransferCents)} and ${formatCents(
                          banks.data.rules.maxTransferCents,
                        )}.`
                      : undefined
                  }
                  error={
                    form.amount && !step2Valid
                      ? amount
                        ? amount.cents < (banks.data?.rules?.minTransferCents ?? 100)
                          ? `The minimum transfer is ${formatCents(banks.data?.rules?.minTransferCents ?? 100)}.`
                          : `The maximum transfer is ${formatCents(banks.data?.rules?.maxTransferCents ?? 50_000_000)}.`
                        : 'Enter a valid amount, for example 1250.00.'
                      : undefined
                  }
                />

                <TextAreaField
                  label="Description"
                  value={form.description}
                  onChange={update('description')}
                  maxLength={240}
                  placeholder="What is this payment for? (optional)"
                  hint={`${form.description.length}/240`}
                />

                {quoteError ? <Alert tone="danger" className="mt-4">{quoteError.message}</Alert> : null}

                {quote ? (
                  <div className="card mt-4" style={{ background: 'var(--navy-50)', borderColor: 'var(--navy-100)' }}>                    <div className="card__body">
                      <div className="receipt__totals">
                        <div className="receipt__total-row">
                          <span className="muted">Transfer amount</span>
                          <span>{quote.amountFormatted}</span>
                        </div>
                        <div className="receipt__total-row">
                          <span className="muted">Processing fee</span>
                          <span>{quote.feeFormatted}</span>
                        </div>
                        <div className="receipt__total-row receipt__total-row--grand">
                          <span>Total leaving your account</span>
                          <span>{quote.totalDebitFormatted}</span>
                        </div>
                      </div>

                      <p className="text-sm mt-3">
                        Available now: <strong>{quote.balanceFormatted}</strong>
                      </p>

                      {quote.balanceCents < quote.totalDebitCents ? (
                        <Alert tone="danger" className="mt-3" title="Insufficient funds">
                          This transfer needs {quote.totalDebitFormatted} but your balance is{' '}
                          {quote.balanceFormatted}. Reduce the amount or ask an administrator to fund
                          your account.
                        </Alert>
                      ) : null}

                      <p className="text-sm muted mt-3">
                        {quote.requiresApproval
                          ? 'Northbridge reviews every transfer. Funds stay in your account until it is approved.'
                          : 'This transfer will settle immediately.'}
                      </p>
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="card__footer">
                <div className="row gap-2">
                  <Button variant="ghost" icon={IconArrowLeft} onClick={() => setStep(1)}>
                    Back
                  </Button>
                  <Button
                    type="submit"
                    variant="primary"
                    icon={IconArrowRight}
                    loading={quoting}
                    disabled={!step2Valid}
                  >
                    Review transfer
                  </Button>
                </div>
              </div>
            </form>
          ) : null}

          {/* ---------- Step 3: PIN + confirm ---------- */}
          {step === 3 ? (
            <form onSubmit={confirm} noValidate>
              <div className="card__body">
                {submitError ? (
                  <Alert tone="danger" title="Transfer not submitted">
                    {submitError.message}
                  </Alert>
                ) : null}

                <h2 className="text-md mb-3">Check the details</h2>

                <div className="card" style={{ background: 'var(--surface-muted)' }}>
                  <div className="card__body">
                    <dl className="datalist datalist--2">
                      <div className="datalist__item">
                        <dt className="datalist__label">To</dt>
                        <dd className="datalist__value">{form.recipientName}</dd>
                      </div>
                      <div className="datalist__item">
                        <dt className="datalist__label">Account</dt>
                        <dd className="datalist__value mono">{form.recipientAccountNumber}</dd>
                      </div>
                      <div className="datalist__item">
                        <dt className="datalist__label">Bank</dt>
                        <dd className="datalist__value">{selectedBank?.name ?? '—'}</dd>
                      </div>
                      <div className="datalist__item">
                        <dt className="datalist__label">Type</dt>
                        <dd className="datalist__value">
                          {TRANSFER_TYPE_OPTIONS.find((option) => option.value === form.transferType)?.label}
                        </dd>
                      </div>
                      <div className="datalist__item">
                        <dt className="datalist__label">Amount</dt>
                        <dd className="datalist__value">{quote?.amountFormatted}</dd>
                      </div>
                      <div className="datalist__item">
                        <dt className="datalist__label">Fee</dt>
                        <dd className="datalist__value">{quote?.feeFormatted}</dd>
                      </div>
                    </dl>

                    <div className="receipt__total-row receipt__total-row--grand">
                      <span>Total debit</span>
                      <span>{quote?.totalDebitFormatted}</span>
                    </div>
                  </div>
                </div>

                <div className="divider" />

                <h2 className="text-md mb-2">Authorise with your transfer PIN</h2>
                <p className="text-sm muted mb-4">
                  This is the 4-digit PIN you chose when opening your account — not your sign-in
                  password.
                </p>

                <SecretField
                  label="Transfer PIN"
                  revealLabel="PIN"
                  required
                  inputMode="numeric"
                  maxLength={4}
                  value={pin}
                  onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 4))}
                  inputClassName="pin-input"
                  placeholder="0000"
                  hint="Incorrect PINs are counted and will lock transfers temporarily."
                />

                <Alert tone={quote?.requiresApproval ? 'info' : 'warning'}>
                  {quote?.requiresApproval
                    ? 'Submitting places this transfer in the review queue. No money moves until Northbridge approves it.'
                    : 'Submitting moves the money immediately and cannot be undone.'}
                </Alert>
              </div>

              <div className="card__footer">
                <div className="row gap-2">
                  <Button variant="ghost" icon={IconArrowLeft} onClick={() => setStep(2)} disabled={submitting}>
                    Back
                  </Button>
                  <Button
                    type="submit"
                    variant="accent"
                    icon={IconLock}
                    loading={submitting}
                    disabled={pin.length !== 4}
                  >
                    Confirm transfer
                  </Button>
                </div>
              </div>
            </form>
          ) : null}
        </Card>
      </div>
    </AppShell>
  );
}

/**
 * Shape sent to both `/quote` and `/create`. Empty optional strings are dropped
 * rather than sent as `""` so the server's optional-field handling applies.
 */
function quotePayload(form) {
  const payload = {
    transferType: form.transferType,
    recipientName: form.recipientName.trim(),
    recipientAccountNumber: form.recipientAccountNumber.replace(/\s/g, ''),
    recipientBankId: Number(form.recipientBankId),
    amount: String(form.amount).trim().replace(',', '.'),
  };

  if (form.recipientRoutingNumber.trim()) payload.recipientRoutingNumber = form.recipientRoutingNumber.trim();
  if (form.recipientIban.trim()) payload.recipientIban = form.recipientIban.trim();
  if (form.recipientSwiftBic.trim()) payload.recipientSwiftBic = form.recipientSwiftBic.trim();
  if (form.recipientCountry.trim()) payload.recipientCountry = form.recipientCountry.trim();
  if (form.description.trim()) payload.description = form.description.trim();

  return payload;
}

