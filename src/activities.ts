import { Context } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import type { DeliveryInput, DeliveryResult } from './types';

// No SMS is sent. The stable offerId represents the idempotency key a real
// delivery provider/outbox must enforce. Activity attempts do not imply exactly-once SMS.
export async function sendOffer(input: DeliveryInput): Promise<DeliveryResult> {
  const attempt = Context.current().info.attempt;
  Context.current().cancellationSignal.throwIfAborted();
  if (Date.now() >= (input.appointmentStartsAt ?? input.deadline)) {
    throw ApplicationFailure.nonRetryable('The appointment has started.', 'OfferExpired', { attempt });
  }
  if (input.scenario === 'delivery_failure' || (input.scenario === 'retry_once' && attempt === 1)) {
    throw ApplicationFailure.retryable('Simulated delivery provider unavailable.', 'SimulatedDeliveryFailure', { attempt });
  }
  const sentAt = Date.now();
  const deadline = Math.min(sentAt + 15 * 60_000, input.appointmentStartsAt ?? input.deadline);
  return {
    sentAt, deadline, attempts: attempt,
    message: `SIMULATED MESSAGE: ${input.clientName}, an appointment is available at Juniper Salon. Please accept or decline before ${new Date(deadline).toISOString()}. Your appointment is confirmed only after a successful acceptance.`,
  };
}
