# Focused edge-case coverage review

This review separates implemented behavior from observed evidence. The starting evidence was **14/14 Workflow tests and 11/11 real-API checks**. The final combined `npm test` run passed **21/21 tests, with no failures or skipped tests**, in 8.104 seconds on October 5, 2026 (20:36:49 PDT; log timestamp 2026-10-06T03:36:49Z). TypeScript checking also passed. Existing 11/11 API results remain applicable because this follow-up added tests and documentation without runtime changes. No new customer features, external integration, or deployment were added.

## Before/after coverage

| Case | Evidence before this review | Focused check and current status |
| --- | --- | --- |
| A known send failure retries once | Tested and passing: first-attempt failure followed by success; two failures alert staff and advance. Existing Activity scenarios fail before sending. | Retain these checks. They do not establish exactly-once external delivery. |
| Acceptance and staff cancellation race | Tested and passing at Workflow and API levels. One consistent terminal outcome wins. | First valid action processed by the Workflow wins; later actions cannot reverse it. |
| Staff cancels while the notification Activity is actually sending or retrying | Cancellation scope and terminal-state checks were implemented, but prior cancellation tests only canceled an already-waiting offer. | **Tested and passing:** controlled Activities hold the first send or second-attempt retry in flight; cancellation rejects the late receipt and prevents booking/next-client outreach. Tests: `cancellation while first send is in flight rejects its late receipt` and the retry variant in [edge-cases.test.ts](../tests/edge-cases.test.ts). A message already sent externally cannot be recalled. |
| Worker restarts before the offer deadline | Tested and passing: same offer, receipt, and deadline survive. The previous automated restart occurred five minutes into a 15-minute offer. | Retain the test; this does not by itself prove overdue-timer handling. |
| Worker restarts after the offer deadline has passed | Deadline and durable timer logic were implemented, but the prior restart evidence did not cross the deadline. | **Tested and passing:** Worker stops with an active offer, time advances beyond its deadline, then the restarted Worker rejects the expired offer and either advances to the next client or ends unfilled if appointment start has passed. Tests: both `Worker restarts after deadline` variants in [edge-cases.test.ts](../tests/edge-cases.test.ts). The old deadline is not renewed. |
| Every eligible client declines | The loop was implemented. Prior tests covered a single decline, no eligible clients, and appointment cutoff—not exhaustion through all declines. | **Tested and passing:** all-decline and mixed decline/timeout variants produce an unfilled terminal state, no booking, and a staff alert. Tests: `entire eligible waitlist … ends unfilled and alerts staff` in [workflow.test.ts](../tests/workflow.test.ts). |
| Every eligible client times out | The loop was implemented. Prior tests covered one timeout and a shortened appointment-start cutoff—not repeated full-window timeouts for all candidates. | **Tested and passing:** time-skipping crosses each client's offer window; the all-timeout variant produces no booking or extra offers and ends unfilled with a staff alert. Test: the all-timeout `entire eligible waitlist` variant in [workflow.test.ts](../tests/workflow.test.ts). |
| Provider sent a message, but its acknowledgement was lost | **Not simulated or tested.** The current Activity scenarios throw before a successful simulated send. | Outside this prototype's proof: retries could duplicate an external message. Requires a real provider's stable-key deduplication and/or durable outbox plus reconciliation. |

## What replay and retries actually establish

When Temporal has recorded a successful Activity completion, replay uses that recorded result. The Worker restart test demonstrates that the recorded demo delivery is not executed a second time. The original offer deadline remains unchanged.

If a provider sent a message but the success was never recorded, the process cannot infer whether delivery occurred. Retrying can repeat the side effect. A stable offer ID helps only if the real provider or an application-owned durable delivery mechanism enforces its idempotency and reconciles ambiguous outcomes. Passing the retry tests therefore does not establish exactly-once SMS delivery.

The prototype has no real SMS provider or calendar adapter. This missing integration is explicit rather than represented by a success label or simulated failure mode.

## Customer rules remain unchanged

- Contact suitable clients in waitlist order, one at a time.
- A successfully delivered offer expires at the earlier of 15 minutes after sending and appointment start. A recorded deadline is never extended on replay or restart.
- Workflow processing time is authoritative for acceptance. A click or HTTP request arriving earlier does not override an expired deadline when processed.
- Staff cancellation stops further offers and invalidates outstanding acceptance; it cannot undo a completed booking or recall a message already sent.
- The target to refill **one in two last-minute cancellations** remains a business goal for a future measured pilot, not a result established by these tests.

The final [combined test log](../evidence/workflow-tests.txt) and [evidence notes](../evidence/README.md) record the results. Provider acknowledgement loss remains untested and is not covered by the passing counts.
