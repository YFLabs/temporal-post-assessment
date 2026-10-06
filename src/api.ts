import { createHash } from 'node:crypto';
import path from 'node:path';
import { Client, Connection, WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { ActionResult, ClientRecord, Opening, OpeningState, ReplyInput, Scenario } from './types';
import { isReplyInput, parseStartsAt } from './validation';

const app = express();
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(process.cwd(), 'public')));
const services = [{ name: 'Haircut', durationMinutes: 45 }, { name: 'Color & finish', durationMinutes: 90 }];
const stylists = ['Maya', 'Rowan'];
let clientPromise: Promise<Client> | undefined;
async function getClient(): Promise<Client> {
  if (!clientPromise) clientPromise = Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233' })
    .then(connection => new Client({ connection, namespace: 'default', identity: 'juniper-demo-api' })).catch(error => { clientPromise = undefined; throw error; });
  return clientPromise;
}
// These are fictional fixtures, generated around the demo day, never a live sheet import.
function sampleClients(now = Date.now()): ClientRecord[] {
  const from = now - 24 * 60 * 60_000;
  const until = now + 4 * 24 * 60 * 60_000;
  return [
    { id: 'alice', name: 'Alice Chen', service: 'Haircut', stylist: 'Maya', availableFrom: from, availableUntil: until, joinedAt: now - 7 * 86400_000 },
    { id: 'ben', name: 'Ben Rivera', service: 'Haircut', stylist: null, availableFrom: from, availableUntil: until, joinedAt: now - 5 * 86400_000 },
    { id: 'imani', name: 'Imani Brooks', service: 'Haircut', stylist: null, availableFrom: from, availableUntil: until, joinedAt: now - 3 * 86400_000 },
    { id: 'leo', name: 'Leo Park', service: 'Haircut', stylist: 'Rowan', availableFrom: from, availableUntil: until, joinedAt: now - 2 * 86400_000 },
    { id: 'nora', name: 'Nora Wilson', service: 'Color & finish', stylist: null, availableFrom: from, availableUntil: until, joinedAt: now - 6 * 86400_000 },
    { id: 'ellie', name: 'Ellie Davis', service: 'Color & finish', stylist: 'Maya', availableFrom: from, availableUntil: until, joinedAt: now - 4 * 86400_000 },
    { id: 'sam', name: 'Sam Morgan', service: 'Haircut', stylist: null, availableFrom: from - 86400_000, availableUntil: from, joinedAt: now - 8 * 86400_000 },
  ];
}
const bad = (response: Response, message: string) => response.status(400).json({ error: message });
const safeId = (id: string) => /^juniper-[a-f0-9]{24}$/.test(id);
async function readState(id: string): Promise<OpeningState> {
  if (!safeId(id)) throw Object.assign(new Error('Unknown opening.'), { statusCode: 404 });
  const client = await getClient();
  return client.connection.withDeadline(Date.now() + 10_000, async () => {
    const handle = client.workflow.getHandle(id);
    const description = await handle.describe();
    if (description.status.name === 'COMPLETED') return await handle.result() as OpeningState;
    return await handle.query<OpeningState>('getOpening');
  });
}
function terminalReply(state: OpeningState, reply: ReplyInput): ActionResult {
  const offer = state.offers.find(o => o.id === reply.offerId && o.clientId === reply.clientId);
  if (state.status === 'filled' && offer?.status === 'accepted' && reply.response === 'accept')
    return { ok: true, code: 'confirmed', message: 'Your appointment is confirmed.' };
  if (offer?.status === 'declined' && reply.response === 'decline')
    return { ok: true, code: 'declined', message: 'Your decline has already been recorded.' };
  return { ok: false, code: 'unavailable', message: 'This offer is no longer available. It has not created a booking.' };
}
app.get('/api/config', (_req, res) => res.json({ services, stylists, clients: sampleClients() }));
app.get('/api/health', async (_req, res) => {
  const client = await getClient();
  await client.connection.withDeadline(Date.now() + 3_000, () => client.connection.workflowService.getSystemInfo({}));
  res.json({ ok: true, messaging: 'simulated' });
});
app.post('/api/openings', async (req, res) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return bad(res, 'Opening details are required.');
  const service = services.find(s => s.name === req.body.service);
  const startsAt = parseStartsAt(req.body.startsAt);
  if (!service || !stylists.includes(req.body.stylist)) return bad(res, 'Choose a listed service and stylist.');
  if (!Number.isFinite(startsAt) || startsAt <= Date.now()) return bad(res, 'The appointment must start in the future.');
  if (startsAt > Date.now() + 48 * 60 * 60_000) return bad(res, 'This prototype handles openings within the next 48 hours.');
  const scenario: Scenario = req.body.scenario ?? 'normal';
  if (!['normal', 'retry_once', 'delivery_failure'].includes(scenario)) return bad(res, 'Unknown demonstration scenario.');
  const opening: Opening = { service: service.name, stylist: req.body.stylist, startsAt, durationMinutes: service.durationMinutes };
  // Service is deliberately excluded: the same stylist/time cannot be started twice
  // under different service names. Temporal also rejects reuse after completion.
  const id = `juniper-${createHash('sha256').update(`${opening.stylist}|${startsAt}`).digest('hex').slice(0, 24)}`;
  const client = await getClient();
  try {
    await client.connection.withDeadline(Date.now() + 10_000, () => client.workflow.start('fillOpeningWorkflow', {
      workflowId: id, taskQueue: 'juniper-salon', workflowIdReusePolicy: 'REJECT_DUPLICATE',
      args: [{ id, opening, clients: sampleClients(), scenario }],
    }));
  } catch (error) {
    if (error instanceof WorkflowExecutionAlreadyStartedError) {
      const state = await readState(id);
      if (state.opening.service !== opening.service) return res.status(409).json({ error: 'This stylist and start time already has an opening.', id });
      return res.status(200).json(state);
    }
    throw error;
  }
  res.status(201).json(await readState(id));
});
app.get('/api/openings', async (_req, res) => {
  const client = await getClient();
  const ids: string[] = [];
  await client.connection.withDeadline(Date.now() + 10_000, async () => {
    for await (const execution of client.workflow.list({ query: "WorkflowType = 'fillOpeningWorkflow'", pageSize: 100 })) {
      if (safeId(execution.workflowId)) ids.push(execution.workflowId);
      if (ids.length >= 100) break;
    }
  });
  const results = await Promise.all(ids.map(id => readState(id)));
  res.json({ openings: results.sort((a, b) => b.createdAt - a.createdAt) });
});
app.get('/api/openings/:id', async (req, res) => res.json(await readState(req.params.id as string)));
app.get('/api/openings/:id/offers/:offerId', async (req, res) => {
  const state = await readState(req.params.id as string);
  const offer = state.offers.find(o => o.id === req.params.offerId);
  if (!offer) return res.status(404).json({ error: 'Offer not found.' });
  // Do not expose the waitlist or other clients to this client-facing route.
  res.json({ opening: state.opening, offer, workflowStatus: state.status,
    ...(offer.status === 'accepted' ? { confirmedClient: state.confirmedClient } : {}) });
});
app.post('/api/openings/:id/respond', async (req, res) => {
  const id = req.params.id as string;
  const reply = req.body as ReplyInput;
  if (!isReplyInput(reply))
    return bad(res, 'A valid offer, client, and accept/decline response are required.');
  const client = await getClient();
  let result: ActionResult;
  const state = await readState(id);
  if (['filled', 'canceled', 'unfilled'].includes(state.status)) result = terminalReply(state, reply);
  else {
    try {
      result = await client.connection.withDeadline(Date.now() + 10_000, () => client.workflow.getHandle(id).executeUpdate<ActionResult, [ReplyInput]>('respondToOffer', { args: [reply] }));
    } catch (error) {
      const latest = await readState(id);
      if (!['filled', 'canceled', 'unfilled'].includes(latest.status)) throw error;
      result = terminalReply(latest, reply);
    }
  }
  res.status(result.ok ? 200 : 409).json(result);
});
app.post('/api/openings/:id/cancel', async (req, res) => {
  const id = req.params.id as string;
  const state = await readState(id);
  if (state.status === 'canceled') return res.json({ ok: true, code: 'canceled', message: 'Outreach is already canceled.' });
  if (['filled', 'unfilled'].includes(state.status)) return res.status(409).json({ ok: false, code: 'unavailable', message: 'This process has already ended.' });
  const client = await getClient();
  try {
    const result = await client.connection.withDeadline(Date.now() + 10_000, () => client.workflow.getHandle(id).executeUpdate<ActionResult, []>('cancelOpening'));
    res.status(result.ok ? 200 : 409).json(result);
  } catch (error) {
    const latest = await readState(id);
    if (latest.status === 'canceled') return res.json({ ok: true, code: 'canceled', message: 'Outreach canceled.' });
    if (latest.status === 'filled') return res.status(409).json({ ok: false, code: 'unavailable', message: 'The appointment was confirmed before cancellation could be applied.' });
    throw error;
  }
});
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const e = error as { name?: string; statusCode?: number; type?: string };
  if (e.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body must be valid JSON.' });
  if (e.type === 'entity.too.large') return res.status(413).json({ error: 'Request body exceeds the 32 KB limit.' });
  // Avoid logging a complete caller payload or stack into submission evidence.
  console.error('Request failed:', e.name ?? 'UnknownError');
  const status = e.statusCode ?? (e.name === 'WorkflowNotFoundError' ? 404 : 503);
  res.status(status).json({ error: status === 404 ? 'Opening not found.' : 'We could not verify the latest state. Refresh before trying again; a pending action may already have completed.' });
});
const port = Number(process.env.PORT ?? 3000);
app.listen(port, '127.0.0.1', () => console.log(`Juniper Salon is available at http://localhost:${port}`));
