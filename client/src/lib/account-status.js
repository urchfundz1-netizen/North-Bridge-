/**
 * Account status transitions and the wording shown when one is applied.
 *
 * The customer list and the customer detail screen both change status, and an
 * administrator must not be told "frozen" means one thing in the list and
 * something else on the detail page - the difference between "cannot send
 * money" and "cannot sign in" is exactly the thing that has to be unambiguous.
 * So the available actions and their consequences are defined once, here.
 */

/**
 * Every status, in the order an administrator should be offered them.
 *
 * The server permits any move to a different status and refuses a no-op with
 * "already <status>", so offering every status except the current one is both
 * complete and safe.
 *
 * `tone` drives the button colour and the confirm button, so the consequential
 * moves read as consequential before the dialog is even opened.
 */
export const STATUS_TARGETS = [
  {
    status: 'active',
    label: 'Reactivate account',
    buttonLabel: 'Reactivate',
    tone: 'accent',
    blurb: 'Restores sign-in and outgoing transfers.',
  },
  {
    status: 'frozen',
    label: 'Freeze account',
    buttonLabel: 'Freeze',
    tone: 'secondary',
    blurb: 'Keeps sign-in and balance access, blocks outgoing transfers.',
  },
  {
    status: 'locked',
    label: 'Lock sign-in',
    buttonLabel: 'Lock sign-in',
    tone: 'secondary',
    blurb: 'Refuses sign-in and ends any session already open.',
  },
  {
    status: 'disabled',
    label: 'Disable account',
    buttonLabel: 'Disable',
    tone: 'danger',
    blurb: 'Closes the account and signs the customer out.',
  },
];

/** The moves available from `status`, in presentation order. */
export function availableStatusActions(status) {
  return STATUS_TARGETS.filter((target) => target.status !== status);
}

export function findStatusTarget(status) {
  return STATUS_TARGETS.find((target) => target.status === status) ?? null;
}

/**
 * The consequence sentence shown in the confirmation dialog. Takes a name
 * rather than a customer object so the list can pass one without knowing the
 * serializer's shape.
 */
export function statusConsequence(name, status) {
  const who = name ?? 'This account';
  if (status === 'active') {
    return `${who} will be able to sign in and send money again. Outstanding pending transfers are not resumed automatically.`;
  }
  if (status === 'frozen') {
    return `${who} will still be able to sign in and view balances, but outgoing transfers will be blocked.`;
  }
  if (status === 'locked') {
    // Sessions are revoked on the spot, not left to expire - see
    // revokeSessionsFor in the status change service. Saying otherwise here
    // would tell an administrator the customer still has access when they
    // do not.
    return `${who} will not be able to sign in, and any session they have open now will end immediately.`;
  }
  if (status === 'disabled') {
    return `${who} will not be able to sign in, and this is intended to be permanent. Use this only when closing an account.`;
  }
  return '';
}