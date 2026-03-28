# Rendering Performance V1

## Purpose

This document captures the next analysis step after
`input-responsiveness-v1`.

The goal is to identify rendering-related optimization opportunities in the
current single-file implementation without changing the game's fixed-tick
movement model.

## Context

`input-responsiveness-v1` is complete.

That iteration focused on:

- input buffering
- deterministic input consumption
- clearer separation between simulation and rendering

One secondary point was intentionally left open:

- expensive per-frame rendering work

## Current Rendering Model

The game currently uses:

- a fixed simulation tick for movement and gameplay updates
- a `requestAnimationFrame` loop for rendering
- full redraws of the scene on each rendered frame

This is structurally cleaner than the earlier version, but it may still do more
rendering work than necessary.

## Candidate Optimization Areas

### 1. Animated gradient background

The background is rebuilt every rendered frame using a radial gradient with
time-dependent colors.

Questions:

- How expensive is the gradient creation relative to the rest of the frame?
- Does the visual effect justify a full recomputation every frame?
- Could the effect be updated less frequently without a noticeable quality loss?

### 2. Full grid redraw

The entire playfield grid is redrawn every rendered frame.

Questions:

- Is the grid visually static enough to pre-render once and reuse?
- Would an offscreen canvas or cached bitmap reduce repeated draw-call cost?

### 3. Full game-object redraw

Snake and food are redrawn every rendered frame even though gameplay state only
changes on the fixed tick.

Questions:

- Is rendering every animation frame necessary for the current visual style?
- Could rendering happen only when state changes, or at a lower cadence?
- Would this still preserve the animated background effect if kept?

### 4. Render loop frequency versus game-state change frequency

The game state changes on the tick, while rendering runs continuously.

Questions:

- How much visual value is gained from rendering between ticks?
- Would a hybrid approach make sense, such as:
  state-driven rendering for gameplay objects plus optional background animation?

### 5. Draw-call volume and canvas effects

The current rendering path includes many draw calls and visual effects such as
shadows and rounded shapes.

Questions:

- Which canvas operations are the most expensive?
- Are glow and shadow effects materially affecting frame cost?
- Are there low-risk simplifications that preserve the look closely enough?

## Constraints

For this next phase, the following should remain unchanged unless there is a
strong reason to revisit them:

- fixed-tick gameplay model
- single-file project structure for now
- current gameplay behavior

## Recommended Analysis Approach

1. Inspect the current render path in `index.html`.
2. Identify which parts are static, semi-static, and fully dynamic.
3. Rank candidate optimizations by likely impact and implementation cost.
4. Prefer simple changes with clear benefit over broad refactors.
5. Only after that decide whether a dedicated `rendering-performance-v1`
   implementation pass is warranted.

## Expected Output of This Analysis

This document should eventually lead to:

- a short list of concrete rendering optimizations
- a recommendation on whether to implement them now
- a clear statement of which optimizations are worth the added complexity

## Initial Hypothesis

The most promising first candidates are likely:

- caching or pre-rendering the static grid
- reducing unnecessary full-frame work for mostly static content
- evaluating whether the animated background should run at full frame rate

The likely lower-priority work is:

- deep visual simplification of snake and food rendering
- broader architectural refactors before evidence justifies them

## Prioritized Recommendations

Based on the current render path in
[`index.html`](/home/dev_hub/projects/snake-game-stoa/index.html), the current
priorities are:

### Priority 1: Cache or pre-render the static grid

Reasoning:

- The grid is fully static.
- It is currently redrawn line-by-line on every rendered frame.
- This has low implementation complexity and clear likely benefit.

Assessment:

- Expected impact: high
- Implementation cost: low
- Risk: low

### Priority 2: Reduce background recomputation frequency

Reasoning:

- The background gradient is recalculated every frame with
  `createRadialGradient`.
- The effect is visually smooth, but it likely does not need full-frame-rate
  recomputation to preserve its look.
- A lower update cadence or cached intermediate background state may reduce
  cost without changing gameplay.

Assessment:

- Expected impact: medium to high
- Implementation cost: low to medium
- Risk: low to medium

### Priority 3: Separate static, semi-static, and tick-driven drawing

Reasoning:

- Gameplay objects change only on the fixed tick.
- Background animation and gameplay object rendering currently share one render
  path.
- Further gains may come from treating static, animated, and gameplay-driven
  layers differently.

Assessment:

- Expected impact: medium
- Implementation cost: medium
- Risk: medium

### Priority 4: Simplify visual effects only if needed

Reasoning:

- Shadows, rounded rectangles, and glow effects add draw cost.
- However, these effects are part of the current visual style.
- They should not be the first target unless simpler optimizations prove
  insufficient.

Assessment:

- Expected impact: low to medium
- Implementation cost: low
- Risk: medium, because visual regressions are more likely

## Recommended Implementation Order

The best order for a follow-up implementation pass is:

1. Cache the grid.
2. Reduce the frequency of animated background recomputation.
3. Reassess whether gameplay objects need full render-loop redraws.
4. Touch visual simplifications only if the earlier steps are not enough.

## Conclusion

`rendering-performance-v1` appears worth pursuing, but it should stay narrow.

The most pragmatic next pass is not a broad rendering rewrite. It is a focused
optimization pass that starts with static grid caching and background update
reduction, because those changes offer the best likely return for the least
added complexity.
