import sanitizeHtml from 'sanitize-html';

/**
 * Database queries are built from validated values only. Operators in user input are stripped so a payload like
 * { "phone": { "$ne": null } } can never reach a query (Document 3, section 13.1).
 */
export function stripOperators<T>(value: T, depth = 0): T {
  if (depth > 12) return value;
  if (Array.isArray(value)) return value.map((v) => stripOperators(v, depth + 1)) as unknown as T;
  if (value && typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k.startsWith('$') || k.includes('.') && !/^[A-Za-z0-9_\-[\].]+$/.test(k)) continue;
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      out[k] = stripOperators(v, depth + 1);
    }
    return out as T;
  }
  return value;
}

/** Longer text fields accept a small set of formatting and are cleaned on the server. No HTML, scripts or embeds beyond this. */
export function cleanRichText(input: string | undefined | null): string {
  if (!input) return '';
  return sanitizeHtml(input, {
    allowedTags: ['b', 'strong', 'i', 'em', 'u', 'ul', 'ol', 'li', 'p', 'br', 'a'],
    allowedAttributes: { a: ['href', 'rel', 'target'] },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    transformTags: { a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer', target: '_blank' }) },
    disallowedTagsMode: 'discard'
  }).trim();
}

/** Plain text: all tags removed. */
export const cleanText = (input: string | undefined | null): string => sanitizeHtml(input ?? '', { allowedTags: [], allowedAttributes: {} }).trim();

/** Escape for a CSV or spreadsheet cell so a value cannot start a formula. */
export const safeCell = (v: unknown): unknown => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
