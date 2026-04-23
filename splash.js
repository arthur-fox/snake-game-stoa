// ── Auth → Game transition ─────────────────────────────────────────────────────
// Four colored snakes (green, purple, blue, orange) rush from each screen edge,
// collide at center, and a shockwave sweeps the screen before the game loads.

function startAuthTransitionAnimation(onComplete) {
  const c = document.createElement('canvas');
  c.style.cssText = 'position:fixed;inset:0;z-index:10001;pointer-events:none;';
  c.width  = window.innerWidth;
  c.height = window.innerHeight;
  document.body.appendChild(c);
  const ctx = c.getContext('2d');

  const W = c.width, H = c.height;
  const CX = W / 2, CY = H / 2;
  const SEG      = Math.round(Math.min(W, H) / 14);
  const MAX_SEGS = 10;
  const FRAMES   = 70;                               // frames to reach centre
  const AMP      = Math.min(W, H) * 0.05;
  const FREQ     = (2 * Math.PI) / (Math.max(W, H) * 0.65);

  // Heads start at screen edges — visible from frame 1
  const snakes = [
    { sx: 0,  sy: CY, vx:  1, vy:  0, color: '#39ff14' }, // L→R  green
    { sx: W,  sy: CY, vx: -1, vy:  0, color: '#a855f7' }, // R→L  purple
    { sx: CX, sy: 0,  vx:  0, vy:  1, color: '#00b4ff' }, // T→B  blue
    { sx: CX, sy: H,  vx:  0, vy: -1, color: '#ff7700' }, // B→T  orange
  ].map(cfg => {
    const dist = Math.max(Math.abs(CX - cfg.sx), Math.abs(CY - cfg.sy));
    return { ...cfg, hx: cfg.sx, hy: cfg.sy, speed: dist / FRAMES, path: [] };
  });

  let phase  = 'approach';
  let shockR = 0;
  const SHOCK_SPEED = Math.max(W, H) * 0.035;
  const SHOCK_MAX   = Math.hypot(CX, CY) * 1.6;

  function hexRgb(hex) {
    return `${parseInt(hex.slice(1,3),16)},${parseInt(hex.slice(3,5),16)},${parseInt(hex.slice(5,7),16)}`;
  }

  function sampleSegs(path) {
    const out = [path[0]]; let d = 0;
    for (let i = 1; i < path.length && out.length < MAX_SEGS; i++) {
      const a = path[i - 1], b = path[i];
      d += Math.hypot(b.x - a.x, b.y - a.y);
      if (d >= SEG * 1.1) { out.push(b); d = 0; }
    }
    return out;
  }

  function drawSnake(s) {
    if (!s.path.length) return;
    const segs = sampleSegs(s.path);
    const sz   = SEG - 3;
    const rgb  = hexRgb(s.color);
    for (let i = segs.length - 1; i >= 0; i--) {
      const { x, y } = segs[i];
      const isHead   = i === 0;
      const a = +(1 - (i / Math.max(segs.length - 1, 1)) * 0.6).toFixed(2);
      ctx.save();
      ctx.shadowColor = s.color;
      ctx.shadowBlur  = isHead ? 22 : 9;
      ctx.fillStyle   = isHead ? s.color : `rgba(${rgb},${a})`;
      ctx.beginPath();
      ctx.roundRect(x - sz / 2, y - sz / 2, sz, sz, sz * 0.18);
      ctx.fill();
      ctx.restore();
    }
  }

  function tick() {
    ctx.clearRect(0, 0, W, H);

    if (phase === 'approach') {
      snakes.forEach(s => {
        s.hx += s.vx * s.speed;
        s.hy += s.vy * s.speed;
        const wave = Math.sin((s.vx !== 0 ? s.hx : s.hy) * FREQ) * AMP;
        s.path.unshift(s.vx !== 0
          ? { x: s.hx, y: CY + wave }
          : { x: CX + wave, y: s.hy });
      });
      snakes.forEach(drawSnake);
      if (snakes.every(s => Math.hypot(s.hx - CX, s.hy - CY) < SEG * 2)) phase = 'collide';

    } else if (phase === 'collide') {
      snakes.forEach(drawSnake);
      shockR += SHOCK_SPEED;

      // Dark fill expanding behind the shockwave
      const darkR = Math.max(0, shockR - SEG * 2);
      if (darkR > 0) {
        ctx.fillStyle = '#0d1117';
        ctx.beginPath();
        ctx.arc(CX, CY, darkR, 0, Math.PI * 2);
        ctx.fill();
      }

      // Bright shockwave ring
      const innerR = Math.max(0, shockR - SEG * 2.5);
      const grad   = ctx.createRadialGradient(CX, CY, innerR, CX, CY, shockR);
      grad.addColorStop(0,    'rgba(255,255,200,0)');
      grad.addColorStop(0.25, 'rgba(255,255,200,0.95)');
      grad.addColorStop(0.65, 'rgba(80,220,60,0.5)');
      grad.addColorStop(1,    'rgba(13,17,23,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(CX, CY, shockR, 0, Math.PI * 2);
      ctx.fill();

      if (shockR >= SHOCK_MAX) {
        ctx.fillStyle = '#0d1117';
        ctx.fillRect(0, 0, W, H);
        setTimeout(() => { c.remove(); onComplete(); }, 150);
        return;
      }
    }

    requestAnimationFrame(tick);
  }

  tick();
}

// ── Splash → Game transition ──────────────────────────────────────────────────
// A full-screen canvas snake sweeps from right to left, eating the splash page.
// Overlapping bite circles along its sinusoidal path form the chomp-mark edge.
// When the tail clears the left edge the canvas is removed and the game appears.

function startChompAnimation() {
  const splash = document.getElementById('splash');

  const c = document.createElement('canvas');
  c.style.cssText = 'position:fixed;inset:0;z-index:10001;pointer-events:none;';
  c.width  = window.innerWidth;
  c.height = window.innerHeight;
  document.body.appendChild(c);
  const ctx = c.getContext('2d');

  const W        = c.width;
  const H        = c.height;
  const SEG      = Math.round(Math.min(W, H) / 9); // segment size ~11% of shortest dim
  const SPEED    = W / 90;                          // full screen in ~1.5 s at 60 fps
  const AMP      = H * 0.28;                        // sine wave amplitude
  const FREQ     = (2 * Math.PI) / (W * 0.85);     // ~one full wave across screen
  const BITE_R   = SEG * 1.25;                      // radius of each bite circle
  const MAX_SEGS = 11;                              // visible body segments

  let headX    = W + SEG * (MAX_SEGS + 2);          // start off-screen right
  const path   = [];                                 // [{x,y}] newest → oldest

  function waveY(x) {
    return H / 2 + Math.sin(x * FREQ) * AMP;
  }

  // Dark eaten area: solid fill + overlapping bite circles along the snake's path
  function drawEaten() {
    if (!path.length) return;
    ctx.fillStyle = '#0d1117';
    const tailX = path[path.length - 1].x;
    if (tailX < W) ctx.fillRect(tailX, 0, W - tailX, H);
    for (let i = 0; i < path.length; i += 2) {
      ctx.beginPath();
      ctx.arc(path[i].x, path[i].y, BITE_R, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Sample evenly-spaced body positions from the recorded path
  function sampleBody() {
    const positions = [path[0]];
    let dist = 0;
    for (let i = 1; i < path.length && positions.length < MAX_SEGS; i++) {
      const a = path[i - 1], b = path[i];
      dist += Math.hypot(b.x - a.x, b.y - a.y);
      if (dist >= SEG * 1.2) { positions.push(b); dist = 0; }
    }
    return positions;
  }

  function drawSnake() {
    const segs = sampleBody();
    const s    = SEG - 4;

    // Tail → head so the head renders on top
    for (let i = segs.length - 1; i >= 0; i--) {
      const { x, y } = segs[i];
      const isHead   = i === 0;
      const alpha    = (1 - (i / Math.max(segs.length - 1, 1)) * 0.55).toFixed(2);
      ctx.save();
      ctx.shadowColor = '#39ff14';
      ctx.shadowBlur  = isHead ? 24 : 10;
      ctx.fillStyle   = isHead ? '#39ff14' : `rgba(57,255,20,${alpha})`;
      ctx.beginPath();
      ctx.roundRect(x - s / 2, y - s / 2, s, s, s * 0.18);
      ctx.fill();
      ctx.restore();
    }

    // Eyes — snake faces left, eyes on left face
    if (segs.length) {
      const { x, y } = segs[0];
      ctx.save();
      ctx.shadowBlur = 0;
      ctx.fillStyle  = '#060810';
      ctx.beginPath(); ctx.arc(x - SEG * 0.16, y - SEG * 0.22, SEG * 0.1, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(x - SEG * 0.16, y + SEG * 0.22, SEG * 0.1, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
  }

  function tick() {
    headX -= SPEED;
    path.unshift({ x: headX, y: waveY(headX) });

    ctx.clearRect(0, 0, W, H);
    drawEaten();
    drawSnake();

    if (headX < -(SEG * (MAX_SEGS + 3) + BITE_R)) {
      ctx.fillStyle = '#0d1117';
      ctx.fillRect(0, 0, W, H);
      setTimeout(() => { c.remove(); splash.style.display = 'none'; }, 180);
      return;
    }

    requestAnimationFrame(tick);
  }

  tick();
}
