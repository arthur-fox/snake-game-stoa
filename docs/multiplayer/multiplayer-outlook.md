# Multiplayer Outlook

## Context

After `input-responsiveness-v1`, the Snake game should have cleaner input
buffering and a clearer separation between simulation and rendering.

That work improves the single-player foundation, but it does not make the game
multiplayer-ready on its own.

## Current Position

The game is currently a single-player, fixed-tick implementation.

Important observations:

- A fixed tick is not inherently a problem for multiplayer.
- The main missing pieces are deterministic simulation boundaries, state
  ownership, input synchronization, and reconciliation.
- The current code is still organized around a local browser game loop rather
  than a networked simulation model.

## What Should Carry Over From Input Responsiveness

The current optimization work should help future multiplayer work in these ways:

- Buffered input is easier to reason about than a single overwriteable input
  slot.
- Clear separation between input, update, and render logic is a prerequisite for
  network-aware architecture.
- A fixed-tick simulation can later become the basis for deterministic or
  server-authoritative updates.

## What Should Not Be Done Yet

To keep `input-responsiveness-v1` focused, the following should be deferred:

- No networking layer.
- No rollback or client-side prediction.
- No state sync protocol.
- No multiplayer-specific file or module architecture overhaul.

## Recommended Next Phase After Input Responsiveness

Once the current work is complete, the next multiplayer-oriented step should be
an architectural preparation phase.

Suggested goals for that phase:

1. Define a clearer simulation state model.
2. Isolate pure game-state update logic from DOM and canvas concerns.
3. Define how player inputs are represented and timestamped by tick.
4. Decide between an authoritative server model and a simpler peer-assisted
   model.
5. Define how remote state sync, correction, and latency handling should work.

## File Structure Guidance

For now, it is reasonable to keep the project in one file.

If multiplayer work begins later, that is the point where a structural split
will likely become worth it. The first candidates to separate would be:

- simulation logic
- input handling
- rendering
- networking and sync

## Conclusion

Multiplayer should be considered during the current work only as a constraint:

- keep the fixed tick
- keep update logic deterministic where possible
- keep input handling orderly and explicit

The actual multiplayer refactor can and should happen after
`input-responsiveness-v1` is finished.
