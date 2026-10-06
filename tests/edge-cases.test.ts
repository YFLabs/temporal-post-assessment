import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Context } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import type { WorkflowHandle } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { fillOpeningWorkflow, getOpening, respondToOffer, cancelOpening } from '../src/workflows';
import type { DeliveryInput, OpeningInput, OpeningState } from '../src/types';

const MINUTE = 60_000;
type Handle = WorkflowHandle<typeof fillOpeningWorkflow>;
function fixture(now: number, minutesToAppointment = 60): OpeningInput {
  return {
    id: `edge-${randomUUID()}`, scenario: 'normal',
    opening: { service: 'Haircut', stylist: 'Maya', startsAt: now + minutesToAppointment * MINUTE, durationMinutes: 45 },
    clients: ['alice', 'ben'].map((id, index) => ({ id, name: id, service: 'Haircut', stylist: null, availableFrom: now - MINUTE, availableUntil: now + 180 * MINUTE, joinedAt: now - (2 - index) * MINUTE })),
  };
}
async function waitForState(handle: Handle, predicate: (state: OpeningState) => boolean): Promise<OpeningState> {
  for (let i = 0; i < 300; i++) {
    const state = await handle.query(getOpening);
    if (predicate(state)) return state;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Workflow did not reach the required phase');
}
async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 300; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Activity did not reach the required attempt');
}

for (const retry of [false, true]) {
  test(`cancellation while ${retry ? 'retry' : 'first send'} is in flight rejects its late receipt`, { timeout: 30_000 }, async () => {
    const environment = await TestWorkflowEnvironment.createTimeSkipping();
    const taskQueue = `cancel-edge-${randomUUID()}`;
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    let activityReturned!: () => void;
    const returned = new Promise<void>(resolve => { activityReturned = resolve; });
    const attempts: number[] = [];
    let inFlight = false;
    const activities = {
      async sendOffer(input: DeliveryInput) {
        const attempt = Context.current().info.attempt;
        attempts.push(attempt);
        if (retry && attempt === 1) throw ApplicationFailure.retryable('Controlled first failure', 'TestSendFailure');
        inFlight = true;
        // Deliberately non-cooperative provider: cancellation cannot retract work
        // already in flight. The late receipt must never resurrect this opening.
        await hold;
        const sentAt = await environment.currentTimeMs();
        activityReturned();
        return { sentAt, attempts: attempt, deadline: input.deadline, message: 'SIMULATED late receipt' };
      },
    };
    try {
      const worker = await Worker.create({ connection: environment.nativeConnection, identity: 'juniper-test-worker', taskQueue, workflowsPath: require.resolve('../src/workflows'), activities });
      await worker.runUntil(async () => {
        const input = fixture(await environment.currentTimeMs());
        const handle = await environment.client.workflow.start(fillOpeningWorkflow, { workflowId: input.id, taskQueue, args: [input] });
        if (retry) await environment.sleep(1100);
        await waitFor(() => inFlight);
        const before = await handle.query(getOpening);
        assert.equal(before.status, 'contacting');
        assert.equal(before.offers[0].status, 'sending');
        assert.deepEqual(attempts, retry ? [1, 2] : [1]);
        assert.equal((await handle.executeUpdate(cancelOpening)).ok, true);
        const final = await handle.result();
        assert.equal(final.status, 'canceled');
        assert.equal(final.offers.length, 1);
        assert.equal(final.offers[0].status, 'canceled');
        assert.equal(final.confirmedClient, undefined);
        release();
        await returned;
        assert.deepEqual(await handle.result(), final);
        assert.deepEqual(attempts, retry ? [1, 2] : [1], 'cancellation must prevent retry/new-client sends');
        const reply = await Promise.allSettled([handle.executeUpdate(respondToOffer, { args: [{ offerId: before.currentOfferId!, clientId: 'alice', response: 'accept' }] })]);
        assert.ok(reply[0].status === 'rejected' || !reply[0].value.ok);
        assert.deepEqual(await handle.result(), final, 'late reply cannot book after cancellation');
      });
    } finally {
      release();
      await environment.teardown();
    }
  });
}

for (const appointmentPassed of [false, true]) {
  test(`Worker restarts after deadline and ${appointmentPassed ? 'ends unfilled after appointment start' : 'advances without renewing the expired offer'}`, { timeout: 30_000 }, async () => {
    const environment = await TestWorkflowEnvironment.createTimeSkipping();
    const taskQueue = `offline-edge-${randomUUID()}`;
    const deliveries: string[] = [];
    const activities = {
      async sendOffer(input: DeliveryInput) {
        deliveries.push(input.offerId);
        const sentAt = await environment.currentTimeMs();
        return { sentAt, attempts: 1, deadline: Math.min(sentAt + 15 * MINUTE, input.appointmentStartsAt!), message: 'SIMULATED test offer' };
      },
    };
    const makeWorker = () => Worker.create({ connection: environment.nativeConnection, identity: 'juniper-test-worker', taskQueue, workflowsPath: require.resolve('../src/workflows'), activities, maxCachedWorkflows: 0 });
    try {
      const input = fixture(await environment.currentTimeMs(), appointmentPassed ? 2 : 60);
      const firstWorker = await makeWorker();
      let handle!: Handle;
      let before!: OpeningState;
      await firstWorker.runUntil(async () => {
        handle = await environment.client.workflow.start(fillOpeningWorkflow, { workflowId: input.id, taskQueue, args: [input] });
        before = await waitForState(handle, state => state.status === 'waiting');
      });
      assert.equal(firstWorker.getState(), 'STOPPED', 'Worker must be offline before crossing deadline');
      const originalDeadline = before.offers[0].deadline;
      // Stop just before the timer: the test server will not skip beyond a
      // queued Workflow task while no Worker exists. Cross the last two seconds
      // in real time, still with the original Worker fully stopped.
      await environment.sleep(Math.max(1, originalDeadline - await environment.currentTimeMs() - 2000));
      await new Promise(resolve => setTimeout(resolve, 2100));
      assert.ok(await environment.currentTimeMs() > originalDeadline);
      const secondWorker = await makeWorker();
      await secondWorker.runUntil(async () => {
        const resumed = await waitForState(handle, state => appointmentPassed ? state.status === 'unfilled' : state.status === 'waiting' && state.currentOfferId !== before.currentOfferId);
        assert.equal(resumed.offers[0].deadline, originalDeadline);
        assert.equal(resumed.offers[0].status, 'timed_out');
        const late = await Promise.allSettled([handle.executeUpdate(respondToOffer, { args: [{ offerId: before.currentOfferId!, clientId: 'alice', response: 'accept' }] })]);
        assert.ok(late[0].status === 'rejected' || !late[0].value.ok);
        if (appointmentPassed) {
          const final = await handle.result();
          assert.equal(final.status, 'unfilled');
          assert.equal(final.confirmedClient, undefined);
          assert.equal(final.offers.length, 1);
          assert.equal(deliveries.length, 1, 'must not send after appointment starts');
          assert.ok(final.alerts.length > 0);
        } else {
          assert.equal(resumed.offers.length, 2);
          assert.equal(deliveries.length, 2, 'recorded first send must not replay');
          const current = resumed.offers.find(offer => offer.id === resumed.currentOfferId)!;
          assert.equal(current.clientId, 'ben');
          assert.equal((await handle.executeUpdate(respondToOffer, { args: [{ offerId: current.id, clientId: 'ben', response: 'accept' }] })).ok, true);
          assert.equal((await handle.result()).confirmedClient?.id, 'ben');
        }
      });
    } finally {
      await environment.teardown();
    }
  });
}
