# Child Agents Plan: Deviations

Plan: `2026-09-29-work-child-agents.md`. Tasks 1–15 were implemented in one session.

## Changes to the plan's code

None. Every code block was applied verbatim. Where the plan says "add X after/before Y", a blank line separates the new top-level declarations from their neighbours; no code changed.

## Process

| Task | Change | Why |
| --- | --- | --- |
| 2, 4, 7, 11 (part gates) | The intermediate `npm test` and `npm run -s check` runs were skipped; only each task's named test files and `typecheck` ran. The full gates ran once at the end. | Instruction for this run: run only the named tests until the final gates, and do not stop at the part review points. |
| 11, Step 2 | The expected-failure run of the appended supervisor tests hung instead of failing. The tests throw at `supervisor.steer` after spawning fake children in `hang` mode, and nothing shuts those children down, so `node --test` never exits. Later test commands were run under `timeout`. | This happens only before the implementation exists; with Step 3 applied the file passes in about 10 seconds. A future plan should say that this step needs a timeout. |
| Final gates | One `npm test` run failed `tests/messaging/autostart.test.mjs` ("concurrent starter processes elect one broker authority") with `EEXIST` on `mkdir`. It passed 5 of 5 isolated reruns and the next full run (603/603). | A pre-existing race in the messaging tests, which this branch does not touch. |
