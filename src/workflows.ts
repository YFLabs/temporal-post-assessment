import {
  condition,
  defineQuery,
  defineSignal,
  setHandler,
  defineUpdate,
  proxyActivities,
  CancellationScope,
} from "@temporalio/workflow";
import type { DemoStatus } from "./types";
import type { ActionResult, OpeningInput, OpeningState, ReplyInput } from './types';
import type * as activities from './activities';
import { selectEligible } from './matching';
import { ActivityFailure, ApplicationFailure } from '@temporalio/common';
import { isReplyInput } from './validation';

const { sendOffer } = proxyActivities<typeof activities>({
  startToCloseTimeout: '5 seconds', scheduleToCloseTimeout: '15 seconds',
  retry: { maximumAttempts: 2, initialInterval: '1 second', backoffCoefficient: 1 },
});
export const getOpening = defineQuery<OpeningState>('getOpening');
export const respondToOffer = defineUpdate<ActionResult, [ReplyInput]>('respondToOffer');
export const cancelOpening = defineUpdate<ActionResult>('cancelOpening');

export async function fillOpeningWorkflow(input: OpeningInput): Promise<OpeningState> {
  const candidates = selectEligible(input.clients, input.opening);
  const state: OpeningState = {
    id: input.id, opening: input.opening, status: 'contacting', createdAt: Date.now(),
    eligibleCount: candidates.length, offers: [], history: [], alerts: [],
  };
  let deliveryScope: CancellationScope | undefined;
  const log = (type: string, message: string, clientId?: string) => {
    state.history.push({ at: Date.now(), type, message, ...(clientId ? { clientId } : {}) });
  };
  const terminal = () => ['filled', 'canceled', 'unfilled'].includes(state.status);
  const current = () => state.offers.find(o => o.id === state.currentOfferId);
  const reject = (message: string): ActionResult => ({ ok: false, code: 'unavailable', message });
  setHandler(getOpening, () => state);
  // These handlers deliberately contain no await between validation and mutation.
  // One Workflow serializes decisions for the opening, including competing replies.
  setHandler(respondToOffer, (reply) => {
    if (!isReplyInput(reply)) return { ok: false, code: 'invalid', message: 'A valid offer, client, and accept/decline response are required.' };
    const offer = state.offers.find(o => o.id === reply.offerId && o.clientId === reply.clientId);
    if (offer?.status === 'accepted' && reply.response === 'accept' && state.status === 'filled') {
      return { ok: true, code: 'confirmed', message: 'Your appointment is confirmed.' };
    }
    if (offer?.status === 'declined' && reply.response === 'decline') {
      return { ok: true, code: 'declined', message: 'Your decline has already been recorded.' };
    }
    if (!offer || terminal() || offer.id !== state.currentOfferId || offer.status !== 'waiting') {
      return reject('This offer is no longer available. It has not created a booking.');
    }
    if (Date.now() >= offer.deadline || Date.now() >= input.opening.startsAt) {
      return reject('This offer has expired. It has not created a booking.');
    }
    if (reply.response === 'accept') {
      offer.status = 'accepted'; state.status = 'filled'; state.endedAt = Date.now();
      state.confirmedClient = { id: offer.clientId, name: offer.clientName };
      log('confirmed', `${offer.clientName} accepted. Appointment confirmed automatically.`, offer.clientId);
      return { ok: true, code: 'confirmed', message: 'Your appointment is confirmed. We look forward to seeing you.' };
    }
    if (reply.response === 'decline') {
      offer.status = 'declined';
      log('declined', `${offer.clientName} declined. Moving to the next suitable client.`, offer.clientId);
      return { ok: true, code: 'declined', message: 'Thank you for letting us know. This appointment has not been booked for you.' };
    }
    return reject('Choose accept or decline.');
  });
  setHandler(cancelOpening, () => {
    if (state.status === 'canceled') return { ok: true, code: 'canceled', message: 'Outreach is already canceled.' };
    if (terminal()) return reject('This process has already ended.');
    state.status = 'canceled'; state.endedAt = Date.now();
    const offer = current();
    if (offer && ['waiting', 'sending'].includes(offer.status)) offer.status = 'canceled';
    state.currentOfferId = undefined;
    state.alerts.push('Outreach was canceled by staff. Check that the opening is accounted for in the booking calendar.');
    log('canceled', 'Staff canceled outreach. No further offers will be sent.');
    deliveryScope?.cancel();
    return { ok: true, code: 'canceled', message: 'Outreach canceled. Outstanding offers can no longer be accepted.' };
  });
  log('started', `Outreach started. ${candidates.length} eligible clients in waitlist order.`);
  for (const [index, client] of candidates.entries()) {
    if (terminal()) return state;
    if (Date.now() >= input.opening.startsAt) break;
    const offer = {
      id: `${input.id}-offer-${client.id}`, clientId: client.id, clientName: client.name,
      status: 'sending' as const, deadline: Math.min(Date.now() + 15 * 60_000, input.opening.startsAt),
      attempts: 0, message: '',
    };
    state.offers.push(offer); state.currentOfferId = offer.id; state.status = 'contacting';
    const tracked = state.offers[state.offers.length - 1];
    log('sending', `Preparing a simulated offer for ${client.name}.`, client.id);
    try {
      deliveryScope = new CancellationScope();
      const receipt = await deliveryScope.run(() => sendOffer({
        offerId: offer.id, clientName: client.name, deadline: offer.deadline, appointmentStartsAt: input.opening.startsAt,
        scenario: index === 0 ? input.scenario : 'normal',
      }));
      if (terminal()) return state;
      tracked.sentAt = receipt.sentAt; tracked.attempts = receipt.attempts; tracked.message = receipt.message;
      tracked.deadline = receipt.deadline ?? tracked.deadline;
      if (receipt.attempts > 1) log('retry', `First send failed; retry ${receipt.attempts - 1} succeeded for ${client.name}.`, client.id);
      // The successful send receipt fixes the exact deadline. Replay never recalculates it.
      if (Date.now() >= tracked.deadline) {
        tracked.status = 'timed_out';
        log('timed_out', `${client.name}'s offer expired before a response could be received.`, client.id);
        continue;
      }
      tracked.status = 'waiting'; state.status = 'waiting';
      log('contacted', `Simulated offer sent to ${client.name}. Exact deadline: ${new Date(tracked.deadline).toISOString()}.`, client.id);
      await condition(() => terminal() || tracked.status !== 'waiting', Math.max(1, tracked.deadline - Date.now()));
      if (terminal()) return state;
      if (tracked.status === 'waiting') {
        tracked.status = 'timed_out';
        log('timed_out', `${client.name}'s offer timed out. Moving to the next suitable client.`, client.id);
      }
    } catch (error) {
      if (terminal()) return state;
      const cause = error instanceof ActivityFailure ? error.cause : undefined;
      const failure = cause instanceof ApplicationFailure ? cause : undefined;
      const detail = failure?.details?.[0] as { attempt?: number } | undefined;
      tracked.attempts = detail?.attempt ?? 2;
      if (failure?.type === 'OfferExpired') {
        tracked.status = 'timed_out';
        log('timed_out', `The appointment started before an offer could be delivered to ${client.name}.`, client.id);
        break;
      }
      tracked.status = 'delivery_failed';
      const alert = `Delivery to ${client.name} failed after ${tracked.attempts} attempts. Staff attention needed; outreach continues.`;
      state.alerts.push(alert); log('delivery_failed', alert, client.id);
    } finally { deliveryScope = undefined; }
  }
  if (!terminal()) {
    state.status = 'unfilled'; state.currentOfferId = undefined; state.endedAt = Date.now();
    const message = Date.now() >= input.opening.startsAt ? 'The appointment start has been reached without a booking.' : 'No suitable clients remain. The opening is still unfilled.';
    state.alerts.push(message); log('unfilled', message);
  }
  return state;
}

// This neutral Workflow exists only to prove that the starter is connected.
// Replace it with the customer Workflow you design during the assessment.
export const continueDemo = defineSignal("continueDemo");
export const getDemoStatus = defineQuery<DemoStatus>("getDemoStatus");

export async function demoWorkflow(requestId: string): Promise<DemoStatus> {
  let shouldContinue = false;
  let status: DemoStatus = {
    requestId,
    phase: "started",
    message: "The demo Workflow started.",
  };

  setHandler(getDemoStatus, () => status);
  setHandler(continueDemo, () => {
    shouldContinue = true;
  });

  status = {
    ...status,
    phase: "waiting",
    message: "The Workflow is durably waiting for a Signal.",
  };

  await condition(() => shouldContinue);

  status = {
    ...status,
    phase: "complete",
    message: "The Signal arrived and the Workflow completed.",
  };
  return status;
}
