/**
 * Money helpers.
 *
 * Every amount in this system is an integer number of minor units (cents).
 * Floating point is never used, so 0.1 + 0.2 problems cannot corrupt a balance.
 * These helpers exist purely to convert to/from a display string at the API
 * boundary.
 */

/**
 * Parse a user-supplied decimal string (e.g. "1250.75") into cents.
 * Rejects anything with more precision than cents, so a user can never enter an
 * amount the ledger cannot represent.
 *
 * @returns {number} amount in cents
 * @throws {Error} when the input is not a valid 2-decimal amount
 */
export function parseAmountToCents(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Amount must be a finite number');
    value = String(value);
  }
  if (typeof value !== 'string') throw new Error('Amount must be a string or number');

  const cleaned = value.trim().replace(/[,\s]/g, '');
  // Require plain decimal digits, optional thousands separators already removed.
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) {
    throw new Error('Enter a valid amount with up to two decimal places');
  }

  const [whole, fraction = ''] = cleaned.split('.');
  const cents = Number.parseInt(whole, 10) * 100 + Number.parseInt(fraction.padEnd(2, '0'), 10);
  if (!Number.isSafeInteger(cents)) throw new Error('Amount is out of range');
  return cents;
}

/**
 * Format cents as a human-readable string.
 *
 * `grouped: false` returns a plain `1234.56`, suitable for machine input and
 * for building a compact receipt payload.
 */
export function formatCents(cents, { currency = 'USD', grouped = true } = {}) {
  const value = Number(cents ?? 0) / 100;
  const formatted = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    useGrouping: grouped,
  }).format(value);
  return grouped ? formatted : value.toFixed(2);
}

/** Minor-unit exponent for supported currencies. All are 2 for now. */
const CURRENCY_EXPONENT = { USD: 2, EUR: 2, GBP: 2, JPY: 0, CAD: 2, AUD: 2 };

/** Major units -> minor units, currency-aware. */
export function toMinorUnits(majorAmount, currency = 'USD') {
  const exponent = CURRENCY_EXPONENT[currency] ?? 2;
  const scaled = Number(majorAmount) * 10 ** exponent;
  const rounded = Math.round(scaled);
  if (!Number.isSafeInteger(rounded)) throw new Error('Amount is out of range');
  return rounded;
}

/** Minor units -> major units, currency-aware. */
export function toMajorUnits(minorUnits, currency = 'USD') {
  const exponent = CURRENCY_EXPONENT[currency] ?? 2;
  return Number(minorUnits) / 10 ** exponent;
}