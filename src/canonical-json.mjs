import { createHash } from 'node:crypto';

/**
 * Serializes any JSON-compatible JavaScript value to a canonical JSON string
 * with deterministic, lexicographically sorted object keys.
 *
 * @param {unknown} value - Value to serialize
 * @returns {string} Deterministic canonical JSON string
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const items = value.map((item) => {
      const res = canonicalJson(item);
      return res === undefined ? 'null' : res;
    });
    return `[${items.join(',')}]`;
  }

  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }

  const keys = Object.keys(value).sort();
  const entries = [];
  for (const key of keys) {
    const val = value[key];
    if (val === undefined || typeof val === 'symbol' || typeof val === 'function') {
      continue;
    }
    const serializedVal = canonicalJson(val);
    if (serializedVal !== undefined) {
      entries.push(`${JSON.stringify(key)}:${serializedVal}`);
    }
  }
  return `{${entries.join(',')}}`;
}

/**
 * Computes a SHA-256 hash over the canonical JSON representation of tool arguments,
 * ignoring the confirmation token property if present.
 *
 * @param {Record<string, unknown> | null | undefined} args - Arguments to hash
 * @returns {string} SHA-256 hexadecimal hash
 */
export function hashArgs(args) {
  const clean = { ...(args || {}) };
  delete clean.confirmToken;
  const canonical = canonicalJson(clean);
  return createHash('sha256').update(canonical).digest('hex');
}
