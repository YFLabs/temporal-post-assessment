# Juniper Salon · Fill the opening

A local, phone-friendly prototype that offers a canceled appointment to suitable waitlisted clients, one at a time. Temporal keeps the process moving through replies, deadlines, notification retries, and staff cancellation.

**Demo boundary:** all clients are fictional and every message is simulated. Confirmation changes this prototype's booking state; it does not write to a real salon calendar. No real text messages are sent. This application is for local evaluation, not public deployment.

## Run from a fresh checkout

Install **Node.js 20+** and start **Docker Desktop**. From this repository, run:

```bash
npm start
```

The start command installs dependencies when needed and launches the local Temporal service, API, and Worker. The first launch needs internet access for dependencies and the Docker image.

- Staff application: [localhost:3000](http://localhost:3000)
- Temporal Web UI: [localhost:8233](http://localhost:8233)
- Required available ports: 3000, 7233, and 8233.

After dependencies are installed, `npm run dev` also starts the application. Stop the API and Worker with Ctrl+C; `npm run stop` stops Temporal. The Docker volume retains Temporal history between restarts. Do not remove that volume during a recovery demonstration.

## What to demonstrate

Use a separate opening for each terminal outcome. Enter the service, stylist, date, and time, then start outreach. Start with **Haircut / Maya** to see Alice, Ben, and Imani in waitlist order. The sample waitlist is the source of demo clients; the old worksheet is a reference, not the main interface.

| Scenario | Action | Expected behavior |
| --- | --- | --- |
| Matching and ordering | Start an opening matching several sample clients | Only suitable clients qualify; earliest waitlist entry receives the first offer. |
| Acceptance | Open the current client's offer and accept before its displayed deadline | Appointment becomes filled automatically; staff sees who accepted and no further offer is sent. |
| Decline | Decline the current offer | The next suitable client receives an offer; history records the decline. |
| Deadline | Leave an offer unanswered | It expires 15 minutes after successful simulated sending or at appointment start, whichever is earlier. The process advances if time and candidates remain. |
| Late reply | Keep an old offer page open, let that offer expire or advance, then submit | The response cannot claim the appointment; the client sees the outcome. |
| Cancellation | Staff cancels while an offer is outstanding | The process becomes canceled; no future offers are created and that offer cannot book the slot. |
| Notification retry | Use a simulated first-send failure | One retry is allowed. A successful retry starts the response window, still capped at appointment start. |
| Repeated notification failure | Use a simulated failure on both attempts | Staff receives an alert; outreach moves to the next candidate. |
| Exhausted waitlist | Decline each suitable client's offer in turn | The opening ends unfilled and staff is alerted. A no-match fixture is included in the automated acceptance-test plan. |
| Duplicate acceptance | Submit the same acceptance again | It cannot create a second booking or change the confirmed client. |

**Fast deadline demonstration:** choose an appointment starting one or two minutes from now and do not respond. This exercises the real appointment-start cutoff without replacing the agreed 15-minute policy with an artificial demo timer. Showing progression after a full 15-minute timeout can be covered by the time-skipping test suite.

While a message is being sent, any displayed deadline is preliminary and the offer cannot be accepted. Successful simulated delivery sets the exact deadline used in both the message and the Workflow. That deadline stays fixed through replay and restart; failed delivery does not create a valid offer.

**Recovery demonstration:** while a client offer is waiting, note its Workflow ID and deadline. Stop the API/Worker with Ctrl+C, leaving Docker running, then run `npm start` again. Reopen the staff page and the same offer. Verify that the deadline has not restarted and the process resumes from its recorded state. This was verified against the running application: the same offer, original deadline, and delivery receipt survived without duplicate delivery. See [recovery evidence](evidence/recovery.json).

## API reference

- `GET /api/config` — listed services, stylists, and fictional waitlist.
- `GET /api/openings` — up to 100 opening processes.
- `POST /api/openings` — `{ "service": "Haircut", "stylist": "Maya", "startsAt": "<future ISO timestamp>", "scenario": "normal" }`.
- `GET /api/openings/:id` — staff status and history.
- `GET /api/openings/:id/offers/:offerId` — current outcome for one client offer without exposing other clients.
- `POST /api/openings/:id/respond` — `{ "offerId": "…", "clientId": "…", "response": "accept" }`; use `decline` for the other response.
- `POST /api/openings/:id/cancel` — cancel active outreach.

Allowed demo scenarios are `normal`, `retry_once`, and `delivery_failure`. Failure injection affects the first suitable client only; later clients use normal delivery. Services are Haircut (45 minutes) and Color & finish (90 minutes), with stylists Maya and Rowan. Openings must be in the next 48 hours. Repeating the same stylist/start/service returns the original process; a different service for that same stylist/start returns HTTP 409.

The API binds to `127.0.0.1`. The client-offer route limits its response data, but this prototype does not authenticate users. Matching `clientId` and `offerId` checks request consistency; **it does not verify who is calling**. Anyone with access to the local API can read staff data and invoke staff or client actions. This is not an access-control boundary suitable for deployment. See the [focused security review](docs/security-review.md).

## Verification and evidence

```bash
npm run typecheck
npm test
npm run test:api  # Run against the application already running on localhost:3000
```

Verification passed: TypeScript checking, **21/21 Workflow tests**, and **11/11 checks against the real local API**, including expanded input-validation and acceptance/cancellation-race checks after security hardening. An actual API/Worker restart preserved the waiting offer and deadline. Browser verification covered creation, Alice declining, Ben accepting, and a 390-pixel mobile layout without horizontal overflow. The API checks create fictional opening processes and finish them in terminal states.

See [verification records and screenshots](evidence/README.md) and the [acceptance-test plan](docs/requirements.md). `npm start` was verified with dependencies already installed; a clean first-time dependency installation and production load testing were not performed.

The [edge-case review](docs/edge-case-review.md) records passing checks for cancellation during sending/retry, restart after expiry, and complete waitlist exhaustion. It also separates the untested case where a real provider sends a message but its acknowledgement is lost. Simulated delivery failures do not prove exactly-once external messaging.

## How Temporal is used

Each opening has its own Workflow. It owns offer selection, status, reply validation, durable waiting, and history. Notification delivery is an Activity with at most two attempts. Queries read status; Updates return the business outcome of client replies and staff cancellation. See [docs/architecture.md](docs/architecture.md) for design and scalability limits.

## Success target and limitations

Lena's target is to refill **at least 50% of cancellations within about 48 hours of the appointment**, with less manual chasing and no double-booking. This prototype demonstrates behavior; it has not measured business uplift.

Within one opening, responses are validated against the current offer and only one client can win. The same stylist and exact appointment start cannot start duplicate opening processes. This does **not** prove that overlapping appointments with different start times, or the same client booking across separate openings, cannot conflict. A production calendar/database must enforce those constraints atomically.

Real SMS and calendar integration, authentication, client-specific access tokens, worksheet import, and production hosting are excluded. The local Temporal development server is not a production deployment. No production load or scale result is claimed.

## Repository guide

- `src/workflows.ts` — offer lifecycle and durable state
- `src/activities.ts` — simulated notification delivery
- `src/api.ts` — HTTP interface to Temporal
- `src/worker.ts` — Workflow and Activity execution
- `public/` — staff and client browser experience
- `tests/` — automated behavior checks
- `docs/requirements.md` — customer requirements and acceptance plan
- `docs/architecture.md` — architecture, reliability boundaries, and scaling plan
- `evidence/` — verification records and Temporal screenshot

Built from the supplied [Temporal assessment starter](https://github.com/john-b-yang/temporal-waitlist-assessment-starter) in a new public repository, not a GitHub fork.
