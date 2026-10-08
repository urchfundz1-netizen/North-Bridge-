/**
 * Customer transfer list.
 *
 * The list itself lives in `TransferBrowser` because the Activity page offers the
 * same list as one of its tabs; this route stays for links that point straight at
 * a customer's transfers and for the "back to transfers" link on a transfer.
 */

import { Link } from 'react-router-dom';
import { AppShell } from '../../components/Layout.jsx';
import { PageHeader } from '../../components/ui.jsx';
import TransferBrowser from '../../components/TransferBrowser.jsx';
import { IconPlus } from '../../components/icons.jsx';

export default function TransfersPage() {
  return (
    <AppShell variant="customer">
      <div className="container page">
        <PageHeader
          title="Transfers"
          subtitle="Everything you have sent, and where it currently stands."
          actions={
            <Link className="btn btn--primary" to="/transfer">
              <IconPlus size={17} />
              New transfer
            </Link>
          }
        />

        <TransferBrowser />
      </div>
    </AppShell>
  );
}