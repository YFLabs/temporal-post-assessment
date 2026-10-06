# Verification evidence

Verification was performed on October 5, 2026 (America/Los_Angeles). Machine-readable logs use UTC, so the evening runs appear as October 6 in those files.

## Verified checks

| Check | Result and evidence |
| --- | --- |
| `npm run typecheck` | Passed. |
| `npm test` | **21/21 passed**, 0 failed/skipped, final combined run in 8.104 seconds: matching, automatic confirmation, decline and stale reply, full 15-minute timeout, appointment-start cutoff, cancellation including in-flight first send/retry, competing replies, retries, full waitlist exhaustion (all decline, all timeout, mixed), malformed direct replies, acceptance/cancellation races, and Worker replay/restart both before and after deadline. [Test log](workflow-tests.txt), [edge-case coverage](../docs/edge-case-review.md). |
| `npm run test:api` | **11/11 passed** against the running API and Temporal service after hardening: malformed JSON, oversized bodies, invalid input shapes, timestamp coercion, duplicate starts, conflicting services, wrong-client/stale replies, concurrent acceptance, acceptance/cancellation races, cancellation, both retry scenarios, real-time deadline, and terminal cleanup. [Machine-readable results](api-smoke.json). |
| Actual API + Worker stop/restart | Passed: same pending offer, unchanged deadline, same delivery receipt, and no duplicate delivery. The opening was canceled after checking. [Before/after evidence](recovery.json). |
| Browser workflow | Created an opening, declined Alice's offer, and accepted Ben's offer. Staff and client pages showed the confirmed outcome. |
| Mobile layout | Staff and client pages inspected at 390 pixels wide; no horizontal overflow. Screenshots below. |
| `npm start` | Launched successfully with dependencies already installed. A fresh dependency install was not separately verified. |

## Temporal evidence

The screenshots show an actual salon process, not the neutral starter demo:

- Workflow: `juniper-be5a39ad0d903f3b7418846c`
- Run: `01a10f42-a530-733b-89cf-e9b5a329f7be`
- Result: completed, with Imani confirmed after Ben declined.
- [Workflow summary screenshot](temporal-workflow.jpg)
- [Meaningful event history screenshot](temporal-history.jpg): `sendOffer` Activities, durable timers, and client Updates.

## Interface screenshots

- [Staff overview](staff-overview.jpg)
- [Staff mobile](staff-mobile.jpg)
- [Client mobile](client-mobile.jpg)
- [Client confirmation](client-confirmed.jpg)

## Limits of this evidence

The focused security review is complete within its documented scope: expanded suites passed 21/21 Workflow tests and 11/11 live-API checks. Docker's published ports were inspected and bind to `127.0.0.1` for both 7233 and 8233. See [review scope and findings](../docs/security-review.md). Machine-local paths in the regenerated Workflow log use `<project>` / `<user-home>` placeholders without changing results. Both Temporal screenshots were recaptured from a new real execution using a neutral Worker identity and visually rechecked.

All clients and messages are simulated. These checks do not establish real SMS delivery, external calendar correctness, authentication, cross-opening overlap protection, production capacity, or production availability. No load test was run. The automated suite checks specific scenarios; it does not prove every failure ordering. Business refill results have not been measured; **50% refill is Lena's target**, not a result from demo data.
