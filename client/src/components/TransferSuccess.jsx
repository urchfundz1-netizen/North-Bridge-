/**
 * Transfer success screen.
 *
 * The customer has just authorised the transfer with their PIN, so the next
 * thing they see is the outcome itself rather than the full receipt document.
 * The receipt is still one click away: "Download Receipt" opens the same till
 * printer the rest of the app uses, which feeds the paper out and then saves
 * the document as an image.
 *
 * `transfer` is the serialised transfer and `receipt` the frozen document the
 * server issued. Neither is re-queried here, so the screen and the downloaded
 * file describe the same transaction.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { IconCheck, IconDownload } from './icons.jsx';
import { ReceiptPrinter } from './ReceiptPrinter.jsx';

export function TransferSuccess({ transfer, receipt }) {
  const [printerOpen, setPrinterOpen] = useState(false);

  const recipientName = transfer?.recipient?.name ?? 'the recipient';
  const amount = transfer?.amountFormatted ?? '';
  const payload = receipt?.payload ?? null;

  return (
    <div className="transfer-success">
      <div className="transfer-success__badge" aria-hidden="true">
        <div className="transfer-success__badge-inner">
          <IconCheck size={64} strokeWidth={2.8} />
        </div>
      </div>

      <h1 className="transfer-success__title">
        Transfer
        <br />
        Successful
      </h1>

      <p className="transfer-success__copy">
        Congratulations! Your transfer of <strong>{amount}</strong> to{' '}
        <strong>{recipientName}</strong> was successful.
      </p>

      <div className="transfer-success__actions">
        <button
          type="button"
          className="transfer-success__action"
          onClick={() => setPrinterOpen(true)}
          disabled={!payload}
        >
          <IconDownload size={28} className="transfer-success__action-icon" />
          <span>Download Receipt</span>
        </button>
      </div>

      <div className="transfer-success__links">
        <Link to={`/transfers/${transfer.id}`} className="link-button">
          View transfer
        </Link>
      </div>

      <ReceiptPrinter
        receipt={receipt}
        open={printerOpen}
        onClose={() => setPrinterOpen(false)}
      />
    </div>
  );
}
