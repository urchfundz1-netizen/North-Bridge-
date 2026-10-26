import { useEffect, useRef, useState } from 'react';
import { AppShell } from '../../components/Layout.jsx';
import { Alert, Button, Card, PageHeader } from '../../components/ui.jsx';
import { IconBitcoin, IconCheck, IconCopy } from '../../components/icons.jsx';

const BITCOIN_ADDRESS = 'bc1qpkx4uye09j9ak0p3tfrs3yjsn0uc3hu0f0fk7e';

export default function CryptoPage() {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef(null);

  useEffect(() => {
    return () => window.clearTimeout(timerRef.current);
  }, []);

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(BITCOIN_ADDRESS);
      setCopied(true);
      window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <AppShell variant="customer">
      <div className="container page" style={{ maxWidth: 760 }}>
        <PageHeader
          title="Crypto"
          subtitle="Receive Bitcoin directly to your Northbridge account."
        />

        <Card title="Bitcoin (BTC)">
          <div className="crypto-receive">
            <div className="crypto-receive__qr">
              <img
                src="/bitcoin-qr.jpeg"
                alt="QR code for your Bitcoin address"
                width="216"
                height="216"
                loading="lazy"
              />
            </div>

            <div className="crypto-receive__details">
              <div className="crypto-receive__heading">
                <IconBitcoin size={22} />
                <span>Your Bitcoin address</span>
              </div>

              <code className="crypto-receive__address">{BITCOIN_ADDRESS}</code>

              <div className="crypto-receive__actions">
                <Button
                  variant={copied ? 'secondary' : 'primary'}
                  icon={copied ? IconCheck : IconCopy}
                  onClick={copyAddress}
                >
                  {copied ? 'Address copied' : 'Copy address'}
                </Button>
              </div>

              <p className="crypto-receive__hint text-sm muted">
                Scan the QR code or copy the address to receive Bitcoin. Only send BTC on the
                Bitcoin network to this address.
              </p>

              <Alert tone="warning" title="Bitcoin network only">
                Sending any other asset or using another network may result in permanent loss of
                funds.
              </Alert>
            </div>
          </div>
        </Card>
      </div>
    </AppShell>
  );
}
