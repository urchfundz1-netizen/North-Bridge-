/**
 * System settings.
 *
 * Only four rules are editable here: the three money limits and the transfer fee,
 * plus the approval switch. Everything else in the settings table is read-only
 * because it is either baked into the code that enforces it (retry counts, lockout
 * thresholds) or presentation only (support contacts).
 *
 * Each rule is saved on its own, so a validation failure on one field cannot
 * discard the other edits on screen, and every save records who changed what.
 */

import { useEffect, useState } from 'react';
import { AppShell } from '../../components/Layout.jsx';
import {
  Alert,
  AsyncBoundary,
  Button,
  Card,
  DefinitionList,
  PageHeader,
  StatusBadge,
  TextField,
} from '../../components/ui.jsx';
import { adminApi } from '../../api/client.js';
import { useAsync, useAction } from '../../lib/hooks.js';
import { centsToInput, formatCents } from '../../lib/format.js';
import { IconLock, IconShield } from '../../components/icons.jsx';

/**
 * One editable rule. Money is entered in major units because that is what an
 * operator types, converted back to integer cents on submit.
 */
const RULES = [
  {
    key: 'require_transfer_approval',
    label: 'Require approval on every transfer',
    help: 'When on, no money moves until an administrator approves it. Withholding this means customers can settle instantly, so it cannot be changed without a reason.',
    type: 'boolean',
  },
  {
    key: 'transfer_fee_cents',
    label: 'Transfer fee',
    help: 'Charged to the customer on top of the amount they enter, at the moment the transfer settles.',
    type: 'money',
  },
  {
    key: 'min_transfer_cents',
    label: 'Minimum transfer',
    help: 'The smallest amount a customer may send.',
    type: 'money',
  },
  {
    key: 'max_transfer_cents',
    label: 'Maximum transfer',
    help: 'The largest single transfer. Balances can still hold more.',
    type: 'money',
  },
];

function initialDraft(rules) {
  if (!rules) return {};
  const draft = {};
  for (const rule of RULES) {
    draft[rule.key] =
      rule.type === 'boolean'
        ? Boolean(rules.requireApproval)
        : centsToInput(rules[{
            require_transfer_approval: 'requireApproval',
            transfer_fee_cents: 'transferFeeCents',
            min_transfer_cents: 'minTransferCents',
            max_transfer_cents: 'maxTransferCents',
          }[rule.key]]);
  }
  return draft;
}

export default function AdminSettingsPage() {
  const settings = useAsync(() => adminApi.settings(), []);
  const [draft, setDraft] = useState({});
  const [reason, setReason] = useState('');
  const [saved, setSaved] = useState(null);

  const [execute, pending, actionError] = useAction((fn) => fn());

  // Seed the form once the server has answered, then re-seed whenever the stored
  // values change under us (a fresh save, or another admin editing the same rule).
  useEffect(() => {
    setDraft(initialDraft(settings.data?.rules));
  }, [settings.data?.rules]);

  const rules = settings.data?.rules;

  const dirtyKeys = RULES.filter((rule) => {
    if (rule.type === 'boolean') return Boolean(draft[rule.key]) !== Boolean(rules?.requireApproval);
    return draft[rule.key] !== centsToInput(rules?.[CENTS_FIELD[rule.key]]);
  }).map((rule) => rule.key);

  const dirty = dirtyKeys.length > 0;

  /** Local sanity check first, so an obviously impossible pair never reaches the server. */
  function localProblem() {
    if (!dirty) return null;
    const min = Math.round(Number(draft.min_transfer_cents) * 100);
    const max = Math.round(Number(draft.max_transfer_cents) * 100);
    const fee = Math.round(Number(draft.transfer_fee_cents) * 100);
    if ([min, max, fee].some((value) => !Number.isFinite(value) || value < 0)) {
      return 'Enter a valid amount for each money field.';
    }
    if (min > max) return 'The minimum cannot be larger than the maximum.';
    if (!draft.require_transfer_approval && !reason.trim()) {
      return 'Give a reason for removing the approval requirement.';
    }
    return null;
  }

  const problem = localProblem();

  const saveAll = async () => {
    if (problem) return;
    const result = await execute(async () => {
      let last = null;
      for (const rule of RULES) {
        if (!dirtyKeys.includes(rule.key)) continue;
        const value =
          rule.type === 'boolean'
            ? Boolean(draft[rule.key])
            : String(Math.round(Number(draft[rule.key]) * 100));
        last = await adminApi.updateSetting(
          rule.key,
          value,
          reason.trim() || undefined,
        );
      }
      return last;
    });
    if (!result) return;
    setReason('');
    setSaved(result.message);
    settings.reload();
  };

  const discard = () => {
    setDraft(initialDraft(rules));
    setSaved(null);
  };

  return (
    <AppShell variant="admin">
      <div className="container page" style={{ maxWidth: 760 }}>
        <PageHeader
          title="Settings"
          subtitle="Banking rules that apply to every customer, enforced on the server."
        />

        {saved ? <Alert tone="success">{saved}</Alert> : null}
        {actionError ? <Alert tone="danger">{actionError.message}</Alert> : null}
        {problem ? <Alert tone="warning" title="Check the form">{problem}</Alert> : null}

        <AsyncBoundary loading={settings.loading} error={settings.error} onRetry={settings.reload}>
          <div className="stack gap-5">
            <Card>
              <div className="stack gap-5">
                {RULES.map((rule) => (
                  <div key={rule.key} className="setting-row">
                    <div className="grow">
                      <div className="row gap-2">
                        <span className="strong">{rule.label}</span>
                        {dirtyKeys.includes(rule.key) ? <span className="badge badge--warn">Edited</span> : null}
                      </div>
                      <p className="text-sm subtle mt-1">{rule.help}</p>
                    </div>

                    <div className="setting-row__control">
                      {rule.type === 'boolean' ? (
                        <label className="switch" style={{ cursor: 'pointer' }}>
                          <input
                            type="checkbox"
                            checked={Boolean(draft[rule.key])}
                            onChange={(event) => {
                              setSaved(null);
                              setDraft((prev) => ({ ...prev, [rule.key]: event.target.checked }));
                            }}
                            aria-label={rule.label}
                          />
                          <span className="switch__track" aria-hidden="true">
                            <span className="switch__thumb" />
                          </span>
                          <span className="switch__label">
                            {draft[rule.key] ? 'Required' : 'Not required'}
                          </span>
                        </label>
                      ) : (
                        <div className="input-affix">
                          <span className="input-affix__prefix" aria-hidden="true">
                            $
                          </span>
                          <input
                            className="input input--affix"
                            type="number"
                            inputMode="decimal"
                            min="0"
                            step="0.01"
                            disabled={rule.key === 'transfer_fee_cents' && draft.require_transfer_approval === false}
                            value={draft[rule.key] ?? ''}
                            onChange={(event) => {
                              setSaved(null);
                              setDraft((prev) => ({ ...prev, [rule.key]: event.target.value }));
                            }}
                            aria-label={rule.label}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </Card>

            <Card>
              <TextField
                label="Reason for these changes"
                value={reason}
                onChange={(event) => {
                  setSaved(null);
                  setReason(event.target.value);
                }}
                maxLength={240}
                placeholder="e.g. Raising the daily ceiling ahead of a holiday weekend"
                hint="Recorded against every setting saved in this batch."
              />

              <div className="row gap-3 mt-4">
                <Button variant="primary" loading={pending} disabled={!dirty || Boolean(problem)} onClick={saveAll}>
                  {dirtyKeys.length === 1 ? 'Save change' : `Save ${dirtyKeys.length} changes`}
                </Button>
                <Button variant="secondary" disabled={!dirty || pending} onClick={discard}>
                  Discard
                </Button>
                {!dirty ? <span className="text-sm subtle">No pending changes.</span> : null}
              </div>
            </Card>

            <Card title="Read-only configuration">
              <DefinitionList
                items={[
                  { label: 'Institution name', value: rules?.bankName ?? '—' },
                  { label: 'Support email', value: rules?.supportEmail ?? '—' },
                  { label: 'Support phone', value: rules?.supportPhone ?? '—' },
                  {
                    label: 'Current transfer fee',
                    value: formatCents(rules?.transferFeeCents ?? 0),
                  },
                  {
                    label: 'Transfer window',
                    value: `${formatCents(rules?.minTransferCents ?? 0)} to ${formatCents(
                      rules?.maxTransferCents ?? 0,
                    )}`,
                  },
                  {
                    label: 'Approval',
                    value: (
                      <StatusBadge
                        status={rules?.requireApproval ? 'active' : 'inactive'}
                        label={rules?.requireApproval ? 'Required' : 'Not required'}
                      />
                    ),
                  },
                ]}
              />

              <div className="divider" />

              <Alert tone="neutral" title="Enforced in code, not configuration">
                <IconLock size={14} /> Session lifetimes, PIN and password lockout thresholds, CSRF
                protection and rate limits are compiled into the server rather than stored, so they
                cannot be loosened by an administrator or an SQL injection.
              </Alert>

              <div className="row gap-2 mt-4 text-sm subtle">
                <IconShield size={14} />
                <span>Every save to this page is written to the audit log.</span>
              </div>
            </Card>
          </div>
        </AsyncBoundary>
      </div>
    </AppShell>
  );
}

const CENTS_FIELD = {
  require_transfer_approval: 'requireApproval',
  transfer_fee_cents: 'transferFeeCents',
  min_transfer_cents: 'minTransferCents',
  max_transfer_cents: 'maxTransferCents',
};
