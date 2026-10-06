import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

// Requires `npm start` in another terminal. Only fictional demo clients are used.
// Records stay in Temporal as visible evidence; each created opening is closed.
const base = process.env.API_BASE_URL ?? 'http://localhost:3000';
const startedAt = new Date().toISOString();
const cases = [];
const created = new Set();
const future = Date.now() + 6 * 60 * 60_000;
let failure;
async function request(path, method = 'GET', body) {
  const response = await fetch(`${base}${path}`, {
    method, headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  });
  return { status: response.status, body: await response.json() };
}
async function rawRequest(path, rawBody) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: rawBody,
    signal: AbortSignal.timeout(15_000),
  });
  return { status: response.status, body: await response.json() };
}
async function check(name, run) {
  const start = Date.now();
  try {
    await run();
    cases.push({ name, status: 'passed', durationMs: Date.now() - start });
    console.log(`PASS ${name}`);
  } catch (error) {
    cases.push({ name, status: 'failed', durationMs: Date.now() - start, error: error.message });
    throw error;
  }
}
async function create(stylist, startsAt, scenario = 'normal') {
  const result = await request('/api/openings', 'POST', { service: 'Haircut', stylist, startsAt, scenario });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  created.add(result.body.id);
  return result.body.id;
}
async function read(id) {
  const result = await request(`/api/openings/${id}`);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
}
async function waitFor(id, predicate, timeoutMs = 12_000) {
  const end = Date.now() + timeoutMs;
  do {
    const state = await read(id);
    if (predicate(state)) return state;
    await sleep(50);
  } while (Date.now() < end);
  assert.fail(`Opening ${id} did not reach the expected state before timeout`);
}
const activeOffer = state => state.offers.find(offer => offer.id === state.currentOfferId);
const waiting = id => waitFor(id, state => state.status === 'waiting' && activeOffer(state)?.status === 'waiting');
const respond = (id, offer, response, clientId = offer.clientId) => request(`/api/openings/${id}/respond`, 'POST', { offerId: offer.id, clientId, response });
const cancel = id => request(`/api/openings/${id}/cancel`, 'POST', {});

try {
  await check('service health reports simulated messaging', async () => {
    const health = await request('/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.messaging, 'simulated');
  });
  await check('malformed JSON, oversized bodies, invalid shapes, and timestamp coercion are rejected', async () => {
    assert.equal((await request('/api/openings', 'POST', { service: 'Unknown', stylist: 'Maya', startsAt: future })).status, 400);
    assert.equal((await request('/api/openings', 'POST', { service: 'Haircut', stylist: 'Maya', startsAt: Date.now() - 1000 })).status, 400);
    assert.equal((await request('/api/openings/juniper-000000000000000000000000/respond', 'POST', { response: 'unknown' })).status, 400);
    assert.equal((await rawRequest('/api/openings', '{')).status, 400, 'malformed JSON is a client error');
    assert.equal((await rawRequest('/api/openings', JSON.stringify({ padding: 'x'.repeat(40_000) }))).status, 413, 'oversized request must be rejected before processing');
    for (const body of [[], null, true, 7, 'opening']) {
      assert.equal((await request('/api/openings', 'POST', body)).status, 400, `invalid body ${JSON.stringify(body)}`);
    }
    const iso = new Date(future).toISOString();
    for (const startsAt of [[iso], { value: iso }, true, null, '', String(future), iso.slice(0, -1), iso.slice(0, 10), future + 0.5]) {
      const result = await request('/api/openings', 'POST', { service: 'Haircut', stylist: 'Maya', startsAt });
      if (result.body.id) created.add(result.body.id);
      assert.equal(result.status, 400, `timestamp must not be coerced: ${JSON.stringify(startsAt)}`);
    }
  });

  let firstId;
  await check('parallel duplicate starts share one Workflow and conflicting service returns 409', async () => {
    const body = { service: 'Haircut', stylist: 'Maya', startsAt: future };
    const responses = await Promise.all([request('/api/openings', 'POST', body), request('/api/openings', 'POST', body)]);
    for (const result of responses) {
      if (result.body.id) created.add(result.body.id);
      assert.ok([200, 201].includes(result.status), JSON.stringify(result.body));
    }
    assert.equal(responses[0].body.id, responses[1].body.id);
    assert.deepEqual(responses.map(result => result.status).sort(), [200, 201]);
    firstId = responses[0].body.id;
    const conflict = await request('/api/openings', 'POST', { ...body, service: 'Color & finish' });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.id, firstId);
  });
  await check('wrong client cannot accept; decline advances and stale acceptance returns 409', async () => {
    const state = await waiting(firstId);
    const offer = activeOffer(state);
    assert.equal((await respond(firstId, offer, 'accept', 'not-the-offer-holder')).status, 409);
    assert.deepEqual(await read(firstId), state, 'wrong client must not mutate state');
    assert.equal((await respond(firstId, { ...offer, id: 'unknown-offer' }, 'accept')).status, 409);
    assert.deepEqual(await read(firstId), state, 'unknown offer must not mutate state');
    for (const malformed of [null, [], {}, { offerId: offer.id, clientId: [], response: 'accept' }, { offerId: offer.id, clientId: offer.clientId, response: 'other' }]) {
      assert.equal((await request(`/api/openings/${firstId}/respond`, 'POST', malformed)).status, 400);
      assert.deepEqual(await read(firstId), state, 'invalid response shape must not mutate state');
    }
    assert.equal((await respond(firstId, offer, 'decline')).status, 200);
    const next = await waitFor(firstId, state => state.status === 'waiting' && state.currentOfferId !== offer.id);
    assert.notEqual(activeOffer(next).clientId, offer.clientId);
    assert.equal((await respond(firstId, offer, 'accept')).status, 409);
    assert.deepEqual(await read(firstId), next, 'stale acceptance must not mutate the current offer');
  });
  await check('concurrent duplicate acceptance is idempotent with exactly one confirmation', async () => {
    const offer = activeOffer(await waiting(firstId));
    const replies = await Promise.all([respond(firstId, offer, 'accept'), respond(firstId, offer, 'accept')]);
    for (const result of replies) {
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.code, 'confirmed');
    }
    const final = await waitFor(firstId, state => state.status === 'filled');
    assert.equal(final.confirmedClient.id, offer.clientId);
    assert.equal(final.offers.filter(item => item.status === 'accepted').length, 1);
    assert.equal(final.history.filter(event => event.type === 'confirmed').length, 1);
    assert.equal((await respond(firstId, offer, 'accept')).body.code, 'confirmed', 'retry after completion must remain idempotent');
    assert.equal((await cancel(firstId)).status, 409, 'acceptance that wins first cannot be canceled afterward');
    assert.deepEqual(await read(firstId), final, 'post-completion retries and cancellation must not change final state');
  });

  await check('staff cancellation closes the offer and subsequent acceptance is rejected', async () => {
    const id = await create('Rowan', future + 60 * 60_000);
    const offer = activeOffer(await waiting(id));
    assert.equal((await cancel(id)).status, 200);
    assert.equal((await cancel(id)).status, 200, 'duplicate cancellation must be idempotent');
    assert.equal((await respond(id, offer, 'accept')).status, 409);
    const final = await read(id);
    assert.equal(final.status, 'canceled');
    assert.equal(final.offers.length, 1);
    assert.equal(final.offers[0].status, 'canceled');
    assert.equal(final.confirmedClient, undefined);
    assert.equal((await cancel(id)).status, 200);
    assert.equal((await respond(id, offer, 'accept')).status, 409);
    assert.deepEqual(await read(id), final, 'cancel-first terminal state must stay unchanged after retries');
  });
  await check('simultaneous acceptance and cancellation choose one immutable terminal outcome', async () => {
    const id = await create('Maya', future + 4 * 60 * 60_000);
    const offer = activeOffer(await waiting(id));
    const [accepted, canceled] = await Promise.all([respond(id, offer, 'accept'), cancel(id)]);
    assert.deepEqual([accepted.status, canceled.status].sort(), [200, 409]);
    const final = await waitFor(id, state => ['filled', 'canceled'].includes(state.status));
    assert.equal(final.offers.length, 1);
    assert.equal(final.offers[0].status, final.status === 'filled' ? 'accepted' : 'canceled');
    assert.equal(final.confirmedClient?.id, final.status === 'filled' ? offer.clientId : undefined);
    assert.equal(final.history.filter(event => ['confirmed', 'canceled'].includes(event.type)).length, 1);
    const retries = await Promise.all([respond(id, offer, 'accept'), cancel(id)]);
    assert.equal(retries[0].status, final.status === 'filled' ? 200 : 409);
    assert.equal(retries[1].status, final.status === 'canceled' ? 200 : 409);
    assert.deepEqual(await read(id), final, 'neither winner retry nor loser retry may change terminal state');
  });
  await check('retry-once scenario sends exactly twice before waiting', async () => {
    const id = await create('Maya', future + 2 * 60 * 60_000, 'retry_once');
    const state = await waiting(id);
    assert.equal(activeOffer(state).attempts, 2);
    assert.equal(state.offers.length, 1);
    assert.equal(state.alerts.length, 0);
    assert.equal((await cancel(id)).status, 200);
  });
  await check('two delivery failures alert staff and advance to the next client', async () => {
    const id = await create('Rowan', future + 3 * 60 * 60_000, 'delivery_failure');
    const state = await waiting(id);
    assert.equal(state.offers[0].status, 'delivery_failed');
    assert.equal(state.offers[0].attempts, 2);
    assert.notEqual(activeOffer(state).clientId, state.offers[0].clientId);
    assert.ok(state.alerts.length > 0);
    assert.equal((await cancel(id)).status, 200);
  });
  await check('appointment-start deadline expires in real time and cannot create a late booking', async () => {
    const startsAt = Date.now() + 2500;
    const id = await create('Maya', startsAt);
    const state = await waiting(id);
    const offer = activeOffer(state);
    assert.equal(offer.deadline, startsAt);
    const final = await waitFor(id, state => state.status === 'unfilled', 8000);
    assert.equal(final.offers.length, 1, 'no new offer after appointment starts');
    assert.equal(final.offers[0].status, 'timed_out');
    assert.ok(final.alerts.length > 0);
    assert.equal((await respond(id, offer, 'accept')).status, 409);
    assert.equal((await read(id)).confirmedClient, undefined);
  });
} catch (error) {
  failure = error;
  console.error(error);
} finally {
  await check('all smoke-test openings finish filled, canceled, or unfilled', async () => {
    for (const id of created) {
      let state = await read(id);
      if (!['filled', 'canceled', 'unfilled'].includes(state.status)) {
        await cancel(id);
        state = await waitFor(id, state => ['filled', 'canceled', 'unfilled'].includes(state.status));
      }
      assert.ok(['filled', 'canceled', 'unfilled'].includes(state.status));
    }
  }).catch(error => { failure ??= error; });
  await mkdir(new URL('../evidence/', import.meta.url), { recursive: true });
  await writeFile(new URL('../evidence/api-smoke.json', import.meta.url), JSON.stringify({ startedAt, completedAt: new Date().toISOString(), cases }, null, 2) + '\n');
}
if (failure) process.exitCode = 1;
else console.log(`${cases.length} live API smoke checks passed.`);
