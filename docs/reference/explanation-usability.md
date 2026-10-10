# Draw, explain and hand off: observation protocol

## Status

No human observation sessions have been run for this change. Implementation began without the
requested observed baseline, so the before/after usability acceptance criterion is still open.
Automated journeys are engineering checks, not evidence of time saved or reader comprehension.
Run the baseline on the prior revision and the repeat on this implementation. Retain identical
task wording and system facts. Do not add editor telemetry.

## Engineering verification (5 October 2026)

- The unit suite passed: 202 files, 3,722 tests.
- `PLAYWRIGHT_BROWSER=chromium PLAYWRIGHT_WORKERS=2 npm run check:full` passed: 309 editor
  journeys, the offline journey, and 13 hosted-site journeys. An earlier run failed the existing
  two-finger zoom check while multiple suites ran concurrently; that check passed in isolation
  and the subsequent full run passed without a code change.
- `PLAYWRIGHT_BROWSER=webkit PLAYWRIGHT_WORKERS=2 npm run check:full` passed: 300 editor
  journeys and 13 hosted-site journeys. Nine editor cases and the offline case were skipped by
  their platform guards.
- The Chromium and WebKit desktop suites passed all 80 journeys, including the editable example.
- Firefox could not launch in this environment: its runtime reported "Could not find profile
  folder" before opening a page. Rechecking the installation and a different temporary directory
  did not resolve it. Firefox acceptance remains pending.
- Native file-picker verification remains pending. The computer-control permission needed to
  exercise the operating-system dialogs was unavailable. Injected-adapter journeys and file
  session unit tests do not substitute for this check.

These results do not satisfy the human observation gates below.

## Hosted engineering verification (10 October 2026)

[CI on 60f3eca](https://github.com/acltabontabon/draft-canvas/actions/runs/38040880397) passed all three
browser shards, including Firefox, plus offline and assembled-site acceptance. The browser launch
problem above is limited to the local macOS environment. [Desktop CI on 584bf60](https://github.com/acltabontabon/draft-canvas/actions/runs/38018279380)
also passed its fake-shell, Rust and packaged-startup checks. These results verify the implementation
prepared for 1.13.0; the observed baseline and five-person handoff remain unrecorded and must not be inferred from
automated test success. The web linked-file experiment was removed before release.

## Baseline task

Use a familiar order-processing system: an API accepts an order, a queue holds accepted work,
a worker processes it, and a database records the result. Ask the participant to draw this system,
explain one order's journey, and hand the diagram to someone else who has not watched it being made.
Let them choose their own controls; give help only when requested or after a recorded impasse.
Record the app revision, platform, input method, and prior familiarity before starting.

Start the clock when the task is read. Mark the times for a recognizable system, a complete
explanation, a prepared handoff, and the recipient's response. Record each assistance request and
what the facilitator said. Do not count time spent resolving test-environment problems as drawing time.

## Repeat after milestones 1–3

Recruit five representative people, covering a first-time diagrammer, a regular architecture
presenter, a developer familiar with the system, a keyboard user, and a touch/small-screen user.
These are recruitment targets, not claims about participants already tested. Each participant
completes the same task and gives their result to a recipient who has not seen its construction.
Avoid showing the example first unless they discover it themselves.

Ask the recipient, without coaching: Where does this scenario begin? Which components hand work
to the next component? What is the final outcome? Record their actual words and score each answer
against the system facts above. Check whether they can advance the story, explore, and make an
editable copy without assistance.

| Session | Revision / platform | Draw time | Explain time | Handoff time | Assistance | Entry / handoffs / outcome |
| --- | --- | --- | --- | --- | --- | --- |
| Baseline | Pending | — | — | — | — | — |
| Repeat 1 | Pending | — | — | — | — | — |
| Repeat 2 | Pending | — | — | — | — | — |
| Repeat 3 | Pending | — | — | — | — | — |
| Repeat 4 | Pending | — | — | — | — | — |
| Repeat 5 | Pending | — | — | — | — | — |

## Refinement and file acceptance

For each observed hesitation, describe the visible trigger, attempted action, actual result, and
proposed adjustment. Prioritize mistaken starting points, unintentionally committed traces,
unclear read-only/copy controls, and confusion between browser recovery and disk saving. Repeat the
affected task after changing it; retain the original observations.

For web file handoff, export a disposable diagram and import it in a fresh browser profile; verify
its shapes, flows and text. Desktop Open, Save and Save As dialogs remain separate native
acceptance checks, including cancellation, external writes and actual file bytes.
