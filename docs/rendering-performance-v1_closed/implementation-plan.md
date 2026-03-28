# Rendering Performance V1 Implementation Plan

## Scope

This plan translates the prioritized findings from
[`rendering-performance-analysis.md`](/home/dev_hub/projects/snake-game-stoa/docs/rendering-performance-v1_closed/rendering-performance-analysis.md)
into concrete implementation steps.

Constraints for this iteration:

- Keep the fixed-tick gameplay model.
- Keep the project in a single file for now.
- Preserve current gameplay behavior and visual identity as much as practical.
- Prefer low-risk optimizations before more invasive render-architecture
  changes.

## Goals

- Reduce unnecessary per-frame canvas work.
- Improve rendering efficiency without changing game feel.
- Keep the implementation understandable inside the current `index.html`.
- Prioritize optimizations with clear benefit and low complexity.

## Non-Goals

- No movement-model changes.
- No multiplayer-related rendering changes.
- No multi-file rendering architecture refactor.
- No visual redesign.

## Status

`rendering-performance-v1` is complete and closed.

Completed in this iteration:

- static grid caching
- lower-frequency animated background recomputation
- clearer separation of cached, animated, and gameplay-driven render layers
- gameplay-layer caching between state changes
- manual gameplay verification

Intentionally left for later:

- visual-effect simplification such as shadows, glow, or shape adjustments,
  because the manual test was clean and there is no current need to trade away
  visuals for additional optimization

## Implementation Steps

### 1. Cache the static grid

The grid is the clearest low-risk optimization target.

Actions:

- Pre-render the grid once into a reusable canvas or image buffer.
- Replace per-frame grid line drawing with a single cached draw operation.
- Rebuild the cache only if canvas dimensions or grid settings change.

Acceptance criteria:

- The visible grid remains unchanged.
- The main render path no longer redraws all grid lines every frame.

### 2. Reduce animated background update frequency

The background should remain animated, but it does not necessarily need full
per-frame recomputation.

Actions:

- Introduce a lower update cadence for the gradient background.
- Reuse the last computed background between refreshes.
- Keep the transition visually smooth enough for the current style.

Acceptance criteria:

- The background still appears animated.
- `createRadialGradient` work is no longer performed on every rendered frame.

### 3. Separate cached, animated, and gameplay-driven render work

The render path should explicitly reflect which content changes at which rate.

Actions:

- Distinguish static cached content, semi-static animated background content,
  and tick-driven gameplay object content.
- Keep the final render flow easy to read inside `index.html`.

Acceptance criteria:

- The rendering code makes it clear which layers are cached, animated, or
  driven by gameplay state.

### 4. Reassess gameplay-object redraw frequency

Gameplay objects currently redraw continuously even though state changes on the
fixed tick.

Actions:

- Evaluate whether snake and food should continue rendering every animation
  frame.
- Prefer the simplest approach that preserves the current look and avoids
  overengineering.

Decision guidance:

- If continuous redraw remains simplest and cheap enough after earlier
  optimizations, keep it.
- If it is still a meaningful cost center, redraw gameplay objects only when
  state changes or when another visual layer requires it.

Acceptance criteria:

- Any change here must preserve visible correctness and game feel.

### 5. Touch visual effects only if needed

Shadows and rounded shapes should be treated as a fallback optimization area,
not the first target.

Actions:

- Only simplify glow, shadow, or shape styling if earlier optimizations are not
  sufficient.
- Prefer very small visual compromises over broad aesthetic regression.

Acceptance criteria:

- Visual simplification is only applied if justified by clear performance need.

### 6. Verify gameplay and rendering behavior manually

Test scenarios:

- Regular gameplay during movement and turning.
- Food collection and score updates.
- Game-over overlay and restart flow.
- General visual smoothness of the background and board.

Acceptance criteria:

- No gameplay regressions.
- No obvious visual artifacts from caching or lower-frequency background
  updates.
- Rendering still feels coherent with the current style.

## Suggested Delivery Order

1. Cache the grid.
2. Lower background recomputation frequency.
3. Clarify layer responsibilities in the render path.
4. Reassess gameplay-object redraw cadence.
5. Only then consider visual-effect simplifications.
6. Manually test and adjust.

## Expected Result

At the end of this iteration, the game should keep the same fixed-tick gameplay
and broadly the same appearance, but with less unnecessary rendering work in
the main loop.

The ideal result is a measurable reduction in repeated canvas work achieved
through simple caching and cadence control rather than through a large
architectural rewrite.
