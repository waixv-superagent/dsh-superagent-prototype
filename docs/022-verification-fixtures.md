# 022 Verification fixtures

Verification is an experiment, not a replay of the happy path. When the behavior under test depends on geometry, timing or state that the existing scene does not provide, the worker builds a **temporary fixture**: a small, named, disposable scene object plus a fixed input and a measurement. This document records the practice and the checklist it adds to a verification package.

The practice comes from a jump verification: the worker spawned a low ceiling over the character's spawn point in PIE, measured the jump's vertical position over time, and used that fixture to test a head-bump case the standard test level did not contain. The attempt is worth codifying because it turned a condition into something controllable, measurable and repeatable — and because it also showed the failure mode of a fixture that looks right but changes nothing, which is why this document asks for the fixture to be validated before its result is trusted. The clearest improvement came afterwards: a single flat box tests one height; a **sloped** ceiling sweeps many heights in one run.

## Why a fixture

- Reading code shows intent, not behavior. A boundary that never occurs in the level is a boundary the verification never exercises.
- Choosing what condition is missing, and building it, is verification work rather than scope expansion: the ticket decides what to change, and the verification decides how to prove it. Waiting to be told which fixture to build hides exactly the case that was never in the level.
- Existing levels are built for play, not for edges. Waiting for the edge to happen by chance costs runs and hides the exact condition that failed.
- A fixture turns an environment variable into an independent variable: same spawn, same input, one thing changed. That is what makes two runs comparable.
- A slope or a parameterized spawn turns one fixture into a sweep: low, middle and high ceilings in a single jump, instead of three separate setups.

## Model

A fixture has four parts, all written down:

| Part | What to record |
| --- | --- |
| Scene | Map or level, the fixture actor's label, mesh, scale, position, rotation and collision profile, and which worlds it was spawned in (for example both the PIE server and client worlds when client prediction and server authority can disagree) |
| Input | The real input path used (the same key or automation entry point a player uses), its timing and count; a fixture driven by a fake animation proves nothing about input handling |
| Measure | The quantity that decides pass or fail: trajectory samples, velocity, animation state, collision, log line, frame timing; sampled densely enough to see the boundary, not just the end state |
| Reset | How the fixture is cleared: a tag or label prefix to destroy it, and a check that the level was not saved with it |

Rules of thumb:

- **Minimal.** One fixture, one independent variable, no unrelated props.
- **Named and tagged.** Prefix the actor label and tags with `VERIFY_` so cleanup is mechanical and a later run can find or replace it.
- **Placed from a reference.** Position it relative to a known point (spawn, floor, platform), in world units, not by eyeballing the viewport, so the written spec reproduces it.
- **Parameterized.** Put the variable in a small script (height, angle, offset, delay) instead of editing actors by hand; keep the script beside the verification plan.
- **Disposable.** Destroy the fixture after the run and never save it into the level; a fixture that leaks into the map becomes an unrelated behavior change.
- **Validated.** Read the actor back in each world it was spawned in (label, transform, collision) and confirm the measurement responds to it. If the fixture is a ceiling and the measured apex equals the no-ceiling baseline, the fixture is not blocking — fix it before judging the behavior; a fixture that changes nothing is a failed experiment, not a passing result.

## When to build one

Build a fixture when the boundary is missing from the scene and the behavior depends on:

| Dimension | Examples |
| --- | --- |
| Geometry | Ceiling height, slope, step height, gap width, overhang, wall angle |
| Timing | Jump window, cooldown, cancel point, network delay, animation blend time |
| State | Overlap, buff stack, stamina, phase transition, empty or invalid input |
| Environment | Moving platform, wind, uneven ground, camera angle, viewport and theme |

Use the existing scene when it already produces the boundary deterministically. A fixture is for the case the scene cannot produce, not a replacement for using the real level.

## Case: a jump against a ceiling

The case that started this document, written as a reusable recipe:

1. **Baseline.** Record the jump with no ceiling: the pawn origin's peak and its rise from standing, time to peak, time to land, animation states. In the original case the origin peaked at about 316 cm above the floor, a rise of about 226 cm.
2. **Flat slab.** Spawn a cube scaled to an 8 m × 8 m × 0.2 m slab over the spawn, with its underside at a chosen height above the floor (for example 235 cm), collision set to block all. Read the actor back in each PIE world to confirm it exists with that transform and blocking collision, then run the same jump. Expect the pawn origin to stop about a capsule half-height below the underside and to begin falling immediately, switching to the fall and land states without penetrating the slab or sticking to it. If the measured apex equals the no-ceiling baseline, the slab is not blocking: fix the fixture before judging the behavior.
3. **Slope.** Rotate the same slab by about 10–20° so its underside crosses the jump path from below the peak to above it: for a 316 cm peak, a slab sweeping roughly 120 cm to 350 cm over 6–8 m covers low, middle and high contact in one run. Verify at each crossing: vertical velocity is zeroed or clamped, the fall starts immediately, the animation transitions are correct, and the server and predicted client agree.
4. **Pin the interesting heights.** When the slope finds a height that misbehaves, add a flat slab at that exact height for a deterministic assertion, and keep the slope as the coverage sweep.
5. **Record and clean up.** Put the slab spec, the sample data and the pass/fail per height into the verification package, then destroy the fixture.

A slope is the general trick, not a ceiling-only trick: a ramp with several step heights, a moving platform crossing a jump window and a sequence of gap widths are the same idea.

## Evidence

The fixture spec belongs in the verification package, not only in the session:

- **版本与前置**: build or changelist under test, map, fixture label and transform, collision, PIE worlds.
- **复现步骤**: how to place the fixture, the input and timing, where the samples are recorded.
- **预期与证据**: the trajectory or state samples, the screenshots or video at contact, and the result per height or parameter point. Automated capture proves that contact and state changed; it does not judge whether the animation looks right.
- **待你判断**: the visual and feel judgment, and any point the fixture did not cover, named honestly.

Without the fixture spec the evidence is not reproducible; without the evidence the fixture is only an anecdote.

## Checklist

- [ ] The reported case was reproduced before the fix or before the fixture was trusted.
- [ ] A fixture exists because the scene cannot produce the boundary, and its spec is written down (level, label, mesh, scale, position, angle, collision, worlds).
- [ ] The fixture was validated: it exists with the expected transform and collision in every world that matters, and the measurement responds to it (the baseline and the fixture runs differ where they should).
- [ ] The parameter sweep covers the ends and the middle, not one sample; heights use a slope or several flat slabs.
- [ ] The modes that can disagree (server and predicted client, different viewports or themes) were exercised.
- [ ] Evidence records the measurement, not only a final screenshot: samples, animation state, log lines, and captures at the contact point.
- [ ] The fixture was destroyed and the level was not saved dirty.
- [ ] The verification package names the fixture, what each point proved, and what was not run.

## Anti-patterns

- Trusting a fixture because it is visible in the viewport, without reading it back and confirming the measurement responds.
- Verifying only what the current level happens to contain and calling the boundary covered.
- Testing one height and calling it "ceiling behavior".
- Spawning a fixture in one world when the server and the predicted client both matter.
- Editing the level by hand, leaving the actors in it, or saving the map.
- Keeping the fixture parameters only in the session transcript, so nobody can re-run the evidence.
- Reporting an automated trajectory or a screenshot as a judgment of animation quality.

## Scope

This document is the general model and checklist. Project-specific recipes — the actual spawn script, the input entry point, the map and the build command — belong in the project's verification playbook next to its automation and manual checks; the worker prompt asks for the fixture and for the boundary sweep, and this document says what makes that evidence trustworthy.
