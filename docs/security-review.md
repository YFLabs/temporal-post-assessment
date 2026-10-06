# Focused security and privacy review

Scope: a local assessment prototype using fictional waitlist entries and simulated messages. This was a time-bounded source, configuration, and evidence review, not a penetration test, production certification, or exhaustive secret-scanner guarantee. No login system, external integrations, public deployment, or compliance claims were added.

## Findings and disposition

| Finding | Disposition |
| --- | --- |
| No caller authentication | Explicit limitation. `clientId`/`offerId` matching checks whether a reply matches the current offer; it does **not** authenticate the person submitting it. Anyone with access to the local API can read staff data and invoke staff/client actions. |
| Temporal ports initially published on all host interfaces | Changed to loopback-only port mappings. Docker was recreated with the existing data volume preserved. Actual published ports were inspected: both 7233 and 8233 bind to `127.0.0.1`. |
| Machine identity in evidence | The initial test log exposed 27 local workspace paths. Regenerated logs use neutral `<project>` / `<user-home>` placeholders. Both Temporal screenshots were replaced with genuine screenshots from a fresh execution using a neutral Worker identity, then visually rechecked. |
| Malformed JSON returned a service error | Error handling now reports malformed JSON and oversized input as client errors instead of a misleading unavailable-service response. Negative API checks passed. |
| Insufficient runtime input validation | Shared runtime validation now rejects invalid shapes/timestamp coercion and malformed replies sent directly to the Workflow. The expanded suites pass 21/21 Workflow tests and 11/11 live-API checks, including acceptance/cancellation races. |
| Cross-opening booking constraints | Remains excluded: one-winner and identical-slot protection do not prevent overlapping appointments at different start times or one client booking distinct openings. Production requires an authoritative atomic reservation constraint. |

## Submission-data check

Initially inspected 26 text files, including tracked and untracked submission files and hidden configuration files, excluding `.git`, `node_modules`, and image/binary files. Checked common private-key headers, GitHub/OpenAI/AWS credential patterns, JWT-like strings, quoted credential assignments, email addresses, user-home paths, hostname patterns, and URLs containing credentials. No credential-pattern matches were found. The only initial text finding was the local-path exposure described above; it was redacted without changing test outcomes. A follow-up scan of 28 text files, including the regenerated test log and review documents, returned no matches for these patterns.

All six evidence screenshots were visually inspected. Staff/client screenshots contain fictional clients and demo outcomes. The Temporal summary contains fictional input and technical execution identifiers. Both replacement Temporal images were visually rechecked: the history now displays a neutral Worker identity. These are fresh captures from a real execution, not cosmetic edits to disguise evidence.

This inspection cannot establish that every possible secret format or personal-data pattern is absent. New test logs must be checked again before submission because they may recreate machine paths.

## Boundaries to keep explicit

- Local evaluation only. No real SMS is sent and no external booking calendar is updated.
- No staff login, client token authentication, or authorization exists. Guess-resistant IDs are not a substitute for access control.
- Business-state checks reject invalid, stale, and canceled replies; this is distinct from identifying the caller.
- Deadline enforcement occurs when the Workflow processes the reply, using its authoritative clock. A client click or HTTP receipt alone does not establish timely acceptance; a reply processed at or after the exact deadline is rejected. UI countdowns are informative only.
- If acceptance and staff cancellation arrive concurrently, the first valid action processed by the Workflow wins. This guarantees one consistent outcome; it does not guarantee that a particular user's click is processed first.
- The refill rate is a proposed business target, not a demonstrated production result.
- Production needs authenticated roles, expiring client credentials, atomic calendar constraints, idempotent provider/outbox operations, monitoring, and capacity testing. Those additions are not included here.

## Applying the four-week learning

- **Week 1:** stable identities, duplicate request handling, validation, and serialized booking decisions protect one opening; retry ambiguity still requires external idempotency in a real integration.
- **Week 2:** the customer conversation defines eligibility, deadlines, cancellation, and simulation scope; business rules are not invented from the practice interview.
- **Week 3:** negative cases, concurrent actions, restart evidence, and actual API outcomes support specific claims. Final rerun results are linked from the evidence notes.
- **Week 4:** the handoff distinguishes working behavior, simulated integrations, measured evidence, and remaining limitations in language Lena can understand.
