import { createRoot } from 'react-dom/client';
import { Receipt } from './components/Receipt.jsx';
import { ReceiptPrinter } from './components/ReceiptPrinter.jsx';
import './styles/app.css';

const params = new URLSearchParams(window.location.search);
const final = params.get('final') === '1';
const mode = params.get('mode') ?? 'printer';

if (params.get('print') === '1') {
  document.body.classList.add('receipt-printing');
}

window.print = () => {
  window.__printed = true;
};

const payload = {
  receiptNumber: 'RCPT-2026-000123',
  issuedAt: '2026-10-23T10:30:00Z',
  bank: { name: 'Northbridge Bank' },
  transaction: {
    referenceNumber: 'NB-9F3A-8821',
    status: final ? 'approved' : 'pending',
    statusLabel: final ? 'Approved' : 'Pending',
    transferType: 'international',
    transferTypeLabel: 'International wire',
    final,
    arrivalHint: '',
    requestedAt: '2026-10-23T10:30:00Z',
    settledAt: final ? '2026-10-23T11:00:00Z' : null,
  },
  customer: {
    name: 'Amara Okafor',
    accountNumber: '0123456789',
    email: 'amara.okafor@example.com',
  },
  recipient: {
    name: 'Wei Chen',
    accountNumber: '6222021234567890',
    accountName: 'Wei Chen',
    bank: 'Bank of China',
    routingNumber: '',
    swiftBic: 'BKCHCNBJ',
    cnaps: '104100000004',
    iban: 'CN00BKCH1234567890123456',
    country: 'China',
  },
  amounts: {
    amountFormatted: '$12,500.00',
    feeFormatted: '$25.00',
    totalDebitFormatted: '$12,525.00',
  },
  description: 'Invoice 2026-041 - consulting',
};

const receipt = { payload, receiptNumber: payload.receiptNumber };

function Preview() {
  if (mode === 'card') {
    return (
      <div style={{ padding: 24 }}>
        <Receipt receipt={receipt} />
      </div>
    );
  }

  return <ReceiptPrinter receipt={receipt} open onClose={() => {}} />;
}

createRoot(document.getElementById('root')).render(<Preview />);

const errors = [];
window.addEventListener('error', (event) => errors.push(String(event.message)));
window.addEventListener('unhandledrejection', (event) => errors.push(String(event.reason)));

setTimeout(() => {
  const selectors =
    mode === 'card'
      ? ['.receipt', '.receipt__head', '.receipt__grid', '.receipt__item', '.receipt__totals', '.receipt__foot', '.btn']
      : [
          '.receipt-printer',
          '.receipt-printer__stage',
          '.receipt-printer__machine',
          '.receipt-printer__screen',
          '.receipt-printer__output',
          '.receipt-paper',
          '.receipt-printer__controls',
          '.receipt-printer__btn',
          '.receipt-printer__home',
          '.paper__title',
          '.paper__row',
        ];

  const measure = (el) => {
    const rect = el.getBoundingClientRect();
    return {
      selector: el.className || el.tagName,
      x: Math.round(rect.x),
      right: Math.round(rect.right),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      overflowX: el.scrollWidth > el.clientWidth + 1,
      text: (el.textContent ?? '').trim().slice(0, 40),
    };
  };

  const report = {
    mode,
    width: window.innerWidth,
    height: window.innerHeight,
    documentScrollWidth: document.documentElement.scrollWidth,
    horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    bodyScrollWidth: document.body.scrollWidth,
    bodyScrollHeight: document.body.scrollHeight,
    overlayScrollHeight: document.querySelector('.receipt-printer')?.scrollHeight ?? null,
    mediaPrint: window.matchMedia('print').matches,
    printed: Boolean(window.__printed),
    printingClass: document.body.classList.contains('receipt-printing'),
    errors,
    elements: selectors.flatMap((selector) => [...document.querySelectorAll(selector)]).map(measure),
  };

  const pre = document.createElement('pre');
  pre.id = '__report';
  pre.textContent = JSON.stringify(report);
  document.body.appendChild(pre);
}, Number(params.get('reportAt') ?? 6500));
