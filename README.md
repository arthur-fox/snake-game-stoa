# Snake Game — Stoa Fork

A browser-based Snake game built with HTML5 Canvas. Single-player and multiplayer (via Supabase Realtime). No build step — open `index.html` directly or serve from any static host.

## Features

### Solo Mode
- **3 arena shapes** that rotate every 100 score points:
  - **Level 1** — Square grid (classic)
  - **Level 2** — Circle with gold interior, black snake
  - **Level 3** — Triangle with dark purple interior, white snake; levels 4+ pick randomly
- **2-second grace period** after every level change — snake cannot die while the arena transitions
- **Leaderboard** via Supabase (sign-in required); guest play available offline

### Power-Ups
All power-ups spawn every 10–20 seconds with a hunger system (equal long-term frequency) and expire after **7 seconds** if uneaten. Each awards **+5 points** on pickup.

| Power-Up | Effect |
|---|---|
| **Invincible Apple** (rainbow) | Snake glows; walls and self-collision ignored for 10s |
| **Poisoned Apple** (dark green ☠) | Instant game over — avoid at all costs |
| **Blue Apple** (blue) | Snake wraps through any wall for 15s; circle border turns blue |

### Triangle Level Mechanics
Triangle walls always wrap (no death on wall contact):
- **Up** through top vertex → emerges at bottom centre
- **Down** through bottom → emerges just inside top vertex
- **Left** through left side → emerges on right side at the same row
- **Right** through right side → emerges on left side at the same row

Only self-collision can kill the snake in triangle levels.

### Multiplayer
Create or join a room with a 6-character code. Requires Supabase auth. Power-ups are solo-only.

## Running Locally

```bash
# No install needed — just open the file
open index.html
# or serve with any static server:
npx serve .
```

To use auth and leaderboard, set your own Supabase project credentials in `index.html`:
```js
const SUPABASE_URL = 'your-project-url';
const SUPABASE_KEY = 'your-anon-key';
```

Guest mode works without any credentials.

## Tech Stack
- Vanilla JS + HTML5 Canvas (layered offscreen canvases for performance)
- Supabase for auth, leaderboard, and multiplayer realtime channels
- Zero dependencies, zero build tooling
