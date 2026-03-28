# Input Responsiveness V1 Implementation Plan

## Scope

This plan translates the findings from
`input-responsiveness-analysis.md` into concrete implementation steps.

Constraints for this iteration:

- Keep the game on a fixed tick.
- Do not introduce free, frame-based movement.
- Keep the project in a single file for now.
- Improve input buffering and separate update/render responsibilities more
  clearly inside the existing file.

## Goals

- Reduce perceived input lag without changing the core game speed model.
- Preserve fast valid input sequences more reliably.
- Remove unnecessary rendering duplication.
- Prepare the code structure for later refactoring without turning this
  iteration into a large architecture rewrite.

## Non-Goals

- No multiplayer implementation.
- No delta-time movement model.
- No split into multiple source files in this iteration.
- No broad visual redesign or rendering optimization pass unless required by
  the rendering cleanup work.

## Implementation Steps

### 1. Stabilize the current structure inside `index.html`

Keep the single-file setup, but make the responsibilities easier to reason
about.

Actions:

- Group the game code into clearer sections inside `index.html`.
- Make the distinction between input handling, simulation updates, and
  rendering explicit.
- Avoid changing game behavior in this step.

Acceptance criteria:

- The relevant game logic can be read as three separate concerns:
  input, update, render.

### 2. Replace single buffered input with a small FIFO queue

The current `nextDir` model should be replaced by a queue of pending direction
changes.

Actions:

- Introduce an input queue for directional commands.
- Keep the queue small and bounded.
- Only enqueue valid direction changes.

Acceptance criteria:

- Rapid direction sequences are preserved in order instead of overwriting one
  another.
- The queue cannot grow without limit.

### 3. Validate against the effective future direction

Validation must consider the most recent queued direction, not only the current
active direction.

Actions:

- Derive the comparison direction from the queue tail when the queue is not
  empty.
- Fall back to the current movement direction when the queue is empty.
- Reject immediate reverse moves against that effective direction.

Acceptance criteria:

- Inputs like `Up -> Left` are accepted when valid.
- Reverse inputs are still blocked consistently.

### 4. Consume input deterministically during the fixed tick

The simulation should continue to run on the existing fixed tick, but it should
use the queued inputs in a predictable way.

Actions:

- Consume at most one queued direction per tick.
- Apply the consumed direction before movement for that tick.
- Leave remaining buffered inputs in the queue for later ticks.

Acceptance criteria:

- Movement stays tick-based.
- Input handling becomes more reliable without changing the game's movement
  model.

### 5. Remove duplicate rendering triggers

The game should have one clear rendering path.

Preferred direction for this iteration:

- Keep simulation and rendering logically separate.
- Remove redundant `draw()` calls from simulation code.
- Retain a single render trigger only if it has a clear responsibility.

Implementation note:

- Because movement remains fixed-tick and grid-based, rendering does not need to
  drive gameplay timing.
- If `requestAnimationFrame` remains, it should render state only and not own
  simulation timing.

Acceptance criteria:

- Rendering is no longer triggered redundantly from multiple places.
- The game still displays correct state transitions.

### 6. Verify gameplay behavior manually

This iteration is small enough for targeted manual verification.

Test scenarios:

- Single quick turn near a wall.
- Fast two-step turn sequences such as `Up -> Left`.
- Repeated rapid key presses during one tick window.
- Reverse-direction attempts that should still be rejected.
- Restart flow and score updates after the input changes.

Acceptance criteria:

- The game feels more responsive.
- No obvious regressions in movement, collisions, restart behavior, or drawing.

## Suggested Delivery Order

1. Clarify structure in `index.html`.
2. Add the bounded input queue.
3. Fix direction validation.
4. Consume one queued input per tick.
5. Remove duplicate rendering triggers.
6. Manually test and adjust.

## Expected Result

At the end of this iteration, the game should still be a fixed-tick,
single-file implementation, but with more reliable input handling and a clearer
separation between simulation and rendering responsibilities.

This should materially improve perceived responsiveness while keeping the code
compatible with later structural work.
