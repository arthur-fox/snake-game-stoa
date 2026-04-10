# Changelog

## Solo Enhancement Fork

All changes are isolated to solo mode. Multiplayer is untouched.

### Arena / Level System
- Levels rotate every 100 score: Square → Circle → Triangle → random
- Each shape has its own interior color, border, grid tint, and snake palette
- Level always resets to Square on new game
- 2-second invincibility grace period on every level transition (no visual change)
- Power-ups and food outside the new arena are removed/respawned on transition

### Triangle Levels
- Blue walls are always permeable — only self-collision can kill
- Wrapping is direction-driven (not geometric) to handle the top vertex correctly:
  - UP → top vertex → bottom centre
  - DOWN → bottom side → just inside top vertex
  - LEFT/RIGHT → opposite side at same row
- Self-collision check skipped on the tick a wrap occurs (body shifts next tick)

### Power-Ups
- **Weighted random + hunger system**: tracks which types haven't spawned recently; equal frequency over time
- All power-ups expire after **7 seconds** if uneaten (unified via `spawnedAt` timestamp)
- All power-ups award **+5 points** on pickup
- **Invincible Apple**: 10s no-death, rainbow glow
- **Poisoned Apple** (formerly Rotten Apple): instant game over; spawns in groups (3 + 1 per 100 score)
- **Blue Apple**: 15s wall-wrap; square border and circle border both turn blue while active

### Quality of Life
- "Play as Guest" bypasses Supabase auth for offline/local testing
- Static background (no blinking)
- Power-up legend panel (left side) with live descriptions
- Score display and level indicator above the canvas
- `roundRect` polyfill for older browsers
