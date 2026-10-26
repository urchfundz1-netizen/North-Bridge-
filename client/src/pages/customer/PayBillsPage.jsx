import { AppShell } from '../../components/Layout.jsx';
import { Card, LinkButton, PageHeader } from '../../components/ui.jsx';
import { IconBill, IconTransfer } from '../../components/icons.jsx';

export default function PayBillsPage() {
  return (
    <AppShell variant="customer">
      <div className="container page" style={{ maxWidth: 760 }}>
        <PageHeader
          title="Pay bills"
          subtitle="Settle bills straight from your Northbridge account."
        />

        <Card title="Bill payments">
          <div className="empty-state">
            <IconBill size={48} className="empty-state__icon" />
            <p className="strong" style={{ color: 'var(--ink-800)' }}>
              Nothing to pay here yet
            </p>
          </div>
          <div className="row wrap gap-2 mt-4">
            <LinkButton to="/transfer" icon={IconTransfer}>
              Make a transfer
            </LinkButton>
          </div>
        </Card>
      </div>
    </AppShell>
  );
}
