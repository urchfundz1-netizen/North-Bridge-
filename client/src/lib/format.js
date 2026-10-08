/**
 * Presentation helpers.
 *
 * All monetary values cross the wire as integer cents. These functions are the
 * only place that converts cents to a display string, so rounding can never be
 * introduced twice (once on the way in, once on the way out).
 */

const currencyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const compactFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 1,
});

/** Format integer cents as a currency string. */
export function formatCents(cents, { compact = false, showSign = false } = {}) {
  const amount = (Number(cents) || 0) / 100;
  if (compact) {
    const sign = amount < 0 ? '-' : showSign && amount > 0 ? '+' : '';
    return `${sign}${compactFormatter.format(Math.abs(amount))}`;
  }
  if (showSign && amount > 0) return `+${currencyFormatter.format(amount)}`;
  if (amount < 0) {
    // Intl renders the minus before the symbol; banking UIs put it after.
    return `-${currencyFormatter.format(Math.abs(amount))}`;
  }
  return currencyFormatter.format(amount);
}

/** Cents -> plain decimal string, for populating amount inputs. */
export function centsToInput(cents) {
  return ((Number(cents) || 0) / 100).toFixed(2);
}

/** Bank account numbers are grouped in fours for readability. */
export function formatAccountNumber(accountNumber) {
  const digits = String(accountNumber ?? '').replace(/\D/g, '');
  return digits.replace(/(\d{4})(?=\d)/g, '$1 ');
}

/** Mask everything but the last four digits. */
export function maskAccountNumber(accountNumber) {
  const digits = String(accountNumber ?? '').replace(/\D/g, '');
  if (digits.length <= 4) return digits;
  return `•••• ${digits.slice(-4)}`;
}

const dateTimeFormatter = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

const dateFormatter = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' });

export function formatDateTime(value) {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return dateTimeFormatter.format(date);
}

export function formatDate(value) {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return dateFormatter.format(date);
}

/** "3 days ago" style label for recent activity. */
export function formatRelative(value) {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const units = [
    ['year', 31536000],
    ['month', 2592000],
    ['week', 604800],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  const formatter = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' });
  for (const [unit, secondsPerUnit] of units) {
    if (Math.abs(seconds) >= secondsPerUnit) {
      return formatter.format(Math.round(seconds / secondsPerUnit), unit);
    }
  }
  return formatter.format(seconds, 'second');
}

/** "2h 15m" duration, for session/expiry countdowns. */
export function formatDuration(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  if (hours === 0) return `${mins}m`;
  if (mins === 0) return `${hours}h`;
  return `${hours}h ${mins}m`;
}

/**
 * Two-letter monogram for the avatar fallback.
 * The API exposes a single `fullName`, so initials are derived from its words.
 */
export function initials(fullName) {
  const words = String(fullName ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 'NB';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words[words.length - 1][0]}`.toUpperCase();
}

/** Title-cased enum for display: `pending` -> `Pending`. */
export function humanize(value) {
  if (!value) return '--';
  const text = String(value).replace(/[_-]+/g, ' ').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Group a list of transactions by calendar day for sectioned rendering. */
export function groupByDate(items = []) {
  const groups = new Map();
  for (const item of items) {
    const key = String(item.createdAt ?? '').slice(0, 10) || 'unknown';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.entries()].map(([date, transactions]) => ({ date, transactions }));
}

/** Transfer types the API accepts, matching `transferTypeSchema`. */
export const TRANSFER_TYPE_OPTIONS = [
  { value: 'local', label: 'Northbridge transfer', description: 'Another account held at Northbridge.' },
  { value: 'international', label: 'International (SWIFT)', description: 'Overseas destination bank.' },
  { value: 'wire', label: 'Wire (ACH)', description: 'Domestic wire or ACH transfer.' },
];

/** Account types the API accepts, matching `accountTypeSchema`. */
export const ACCOUNT_TYPE_OPTIONS = [
  { value: 'checking', label: 'Checking' },
  { value: 'savings', label: 'Savings' },
  { value: 'premium', label: 'Premium' },
];

export const ACCOUNT_STATUS_OPTIONS = [
  { value: 'active', label: 'Active', description: 'Full access, including transfers.' },
  { value: 'frozen', label: 'Frozen', description: 'View only. Transfers are blocked.' },
  { value: 'locked', label: 'Locked', description: 'Sign-in blocked after failed attempts.' },
  { value: 'disabled', label: 'Disabled', description: 'Sign-in blocked by an administrator.' },
];

export const TRANSFER_STATUS_OPTIONS = [
  { value: 'all', label: 'All transfers' },
  { value: 'pending', label: 'Pending review' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'cancelled', label: 'Cancelled' },
];
