import { AppShell } from '../../components/Layout.jsx';
import { Card, DefinitionList, PageHeader } from '../../components/ui.jsx';
import { IconCard } from '../../components/icons.jsx';
import { useSession } from '../../context/SessionContext.jsx';

const DEMO_CARD = {
  number: '4242 4242 4242 4242',
  expiry: '12/29',
};

export default function LinkCardPage() {
  const { customer } = useSession();

  return (
    <AppShell variant="customer">
      <div className="container page" style={{ maxWidth: 560 }}>
        <PageHeader
          title="Card"
          subtitle="The card details linked to your Northbridge account."
        />

        <Card title="Linked card">
          <div className="row gap-3 mb-5">
            <span className="txn__icon txn__icon--debit">
              <IconCard size={20} />
            </span>
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="strong mono">{DEMO_CARD.number}</div>
              <div className="text-sm muted truncate">{customer?.fullName ?? 'Demo Cardholder'}</div>
            </div>
          </div>

          <DefinitionList
            items={[
              { label: 'Name on card', value: customer?.fullName ?? 'Demo Cardholder' },
              { label: 'Card number', value: <span className="mono">{DEMO_CARD.number}</span> },
              { label: 'Expiry', value: DEMO_CARD.expiry },
              {
                label: 'Account number',
                value: <span className="mono">{customer?.accountNumber ?? '—'}</span>,
              },
            ]}
          />
        </Card>
      </div>
    </AppShell>
  );
}
