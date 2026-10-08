/** Print a seed failure with the per-field detail a terminal caller needs. */
export function reportFailure(label, error) {
  console.error(`[${label}] failed: ${error.message}`);

  // Validation failures carry a `{ field: message }` map. Printing the generic
  // headline alone ("Please correct the highlighted fields.") is useless when
  // there is no form on screen to point at.
  const details = error?.details;
  if (details && typeof details === 'object') {
    for (const [field, message] of Object.entries(details)) {
      console.error(`    ${field}: ${Array.isArray(message) ? message.join(' ') : String(message)}`);
    }
  }
}
