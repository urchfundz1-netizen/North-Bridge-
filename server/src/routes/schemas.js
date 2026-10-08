/**
 * Shared Zod schemas.
 *
 * These define the exact contract between the browser and the API. Because the
 * parsed result replaces `req.body`, handlers only ever see trimmed, coerced,
 * known-shape values - unknown keys are stripped rather than forwarded to SQL.
 */

import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* Primitives                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A monetary amount as the user types it: "1", "1250.75".
 * Validated into integer cents later by `parseAmountToCents`, which is the
 * single place where the string becomes a number.
 */
export const amountSchema = z
  .string()
  .trim()
  .min(1, 'Enter an amount.')
  .max(20, 'That amount is too large.')
  .regex(/^\d{1,12}([.,]\d{1,2})?$/, 'Enter a valid amount, e.g. 1250.00');

export const passwordSchema = z
  .string()
  .min(12, 'Use at least 12 characters.')
  .max(200, 'Password is too long.')
  .refine((v) => /[a-z]/.test(v), 'Include a lowercase letter.')
  .refine((v) => /[A-Z]/.test(v), 'Include an uppercase letter.')
  .refine((v) => /[0-9]/.test(v), 'Include a number.')
  .refine((v) => /[^A-Za-z0-9]/.test(v), 'Include a symbol.');

/**
 * The transfer PIN is a separate, lower-entropy secret than the password. It
 * is therefore strictly 4 digits, and is additionally protected by attempt
 * lockout in the transfer service.
 */
export const transferPinSchema = z
  .string()
  .trim()
  .regex(/^[0-9]{4}$/, 'Your transfer PIN must be exactly 4 digits.');

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(5, 'Enter your email address.')
  .max(180, 'Email address is too long.')
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, 'Enter a valid email address.');

/** Reject a date of birth that is in the future or implies an age over 120. */
export const dateOfBirthSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter your date of birth as YYYY-MM-DD.')
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) return false;
    const age = (Date.now() - date.getTime()) / (365.25 * 24 * 3_600 * 1_000);
    return age >= 18 && age <= 120;
  }, 'You must be at least 18 years old to open an account.');

export const accountTypeSchema = z.enum(['checking', 'savings', 'premium']);
export const accountStatusSchema = z.enum(['active', 'locked', 'frozen', 'disabled']);
export const transferTypeSchema = z.enum(['local', 'international', 'wire']);

/**
 * Remove the separators people put in bank identifiers. Account numbers, routing
 * codes, IBANs and BICs are all written with spaces or hyphens for legibility, so
 * stripping them here means the stored value is canonical and the customer is not
 * punished for typing "4471 8822 01".
 *
 * Non-string values are passed through untouched so `z.preprocess` composes with
 * the rest of the pipeline (and so `undefined` still means "not supplied").
 */
const stripSeparators = (value) =>
  typeof value === 'string' ? value.replace(/[\s-]/g, '') : value;

/** Digits-only identifier, tolerant of the spacing people actually type. */
const accountNumberLike = z.preprocess(
  stripSeparators,
  z
    .string()
    .trim()
    .min(3, 'Enter the recipient account number.')
    .max(34, 'That account number is too long.')
    .regex(/^[A-Za-z0-9]+$/, 'Account numbers may only contain letters and digits.'),
);

const routingNumberSchema = z.preprocess(
  stripSeparators,
  z
    .string()
    .trim()
    .max(34, 'Routing code is too long.')
    .regex(/^[A-Za-z0-9]*$/, 'Routing codes may only contain letters and digits.')
    .optional()
    .or(z.literal('')),
);

/* -------------------------------------------------------------------------- */
/* Registration                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The registration shape, before cross-field rules. Kept as a plain object
 * schema so it can be reused: `.superRefine()` returns a ZodEffects wrapper,
 * which does not support `.omit()` / `.extend()`.
 */
const registrationShape = {
  fullName: z.string().trim().min(2, 'Enter your full name.').max(120),
  dateOfBirth: dateOfBirthSchema,
  email: emailSchema,
  phone: z
    .string()
    .trim()
    .min(7, 'Enter a contact phone number.')
    .max(30)
    .regex(/^[+0-9()\-.\s]+$/, 'Enter a valid phone number.'),
  addressLine1: z.string().trim().min(3, 'Enter your street address.').max(150),
  addressLine2: z.string().trim().max(150).optional(),
  city: z.string().trim().min(2, 'Enter your city.').max(80),
  stateRegion: z.string().trim().min(2, 'Enter your state or region.').max(80),
  postalCode: z.string().trim().min(3, 'Enter your postal code.').max(20),
  country: z.string().trim().min(2, 'Enter your country.').max(80),
  accountType: accountTypeSchema,
  password: passwordSchema,
  confirmPassword: z.string(),
  transferPin: transferPinSchema,
  confirmTransferPin: z.string(),
  acceptTerms: z.literal(true, {
    errorMap: () => ({ message: 'You must accept the terms to continue.' }),
  }),
};

export const registerSchema = z.object(registrationShape).superRefine((data, ctx) => {
  if (data.password !== data.confirmPassword) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['confirmPassword'],
      message: 'Passwords do not match.',
    });
  }
  if (data.transferPin !== data.confirmTransferPin) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['confirmTransferPin'],
      message: 'Transfer PINs do not match.',
    });
  }
  // A 4-digit PIN must not also be the password, or one leaked credential
  // would unlock both the portal and money movement.
  if (data.password === data.transferPin) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['transferPin'],
      message: 'Your transfer PIN must be different from your password.',
    });
  }
});

/* -------------------------------------------------------------------------- */
/* Authentication                                                             */
/* -------------------------------------------------------------------------- */

export const customerLoginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Enter your password.').max(200),
});

export const adminLoginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Enter your password.').max(200),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password.'),
  newPassword: passwordSchema,
  confirmPassword: z.string(),
}).refine((d) => d.newPassword === d.confirmPassword, {
  path: ['confirmPassword'],
  message: 'Passwords do not match.',
});

export const changePinSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password.'),
  currentTransferPin: transferPinSchema,
  newTransferPin: transferPinSchema,
  confirmTransferPin: z.string(),
}).superRefine((data, ctx) => {
  if (data.newTransferPin !== data.confirmTransferPin) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['confirmTransferPin'],
      message: 'Transfer PINs do not match.',
    });
  }
  if (data.newTransferPin === data.currentTransferPin) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['newTransferPin'],
      message: 'Choose a transfer PIN different from your current one.',
    });
  }
});

/* -------------------------------------------------------------------------- */
/* Profile                                                                    */
/* -------------------------------------------------------------------------- */

const addressFields = {
  addressLine1: z.string().trim().min(3).max(150),
  addressLine2: z.string().trim().max(150).nullable().optional(),
  city: z.string().trim().min(2).max(80),
  stateRegion: z.string().trim().min(2).max(80),
  postalCode: z.string().trim().min(3).max(20),
  country: z.string().trim().min(2).max(80),
};

export const updateProfileSchema = z
  .object({
    fullName: z.string().trim().min(2).max(120).optional(),
    phone: z.string().trim().min(7).max(30).optional(),
    ...addressFields,
  })
  .partial()
  .refine((data) => Object.keys(data).length > 0, 'No changes were submitted.');

/* -------------------------------------------------------------------------- */
/* Transfers                                                                  */
/* -------------------------------------------------------------------------- */

export const transferSchema = z.object({
  transferType: transferTypeSchema,
  recipientName: z.string().trim().min(2, "Enter the recipient's full name.").max(120),
  recipientAccountNumber: accountNumberLike,
  recipientBankId: z.coerce.number().int().positive('Select a recipient bank.'),
  recipientRoutingNumber: routingNumberSchema,
  // IBANs and BICs are written in groups of four for legibility, so people type
  // and paste them with spaces. Strip separators before validating, and store the
  // canonical unbroken form so receipts match what the destination bank expects.
  recipientIban: z.preprocess(
    stripSeparators,
    z.string().trim().max(34).regex(/^[A-Za-z0-9]*$/).optional().or(z.literal('')),
  ),
  recipientSwiftBic: z.preprocess(
    stripSeparators,
    z.string().trim().max(11).regex(/^[A-Za-z0-9]*$/).optional().or(z.literal('')),
  ),
  recipientCountry: z.string().trim().max(80).optional(),
  amount: amountSchema,
  description: z.string().trim().max(240).optional(),
  transferPin: transferPinSchema,
  /** Client-generated token; a retried submit returns the original transfer. */
  idempotencyKey: z.string().trim().max(64).optional(),
});

/** Same as a transfer, without the PIN - used to quote a fee before commit. */
export const transferQuoteSchema = transferSchema.omit({ transferPin: true });

/* -------------------------------------------------------------------------- */
/* Admin                                                                      */
/* -------------------------------------------------------------------------- */

export const adminCreateCustomerSchema = z
  .object(registrationShape)
  .omit({ confirmPassword: true, confirmTransferPin: true, acceptTerms: true })
  .extend({
    transferPin: transferPinSchema.optional(),
    reason: z.string().trim().max(240).optional(),
  });

export const adminUpdateCustomerSchema = z
  .object({
    fullName: z.string().trim().min(2).max(120).optional(),
    dateOfBirth: dateOfBirthSchema.optional(),
    email: emailSchema.optional(),
    phone: z.string().trim().min(7).max(30).optional(),
    ...addressFields,
    accountType: accountTypeSchema.optional(),
    reason: z.string().trim().max(240).optional(),
  })
  .refine((data) => Object.keys(data).some((key) => key !== 'reason'), 'No changes were submitted.');

export const changeStatusSchema = z.object({
  status: accountStatusSchema,
  reason: z
    .string()
    .trim()
    .min(5, 'Please state the reason for this status change.')
    .max(240),
});

export const fundAccountSchema = z.object({
  amount: amountSchema,
  description: z.string().trim().max(240).optional(),
  reference: z.string().trim().max(64).optional(),
});

export const adjustBalanceSchema = z.object({
  amount: z
    .string()
    .trim()
    .regex(/^[+-]?\d{1,12}([.,]\d{1,2})?$/, 'Enter a valid amount.'),
  reason: z.string().trim().min(5, 'Please state the reason for this adjustment.').max(240),
});

export const reviewTransferSchema = z.object({
  note: z.string().trim().max(240).optional(),
  reason: z.string().trim().max(240).optional(),
});

export const bankSchema = z.object({
  name: z.string().trim().min(2, 'Enter the bank name.').max(120),
  code: z.string().trim().max(20).optional(),
  country: z.string().trim().min(2).max(80).default('United States'),
  routingNumberLength: z.coerce.number().int().min(3).max(12).nullable().optional(),
  supportsLocal: z.coerce.boolean().default(true),
  supportsInternational: z.coerce.boolean().default(true),
  supportsWire: z.coerce.boolean().default(true),
  isActive: z.coerce.boolean().default(true),
  reason: z.string().trim().max(240).optional(),
});

/* -------------------------------------------------------------------------- */
/* Query strings                                                              */
/* -------------------------------------------------------------------------- */

const optionalTrimmed = z.string().trim().max(120).optional();

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const transferListSchema = paginationSchema.extend({
  status: z.enum(['all', 'pending', 'approved', 'rejected', 'cancelled']).default('all'),
  search: optionalTrimmed,
});

export const customerListSchema = paginationSchema.extend({
  status: z.enum(['all', 'active', 'locked', 'frozen', 'disabled']).default('all'),
  accountType: z.enum(['all', 'checking', 'savings', 'premium']).default('all'),
  search: optionalTrimmed,
});

export const bankListSchema = z.object({
  includeInactive: z.coerce.boolean().default(false),
  transferType: z.enum(['all', 'local', 'international', 'wire']).default('all'),
  search: optionalTrimmed,
});

export const ledgerListSchema = paginationSchema.extend({
  entryType: z
    .enum(['all', 'deposit', 'transfer_principal', 'transfer_fee', 'adjustment'])
    .default('all'),
});

export const auditListSchema = paginationSchema.extend({
  action: z.string().trim().max(60).optional(),
  actorType: z.enum(['all', 'admin', 'customer', 'system']).default('all'),
  actorId: z.coerce.number().int().positive().optional(),
  targetType: z.string().trim().max(40).optional(),
  search: optionalTrimmed,
});