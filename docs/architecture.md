# Architecture, reliability, and scalability

## Local flow

```text
Staff page / Client offer page
              |
          HTTP API
              |
       Temporal Service ---- persisted event history / timers
              |
         Task Queue
              |
            Worker
       /              \
Opening Workflow     Simulated notification Activity
```

The API starts an opening Workflow and forwards client replies and staff cancellation through Temporal Updates. Updates return a business result so a received request is not confused with a confirmed booking. Queries expose Workflow state to the UI. The Worker executes the Workflow and notification Activity; Temporal stores history and schedules durable work.

## Offer lifecycle

An opening selects eligible sample clients in waitlist order. It creates one current offer, attempts notification, and waits for a response or the exact deadline. Decline/timeout advances to the next eligible client; timely acceptance fills the opening. Staff cancellation terminates outreach. Exhaustion or appointment-start cutoff ends unfilled with an alert.

The notification Activity receives the appointment start time. On successful simulated sending, it records `sentAt` and computes `deadline = min(sentAt + 15 minutes, appointment start)`. Its receipt returns that deadline to the Workflow, and the same value appears in the simulated message. A successful retry therefore starts the full response window, still capped at appointment start. While delivery is in progress, any displayed deadline is preliminary and acceptance is unavailable. Until the Workflow processes a successful delivery receipt, it does not make the offer acceptable.

Once a successful delivery receipt is recorded, replay and restart reuse that receipt and never reset its deadline. Waiting uses Temporal's durable timer/condition support, not a browser timer or an in-memory API timeout. The browser countdown is display only; the Workflow decides whether a reply is timely.

Notification is an Activity because delivery is an external side effect. Its retry policy allows **two total attempts**, with a short retry delay. Demonstration controls can fail the first attempt or both attempts for the initial candidate. After both failures, the Workflow records an alert and advances. This simulates failure behavior; it is not evidence of SMS delivery.

### Delivery failure versus an unknown delivery outcome

The existing failure scenarios throw **before** the simulated send. In that known-failure case, retrying once can safely produce the first simulated message. This does not exercise a provider that actually sent a message but whose acknowledgement was lost before Temporal recorded the Activity completion.

That second case has an **unknown outcome**: a retry can produce a duplicate external message. Replay reuses an Activity completion already recorded in history, but it cannot invent a missing acknowledgement or prove that an unrecorded external send never happened. The stable offer ID is a potential idempotency key; no real provider-side deduplication, durable outbox, or acknowledgement reconciliation is implemented here. No exactly-once delivery claim is made.

A production adapter must reuse the same operation key and recover the provider's original delivery receipt/deadline after an ambiguous failure rather than issue a new effective offer with a later deadline. Within this prototype, once the successful receipt is recorded, the exact deadline remains fixed at the earlier of 15 minutes from that send and appointment start; replay/restart does not extend it. Lost acknowledgements are **not simulated or tested** by the current delivery controls. See the [edge-case review](edge-case-review.md) for case-specific coverage.

## Booking and cancellation correctness

- Each opening Workflow owns its current offer and final outcome. Reply validation and the winning state transition execute together without an awaited external operation between them.
- A reply must name the current offer and client, be processed by the Workflow before its deadline, and target an active opening. The Workflow's durable clock is authoritative: a client click or HTTP request received before the cutoff is not a booking if the Workflow processes it at or after the cutoff. Old links and repeated requests cannot create another winner.
- Workflow IDs derived from the stylist and appointment start prevent duplicate processes for the identical slot. This is narrower than calendar-wide reservation protection.
- A processed cancellation prevents subsequent offers and invalidates the outstanding offer. Cancellation cannot unsend a message already delivered or retroactively erase a confirmation that won a race before cancellation was processed.
- If acceptance and cancellation race, the first valid action processed by the Workflow wins. Acceptance first leaves the appointment confirmed; cancellation first rejects the acceptance. Client-side click order is not a guarantee of processing order.
- Workflow history survives Worker/API restarts while the Temporal data volume remains intact. A restart must not reset the original response deadline.

## What is simulated or excluded

Sample clients, notification delivery, and the booking record are local demo behavior. No real calendar, SMS provider, worksheet import, authentication, or authorization is present. The application should be run locally as requested by the assessment.

The same stylist/start identity and one-winner Workflow logic do **not** prevent overlapping reservations with different start times or the same client booking separate openings. They also cannot know that someone changed an external calendar unless staff cancels the process. These are explicit integration limits.

The staff listing currently reads up to 100 Workflow executions and queries their states; it is intentionally a small-demo approach. The API listens on loopback. The client-offer response omits other clients, but endpoints have no authentication and are unsuitable for exposing publicly. `clientId`/`offerId` validation establishes request consistency, not caller identity or authorization. Anyone who can reach the local API can read staff data and invoke staff/client actions. See the [focused security review](security-review.md) for the review scope and findings.

## Production path and scale

1. **Authoritative booking constraint.** Reserve the real calendar slot atomically before reporting success. Enforce stylist/service-duration overlap constraints and any client-overlap policy in the authoritative database or booking API. Resolve competing reservation attempts with a single committed winner.
2. **Safe external effects.** Key real notification and booking requests by stable offer/operation IDs. Use provider idempotency or an outbox/reconciliation process because an Activity can complete externally before its acknowledgement is recorded and later be retried. Temporal retries alone do not guarantee exactly-once SMS or calendar writes.
3. **Access control.** Authenticate staff, authorize salon-specific actions, and use expiring client-specific offer tokens. Do not rely on an unguessable Workflow ID as authorization. Minimize personal data in Workflow history and define retention.
4. **Worker capacity.** Multiple Workers can poll a shared Task Queue, allowing independent openings to progress in parallel. Keep each opening's state bounded. Set Worker concurrency and separate notification tasks where provider latency would otherwise consume capacity.
5. **Provider limits and read traffic.** Rate-limit notifications per provider/salon; pace bursts of cancellations. Use a paginated read model for staff search and reporting rather than querying every Workflow on every refresh. Apply backoff to UI polling.
6. **Operations.** Monitor unfilled openings, retry exhaustion, task queue delay, deadline handling delay, and rejected stale replies. Alert on stalled processes. Test provider outages, Worker loss, deployment compatibility, and reservation conflicts before piloting.
7. **Production Temporal.** Replace the single-node development server with a supported production service, appropriate persistence/backups, access control, and service monitoring. Define recovery objectives and verify restore procedures.

These are proposed next steps. This assessment does not include load tests, production availability evidence, capacity estimates, or a claim that the system is production-ready.

## Technical references

- [Temporal TypeScript message passing: Queries and Updates](https://docs.temporal.io/develop/typescript/workflows/message-passing)
- [Temporal TypeScript durable timers](https://docs.temporal.io/develop/typescript/workflows/timers)
- [Temporal Activities](https://docs.temporal.io/activities)
