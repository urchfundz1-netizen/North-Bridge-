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

  // When the paper has finished feeding, download the receipt as an image.
  useEffect(() => {
    if (!open || phase !== PHASES.COMPLETE || printed.current) return undefined;
    printed.current = true;

    const timer = setTimeout(() => {
      downloadReceiptImage(payload, receipt);
    }, 200);

    return () => clearTimeout(timer);
  }, [open, phase, payload, receipt]);

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
        <p className="paper__sub">Thank you for Banking with us</p>

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

const RECEIPT_IMAGE_CSS = `
  * { box-sizing: border-box; }
  .sheet { width: 80mm; margin: 0 auto; padding: 6mm; background: #fff; font-family: "Courier New", Courier, monospace; }
  .paper { color: #000; font-size: 13px; line-height: 1.6; -webkit-font-smoothing: none; font-smooth: never; text-rendering: optimizeLegibility; }
  .center { text-align: center; }
  .title { margin: 0; font-size: 19px; font-weight: 900; letter-spacing: 0.18em; text-transform: uppercase; }
  .sub { margin: 4px 0 0; font-size: 11px; font-weight: 700; letter-spacing: 0.06em; }
  .rule { margin: 18px 0; border: 0; border-top: 1px dashed #000; }
  .rule-solid { border-top: 1px solid #000; }
  .rows { display: flex; flex-direction: column; gap: 6px; }
  .row { display: flex; justify-content: space-between; gap: 12px; font-size: 13px; font-weight: 700; }
  .row > span { min-width: 0; }
  .row > span:last-child { text-align: right; word-break: break-word; }
  .section-title { margin: 0 0 8px; font-size: 11px; font-weight: 900; letter-spacing: 0.2em; }
  .total { font-size: 16px; font-weight: 900; }
  .thanks { margin: 0; font-size: 13px; font-weight: 900; letter-spacing: 0.12em; }
  .foot { margin: 0; font-size: 11px; text-align: center; color: #000; font-weight: 700; }
  .stars { margin: 10px 0 0; font-size: 10px; letter-spacing: 0.32em; }
`;

function receiptSheetHtml(payload, receipt) {
  const bank = payload.bank ?? {};
  const tx = payload.transaction ?? {};
  const customer = payload.customer ?? {};
  const recipient = payload.recipient ?? {};
  const amounts = payload.amounts ?? {};
  const final = tx.final ?? tx.status === 'approved';

  return `
    <div class="sheet">
      <div class="paper">
        <header class="center">
          <h1 class="title">${escapeHtml(bank.name ?? 'Northbridge Bank')}</h1>
          <p class="sub">TRANSFER RECEIPT</p>
        </header>
        <hr class="rule">
        <div class="rows">
          <div class="row"><span>Receipt No.</span><span>${escapeHtml(payload.receiptNumber ?? receipt?.receiptNumber ?? '—')}</span></div>
          <div class="row"><span>Date</span><span>${escapeHtml(formatStamp(payload.issuedAt))}</span></div>
          <div class="row"><span>Reference</span><span>${escapeHtml(tx.referenceNumber ?? '—')}</span></div>
          <div class="row"><span>Transfer type</span><span>${escapeHtml(tx.transferTypeLabel ?? tx.transferType ?? '—')}</span></div>
        </div>
        <hr class="rule">
        <div>
          <p class="section-title">FROM</p>
          <div class="rows">
            <div class="row"><span>Name</span><span>${escapeHtml(customer.name ?? '—')}</span></div>
            <div class="row"><span>Account</span><span>${escapeHtml(customer.accountNumber ?? '—')}</span></div>
            <div class="row"><span>Email</span><span>${escapeHtml(customer.email ?? '—')}</span></div>
          </div>
        </div>
        <hr class="rule">
        <div>
          <p class="section-title">TO</p>
          <div class="rows">
            <div class="row"><span>Name</span><span>${escapeHtml(recipient.name ?? '—')}</span></div>
            <div class="row"><span>Account</span><span>${escapeHtml(recipient.accountNumber ?? '—')}</span></div>
            <div class="row"><span>Account name</span><span>${escapeHtml(recipient.accountName ?? '—')}</span></div>
            <div class="row"><span>Bank</span><span>${escapeHtml(recipient.bank ?? '—')}</span></div>
            <div class="row"><span>Routing number</span><span>${escapeHtml(recipient.routingNumber ?? '—')}</span></div>
            <div class="row"><span>SWIFT / BIC</span><span>${escapeHtml(recipient.swiftBic ?? '—')}</span></div>
            <div class="row"><span>CNAPS</span><span>${escapeHtml(recipient.cnaps ?? '—')}</span></div>
            <div class="row"><span>IBAN</span><span>${escapeHtml(recipient.iban ?? '—')}</span></div>
            <div class="row"><span>Country</span><span>${escapeHtml(recipient.country ?? '—')}</span></div>
          </div>
        </div>
        <hr class="rule">
        <div class="rows">
          <div class="row"><span>Amount</span><span>${escapeHtml(amounts.amountFormatted ?? '—')}</span></div>
          <div class="row"><span>Processing fee</span><span>${escapeHtml(amounts.feeFormatted ?? '—')}</span></div>
        </div>
        <hr class="rule rule-solid">
        <div class="rows total">
          <div class="row"><span>${final ? 'TOTAL DEBITED' : 'TOTAL'}</span><span>${escapeHtml(amounts.totalDebitFormatted ?? '—')}</span></div>
        </div>
        ${
          payload.description
            ? `<hr class="rule"><div class="rows"><div class="row"><span>Description</span><span>${escapeHtml(payload.description)}</span></div></div>`
            : ''
        }
        ${
          payload.rejectionReason
            ? `<hr class="rule"><div class="rows"><div class="row"><span>Reason</span><span>${escapeHtml(payload.rejectionReason)}</span></div></div>`
            : ''
        }
        <hr class="rule">
        <div class="center">
          <p class="thanks">THANK YOU!</p>
          <p class="sub">Thank you for Banking with us</p>
          <p class="stars">* * * * * * * * * *</p>
        </div>
        <hr class="rule">
        <p class="foot">${escapeHtml(
          final
            ? 'Funds settled once only. This document is the authoritative record of the transaction.'
            : tx.arrivalHint ?? '',
        )}</p>
      </div>
    </div>
  `;
}

/**
 * Rasterise the receipt into a PNG on the client. The sheet is rendered off
 * screen with its own copy of the styles, serialised into an SVG
 * `<foreignObject>`, and drawn onto a canvas. That keeps the image identical to
 * the paper on screen without pulling in an HTML-to-image dependency.
 */
function downloadReceiptImage(payload, receipt) {
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position: fixed; left: -10000px; top: 0;';

  const sheetHost = document.createElement('div');
  sheetHost.style.cssText = 'width: 80mm; background: #fff;';
  sheetHost.innerHTML = `<style>${RECEIPT_IMAGE_CSS}</style>${receiptSheetHtml(payload, receipt)}`;

  host.appendChild(sheetHost);
  document.body.appendChild(host);

  const width = Math.ceil(sheetHost.getBoundingClientRect().width);
  const height = Math.ceil(sheetHost.scrollHeight);
  const markup = new XMLSerializer().serializeToString(sheetHost);
  document.body.removeChild(host);

  if (!width || !height) return;

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}"><foreignObject x="0" y="0" width="${width}" height="${height}">` +
    `${markup}</foreignObject></svg>`;

  const svgUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  const image = new Image();

  image.onload = () => {
    const scale = 3;
    const canvas = document.createElement('canvas');
    canvas.width = width * scale;
    canvas.height = height * scale;

    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(svgUrl);

    canvas.toBlob((blob) => {
      if (!blob) return;
      const pngUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = pngUrl;
      link.download = `northbridge-receipt-${payload.receiptNumber ?? receipt?.receiptNumber ?? 'receipt'}.png`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(pngUrl);
    }, 'image/png');
  };

  image.onerror = () => URL.revokeObjectURL(svgUrl);
  image.src = svgUrl;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
