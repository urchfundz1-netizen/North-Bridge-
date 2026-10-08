/**
 * Shared presentational primitives.
 *
 * These are deliberately dumb: no data fetching, no API knowledge. Keeping the
 * feedback surfaces (badges, alerts, tables, modals) in one file makes status
 * colours and empty-state copy consistent across the customer and admin apps.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useScrollLock } from '../lib/hooks.js';
import {
  IconAlert,
  IconCheckCircle,
  IconChevronDown,
  IconInbox,
  IconInfo,
  IconX,
} from './icons.jsx';
import { humanize } from '../lib/format.js';

/* -------------------------------------------------------------------------- */
/* Status badges                                                              */
/* -------------------------------------------------------------------------- */

const STATUS_TONE = {
  // Customer account status
  active: 'success',
  frozen: 'warning',
  locked: 'danger',
  disabled: 'neutral',
  // Transfer status
  pending: 'warning',
  pending_review: 'warning',
  approved: 'success',
  rejected: 'danger',
  cancelled: 'neutral',
  // Admin role
  super_admin: 'gold',
  admin: 'info',
  // Banking institution status
  active_bank: 'success',
  inactive: 'neutral',
};

export function StatusBadge({ status, label, tone }) {
  const resolved = tone ?? STATUS_TONE[String(status)] ?? 'neutral';
  return (
    <span className={`badge badge--${resolved}`}>
      <span className="badge__dot" aria-hidden="true" />
      {label ?? humanize(status)}
    </span>
  );
}

/** Badge for a `method`/direction label, e.g. "Deposit" vs "Withdrawal". */
export function DirectionBadge({ direction, label }) {
  const isCredit = direction === 'credit' || direction === 'deposit' || direction === 'in';
  return (
    <span className={`badge badge--${isCredit ? 'success' : 'info'}`}>
      {label ?? (isCredit ? 'Credit' : 'Debit')}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Alerts                                                                     */
/* -------------------------------------------------------------------------- */

const ALERT_ICON = {
  info: IconInfo,
  success: IconCheckCircle,
  warning: IconAlert,
  danger: IconAlert,
};

export function Alert({ tone = 'info', title, children, className = '' }) {
  const Glyph = ALERT_ICON[tone] ?? IconInfo;
  return (
    <div className={`alert alert--${tone} ${className}`} role={tone === 'danger' ? 'alert' : 'status'}>
      <Glyph size={20} className="alert__icon" />
      <div className="alert__body">
        {title ? <div className="alert__title">{title}</div> : null}
        {children ? <div>{children}</div> : null}
      </div>
    </div>
  );
}

/**
 * Renders an ApiError (or any Error) with server-supplied field details.
 * Kept separate from Alert because it understands the API error shape.
 */
export function ErrorNotice({ error, className = '', onRetry }) {
  if (!error) return null;
  const fields = error.details && typeof error.details === 'object' ? error.details : null;
  const entries = fields ? Object.entries(fields) : [];

  return (
    <div className={`alert alert--danger ${className}`} role="alert">
      <IconAlert size={20} className="alert__icon" />
      <div className="alert__body">
        <div className="alert__title">{error.message ?? 'Something went wrong.'}</div>
        {entries.length > 0 ? (
          <ul style={{ marginTop: '0.25rem' }}>
            {entries.map(([field, message]) => (
              <li key={field}>
                <strong style={{ textTransform: 'capitalize' }}>{field.replace(/_/g, ' ')}:</strong>{' '}
                {Array.isArray(message) ? message.join(' ') : String(message)}
              </li>
            ))}
          </ul>
        ) : null}
        {onRetry ? (
          <div style={{ marginTop: 'var(--space-3)' }}>
            <Button variant="secondary" size="sm" onClick={onRetry}>
              Try again
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Form fields                                                                */
/* -------------------------------------------------------------------------- */

export function Field({
  label,
  htmlFor,
  hint,
  error,
  required = false,
  children,
  className = '',
}) {
  return (
    <div className={`field ${className}`}>
      {label ? (
        <label className="field__label" htmlFor={htmlFor}>
          {label}
          {required ? (
            <span className="field__required" aria-hidden="true">
              *
            </span>
          ) : null}
        </label>
      ) : null}
      {children}
      {hint && !error ? <span className="field__hint">{hint}</span> : null}
      {error ? (
        <span className="field__error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

export function TextField({
  label,
  hint,
  error,
  required,
  className,
  inputClassName = '',
  ...rest
}) {
  const generatedId = useId();
  const id = rest.id ?? generatedId;
  const invalid = Boolean(error);
  return (
    <Field label={label} htmlFor={id} hint={hint} error={error} required={required} className={className}>
      <input
        {...rest}
        id={id}
        className={`input ${inputClassName}`}
        aria-invalid={invalid || undefined}
        aria-describedby={hint && !invalid ? `${id}-hint` : undefined}
        required={required}
      />
    </Field>
  );
}

/**
 * A password or PIN entry with a show/hide control.
 *
 * Secrets are the one field type that cannot be proofread by eye, so every one
 * of them gets the same reveal button instead of each screen inventing its own.
 * `revealLabel` keeps the button text meaningful for PINs as well as passwords.
 */
export function SecretField({ revealLabel = 'password', hint, ...rest }) {
  const [visible, setVisible] = useState(false);
  const toggle = (
    <button
      type="button"
      className="btn btn--ghost btn--sm secret-toggle"
      onClick={() => setVisible((value) => !value)}
      aria-pressed={visible}
    >
      {visible ? `Hide ${revealLabel}` : `Show ${revealLabel}`}
    </button>
  );

  return (
    <TextField
      {...rest}
      type={visible ? 'text' : 'password'}
      autoComplete={rest.autoComplete ?? 'off'}
      hint={
        hint ? (
          <span className="secret-hint">
            <span>{hint}</span>
            {toggle}
          </span>
        ) : toggle
      }
    />
  );
}

export function SelectField({
  label,
  hint,
  error,
  required,
  options = [],
  placeholder,
  className,
  children,
  ...rest
}) {
  const generatedId = useId();
  const id = rest.id ?? generatedId;
  return (
    <Field label={label} htmlFor={id} hint={hint} error={error} required={required} className={className}>
      <select {...rest} id={id} className="select" aria-invalid={Boolean(error) || undefined} required={required}>
        {placeholder ? <option value="">{placeholder}</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
        {children}
      </select>
    </Field>
  );
}

export function TextAreaField({ label, hint, error, required, className, ...rest }) {
  const generatedId = useId();
  const id = rest.id ?? generatedId;
  return (
    <Field label={label} htmlFor={id} hint={hint} error={error} required={required} className={className}>
      <textarea {...rest} id={id} className="textarea" aria-invalid={Boolean(error) || undefined} required={required} />
    </Field>
  );
}

/* -------------------------------------------------------------------------- */
/* Radio cards (account type, status, transfer direction)                     */
/* -------------------------------------------------------------------------- */

export function RadioCardGroup({ legend, name, value, onChange, options, columns, className = '' }) {
  return (
    <fieldset className={`fieldset ${className}`}>
      <legend className="fieldset__legend">{legend}</legend>
      <div className={`radio-cards ${columns === 3 ? 'radio-cards--3' : ''}`}>
        {options.map((option) => {
          const id = `${name}-${option.value}`;
          return (
            <label className="radio-card" key={option.value} htmlFor={id}>
              <input
                type="radio"
                id={id}
                name={name}
                value={option.value}
                checked={value === option.value}
                onChange={(event) => onChange(event.target.value)}
                disabled={option.disabled}
              />
              <span className="radio-card__body">
                <span className="radio-card__title">{option.label}</span>
                {option.description ? <span className="radio-card__desc">{option.description}</span> : null}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/* -------------------------------------------------------------------------- */
/* Buttons                                                                    */
/* -------------------------------------------------------------------------- */

export function Button({
  variant = 'primary',
  size,
  loading = false,
  disabled,
  icon: Glyph,
  children,
  className = '',
  type = 'button',
  ...rest
}) {
  const classes = [
    'btn',
    `btn--${variant}`,
    size === 'sm' ? 'btn--sm' : size === 'lg' ? 'btn--lg' : '',
    rest.className ?? '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button type={type} {...rest} className={classes} disabled={disabled || loading}>
      {loading ? <span className="spinner" aria-hidden="true" /> : Glyph ? <Glyph size={17} /> : null}
      {/* Wrapped in an element on purpose: when Google's translation has
          wrapped the label text, React's insertion reference for the
          loading spinner must be a stable element - pointing at a wrapped-
          away text node throws NotFoundError mid-submit. */}
      <span className="btn__label">{children}</span>
    </button>
  );
}

/**
 * A link that looks like a button.
 *
 * `to` renders a router `<Link>` so navigation stays client-side; `href`
 * renders a plain anchor for anything leaving the app (or a full page load).
 * A router `to` spread onto a bare `<a>` produces an element with no `href`,
 * which looks clickable and does nothing — so the two cases must be told apart
 * rather than merged into one tag.
 */
export function LinkButton({
  variant = 'primary',
  size,
  icon: Glyph,
  children,
  className = '',
  to,
  ...rest
}) {
  const classes = [
    'btn',
    `btn--${variant}`,
    size === 'sm' ? 'btn--sm' : size === 'lg' ? 'btn--lg' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const content = (
    <>
      {Glyph ? <Glyph size={17} /> : null}
      {children}
    </>
  );

  if (to !== undefined) {
    return (
      <Link to={to} className={classes} {...rest}>
        {content}
      </Link>
    );
  }

  return (
    <a className={classes} {...rest}>
      {content}
    </a>
  );
}

/* -------------------------------------------------------------------------- */
/* Cards                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * `toggle`, when given, turns the title into a disclosure control:
 * `{ expanded, onToggle, controls }`. The button stays inside the `h2` so the
 * card keeps its heading semantics and its place in the document outline -
 * a screen reader still announces "Review activity, heading, level 2" before
 * the expanded/collapsed state.
 */
export function Card({
  title,
  subtitle,
  actions,
  footer,
  children,
  className = '',
  bodyClassName = '',
  toggle,
}) {
  return (
    <section className={`card ${className}`}>
      {title || actions ? (
        <header className="card__header">
          <div className="grow">
            {title ? (
              <h2 className="card__title">
                {toggle ? (
                  <button
                    type="button"
                    className="card__disclosure"
                    aria-expanded={toggle.expanded}
                    aria-controls={toggle.controls}
                    onClick={toggle.onToggle}
                  >
                    {title}
                    <IconChevronDown size={16} className="card__disclosure-icon" />
                  </button>
                ) : (
                  title
                )}
              </h2>
            ) : null}
            {subtitle ? <div className="text-sm muted mt-1">{subtitle}</div> : null}
          </div>
          {actions ? <div className="row gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className={`card__body ${bodyClassName}`}>{children}</div>
      {footer ? <footer className="card__footer">{footer}</footer> : null}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Stats                                                                      */
/* -------------------------------------------------------------------------- */

export function Stat({ label, value, hint, tone, as: Component = 'div', ...rest }) {
  return (
    <Component className={`stat ${tone ? `stat--${tone}` : ''}`} {...rest}>
      <span className="stat__label">{label}</span>
      <span className="stat__value">{value}</span>
      {hint ? <span className="stat__hint">{hint}</span> : null}
    </Component>
  );
}

/* -------------------------------------------------------------------------- */
/* Tables                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * `columns` accepts `{ key, header, align, width, render }`. Rendering is
 * delegated entirely to the caller so tables can show badges, links and money
 * without this component knowing about any domain type.
 */
export function DataTable({
  columns,
  rows,
  rowKey = (row, index) => row.id ?? index,
  onRowClick,
  empty = 'No records to display.',
  fixed = false,
  footer,
}) {
  if (!rows || rows.length === 0) {
    return <EmptyState title={empty} />;
  }

  return (
    <>
      <div className="table-wrap">
        <table className={`table ${fixed ? 'table--fixed' : ''}`}>
          <thead>
            <tr>
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  style={{
                    textAlign: column.align === 'right' ? 'right' : 'left',
                    width: column.width,
                  }}
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr
                key={rowKey(row, index)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                style={onRowClick ? { cursor: 'pointer' } : undefined}
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={column.align === 'right' ? 'cell-num' : undefined}
                    data-label={column.header}
                  >
                    {column.render ? column.render(row, index) : row[column.key]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {footer}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Empty / loading states                                                     */
/* -------------------------------------------------------------------------- */

export function EmptyState({ title = 'Nothing here yet', description, action, icon: Glyph = IconInbox }) {
  return (
    <div className="empty-state">
      <Glyph size={48} className="empty-state__icon" />
      <p className="strong" style={{ color: 'var(--ink-800)' }}>
        {title}
      </p>
      {description ? <p className="text-sm mt-1">{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function LoadingBlock({ label = 'Loading' }) {
  return (
    <div className="loading-block" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label}…</span>
    </div>
  );
}

export function SkeletonRows({ rows = 5 }) {
  return (
    <div className="stack gap-3" aria-hidden="true">
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="skeleton" style={{ width: `${100 - index * 6}%` }} />
      ))}
    </div>
  );
}

/**
 * Renders the standard loading/error/empty trio so every list page behaves the
 * same way. `children` is called only when there is something to show.
 */
export function AsyncBoundary({ loading, error, empty, emptyTitle, onRetry, children, skeletonRows }) {
  if (loading) return skeletonRows ? <SkeletonRows rows={skeletonRows} /> : <LoadingBlock />;
  if (error) {
    return <ErrorNotice error={error} onRetry={onRetry} />;
  }
  if (empty) return <EmptyState title={emptyTitle ?? 'No records to display.'} />;
  return children;
}

/* -------------------------------------------------------------------------- */
/* Modal                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Accessible dialog: focus moves inside on open, is trapped by the backdrop
 * (which closes on Escape), and body scroll is locked while it is shown.
 */
export function Modal({ open, onClose, title, subtitle, children, footer, width }) {
  const panelRef = useRef(null);
  const titleId = useId();
  const previouslyFocusedRef = useRef(null);

  useScrollLock(open);

  useEffect(() => {
    if (!open) return undefined;
    previouslyFocusedRef.current = document.activeElement;
    const panel = panelRef.current;
    // Focus the panel itself rather than the first input so screen readers
    // announce the dialog title before the fields.
    panel?.focus();
    return () => {
      const previous = previouslyFocusedRef.current;
      if (previous && typeof previous.focus === 'function') previous.focus();
    };
  }, [open]);

  const handleKeyDown = (event) => {
    if (event.key === 'Escape') {
      onClose?.();
      return;
    }
    if (event.key !== 'Tab') return;

    // Trap Tab inside the dialog.
    const focusable = panelRef.current?.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    if (!focusable || focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  if (!open) return null;

  return (
    // Dismissal by clicking outside is a mouse-only convenience; the dialog is
    // already dismissible with Escape and with its own close control.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        // Only close when the click starts on the backdrop itself.
        if (event.target === event.currentTarget) onClose?.();
      }}
      onKeyDown={handleKeyDown}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={panelRef}
        style={width ? { maxWidth: width } : undefined}
      >
        <header className="modal__header">
          <div className="grow">
            <h2 className="text-lg" id={titleId}>
              {title}
            </h2>
            {subtitle ? <div className="text-sm muted mt-1">{subtitle}</div> : null}
          </div>
          <button type="button" className="modal__close" onClick={onClose} aria-label="Close dialog">
            <IconX size={20} />
          </button>
        </header>
        <div className="modal__body">{children}</div>
        {footer ? <footer className="modal__footer">{footer}</footer> : null}
      </div>
    </div>
  );
}

/** Confirmation dialog used before irreversible admin actions. */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'primary',
  loading = false,
  requireReason = false,
  reasonLabel = 'Reason',
  reason = '',
  onReasonChange = () => {},
  children,
}) {
  const reasonLength = (reason ?? '').trim().length;
  const canConfirm = !requireReason || reasonLength >= 3;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button variant={variant} onClick={onConfirm} loading={loading} disabled={!canConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {message ? <p>{message}</p> : null}
      {children}
      {requireReason ? (
        <div style={{ marginTop: 'var(--space-4)' }}>
          <TextAreaField
            label={reasonLabel}
            required
            value={reason ?? ''}
            onChange={(event) => onReasonChange(event.target.value)}
            maxLength={500}
            placeholder="Recorded in the audit log"
            hint={`${reasonLength}/500 characters`}
          />
        </div>
      ) : null}
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/* Pagination                                                                 */
/* -------------------------------------------------------------------------- */

export function Pagination({ page, totalPages, total, onPageChange, pageSize, onPageSizeChange, pageSizeOptions }) {
  if (totalPages <= 1 && !onPageSizeChange) return null;

  const pages = [];
  const addGap = () => {
    if (pages[pages.length - 1] !== 'gap') pages.push('gap');
  };
  for (let current = 1; current <= totalPages; current += 1) {
    if (current === 1 || current === totalPages || Math.abs(current - page) <= 1) {
      pages.push(current);
    } else {
      addGap();
    }
  }

  return (
    <div className="pagination">
      <div className="text-sm muted">
        {total !== undefined ? (
          <>
            Showing <strong>{Math.min((page - 1) * (pageSize ?? 20) + 1, total)}</strong>–
            <strong>{Math.min(page * (pageSize ?? 20), total)}</strong> of <strong>{total}</strong>
          </>
        ) : (
          <>
            Page <strong>{page}</strong> of <strong>{totalPages}</strong>
          </>
        )}
      </div>

      <div className="row gap-2">
        {onPageSizeChange && pageSizeOptions ? (
          <select
            className="select"
            style={{ width: 'auto', minHeight: '34px', fontSize: 'var(--text-sm)' }}
            value={pageSize}
            onChange={(event) => onPageSizeChange(Number(event.target.value))}
            aria-label="Rows per page"
          >
            {pageSizeOptions.map((option) => (
              <option key={option} value={option}>
                {option} / page
              </option>
            ))}
          </select>
        ) : null}

        <nav className="row gap-1" aria-label="Pagination">
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1}
          >
            Previous
          </button>
          {pages.map((entry, index) =>
            entry === 'gap' ? (
              <span key={`gap-${index}`} className="subtle px-1">
                …
              </span>
            ) : (
              <button
                key={entry}
                type="button"
                className={`btn btn--sm ${entry === page ? 'btn--primary' : 'btn--secondary'}`}
                onClick={() => onPageChange(entry)}
                aria-current={entry === page ? 'page' : undefined}
                aria-label={`Page ${entry}`}
              >
                {entry}
              </button>
            ),
          )}
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            onClick={() => onPageChange(page + 1)}
            disabled={page >= totalPages}
          >
            Next
          </button>
        </nav>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Misc layout helpers                                                        */
/* -------------------------------------------------------------------------- */

export function PageHeader({ title, subtitle, actions, children }) {
  return (
    <header className="mb-6">
      <div className="row wrap gap-4" style={{ alignItems: 'flex-start' }}>
        <div className="grow">
          <h1 className="text-2xl">{title}</h1>
          {subtitle ? <p className="muted mt-1">{subtitle}</p> : null}
        </div>
        {actions ? <div className="row wrap gap-2">{actions}</div> : null}
      </div>
      {children}
    </header>
  );
}

/** Two-column page layout; collapses to a single column on narrow screens. */
export function PageGrid({ children, className = '', style }) {
  return (
    <div
      className={className}
      style={{
        display: 'grid',
        gap: 'var(--space-5)',
        gridTemplateColumns: '1fr',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function Avatar({ src, alt, size = 'md', className = '' }) {
  const dimensions = { sm: 32, md: 44, lg: 72, xl: 104 }[size] ?? 44;
  if (!src) {
    return (
      <span
        className={`avatar avatar--${size} ${className}`}
        style={{ width: dimensions, height: dimensions }}
        aria-hidden="true"
      >
        {alt}
      </span>
    );
  }
  return (
    <img
      src={src}
      alt={alt ? `${alt} profile picture` : 'Profile picture'}
      className={`avatar avatar--${size} ${className}`}
      style={{ width: dimensions, height: dimensions }}
      loading="lazy"
    />
  );
}

export function DefinitionList({ items, columns }) {
  return (
    <div className={`datalist ${columns ? `datalist--${columns}` : ''}`}>
      {items
        .filter(Boolean)
        .map((item) => (
          <div className="datalist__item" key={item.label}>
            <span className="datalist__label">{item.label}</span>
            <span className="datalist__value">{item.value}</span>
          </div>
        ))}
    </div>
  );
}

export function SectionTitle({ children, action }) {
  return (
    <div className="row gap-3 mb-3">
      <h2 className="text-lg grow">{children}</h2>
      {action}
    </div>
  );
}

/** Wizard progress for the multi-step transfer flow. */
export function Steps({ current, steps }) {
  return (
    <ol className="steps" aria-label="Progress">
      {steps.map((step, index) => {
        const position = index + 1;
        const state = position < current ? 'is-done' : position === current ? 'is-active' : '';
        return (
          <li key={step} className={`step ${state}`} aria-current={position === current ? 'step' : undefined}>
            <span className="step__dot" aria-hidden="true">
              {position < current ? '✓' : position}
            </span>
            {step}
            {index < steps.length - 1 ? <span className="step__sep" aria-hidden="true" /> : null}
          </li>
        );
      })}
    </ol>
  );
}
