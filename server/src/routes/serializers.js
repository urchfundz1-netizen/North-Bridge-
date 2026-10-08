/**
 * Response serialisers.
 *
 * Nothing that leaves the API is a raw database row. Every row containing a
 * password hash, transfer-PIN hash or failed-attempt counter passes through one
 * of these functions, so a new secret column can never be leaked by forgetting
 * to strip it in a route.
 */

import { formatCents } from '../core/money.js';

const TYPE_LABELS = {
  local: 'Local Transfer',
  international: 'International Transfer',
  wire: 'Wire Transfer',
};

const STATUS_LABELS = {
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

/** Customer profile for the signed-in customer. */
export function toCustomerSelf(customer) {
  return {
    id: customer.id,
    accountNumber: customer.account_number,
    fullName: customer.full_name,
    dateOfBirth: customer.date_of_birth,
    email: customer.email,
    phone: customer.phone,
    address: {
      line1: customer.address_line1,
      line2: customer.address_line2,
      city: customer.city,
      stateRegion: customer.state_region,
      postalCode: customer.postal_code,
      country: customer.country,
    },
    accountType: customer.account_type,
    status: customer.status,
    statusReason: customer.status_reason,
    statusChangedAt: customer.status_changed_at,
    balanceCents: customer.balance_cents,
    balanceFormatted: formatCents(customer.balance_cents),
    profilePicture: customer.profile_picture,
    lastLoginAt: customer.last_login_at,
    createdAt: customer.created_at,
    // Surfaced so the portal can warn before the user is surprised by a limit.
    transferPinLockedUntil: customer.transfer_pin_locked_until,
    canTransfer: customer.status === 'active',
  };
}

/** Customer record as an administrator sees it - more detail, still no secrets. */
export function toCustomerAdmin(customer) {
  return {
    id: customer.id,
    accountNumber: customer.account_number,
    fullName: customer.full_name,
    dateOfBirth: customer.date_of_birth,
    email: customer.email,
    phone: customer.phone,
    address: {
      line1: customer.address_line1,
      line2: customer.address_line2,
      city: customer.city,
      stateRegion: customer.state_region,
      postalCode: customer.postal_code,
      country: customer.country,
    },
    accountType: customer.account_type,
    status: customer.status,
    statusReason: customer.status_reason,
    statusChangedAt: customer.status_changed_at,
    statusChangedByAdminId: customer.status_changed_by_admin_id,
    balanceCents: customer.balance_cents,
    balanceFormatted: formatCents(customer.balance_cents),
    profilePicture: customer.profile_picture,
    lastLoginAt: customer.last_login_at,
    createdAt: customer.created_at,
    updatedAt: customer.updated_at,
    failedLoginAttempts: customer.failed_login_attempts,
    lockedUntil: customer.locked_until,
    transferPinLockedUntil: customer.transfer_pin_locked_until,
  };
}

/** Ledger row for the customer statement view. */
export function toLedgerEntry(entry) {
  return {
    id: entry.id,
    type: entry.entry_type,
    typeLabel: ledgerTypeLabel(entry.entry_type),
    direction: entry.amount_cents >= 0 ? 'credit' : 'debit',
    amountCents: entry.amount_cents,
    amountFormatted: formatCents(Math.abs(entry.amount_cents)),
    signedFormatted: `${entry.amount_cents >= 0 ? '+' : '-'}${formatCents(Math.abs(entry.amount_cents))}`,
    balanceAfterCents: entry.balance_after_cents,
    balanceAfterFormatted: formatCents(entry.balance_after_cents),
    description: entry.description,
    referenceNumber: entry.reference_number,
    transferId: entry.transfer_id,
    createdAt: entry.created_at,
    adminName: entry.admin_name ?? null,
  };
}

function ledgerTypeLabel(type) {
  return (
    {
      deposit: 'Deposit',
      transfer_principal: 'Transfer',
      transfer_fee: 'Transfer Fee',
      adjustment: 'Adjustment',
    }[type] ?? type
  );
}

/** Transfer row, safe for the owning customer. */
export function toTransfer(transfer, { includeCustomer = false } = {}) {
  return {
    id: transfer.id,
    referenceNumber: transfer.reference_number,
    receiptNumber: transfer.receipt_number ?? null,
    transferType: transfer.transfer_type,
    transferTypeLabel: TYPE_LABELS[transfer.transfer_type] ?? transfer.transfer_type,
    status: transfer.status,
    statusLabel: STATUS_LABELS[transfer.status] ?? transfer.status,
    requiresApproval: Boolean(transfer.requires_approval),
    recipient: {
      name: transfer.recipient_name,
      accountNumber: transfer.recipient_account_number,
      bank: transfer.recipient_bank_name,
      routingNumber: transfer.recipient_routing_number,
      iban: transfer.recipient_iban,
      swiftBic: transfer.recipient_swift_bic,
      country: transfer.recipient_country,
    },
    amountCents: transfer.amount_cents,
    amountFormatted: formatCents(transfer.amount_cents),
    feeCents: transfer.fee_cents,
    feeFormatted: formatCents(transfer.fee_cents),
    totalDebitCents: transfer.total_debit_cents,
    totalDebitFormatted: formatCents(transfer.total_debit_cents),
    description: transfer.description,
    requestedAt: transfer.requested_at,
    reviewedAt: transfer.reviewed_at,
    settledAt: transfer.settled_at,
    cancelledAt: transfer.cancelled_at,
    rejectionReason: transfer.rejection_reason,
    reviewNote: transfer.review_note,
    ...(includeCustomer
      ? {
          customer: {
            id: transfer.customer_id,
            name: transfer.customer_name,
            accountNumber: transfer.customer_account_number,
            email: transfer.customer_email,
            status: transfer.customer_status ?? null,
          },
        }
      : {}),
  };
}

/** Bank catalogue entry. */
export function toBank(bank) {
  return {
    id: bank.id,
    name: bank.name,
    code: bank.code,
    country: bank.country,
    routingNumberLength: bank.routing_number_length,
    supportsLocal: Boolean(bank.supports_local),
    supportsInternational: Boolean(bank.supports_international),
    supportsWire: Boolean(bank.supports_wire),
    isActive: Boolean(bank.is_active),
    createdAt: bank.created_at,
    updatedAt: bank.updated_at,
  };
}

/** Administrator identity. Never includes the password hash. */
export function toAdminSelf(admin) {
  return {
    id: admin.id,
    email: admin.email,
    fullName: admin.full_name,
    role: admin.role,
    status: admin.status,
    lastLoginAt: admin.last_login_at,
    createdAt: admin.created_at,
  };
}

/** Audit log row for the admin viewer. */
export function toAuditLog(row) {
  let metadata = null;
  try {
    metadata = row.metadata_json ? JSON.parse(row.metadata_json) : null;
  } catch {
    metadata = null;
  }
  return {
    id: row.id,
    actor: {
      type: row.actor_type,
      id: row.actor_id,
      email: row.actor_email,
    },
    action: row.action,
    target: {
      type: row.target_type,
      id: row.target_id,
      label: row.target_label,
    },
    reason: row.reason,
    metadata,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    createdAt: row.created_at,
  };
}

/** Standard paginated envelope. */
export function paginated(rows, total, { limit, offset }) {
  return {
    data: rows,
    pagination: {
      total,
      limit,
      offset,
      hasMore: offset + rows.length < total,
    },
  };
}