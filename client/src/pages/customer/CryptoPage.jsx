import { AppShell } from '../../components/Layout.jsx';
import { Card, PageHeader } from '../../components/ui.jsx';
import { IconBitcoin } from '../../components/icons.jsx';

export default function CryptoPage() {
  return (
    <AppShell variant="customer">
      <div className="container page" style={{ maxWidth: 760 }}>
        <PageHeader
          title="Crypto"
          subtitle="Buy, sell and hold digital assets."
        />

        <Card title="Crypto">
          <div className="empty-state">
            <IconBitcoin size={48} className="empty-state__icon" />
            <p className="strong" style={{ color: 'var(--ink-800)' }}>
              No crypto activity yet
            </p>
          </div>
        </Card>
      </div>
    </AppShell>
  );
}
