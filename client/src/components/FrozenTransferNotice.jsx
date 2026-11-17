import { Button, Modal } from './ui.jsx';

export function FrozenTransferNotice({ open, onClose, accountNumber }) {
  const lastFour = String(accountNumber ?? '').replace(/\D/g, '').slice(-4) || '----';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Account temporarily frozen"
      width={520}
      footer={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="stack gap-4">
        <p>
          Transfers are currently unavailable for the account ending in <strong>{lastFour}</strong>.
        </p>
        <p>
          Review the account status or contact your administrator if you believe this is a
          mistake.
        </p>
      </div>
    </Modal>
  );
}
