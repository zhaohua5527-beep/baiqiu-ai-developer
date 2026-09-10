# Full Test Bug Record - 2026-08-26

## Run

- Command: Node 24 native test runner over 123 `*.test.js` files
- Result: 729 tests, 669 passed, 60 failed, 0 skipped, 0 cancelled
- CircleCI: unavailable in the current Codex tool environment
- Production messages: none sent

## Failures

### Browser and shell

- `black-ball-browser-shell.test.js`: stable task-board header control; browser initialization and bounds
- `knowledge-universe-3d.test.js`: local WebGL renderer and DOM fallback contract
- `sidebar-control-hierarchy.test.js`: project creation and semantic status signals
- `wechat-gateway-contract.test.js`: locked WeChat conversation ordering

### Public progress and delivery

- `black-ball-live-surface.test.js`: internal narration buffering; terminal activity cleanup
- `black-ball-stream-contract.test.js`: stale snapshot merge; HMS progress and answer forwarding
- `live-blackball-progress-contract.test.js`: per-segment process cleanup; completed activity cleanup
- `message-order-and-public-progress.test.js`: stream identity; reasoning/reply sequencing
- `task-visibility-regressions.test.js`: independent execution/structured surfaces; model reasoning timeout path
- `request-run-contract.test.js`: durable evidence after presentation protocol failure
- `request-lifecycle-regressions.test.js`: duplicate start protection, durable/live reconciliation, protocol recovery, bounded activity
- `reported-rc64-regressions.test.js`: failed product result persistence
- `progressive-typing-render.test.js`: 15 renderer lifecycle, scrolling, activity, typing, and reconciliation assertions
- `hms-progress.test.js`: thought/message answer demux
- `hms-project-architecture.test.js`: public Black Ball naming
- `project-three-modes-fixes.test.js`: verified CEO file delivery
- `public-boundary-and-model-capability.test.js`: public runtime naming
- `renderer-display-regressions.test.js`: completed answer activity cleanup

### State, persistence, and lifecycle

- `conscious-center-responsibility.test.js`: legacy snapshot migration
- `context-cycle.test.js`: checkpoint consistency between renderer meters and provider history
- `first-use-guide.test.js`: automatic first-use opening gate
- `message-knowledge-capture.test.js`: transient cleanup on session change
- `preset-interrupt-controller.test.js`: overlapping task controller ownership
- `session-scroll-restoration.test.js`: scroll anchor persistence and first-entry restoration
- `instruction-anchor-layout-regressions.test.js`: instruction anchoring and layout convergence
- `hms-knowledge-boundary.test.js`: on-demand knowledge retrieval and source references
- `hms-tool-protocol.test.js`: evidence-based completion and concise nested-file delivery
- `self-healing.test.js`: protocol failure incident handling

## Triage

The current React runtime error is a product bug: the assistant-ui bridge returns a newly allocated snapshot object on every `getSnapshot()` call. React `useSyncExternalStore` requires a cached snapshot and reaches error #185. This is the first fix target.

## Fix Applied

- Cached unchanged bridge snapshots in `renderer-v2/app.js`.
- Added `test/assistant-ui-bridge.test.js` to protect the React external-store contract.
- Targeted regression passed: 1/1.

## Regression

- Result after fix: 730 tests, 670 passed, 60 failed, 0 skipped, 0 cancelled.
- The 60 baseline failures are unchanged; the added regression test passes.

The remaining failures are retained rather than hidden. They require separate triage because the suite mixes implementation defects with stale/static assertions and test-harness defects. There is also a direct contradiction: `black-ball-live-surface.test.js` requires `collapseCompletedExecutionActivity()` to call `root.remove()`, while `structured-stream-window-regressions.test.js` requires the same function not to call `root.remove()`. Both cannot be satisfied by a single product implementation without changing the test contract.

## Stop, Stall, and Public Reasoning Follow-up

- Scope: exact run cancellation, stale-run ownership, public reasoning separation, and stalled-run termination.
- CircleCI: no project config, CLI, token, or remote plugin runner was available; the equivalent local Node suite was used.
- Production messages: none sent.
- Deployment/restart: not performed.

### Bugs Fixed

- The send button could reach form submission instead of aborting when input text was present.
- Cleanup was session-scoped instead of `sessionId + runId` scoped, allowing an old request to clear a replacement owner.
- Raw provider `reasoningContent` was exposed without an explicit public marker.
- Public reasoning shared structured/execution history instead of using its own transient typewriter lane.
- Renderer timeout fields existed without active timers or timeout handlers, allowing a silent run to remain stuck.
- Legacy static tests still required removed activity surfaces and non-typewriter answers.

### Verification

- Syntax: `main.js` and `renderer-v2/app.js` passed `node --check`.
- Focused regressions: 40 tests passed, 0 failed.
- Current-source suite: 736 tests, 685 passed, 51 failed, 0 skipped, 0 cancelled.
- Previous comparable baseline: 735 tests, 673 passed, 62 failed.
- Delta: one new passing regression, 12 more passes, 11 fewer failures.

The remaining 51 failures are retained for separate work. The dominant groups are pre-existing interface rollback assertions, removed assistant-ui bridge expectations, and incomplete source-evaluation harnesses. None of the remaining failures is in the focused stop, run-ownership, public-reasoning, structured-window, or stream-sequencing set.

## Interaction and Event-order Follow-up

- Stop now aborts the exact `sessionId + runId` owner before the form can submit queued text.
- Cancellation waits for the product result commit and persists a fallback cancellation result before returning the terminal snapshot.
- Explicitly public Black Ball reasoning uses an independent typewriter lane. It can finish typing while answer text starts, then fades and removes itself.
- Unmarked provider reasoning remains private and is never forwarded to the renderer.
- Structured output contains only real structured events, is ordered by the producer sequence, and keeps the newest three visible entries.
- Producer `sequence` values are retained per target; White Ball allocates fallback sequence values only for legacy events that omit one.
- Terminal transport frames keep the answer owner alive until the durable result is bound and visible output drains.

### Verification After Follow-up

- Syntax checks: passed for `main.js`, `renderer-v2/app.js`, and the Electron DOM probe.
- Focused stop/reasoning/structured/persistence regressions: 48 passed, 0 failed.
- Electron DOM behavior probe: 5 passed, 0 failed.
- Current-source suite: 737 tests, 691 passed, 46 failed, 0 skipped, 0 cancelled.
- Previous comparable result: 736 tests, 685 passed, 51 failed.
- CircleCI: unavailable; no CircleCI plugin tool, project configuration, CLI, or token is exposed in this environment.
- Production messages: none sent.
- Deployment/restart: not performed.

## Real Electron Conversation Verification

The final verification launches the real Electron application through CDP with
`BAIQIU_E2E_TEST=1` and a temporary user-data directory. The production profile,
API keys, history, desktop shortcuts, version, and archives are not read or
modified by this test mode.

### Runtime Bugs Found and Fixed

- A session refresh could detach the live answer row while reasoning continued
  to update only the in-memory entry. `restoreLiveChatStream()` now restores the
  row and its transient reasoning segments before further stream paint.
- `flushLiveChatStream()` invoked `finalizeWhenDrained()` only while the entry
  was not finalizing. Final answers are finalizing while their visible typewriter
  drains, so the inverted condition could strand a fully typed response forever.
  The drain callback now runs whenever no visible output remains.
- The E2E-only product submission branch changed the source shape around
  `submitProductWithTaskBrain(payload)`. The lifecycle regression now locates
  the actual call instead of requiring the previous assignment syntax.

### Final Results

- Syntax checks: passed for `main.js` and `renderer-v2/app.js`.
- Focused stream, stop, reasoning, structured-event, persistence, and Electron
  regressions: 47 passed, 0 failed.
- Real Electron conversation: 1 passed, 0 failed. It verifies composer submit,
  public reasoning in the DOM, the newest three producer-ordered structured
  events, Markdown answer streaming, durable persistence, same-button abort,
  cancelled-result persistence, and reload restoration.
- Full local suite: 124 test files, 734 tests, 688 passed, 46 failed, 0 skipped,
  0 cancelled.
- The remaining 46 failures are the existing stale UI/static assertions,
  incomplete VM harnesses, and contradictory legacy protocol expectations.
  None is a failure in the 47 focused regressions above, and the count did not
  increase after the final lifecycle-test adjustment.
- The first direct `node` invocation failed because Node is not on the shell
  `PATH`; all recorded tests used Codex's bundled Node 24 executable.
- CircleCI remains unavailable: no CircleCI tool is exposed, MCP resources and
  templates are empty, the repository has no `.circleci/config.yml`, and no CLI
  or token is available. No cloud CI result is claimed.
- Deployment/restart: not performed.

## Final Stream Lifecycle Follow-up

### Bugs Fixed

- Hermes protocol failure no longer automatically replays the same user request.
  The failure is recorded and returned without starting a second generation.
- A `missing_public_final_envelope` result with real durable execution evidence is
  now classified as succeeded/degraded/recovered. Quota, cancellation, timeout,
  and evidence-free failures remain failed.
- A second public reasoning segment could remain queued forever after the first
  answer had already become fully visible. The renderer now also checks the
  persisted segment end and the revealed answer length before queuing reasoning.
- Session refresh can rebuild the live segment DOM without losing the visible
  answer boundary used to release the next public reasoning segment.

### Verified Interaction

- Stop calls the exact active `sessionId + runId` abort owner before form submit.
- Explicitly public reasoning is transient typewriter text; unmarked provider
  thought stays private and is never rendered.
- Two complete `reasoning -> answer` cycles render in one turn while both answer
  segments remain permanent.
- Four producer-authored structured events remain ordered by producer sequence,
  with only the newest three visible.
- Markdown headings, tables, inline code, fenced code, persistence, cancellation,
  and reload restoration survive the real Electron flow.

### Final Verification

- Syntax checks: passed for `main.js`, `renderer-v2/app.js`, and
  `services/request-run-contract.js`.
- Focused stop/reasoning/structured/persistence regressions: 118 passed, 0 failed.
- Updated progressive typing and lifecycle regressions: 34 passed, 0 failed.
- Real isolated Electron conversation: 1 passed, 0 failed when run alone and in
  the serial full suite. A parallel full-suite run caused test-process contention,
  so the authoritative full run used `--test-concurrency=1`.
- Full local suite: 124 files, 734 tests, 714 passed, 20 failed, 0 skipped,
  0 cancelled. The remaining failures are unrelated legacy UI/static contracts
  for task board/browser, knowledge and conscious center, project naming/file
  delivery, instruction/scroll layout, sidebar, and WeChat.
- CircleCI is still unavailable: no plugin tool, MCP resource/template, project
  config, CLI, or `CIRCLECI_TOKEN` is present. No CircleCI result is claimed.
- Production messages: none sent. Deployment/restart: not performed.
