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
        <p>Dear Valued Customer,</p>
        <p>
          Your Northbridge Bank account ending in <strong>{lastFour}</strong> has been
          temporarily frozen due to unrecognized activity detected on your account.
        </p>
        <p>
          To resolve this issue, please visit your nearest official Northbridge Bank branch in
          person with a valid government-issued ID for identity verification and further
          assistance.
        </p>
        <p>
          Your security is our priority. We apologize for any inconvenience and appreciate your
          cooperation.
        </p>
        <p>
          <strong>Northbridge Bank</strong>
          <br />
          Customer Support Team
        </p>
      </div>
    </Modal>
  );
}
