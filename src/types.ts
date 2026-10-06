export type DemoStatus = { requestId: string; phase: 'started' | 'waiting' | 'complete'; message: string };
export type ClientRecord = {
  id: string; name: string; service: string; stylist: string | null;
  availableFrom: number; availableUntil: number; joinedAt: number;
};
export type Opening = { service: string; stylist: string; startsAt: number; durationMinutes: number };
export type Scenario = 'normal' | 'retry_once' | 'delivery_failure';
export type OpeningInput = { id: string; opening: Opening; clients: ClientRecord[]; scenario: Scenario };
export type Offer = {
  id: string; clientId: string; clientName: string;
  status: 'sending' | 'waiting' | 'accepted' | 'declined' | 'timed_out' | 'delivery_failed' | 'canceled';
  sentAt?: number; deadline: number; attempts: number; message: string;
};
export type OpeningState = {
  id: string; opening: Opening; status: 'contacting' | 'waiting' | 'filled' | 'canceled' | 'unfilled';
  createdAt: number; eligibleCount: number; currentOfferId?: string; offers: Offer[];
  history: { at: number; type: string; message: string; clientId?: string }[];
  alerts: string[]; confirmedClient?: { id: string; name: string }; endedAt?: number;
};
export type ReplyInput = { offerId: string; clientId: string; response: 'accept' | 'decline' };
export type ActionResult = { ok: boolean; code: string; message: string };
export type DeliveryInput = { offerId: string; clientName: string; deadline: number; appointmentStartsAt?: number; scenario: Scenario };
export type DeliveryResult = { sentAt: number; attempts: number; message: string; deadline?: number };
