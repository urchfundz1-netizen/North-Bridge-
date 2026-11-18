import { Button, Modal } from './ui.jsx';

export function FrozenTransferNotice({ open, onClose, accountNumber }) {
  const lastFour = String(accountNumber ?? '').replace(/\D/g, '').slice(-4) || '----';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Account Temporarily Frozen"
      titleClassName="text-center"
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
          Your account has been temporarily frozen following the detection of unusual or
          unrecognized login activity. This precautionary measure has been taken to safeguard your
          account and prevent potential unauthorized access.
        </p>
        <p>
          Please contact our customer support team for assistance with account verification and the
          restoration of your account access.
        </p>
        <p>
          Thank you for your cooperation. <strong>Your security remains our priority.</strong>
        </p>
      </div>
    </Modal>
  );
}
