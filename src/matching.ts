import type { ClientRecord, Opening } from './types';

export function selectEligible(clients: ClientRecord[], opening: Opening): ClientRecord[] {
  const endsAt = opening.startsAt + opening.durationMinutes * 60_000;
  return clients.filter(c => c.service === opening.service &&
    (c.stylist === null || c.stylist === opening.stylist) &&
    c.availableFrom <= opening.startsAt && c.availableUntil >= endsAt)
    .sort((a, b) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id));
}
