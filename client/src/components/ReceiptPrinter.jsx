/**
 * Receipt printer.
 *
 * Clicking Print on a receipt does not open the browser print dialog straight
 * away. It puts the document through a till printer first: the machine takes a
 * moment to wake, the paper feeds out of the slot, and only then does the real
 * print dialog open with the receipt on it. The point is that the customer sees
 * the same document a thermal printer would produce, rather than the on-screen
 * card.
 *
 * Two copies of the paper exist at once, from one source of truth:
 *
 *   * `.receipt-paper` is the animated copy on screen. It is clipped by the
 *     printer slot so it looks like it is emerging from the machine.
 *   * `.print-sheet` is the copy the printer sends to the browser. It is hidden
 *     on screen and becomes the only thing on the page in `@media print`.
 *
 * Both are rendered by `PaperContent`, so the printed document and the one on
 * screen can never drift apart.
 *
 * The receipt data is the frozen payload the server issued, so the printed
 * document reads exactly as it did on the day the transfer was made.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/** How long the machine "wakes up" before the paper starts feeding. */
const WAKE_MS = 1200;
/** How long the paper takes to feed out of the slot. */
const FEED_MS = 3500;

const PHASES = {
  PROCESSING: 'processing',
  PRINTING: 'printing',
  COMPLETE: 'complete',
};

export function ReceiptPrinter({ receipt, open, onClose }) {
  const payload = receipt?.payload ?? null;
  const [phase, setPhase] = useState(PHASES.PROCESSING);
  const timers = useRef([]);
  const printed = useRef(false);
  const dialogRef = useRef(null);

  const clearTimers = useCallback(() => {
    timers.current.forEach((id) => clearTimeout(id));
    timers.current = [];
  }, []);

  const run = useCallback(() => {
    clearTimers();
    printed.current = false;
    setPhase(PHASES.PROCESSING);
    timers.current.push(
      setTimeout(() => setPhase(PHASES.PRINTING), WAKE_MS),
      setTimeout(() => setPhase(PHASES.COMPLETE), WAKE_MS + FEED_MS),
    );
  }, [clearTimers]);

  // The machine runs its cycle whenever the printer is opened.
  useEffect(() => {
    if (!open) return undefined;
    run();
    return clearTimers;
  }, [open, run, clearTimers]);

  // Escape closes the printer. The dialog is a transient view, so it does not
  // trap focus the way a form dialog does.
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKeyDown);
    dialogRef.current?.focus();
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  // Stop the page behind the printer from scrolling under it.
  useEffect(() => {
    if (!open) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  // When the paper has finished feeding, hand the clean sheet to the browser.
  // `receipt-printing` on the body is what the print stylesheet keys off to
  // hide the app and leave only the sheet on the page.
  useEffect(() => {
    if (!open || phase !== PHASES.COMPLETE || printed.current) return undefined;
    printed.current = true;

    const cleanup = () => {
      document.body.classList.remove('receipt-printing');
      window.removeEventListener('afterprint', cleanup);
    };

    document.body.classList.add('receipt-printing');
    window.addEventListener('afterprint', cleanup);

    // One frame so the sheet is laid out before the dialog opens.
    const frame = requestAnimationFrame(() => {
      window.print();
    });

    return () => {
      cancelAnimationFrame(frame);
      cleanup();
    };
  }, [open, phase]);

  if (!open || !payload) return null;

  const amount = payload.amounts?.totalDebitFormatted ?? '—';
  const bankName = payload.bank?.name ?? 'Northbridge Bank';

  return createPortal(
    <div className="receipt-printer-portal">
      <div
        className="receipt-printer"
        role="dialog"
        aria-modal="true"
        aria-label="Receipt printer"
        ref={dialogRef}
        tabIndex={-1}
      >
        <div className="receipt-printer__stage">
          <div className="receipt-printer__machine">
            <header className="receipt-printer__head">
              <div className="receipt-printer__brand">
                <span className="receipt-printer__logo" aria-hidden="true">
                  N
                </span>
                <span>RECEIPT</span>
              </div>
              <button type="button" className="receipt-printer__home" onClick={() => onClose?.()}>
                Close
              </button>
            </header>

            <div className="receipt-printer__screen">
              <div className="receipt-printer__screen-top">
                <div>
                  <p className="receipt-printer__screen-title">{bankName}</p>
                  <p className="receipt-printer__screen-sub">Transfer receipt</p>
                </div>
                <strong className="receipt-printer__screen-amount">{amount}</strong>
              </div>

              <div className="receipt-printer__screen-rule" />

              <div className="receipt-printer__status">
                <span className="receipt-printer__status-icon" aria-hidden="true">
                  {phase === PHASES.COMPLETE ? (
                    <span className="receipt-printer__check">✓</span>
                  ) : (
                    <span className="spinner" />
                  )}
                </span>
                <div>
                  <p className="receipt-printer__status-text">{statusText(phase)}</p>
                  <p className="receipt-printer__status-sub">{statusSubText(phase, payload)}</p>
                </div>
              </div>
            </div>

            <div className="receipt-printer__slot" />
          </div>

          <div
            className={`receipt-printer__output ${phase === PHASES.COMPLETE ? 'receipt-printer__output--full' : ''}`}
          >
            <article
              className={[
                'receipt-paper',
                phase !== PHASES.PROCESSING ? 'receipt-paper--visible' : '',
                // The feed class carries the animation, and it has to survive
                // the hand-off to the complete phase or the paper would jump
                // back into the machine.
                phase === PHASES.PRINTING ? 'receipt-paper--stepped' : '',
                phase === PHASES.COMPLETE ? 'receipt-paper--done' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <PaperContent payload={payload} />
            </article>
          </div>

          <div className="receipt-printer__controls">
            <button
              type="button"
              className="receipt-printer__btn receipt-printer__btn--primary"
              onClick={run}
            >
              {phase === PHASES.COMPLETE ? 'Print receipt again' : 'Printing...'}
            </button>
          </div>
        </div>
      </div>

      {/* The copy the browser actually prints. Hidden on screen by CSS. */}
      <div className="print-sheet" aria-hidden="true">
        <PaperContent payload={payload} />
      </div>
    </div>,
    document.body,
  );
}

function statusText(phase) {
  if (phase === PHASES.COMPLETE) return 'Receipt printed';
  if (phase === PHASES.PRINTING) return 'Printing your receipt';
  return 'Processing your receipt';
}

function statusSubText(phase, payload) {
  if (phase === PHASES.COMPLETE) return 'Receipt printed successfully';
  if (phase === PHASES.PRINTING) return 'Your receipt is being printed';
  return payload?.transaction?.final
    ? 'Preparing the final document'
    : 'Please wait...';
}

/**
 * The thermal paper itself.
 *
 * Every value comes from the frozen receipt payload, and anything the server
 * did not record prints as a dash rather than as a blank, so the document never
 * looks like it is missing something.
 */
function PaperContent({ payload }) {
  const bank = payload.bank ?? {};
  const tx = payload.transaction ?? {};
  const customer = payload.customer ?? {};
  const recipient = payload.recipient ?? {};
  const amounts = payload.amounts ?? {};
  const final = tx.final ?? tx.status === 'approved';

  return (
    <div className="paper">
      <header className="paper__center">
        <h2 className="paper__title">{bank.name ?? 'Northbridge Bank'}</h2>
        <p className="paper__sub">TRANSFER RECEIPT</p>
      </header>

      <hr className="paper__rule" />

      <div className="paper__rows">
        <PaperRow label="Receipt No." value={payload.receiptNumber} />
        <PaperRow label="Date" value={formatStamp(payload.issuedAt)} />
        <PaperRow label="Reference" value={tx.referenceNumber} />
        <PaperRow label="Transfer type" value={tx.transferTypeLabel ?? tx.transferType} />
      </div>

      <hr className="paper__rule" />

      <div className="paper__section">
        <p className="paper__section-title">FROM</p>
        <PaperRow label="Name" value={customer.name} />
        <PaperRow label="Account" value={customer.accountNumber} />
        <PaperRow label="Email" value={customer.email} />
      </div>

      <hr className="paper__rule" />

      <div className="paper__section">
        <p className="paper__section-title">TO</p>
        <PaperRow label="Name" value={recipient.name} />
        <PaperRow label="Account" value={recipient.accountNumber} />
        <PaperRow label="Account name" value={recipient.accountName} />
        <PaperRow label="Bank" value={recipient.bank} />
        <PaperRow label="Routing number" value={recipient.routingNumber} />
        <PaperRow label="SWIFT / BIC" value={recipient.swiftBic} />
        <PaperRow label="CNAPS" value={recipient.cnaps} />
        <PaperRow label="IBAN" value={recipient.iban} />
        <PaperRow label="Country" value={recipient.country} />
      </div>

      <hr className="paper__rule" />

      <div className="paper__rows">
        <PaperRow label="Amount" value={amounts.amountFormatted} />
        <PaperRow label="Processing fee" value={amounts.feeFormatted} />
      </div>

      <hr className="paper__rule paper__rule--solid" />

      <div className="paper__rows paper__rows--total">
        <PaperRow label={final ? 'TOTAL DEBITED' : 'TOTAL'} value={amounts.totalDebitFormatted} />
      </div>

      {payload.description ? (
        <>
          <hr className="paper__rule" />
          <div className="paper__rows">
            <PaperRow label="Description" value={payload.description} />
          </div>
        </>
      ) : null}

      {payload.rejectionReason ? (
        <>
          <hr className="paper__rule" />
          <div className="paper__rows">
            <PaperRow label="Reason" value={payload.rejectionReason} />
          </div>
        </>
      ) : null}

      <hr className="paper__rule" />

      <div className="paper__center">
        <p className="paper__thanks">THANK YOU!</p>
        <p className="paper__sub">We appreciate your business.</p>

        <div className="paper__bars" aria-hidden="true">
          <span className="paper__bar paper__bar--h32" />
          <span className="paper__bar paper__bar--h24" />
          <span className="paper__bar paper__bar--h40" />
          <span className="paper__bar paper__bar--h28" />
          <span className="paper__bar paper__bar--h36" />
          <span className="paper__bar paper__bar--h20" />
          <span className="paper__bar paper__bar--h40" />
          <span className="paper__bar paper__bar--h28" />
          <span className="paper__bar paper__bar--h36" />
          <span className="paper__bar paper__bar--h24" />
        </div>

        <p className="paper__stars">* * * * * * * * * *</p>
      </div>

      <hr className="paper__rule" />

      <p className="paper__foot">
        {final
          ? 'Funds settled once only. This document is the authoritative record of the transaction.'
          : tx.arrivalHint ?? ''}
      </p>
    </div>
  );
}

function PaperRow({ label, value }) {
  return (
    <div className="paper__row">
      <span>{label}</span>
      <span>{value || '—'}</span>
    </div>
  );
}

function formatStamp(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
