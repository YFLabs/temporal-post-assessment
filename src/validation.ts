import type { ReplyInput } from './types';

// Runtime validation is shared by HTTP and Workflow handlers. TypeScript types
// alone do not validate data received over either boundary.
export function isReplyInput(value: unknown): value is ReplyInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const reply = value as Record<string, unknown>;
  const identifier = (id: unknown) => typeof id === 'string' && id.length > 0 &&
    id.length <= 200 && id.trim() === id;
  return identifier(reply.offerId) && identifier(reply.clientId) &&
    (reply.response === 'accept' || reply.response === 'decline');
}

export function parseStartsAt(value: unknown): number {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : NaN;
  // Require an explicit timezone. Reject arrays/objects instead of coercing them
  // to a date, and canonicalize equivalent ISO representations to milliseconds.
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return NaN;
  const timestamp = Date.parse(value);
  return Number.isSafeInteger(timestamp) ? timestamp : NaN;
}
