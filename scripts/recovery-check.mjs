import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
const file = new URL('../evidence/recovery.json', import.meta.url);
async function api(path, body) {
  const response = await fetch(`http://localhost:3000${path}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000) });
  const value = await response.json();
  assert.ok(response.ok, JSON.stringify(value));
  return value;
}
if (process.argv[2] === 'before') {
  const opening = await api('/api/openings', { service: 'Color & finish', stylist: 'Rowan', startsAt: Date.now() + 10 * 60 * 60_000 });
  let state;
  for (let i = 0; i < 50; i++) {
    state = await api(`/api/openings/${opening.id}`);
    if (state.status === 'waiting') break;
    await sleep(100);
  }
  assert.equal(state.status, 'waiting');
  const before = { recordedAt: new Date().toISOString(), workflowId: state.id, offerId: state.currentOfferId, deadline: state.offers[0].deadline, sentAt: state.offers[0].sentAt, offerCount: state.offers.length, deliveryEvents: state.history.filter(event => event.type === 'contacted').length };
  await writeFile(file, JSON.stringify({ before, result: 'Restart verification pending' }, null, 2) + '\n');
  console.log(JSON.stringify(before));
} else if (process.argv[2] === 'after') {
  const { before } = JSON.parse(await readFile(file, 'utf8'));
  const state = await api(`/api/openings/${before.workflowId}`);
  assert.equal(state.status, 'waiting');
  assert.equal(state.currentOfferId, before.offerId);
  assert.equal(state.offers[0].deadline, before.deadline);
  assert.equal(state.offers[0].sentAt, before.sentAt);
  assert.equal(state.offers.length, before.offerCount);
  assert.equal(state.history.filter(event => event.type === 'contacted').length, before.deliveryEvents);
  const cancellation = await api(`/api/openings/${state.id}/cancel`, {});
  assert.equal(cancellation.ok, true);
  await writeFile(file, JSON.stringify({ before, after: { recordedAt: new Date().toISOString(), statusBeforeCleanup: state.status, sameOffer: true, sameDeadline: true, sameDeliveryReceipt: true, noDuplicateDelivery: true, cleanup: 'Canceled after verification' }, result: 'passed' }, null, 2) + '\n');
  console.log('PASS actual API/Worker restart preserved offer, deadline, and completed delivery receipt.');
} else throw new Error('Usage: node scripts/recovery-check.mjs before|after');
