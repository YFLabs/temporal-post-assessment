# Customer requirements and acceptance plan

Source: the completed 19-turn assessment conversation with Lena, including her final confirmation. These are the actual assessment findings, not the earlier practice simulation.

## Problem and outcome

Juniper Salon currently scans a worksheet and texts clients by hand after a cancellation. Busy staff lose track of replies and forget to move to the next person. Lena defines last-minute cancellations as those within about **48 hours** of the appointment.

Primary target: refill **at least half** of those cancellations while reducing repeated staff checking and chasing. Reliable progression and avoiding double-booking are essential. This is a customer target, not a measured prototype result.

## Confirmed behavior

| ID | Requirement |
| --- | --- |
| R1 | Staff enters service, stylist, date, and time, then starts the offer process. |
| R2 | Match the service, client availability, and any required stylist preference. Order suitable clients by earliest waitlist entry. |
| R3 | Contact one client at a time. A decline or no response moves the process to the next suitable client. |
| R4 | Every offer has a 15-minute response window, capped at the appointment start. The same policy applies to today and tomorrow. Show the exact deadline in the message and client page. |
| R5 | A valid acceptance within the deadline automatically confirms the appointment and stops outreach. Staff sees who accepted; staff approval is not required. |
| R6 | An expired offer cannot claim the appointment. Staff can see that it timed out. Avoid double-booking. |
| R7 | Retry a failed notification once. If the retry fails, alert staff and move to the next client. Also alert staff when a process ends without filling the opening. |
| R8 | Staff can cancel immediately when the opening is filled another way, preventing further offers. |
| R9 | Staff sees opening details, current offer holder, response deadline, and filled/canceled state. History shows contacts, declines, timeouts, and the final result. |
| R10 | A warm, simple, phone-friendly staff and client experience replaces the worksheet as the main interface. The existing worksheet remains a reference. Client deadline and outcome are especially clear. |
| R11 | Staff decides whether to start very short-notice outreach. No minimum client travel-notice rule has been set. |
| R12 | Sample waitlist clients and clearly labeled simulated text messages are acceptable for the first demonstration. Matching, deadlines, responses, confirmation, and cancellation must behave realistically. Real texting and booking-calendar integration come later. |

## Implementation choices and boundaries

- One Temporal Workflow per opening coordinates offers and owns durable state. This is an implementation choice, not a technical decision requested from Lena.
- The Workflow rejects replies for an old offer, the wrong client, an expired deadline, or a terminal opening. Repeated requests cannot create a second confirmation.
- Deadline is `min(successful simulated send time + 15 minutes, appointment start)`. A successful retry starts the full response window, still capped at appointment start. Before delivery, any shown deadline is preliminary and the offer is not valid for acceptance. After delivery, the message and Workflow use the same exact deadline; replay or restart never resets it. No minimum response window or travel buffer is invented.
- Matching uses fictional waitlist entries. Any fixed sample availability or deterministic tie-breaking is demo data/implementation behavior, not a new salon policy.
- “Confirmed” means recorded in this prototype. A real booking calendar is not connected.
- Workflow-level protection prevents two winners for one opening. Identical stylist/start openings share a canonical identity. Calendar-wide overlap prevention remains production work; see the architecture document.
- Demo failure controls simulate messaging-provider errors. They do not test an actual SMS provider.
- This assessment prototype accepts openings within the next 48 hours, using two sample services and two sample stylists. Those catalogue entries and durations are demonstration choices.

## Thirty-minute development plan

1. **Minutes 0–5:** finalize this requirement map, API/data contract, and state transitions.
2. **Minutes 5–17:** build the durable Workflow, notification Activity, API, and staff/client pages in parallel.
3. **Minutes 17–25:** run matching, lifecycle, retry, stale-reply, and cancellation tests; check browser flows and fix failures.
4. **Minutes 25–30:** verify restart behavior, capture Temporal evidence, finalize run instructions and limitations. Keep presentation creation for the reserved presentation phase.

This is a delivery plan, not a record of actual completion times.

## Acceptance-test plan

Verified results are recorded in [the evidence notes](../evidence/README.md): 21/21 Workflow tests, 11/11 real-API checks after security hardening, an actual API/Worker restart, and browser/mobile checks. The table below describes the acceptance plan; its inclusion alone does not establish that every variation was tested. Consult the logs for exact coverage.

| Check | Evidence needed |
| --- | --- |
| Eligibility and priority | Mismatched service, availability, and stylist preference are excluded; the oldest eligible entry is first. |
| Timely acceptance | Valid current offer becomes filled with the correct client; subsequent candidates receive no offer. |
| Decline and exhaustion | Decline advances to the next eligible client; exhausting the list produces an unfilled state and alert. |
| Durable timeout | Time-skipping test crosses the full 15-minute deadline and advances without a browser action. |
| Short-notice deadline | Appointment start earlier than 15 minutes truncates the offer; nothing can book after that cutoff. |
| Stale/late reply | Old offer ID, wrong client ID, and replies at or past expiration cannot fill an opening. |
| Duplicate/racing replies | Repeated acceptance is safe; competing acceptances produce one confirmed client. |
| Cancellation | Cancels a waiting process; later acceptance is rejected and no next offer is sent. Check cancellation during notification work too. |
| Retry policy | First failure then success uses two attempts and sets the deadline from the successful send; two failures create an alert and proceed to the next candidate without a valid offer for the failed recipient. |
| Duplicate opening | Starting the same stylist/start twice does not create independent competing processes. |
| Recovery | Restart Worker/API while waiting; retain Workflow ID, current offer, and original deadline. |
| Interface | Desktop and phone-width staff/client pages expose clear current status, deadline, history, and outcomes. Simulated messages remain labeled. |
| Evaluation setup | Fresh-checkout one-command start launches local services; typecheck and automated tests run; meaningful Temporal history screenshot is saved. |

## Pilot measurement proposal

Before connecting real clients, agree on a pilot period and record all cancellations within 48 hours, whether staff started outreach, final calendar-confirmed outcome, reason for any unfilled opening, and staff intervention. Refill rate should use all in-scope cancellations as its denominator so skipped openings are visible. Record staff effort and booking conflicts alongside the rate. Sample demo outcomes cannot establish the 50% business target.
