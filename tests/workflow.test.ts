import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Context } from '@temporalio/activity';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { fillOpeningWorkflow, getOpening, respondToOffer, cancelOpening } from '../src/workflows';
import { selectEligible } from '../src/matching';
import { sendOffer } from '../src/activities';
import type { ClientRecord, DeliveryInput, OpeningInput, OpeningState, ReplyInput, Scenario } from '../src/types';

const MINUTE = 60_000;
function fixture(now: number, scenario: Scenario = 'normal'): OpeningInput {
  return {
    id: `test-${randomUUID()}`,
    opening: { service: 'Haircut', stylist: 'Maya', startsAt: now + 60 * MINUTE, durationMinutes: 45 },
    clients: [
      { id: 'alice', name: 'Alice', service: 'Haircut', stylist: 'Maya', availableFrom: now, availableUntil: now + 180 * MINUTE, joinedAt: now - 2000 },
      { id: 'ben', name: 'Ben', service: 'Haircut', stylist: null, availableFrom: now, availableUntil: now + 180 * MINUTE, joinedAt: now - 1000 },
    ],
    scenario,
  };
}

test('matching checks service, required stylist, full appointment duration, and waitlist order', () => {
  const input = fixture(1_000_000);
  const base = input.clients[0];
  const additions: ClientRecord[] = [
    { ...base, id: 'wrong-service', service: 'Color', joinedAt: 0 },
    { ...base, id: 'wrong-stylist', stylist: 'Other', joinedAt: 0 },
    { ...base, id: 'starts-late', availableFrom: input.opening.startsAt + 1, joinedAt: 0 },
    { ...base, id: 'ends-early', availableUntil: input.opening.startsAt + 44 * MINUTE, joinedAt: 0 },
    { ...base, id: 'tie-before', joinedAt: base.joinedAt },
  ];
  const matches = selectEligible([...input.clients].reverse().concat(additions), input.opening);
  assert.deepEqual(matches.map(client => client.id), ['alice', 'tie-before', 'ben']);
  assert.deepEqual(input.clients.map(client => client.id), ['alice', 'ben'], 'matching must not reorder source data');
});

test('real Temporal Workflow enforces the salon process', { timeout: 120_000 }, async (t) => {
  const environment = await TestWorkflowEnvironment.createTimeSkipping();
  const taskQueue = `salon-test-${randomUUID()}`;
  const sends: { offerId: string; attempt: number }[] = [];
  const activities = {
    async sendOffer(input: DeliveryInput) {
      sends.push({ offerId: input.offerId, attempt: Context.current().info.attempt });
      const result = await sendOffer(input);
      // External Activities use wall time; align their receipt with the test
      // server's virtual clock while retaining the real delivery/retry logic.
      const sentAt = await environment.currentTimeMs();
      return { ...result, sentAt, deadline: Math.min(sentAt + 15 * MINUTE, input.appointmentStartsAt ?? input.deadline) };
    },
  };
  try {
    const worker = await Worker.create({ connection: environment.nativeConnection, identity: 'juniper-test-worker', taskQueue, workflowsPath: require.resolve('../src/workflows'), activities });
    await worker.runUntil(async () => {
      const start = async (input: OpeningInput) => environment.client.workflow.start(fillOpeningWorkflow, { workflowId: input.id, taskQueue, args: [input] });
      type Handle = Awaited<ReturnType<typeof start>>;
      const stateWhen = async (handle: Handle, predicate: (state: OpeningState) => boolean): Promise<OpeningState> => {
        let last: OpeningState | undefined;
        for (let i = 0; i < 300; i++) {
          last = await handle.query(getOpening);
          if (predicate(last)) return last;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.fail(`Expected Workflow state was not reached: ${JSON.stringify(last)}`);
      };
      const waiting = (handle: Handle, clientId = 'alice') => stateWhen(handle, state => state.status === 'waiting' && state.offers.some(offer => offer.id === state.currentOfferId && offer.clientId === clientId && offer.status === 'waiting'));
      const accept = (handle: Handle, state: OpeningState) => {
        const offer = state.offers.find(item => item.id === state.currentOfferId)!;
        return handle.executeUpdate(respondToOffer, { args: [{ offerId: offer.id, clientId: offer.clientId, response: 'accept' }] });
      };

      await t.test('timely acceptance automatically confirms and stops outreach', async () => {
        const input = fixture(await environment.currentTimeMs());
        const handle = await start(input);
        const state = await waiting(handle);
        const outcome = await accept(handle, state);
        assert.equal(outcome.ok, true);
        const final = await handle.result();
        assert.equal(final.status, 'filled');
        assert.equal(final.confirmedClient?.id, 'alice');
        assert.equal(final.offers.length, 1);
        assert.equal(final.offers[0].status, 'accepted');
        await Promise.allSettled([handle.executeUpdate(cancelOpening), accept(handle, state)]);
        assert.deepEqual(await handle.result(), final, 'late cancellation or duplicate acceptance cannot mutate the terminal result');
      });

      await t.test('decline advances to next client and stale previous offer cannot claim it', async () => {
        const input = fixture(await environment.currentTimeMs());
        const handle = await start(input);
        const first = await waiting(handle);
        const reply = { offerId: first.currentOfferId!, clientId: 'alice', response: 'decline' as const };
        assert.equal((await handle.executeUpdate(respondToOffer, { args: [reply] })).ok, true);
        const next = await waiting(handle, 'ben');
        assert.equal((await handle.executeUpdate(respondToOffer, { args: [{ ...reply, response: 'accept' }] })).ok, false);
        assert.equal(next.offers[0].status, 'declined');
        await accept(handle, next);
        assert.equal((await handle.result()).confirmedClient?.id, 'ben');
      });

      await t.test('15-minute timeout moves to next client and rejects the late response', async () => {
        const handle = await start(fixture(await environment.currentTimeMs()));
        const first = await waiting(handle);
        const offer = first.offers[0];
        assert.ok(Math.abs((offer.deadline - (offer.sentAt ?? first.createdAt)) - 15 * MINUTE) < 2000);
        await environment.sleep(15 * MINUTE + 100);
        const next = await waiting(handle, 'ben');
        assert.equal(next.offers[0].status, 'timed_out');
        assert.equal((await handle.executeUpdate(respondToOffer, { args: [{ offerId: offer.id, clientId: 'alice', response: 'accept' }] })).ok, false);
        await accept(handle, next);
        assert.equal((await handle.result()).confirmedClient?.id, 'ben');
      });

      await t.test('short-notice deadline is capped by appointment start and ends unfilled', async () => {
        const now = await environment.currentTimeMs();
        const input = fixture(now);
        input.opening.startsAt = now + 2 * MINUTE;
        const handle = await start(input);
        const first = await waiting(handle);
        assert.equal(first.offers[0].deadline, input.opening.startsAt);
        await environment.sleep(2 * MINUTE + 100);
        const final = await handle.result();
        assert.equal(final.status, 'unfilled');
        assert.equal(final.offers.length, 1, 'must not contact another client after appointment starts');
        assert.equal(final.offers[0].status, 'timed_out');
        assert.ok(final.alerts.length > 0);
      });

      await t.test('staff cancellation invalidates active offer and prevents further outreach', async () => {
        const handle = await start(fixture(await environment.currentTimeMs()));
        await waiting(handle);
        assert.equal((await handle.executeUpdate(cancelOpening)).ok, true);
        const final = await handle.result();
        assert.equal(final.status, 'canceled');
        assert.equal(final.offers.length, 1);
        assert.equal(final.offers[0].status, 'canceled');
        assert.equal(final.confirmedClient, undefined);
        await Promise.allSettled([
          handle.executeUpdate(respondToOffer, { args: [{ offerId: final.offers[0].id, clientId: 'alice', response: 'accept' }] }),
          handle.executeUpdate(cancelOpening),
        ]);
        assert.deepEqual(await handle.result(), final, 'canceled state is immutable after late responses and retries');
      });

      await t.test('wrong client is rejected; competing duplicate acceptance cannot create two bookings', async () => {
        const handle = await start(fixture(await environment.currentTimeMs()));
        const first = await waiting(handle);
        const offerId = first.currentOfferId!;
        assert.equal((await handle.executeUpdate(respondToOffer, { args: [{ offerId, clientId: 'ben', response: 'accept' }] })).ok, false);
        assert.deepEqual(await handle.query(getOpening), first, 'a wrong client cannot change any state');
        assert.equal((await handle.executeUpdate(respondToOffer, { args: [{ offerId: 'unknown-offer', clientId: 'alice', response: 'accept' }] })).ok, false);
        assert.deepEqual(await handle.query(getOpening), first, 'an unknown offer cannot change any state');
        const results = await Promise.allSettled([
          handle.executeUpdate(respondToOffer, { args: [{ offerId, clientId: 'alice', response: 'accept' }] }),
          handle.executeUpdate(respondToOffer, { args: [{ offerId, clientId: 'alice', response: 'accept' }] }),
          handle.executeUpdate(respondToOffer, { args: [{ offerId, clientId: 'ben', response: 'accept' }] }),
        ]);
        assert.ok(results.slice(0, 2).some(result => result.status === 'fulfilled' && result.value.ok));
        const competing = results[2];
        assert.ok(competing.status === 'rejected' || !competing.value.ok);
        const final = await handle.result();
        assert.equal(final.confirmedClient?.id, 'alice');
        assert.equal(final.offers.filter(offer => offer.status === 'accepted').length, 1);
        assert.equal(final.offers.length, 1);
      });

      await t.test('malformed direct Workflow responses are rejected without any state mutation', async () => {
        const handle = await start(fixture(await environment.currentTimeMs()));
        const before = await waiting(handle);
        const valid = { offerId: before.currentOfferId!, clientId: 'alice', response: 'accept' };
        const malformed: unknown[] = [null, true, 3, 'accept', [], {},
          { ...valid, response: 'other' }, { ...valid, clientId: [] },
          { ...valid, offerId: {} }, { ...valid, clientId: '' }];
        for (const value of malformed) {
          const result = await handle.executeUpdate(respondToOffer, { args: [value as ReplyInput] });
          assert.equal(result.ok, false, `must reject malformed response ${JSON.stringify(value)}`);
          assert.deepEqual(await handle.query(getOpening), before, 'rejected responses must not alter state or history');
        }
        await handle.executeUpdate(cancelOpening);
        assert.equal((await handle.result()).status, 'canceled');
      });

      await t.test('simultaneous acceptance and cancellation have one coherent terminal winner', async () => {
        const handle = await start(fixture(await environment.currentTimeMs()));
        const before = await waiting(handle);
        const results = await Promise.allSettled([accept(handle, before), handle.executeUpdate(cancelOpening)]);
        const final = await handle.result();
        assert.ok(['filled', 'canceled'].includes(final.status));
        assert.equal(results.filter(result => result.status === 'fulfilled' && result.value.ok).length, 1);
        assert.equal(final.offers.length, 1, 'race must never start another offer');
        assert.equal(final.offers[0].status, final.status === 'filled' ? 'accepted' : 'canceled');
        assert.equal(final.confirmedClient?.id, final.status === 'filled' ? 'alice' : undefined);
        const terminalEvents = final.history.filter(event => ['confirmed', 'canceled'].includes(event.type));
        assert.equal(terminalEvents.length, 1, 'history must report one final outcome');
        await Promise.allSettled([accept(handle, before), handle.executeUpdate(cancelOpening)]);
        assert.deepEqual(await handle.result(), final, 'retrying both actions cannot change the final outcome');
      });

      await t.test('notification is retried once and succeeds on its second attempt', async () => {
        const input = fixture(await environment.currentTimeMs(), 'retry_once');
        const handle = await start(input);
        await environment.sleep(2000);
        const state = await waiting(handle);
        const attempts = sends.filter(send => send.offerId === state.currentOfferId).map(send => send.attempt);
        assert.deepEqual(attempts, [1, 2]);
        assert.equal(state.offers[0].attempts, 2);
        assert.equal(state.alerts.length, 0);
        await accept(handle, state);
        assert.equal((await handle.result()).status, 'filled');
      });

      await t.test('two failed send attempts alert staff and advance to next eligible client', async () => {
        const input = fixture(await environment.currentTimeMs(), 'delivery_failure');
        const handle = await start(input);
        await environment.sleep(2000);
        const next = await waiting(handle, 'ben');
        assert.equal(next.offers[0].status, 'delivery_failed');
        assert.deepEqual(sends.filter(send => send.offerId === next.offers[0].id).map(send => send.attempt), [1, 2]);
        assert.ok(next.alerts.length > 0);
        await accept(handle, next);
        assert.equal((await handle.result()).confirmedClient?.id, 'ben');
      });

      for (const responses of [['decline', 'decline'], ['timeout', 'timeout'], ['decline', 'timeout']] as const) {
        await t.test(`entire eligible waitlist ${responses.join(' then ')} ends unfilled and alerts staff`, async () => {
          const input = fixture(await environment.currentTimeMs());
          const handle = await start(input);
          for (const [index, response] of responses.entries()) {
            const state = await waiting(handle, input.clients[index].id);
            const offer = state.offers.find(item => item.id === state.currentOfferId)!;
            if (response === 'decline') {
              assert.equal((await handle.executeUpdate(respondToOffer, { args: [{ offerId: offer.id, clientId: offer.clientId, response: 'decline' }] })).ok, true);
            } else {
              await environment.sleep(15 * MINUTE + 100);
            }
          }
          const final = await handle.result();
          assert.equal(final.status, 'unfilled');
          assert.equal(final.eligibleCount, 2);
          assert.equal(final.offers.length, 2);
          assert.deepEqual(final.offers.map(offer => offer.status), responses.map(response => response === 'decline' ? 'declined' : 'timed_out'));
          assert.equal(final.currentOfferId, undefined);
          assert.equal(final.confirmedClient, undefined);
          assert.ok(final.alerts.some(alert => /no suitable clients|unfilled/i.test(alert)), 'staff must receive an actionable unfilled alert');
          assert.equal(final.history.at(-1)?.type, 'unfilled');
          assert.equal(sends.filter(send => send.offerId.startsWith(input.id)).length, 2, 'no additional offers after exhaustion');
        });
      }

      await t.test('no eligible clients ends unfilled and alerts staff without sending', async () => {
        const input = fixture(await environment.currentTimeMs());
        input.clients = input.clients.map(client => ({ ...client, service: 'Unmatched service' }));
        const handle = await start(input);
        const final = await handle.result();
        assert.equal(final.status, 'unfilled');
        assert.equal(final.eligibleCount, 0);
        assert.equal(final.offers.length, 0);
        assert.ok(final.alerts.length > 0);
      });
    });
  } finally {
    await environment.teardown();
  }
});

test('Worker restart preserves the same pending offer and original deadline', { timeout: 60_000 }, async () => {
  const environment = await TestWorkflowEnvironment.createTimeSkipping();
  const taskQueue = `restart-test-${randomUUID()}`;
  let deliveries = 0;
  const activities = { async sendOffer(input: DeliveryInput) { deliveries++; const result = await sendOffer(input); const sentAt = await environment.currentTimeMs(); return { ...result, sentAt, deadline: Math.min(sentAt + 15 * MINUTE, input.appointmentStartsAt ?? input.deadline) }; } };
  const makeWorker = () => Worker.create({ connection: environment.nativeConnection, identity: 'juniper-test-worker', taskQueue, workflowsPath: require.resolve('../src/workflows'), activities, maxCachedWorkflows: 0 });
  try {
    const input = fixture(await environment.currentTimeMs());
    const firstWorker = await makeWorker();
    let handle: Awaited<ReturnType<typeof environment.client.workflow.start<typeof fillOpeningWorkflow>>>;
    let before: OpeningState;
    await firstWorker.runUntil(async () => {
      handle = await environment.client.workflow.start(fillOpeningWorkflow, { workflowId: input.id, taskQueue, args: [input] });
      for (let i = 0; i < 300; i++) {
        before = await handle.query(getOpening);
        if (before.status === 'waiting') return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.fail('First Worker did not reach waiting state');
    });
    await environment.sleep(5 * MINUTE);
    const secondWorker = await makeWorker();
    await secondWorker.runUntil(async () => {
      const resumed = await handle!.query(getOpening);
      assert.equal(resumed.currentOfferId, before!.currentOfferId);
      assert.equal(resumed.offers[0].deadline, before!.offers[0].deadline);
      assert.equal(deliveries, 1, 'recorded delivery must not run again on replay');
      assert.equal((await handle!.executeUpdate(respondToOffer, { args: [{ offerId: resumed.currentOfferId!, clientId: 'alice', response: 'accept' }] })).ok, true);
      assert.equal((await handle!.result()).status, 'filled');
    });
  } finally {
    await environment.teardown();
  }
});
