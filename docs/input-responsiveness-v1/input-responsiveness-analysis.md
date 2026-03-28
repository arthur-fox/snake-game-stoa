# Input Responsiveness V1

## Problem Statement

The Snake game currently feels less responsive than expected. The perceived input
lag can be explained by several structural issues in the implementation.

## Findings

### 1. Tick-based input delay (primary cause)

Game updates run on a fixed interval via `setInterval(tick, 130ms)`.
Input is not applied immediately, but only when the next `tick()` executes.

- Worst-case latency is approximately 130 ms.
- This amount of delay is clearly noticeable in a game that depends on quick
  directional changes.

### 2. Single buffered input (`nextDir`)

Only one pending direction is stored. Rapid input sequences overwrite each
other. In addition, reverse-direction validation is performed against the
current direction (`dir`), not the buffered direction.

- Fast sequences such as `Up -> Left` can be partially ignored.
- This creates a "missed input" feeling even when the player's key presses were
  valid.

### 3. No true input queue

There is no FIFO queue for directional inputs.

- The system cannot reliably process fast multi-step direction changes within a
  single tick window.
- Inputs that occur between ticks compete for the same single buffer slot.

### 4. Redundant rendering loop

The game uses both:

- a continuous `requestAnimationFrame` loop
- an additional `draw()` call inside `tick()`

This leads to unnecessary duplicate rendering work.

### 5. Expensive per-frame rendering

Each frame rebuilds:

- a radial gradient background
- a full grid with many draw calls

This increases CPU/GPU load and can indirectly affect perceived responsiveness.

## Conclusion

The "non-responsive" feeling is mainly caused by input being quantized to the
tick interval and by the lack of proper input buffering. Rendering
inefficiencies may amplify the issue but are likely secondary.

## Recommended Direction

The first iteration should focus on the input path before touching visual
rendering:

1. Replace the single pending direction with a small FIFO input queue.
2. Validate new directions against the most recently queued direction, not only
   against the current movement direction.
3. Ensure each game tick consumes at most one queued direction in deterministic
   order.
4. Remove duplicate render triggers so the game has one clear rendering path.
5. Profile rendering cost only after the input model is corrected.

## Expected Outcome

If the above changes are implemented, the game should feel more responsive even
without changing the tick rate, because valid user input will be preserved and
applied consistently instead of being overwritten or dropped.
