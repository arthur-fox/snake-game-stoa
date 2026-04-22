    // ── Multiplayer State ─────────────────────────────────────
    let partyMode = false;
    let playerColors = new Map();
    let lobbyChannel = null;
    let lobbyChannelReady = false;
    let lobbyChannelError = null;

    function hashUsername(username) {
      let hash = 0;
      for (let i = 0; i < username.length; i++) {
        hash = ((hash << 5) - hash) + username.charCodeAt(i);
        hash |= 0;
      }
      return Math.abs(hash);
    }

    function getPresencePlayers(state) {
      return [...new Set(
        Object.values(state || {})
          .flatMap((presences) => presences)
          .map((presence) => presence.username)
          .filter(Boolean)
      )].sort((a, b) => a.localeCompare(b));
    }

    function buildPlayerColorMap(state) {
      const colors = new Map();
      const usedSlots = new Set();

      getPresencePlayers(state).forEach((username) => {
        let slot = hashUsername(username) % PLAYER_COLORS.length;
        let attempts = 0;
        while (usedSlots.has(slot) && attempts < PLAYER_COLORS.length) {
          slot = (slot + 1) % PLAYER_COLORS.length;
          attempts++;
        }
        usedSlots.add(slot);
        colors.set(username, PLAYER_COLORS[slot]);
      });

      return colors;
    }

    async function syncPlayerColors() {
      if (!mpChannel || !currentUser) return;

      const nextColors = buildPlayerColorMap(mpChannel.presenceState());
      playerColors = nextColors;

      const previousColor = myColor;
      myColor = nextColors.get(currentUser.username) || PLAYER_COLORS[0];

      peers.forEach((peer, username) => {
        peer.color = nextColors.get(username) || peer.color || '#ccc';
      });
      if (myColor !== previousColor && typeof syncRoomPresence === 'function') {
        await syncRoomPresence();
      }
      gameplayLayerDirty = true;
    }

    async function handlePresenceSync() {
      await syncPlayerColors();
      updateLobbyList();
    }

    function showCanvas() {
      if (countdownActive) {
        score = 0;
        scoreEl.textContent = '0';
      }
      document.getElementById('game-col').classList.add('gameplay-active');
      document.getElementById('mp-entry').style.display    = 'none';
      document.getElementById('mp-lobby').style.display    = 'none';
      document.getElementById('canvas-wrap').style.display = 'block';
      document.getElementById('score-display').style.display = '';
      document.getElementById('level-display').style.display = partyMode ? '' : 'none';
      document.getElementById('legend-panel').style.display  = partyMode ? '' : 'none';
      document.getElementById('mp-legend-panel').style.display = multiplayerMode && isShootingEnabled() ? '' : 'none';
      document.getElementById('hint').style.display        = '';
      updateGameplayHint();
      focusGameplaySurface();
    }

    function updateGameplayHint() {
      const hintEl = document.getElementById('hint');
      if (!hintEl) return;
      hintEl.textContent = multiplayerMode && isShootingEnabled()
        ? 'Arrow keys or WASD to move · Space to shoot'
        : 'Arrow keys or WASD to move';
    }

    function setSoloLeaderboardVisible(visible) {
      document.getElementById('lb-panel').style.display = visible ? 'block' : 'none';
    }

    function setBoardHalo(mode = 'green') {
      const wrapEl = document.getElementById('canvas-wrap');
      if (!wrapEl) return;

      if (mode === 'none') {
        wrapEl.style.setProperty('--board-glow-opacity', '0');
        return;
      }

      wrapEl.style.setProperty('--board-glow-inset', '-18px');
      wrapEl.style.setProperty('--board-glow-blur', '18px');

      if (mode === 'blue') {
        wrapEl.style.setProperty('--board-glow-shadow', '0 0 56px rgba(0,136,255,0.16)');
        wrapEl.style.setProperty('--board-glow-opacity', '0.8');
        return;
      }

      wrapEl.style.setProperty('--board-glow-shadow', '0 0 56px rgba(57,255,20,0.14)');
      wrapEl.style.setProperty('--board-glow-opacity', '0.78');
    }

    function startSolo() {
      multiplayerMode = false;
      partyMode = false;
      roomStage = 'browse';
      clearCurrentMatchSnapshot();
      matchResults.clear();
      resetCombatState();
      countdownActive = false;
      pendingStartDirection = null;
      lastMultiplayerHudKey = '';
      resetRoomSettings();
      syncLobbyPresence();
      setSoloLeaderboardVisible(true);
      startCountdown();
    }

    function startParty() {
      multiplayerMode = false;
      partyMode = true;
      roomStage = 'browse';
      clearCurrentMatchSnapshot();
      matchResults.clear();
      resetCombatState();
      countdownActive = false;
      pendingStartDirection = null;
      lastMultiplayerHudKey = '';
      resetRoomSettings();
      syncLobbyPresence();
      setSoloLeaderboardVisible(true);
      startCountdown();
    }

    // ── Game ──────────────────────────────────────────────────
    const canvas  = document.getElementById('c');
    const ctx     = canvas.getContext('2d');
    const scoreEl = document.getElementById('score-val');

    const CELL = 20;
    const COLS = canvas.width  / CELL;
    const ROWS = canvas.height / CELL;
    const TICK = 130;
    const MAX_INPUT_QUEUE = 2;
    const BACKGROUND_REFRESH_MS = 100;
    const INPUT_DIRECTIONS = {
      ArrowUp:    { x: 0,  y: -1 },
      ArrowDown:  { x: 0,  y: 1 },
      ArrowLeft:  { x: -1, y: 0 },
      ArrowRight: { x: 1,  y: 0 },
      w:          { x: 0,  y: -1 },
      a:          { x: -1, y: 0 },
      s:          { x: 0,  y: 1 },
      d:          { x: 1,  y: 0 },
    };

    let snake, dir, inputQueue, foods, score, gameLoop, gameOver;
    let backgroundCanvas, backgroundCtx, lastBackgroundRefresh;
    let gameplayCanvas, gameplayCtx, gameplayLayerDirty;
    let gridCanvas, gridCtx;
    let renderRaf;

    // ── Power-Up State ────────────────────────────────────────
    const POWERUP_TYPES       = ['INVINCIBLE', 'ROTTEN', 'BLUE_APPLE'];
    const POWERUP_SPAWN_MIN   = 10000;   // 10 s
    const POWERUP_SPAWN_MAX   = 20000;   // 20 s
    const INVINCIBLE_DURATION = 10000;   // 10 s
    const BLUE_APPLE_DURATION = 15000;   // 15 s
    const POWERUP_EXPIRE_MS   = 7000;    // 7 s — all power-ups vanish if uneaten

    let powerUps            = [];   // [{type, x, y}]
    let invincible          = false;
    let wallWrap            = false;
    let invincibleUntil     = 0;
    let wallWrapUntil       = 0;
    let levelGraceUntil     = 0;   // silent 2-second invincibility after level change
    let powerUpSpawnTimeout = null;
    let hungerCounts        = { INVINCIBLE: 0, ROTTEN: 0, BLUE_APPLE: 0 };

    function focusGameplaySurface() {
      setTimeout(() => {
        if (document.activeElement !== canvas) {
          canvas.focus({ preventScroll: true });
        }
      }, 0);
    }

    function init() {
      resetGameState();           // must run first so score=0 before buildGridCache
      buildBackgroundCache(true);
      buildGameplayLayerCache();
      buildGridCache();
      startGameLoop();
      startRenderLoop();
      if (partyMode) scheduleNextPowerUp();
      focusGameplaySurface();
    }

    // ── Arena / Level System ──────────────────────────────────
    const SHAPES = ['square', 'circle', 'triangle'];

    const LEVEL_CONFIG = {
      square: {
        interior: null,
        borderColor: '#000',
        gridColor: 'rgba(255,255,255,0.03)',
        snakeHead: null,
        snakeBodyFn: (i, len) => `rgb(30,${Math.round(200 - (i / len) * 90)},20)`,
        eyeColor: '#111',
      },
      circle: {
        interior: '#FFD700',
        borderColor: '#000',
        gridColor: 'rgba(0,0,0,0.12)',
        snakeHead: '#0d0d0d',
        snakeBodyFn: (i, len) => `rgba(13,13,13,${(0.9 - (i / len) * 0.35).toFixed(2)})`,
        eyeColor: '#fff',
      },
      triangle: {
        interior: '#0c0028',
        borderColor: '#000',
        gridColor: 'rgba(255,255,255,0.06)',
        snakeHead: '#f0f0f0',
        snakeBodyFn: (i, len) => `rgba(220,220,220,${(0.9 - (i / len) * 0.35).toFixed(2)})`,
        eyeColor: '#111',
      },
    };

    let lastLevelShape = 'square';
    let levelShapes = ['square', 'circle', 'triangle'];

    function getArenaShape() {
      if (!partyMode) return 'square';
      const level = Math.floor((score || 0) / 100);
      while (levelShapes.length <= level) {
        levelShapes.push(SHAPES[Math.floor(Math.random() * SHAPES.length)]);
      }
      return levelShapes[level];
    }

    function _triSign(px, py, x1, y1, x2, y2) {
      return (px - x2) * (y1 - y2) - (x1 - x2) * (py - y2);
    }

    function isInArena(x, y) {
      const shape = getArenaShape();
      if (shape === 'square') return x >= 0 && x < COLS && y >= 0 && y < ROWS;
      const px = x + 0.5;
      const py = y + 0.5;
      if (shape === 'circle') {
        return (px - 15) * (px - 15) + (py - 15) * (py - 15) < 14.5 * 14.5;
      }
      if (shape === 'triangle') {
        const d1 = _triSign(px, py, 15, 1, 1, 29);
        const d2 = _triSign(px, py, 1, 29, 29, 29);
        const d3 = _triSign(px, py, 29, 29, 15, 1);
        return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
      }
      return false;
    }

    function buildArenaPath(targetCtx) {
      const W = canvas.width;
      const H = canvas.height;
      const shape = getArenaShape();
      targetCtx.beginPath();
      if (shape === 'circle') {
        targetCtx.arc(W / 2, H / 2, W / 2 - 4, 0, Math.PI * 2);
      } else if (shape === 'triangle') {
        targetCtx.moveTo(W / 2, CELL);
        targetCtx.lineTo(CELL, H - CELL);
        targetCtx.lineTo(W - CELL, H - CELL);
        targetCtx.closePath();
      }
    }

    function updateLevelDisplay() {
      const el = document.getElementById('level-val');
      if (el) el.textContent = Math.floor(score / 100) + 1;
    }

    // ── Game State ────────────────────────────────────────────
    function resetGameState() {
      const initialSpawn = getInitialSpawnState();
      snake      = initialSpawn.snake;
      dir        = initialSpawn.dir;
      inputQueue = [];
      score      = 0;
      gameOver   = false;
      spectating = false;
      canvas._btn = null;
      canvas.style.cursor = 'default';
      document.getElementById('solo-end-overlay').style.display = 'none';
      gameplayLayerDirty = true;
      scoreEl.textContent = '0';
      powerUps        = [];
      invincible      = false;
      wallWrap        = false;
      invincibleUntil = 0;
      wallWrapUntil   = 0;
      levelGraceUntil = 0;
      hungerCounts    = { INVINCIBLE: 0, ROTTEN: 0, BLUE_APPLE: 0 };
      lastLevelShape  = 'square';
      levelShapes     = ['square', 'circle', 'triangle'];
      updateWallDisplay();
      updateLevelDisplay();
      resetFoodsForCurrentMode();
      if (partyMode) spawnFood();
      if (pendingStartDirection && enqueueDirection(pendingStartDirection)) {
        pendingStartDirection = null;
      }
    }

    function restartSoloRun() {
      document.getElementById('solo-end-overlay').style.display = 'none';
      startCountdown();
    }

    function returnToMainMenuFromSolo() {
      stopGameLoop();
      gameOver = false;
      canvas._btn = null;
      document.getElementById('solo-end-overlay').style.display = 'none';
      partyMode = false;
      multiplayerMode = false;
      roomStage = 'browse';
      clearCurrentMatchSnapshot();
      matchResults.clear();
      resetCombatState();
      countdownActive = false;
      pendingStartDirection = null;
      lastMultiplayerHudKey = '';
      resetRoomSettings();
      document.getElementById('mp-lobby').style.display = 'none';
      document.getElementById('canvas-wrap').style.display = 'none';
      document.getElementById('mp-game-hud').style.display = 'none';
      document.getElementById('score-display').style.display = 'none';
      document.getElementById('level-display').style.display = 'none';
      document.getElementById('legend-panel').style.display = 'none';
      document.getElementById('mp-legend-panel').style.display = 'none';
      document.getElementById('hint').style.display = 'none';
      document.getElementById('mp-entry').style.display = 'flex';
      document.getElementById('game-col').classList.remove('gameplay-active');
      setSoloLeaderboardVisible(true);
      if (typeof setLobbyBrowseNotice === 'function') {
        setLobbyBrowseNotice('');
      }
      if (typeof ensureLobbyChannel === 'function' && !lobbyChannel) {
        ensureLobbyChannel();
      }
      if (typeof syncLobbyPresence === 'function') {
        syncLobbyPresence();
      }
      if (typeof renderAvailableRooms === 'function') {
        renderAvailableRooms();
      }
    }

    function startGameLoop() {
      clearInterval(gameLoop);
      gameLoop = setInterval(tick, TICK);
    }

    function stopSimulation() {
      clearInterval(gameLoop);
      clearTimeout(powerUpSpawnTimeout); powerUpSpawnTimeout = null;
    }
    function stopRenderer()   { cancelAnimationFrame(renderRaf); }
    function stopGameLoop()   { stopSimulation(); stopRenderer(); }

    function spawnFood() {
      let pos;
      do {
        pos = { x: Math.floor(Math.random() * COLS), y: Math.floor(Math.random() * ROWS) };
      } while (
        !isInArena(pos.x, pos.y) ||
        snake.some(s => s.x === pos.x && s.y === pos.y) ||
        powerUps.some(p => p.x === pos.x && p.y === pos.y) ||
        specialItems.some((item) => item.x === pos.x && item.y === pos.y)
      );
      foods = [{ id: generateFoodId(), x: pos.x, y: pos.y }];
      gameplayLayerDirty = true;
    }

    // ── Power-Up Logic ────────────────────────────────────────
    function updateWallDisplay() {
      // Shaped arenas remove the square border entirely — only square level uses it
      if (getArenaShape() !== 'square') {
        canvas.style.border    = 'none';
        canvas.style.boxShadow = 'none';
        setBoardHalo('none');
        buildGridCache(); // rebuild border color (e.g. circle turns blue on Blue Apple)
        return;
      }
      if (wallWrap) {
        canvas.style.border    = '2px solid #0088ff';
        canvas.style.boxShadow = 'none';
        setBoardHalo('blue');
      } else {
        canvas.style.border    = '2px solid #000';
        canvas.style.boxShadow = 'none';
        setBoardHalo('green');
      }
    }

    function scheduleNextPowerUp() {
      if (!partyMode) return;
      const delay = POWERUP_SPAWN_MIN + Math.random() * (POWERUP_SPAWN_MAX - POWERUP_SPAWN_MIN);
      powerUpSpawnTimeout = setTimeout(() => {
        if (!gameOver && partyMode) {
          spawnPowerUp();
          scheduleNextPowerUp();
        }
      }, delay);
    }

    function spawnPowerUp() {
      // Weighted random: base weight 1 + hunger for each type not recently seen
      const weights = POWERUP_TYPES.map(t => 1 + hungerCounts[t]);
      const total   = weights.reduce((a, b) => a + b, 0);
      let r = Math.random() * total;
      let type = POWERUP_TYPES[POWERUP_TYPES.length - 1];
      for (let i = 0; i < POWERUP_TYPES.length; i++) {
        r -= weights[i];
        if (r <= 0) { type = POWERUP_TYPES[i]; break; }
      }

      // Update hunger: reset chosen type, increment all others
      POWERUP_TYPES.forEach(t => {
        hungerCounts[t] = (t === type) ? 0 : hungerCounts[t] + 1;
      });

      function randomFreeCell(extras) {
        let pos, attempts = 0;
        do {
          pos = { x: Math.floor(Math.random() * COLS), y: Math.floor(Math.random() * ROWS) };
          attempts++;
        } while (attempts < 200 && (
          !isInArena(pos.x, pos.y) ||
          snake.some(s => s.x === pos.x && s.y === pos.y) ||
          foods.some((foodItem) => foodItem.x === pos.x && foodItem.y === pos.y) ||
          powerUps.some(p => p.x === pos.x && p.y === pos.y) ||
          (extras || []).some(e => e.x === pos.x && e.y === pos.y)
        ));
        return pos;
      }

      const spawnedAt = Date.now();
      if (type === 'ROTTEN') {
        // Base 3 apples + 1 per 100 score
        const count  = 3 + Math.floor(score / 100);
        const placed = [];
        for (let i = 0; i < count; i++) {
          const pos = randomFreeCell(placed);
          placed.push(pos);
          powerUps.push({ type: 'ROTTEN', x: pos.x, y: pos.y, spawnedAt });
        }
      } else {
        // Don't stack if same effect already active or already on board
        if (type === 'INVINCIBLE' && (invincible || powerUps.some(p => p.type === 'INVINCIBLE'))) return;
        if (type === 'BLUE_APPLE' && (wallWrap   || powerUps.some(p => p.type === 'BLUE_APPLE')))  return;
        powerUps.push({ type, ...randomFreeCell([]), spawnedAt });
      }
      gameplayLayerDirty = true;
    }

    function applyPowerUp(type) {
      const now = Date.now();
      if (type === 'INVINCIBLE') {
        invincible      = true;
        invincibleUntil = now + INVINCIBLE_DURATION;
        score += 5;
        scoreEl.textContent = score;
      } else if (type === 'ROTTEN') {
        endGame(); return;
      } else if (type === 'BLUE_APPLE') {
        wallWrap      = true;
        wallWrapUntil = now + BLUE_APPLE_DURATION;
        updateWallDisplay();
        score += 5;
        scoreEl.textContent = score;
      }
    }
    // ── Simulation ────────────────────────────────────────────
    function getNextHead() {
      return { x: snake[0].x + dir.x, y: snake[0].y + dir.y };
    }

    function isOutOfBounds(pos) {
      // Blue apple dissolves arena walls — only outer square grid matters
      if (wallWrap) return pos.x < 0 || pos.x >= COLS || pos.y < 0 || pos.y >= ROWS;
      return !isInArena(pos.x, pos.y);
    }

    // Triangle wrapping uses snake direction (not geometry) to avoid ambiguity at the top vertex.
    //   UP    → exits top point  → emerges at bottom centre (y=28)
    //   DOWN  → exits bottom     → emerges just inside top vertex (y=2)
    //   LEFT  → exits left side  → emerges on right side at same row
    //   RIGHT → exits right side → emerges on left side  at same row
    function wrapTriangle(head, snakeDir) {
      if (snakeDir.y === -1) {
        // Heading up → out the top point → emerge at bottom centre
        return { x: 15, y: 28 };
      }
      if (snakeDir.y === 1) {
        // Heading down → out the bottom → emerge just inside top vertex
        return { x: 15, y: 2 };
      }
      // Heading left or right: wrap to opposite side at same row.
      // At row y the triangle's half-width at the cell centre is: t * 14
      // where t = (y + 0.5 - 1) / 28 = (y - 0.5) / 28
      const t = Math.max(0.01, Math.min(1, (head.y - 0.5) / 28));
      if (snakeDir.x === -1) {
        // Exiting left → land on right side
        return { x: Math.floor(15 + t * 14 - 0.5), y: head.y };
      }
      // Exiting right → land on left side
      return { x: Math.floor(15 - t * 14 + 0.5), y: head.y };
    }

    function hitsSnake(pos) {
      return snake.some(s => s.x === pos.x && s.y === pos.y);
    }

    function consumeQueuedDirection() {
      if (!inputQueue.length) return;
      dir = inputQueue.shift();
    }

    function tick() {
      consumeQueuedDirection();
      if (partyMode) {
        const now = Date.now();
        if (invincible && now >= invincibleUntil) {
          invincible = false;
          gameplayLayerDirty = true;
        }
        if (wallWrap && now >= wallWrapUntil) {
          wallWrap = false;
          updateWallDisplay();
          gameplayLayerDirty = true;
        }
        const before = powerUps.length;
        powerUps = powerUps.filter((powerUp) => now - powerUp.spawnedAt < POWERUP_EXPIRE_MS);
        if (powerUps.length !== before) gameplayLayerDirty = true;
      }

      let head = getNextHead();
      let didTriangleWrap = false;

      if (partyMode && getArenaShape() === 'triangle' && !isInArena(head.x, head.y)) {
        head = wrapTriangle(head, dir);
        if (!isInArena(head.x, head.y)) head = { x: 15, y: 28 };
        didTriangleWrap = true;
      }

      let outOfBounds = isOutOfBounds(head);
      if (partyMode && outOfBounds && (wallWrap || invincible || Date.now() < levelGraceUntil)) {
        head = {
          x: ((head.x % COLS) + COLS) % COLS,
          y: ((head.y % ROWS) + ROWS) % ROWS,
        };
        outOfBounds = false;
      }

      const selfCollision = !outOfBounds && hitsSnake(head);
      const peerCollision = multiplayerMode ? getPeerCollision(head) : null;
      if (
        outOfBounds ||
        (!partyMode && selfCollision) ||
        (partyMode && !invincible && !didTriangleWrap && Date.now() >= levelGraceUntil && selfCollision) ||
        peerCollision
      ) {
        endGame({
          cause: outOfBounds ? 'wall' : selfCollision ? 'self' : `peer-${peerCollision.type}`,
          collision: peerCollision,
          head,
        });
        return;
      }

      snake.unshift(head);

      let shouldGrow = false;
      const consumedFood = getFoodAtPosition(head);
      const consumedSpecial = multiplayerMode ? getSpecialItemAtPosition(head) : null;

      if (multiplayerMode) {
        if (consumedFood) {
          if (isHost) {
            resolveFoodClaim(consumedFood.id, currentUser.username);
            shouldGrow = true;
          } else {
            requestFoodClaim(consumedFood.id);
          }
        }

        if (!shouldGrow && pendingGrowth > 0) {
          pendingGrowth--;
          shouldGrow = true;
        }

        if (consumedSpecial) {
          if (isHost) {
            resolveSpecialClaim(consumedSpecial.id, currentUser.username);
          } else {
            requestSpecialClaim(consumedSpecial.id);
          }
        }
      } else if (consumedFood) {
        foods = foods.filter((foodItem) => foodItem.id !== consumedFood.id);
        score += 10;
        scoreEl.textContent = score;
        if (partyMode) {
          spawnFood();
          const newShape = getArenaShape();
          if (newShape !== lastLevelShape) {
            lastLevelShape = newShape;
            levelGraceUntil = Date.now() + 2000;
            buildGridCache();
            updateLevelDisplay();
            powerUps = powerUps.filter((powerUp) => isInArena(powerUp.x, powerUp.y));
            if (!foods.every((foodItem) => isInArena(foodItem.x, foodItem.y))) {
              spawnFood();
            }
            gameplayLayerDirty = true;
          }
        } else {
          foods = refillFoods(foods);
        }
        shouldGrow = true;
      }

      if (!shouldGrow) {
        snake.pop();
      }

      if (partyMode) {
        for (let i = powerUps.length - 1; i >= 0; i--) {
          const powerUp = powerUps[i];
          if (head.x === powerUp.x && head.y === powerUp.y) {
            applyPowerUp(powerUp.type);
            if (powerUp.type === 'ROTTEN') {
              powerUps = powerUps.filter((entry) => entry.type !== 'ROTTEN');
            } else {
              powerUps.splice(i, 1);
            }
            break;
          }
        }
      }

      gameplayLayerDirty = true;
      if (multiplayerMode) broadcastSnakeState();
    }

    // ── Rendering ─────────────────────────────────────────────
    function startRenderLoop() {
      cancelAnimationFrame(renderRaf);
      (function loop() {
        if (gameOver && !spectating) return;
        renderFrame();
        renderRaf = requestAnimationFrame(loop);
      })();
    }

    function buildGridCache() {
      gridCanvas = document.createElement('canvas');
      gridCanvas.width = canvas.width;
      gridCanvas.height = canvas.height;
      gridCtx = gridCanvas.getContext('2d');
      const shape = getArenaShape();

      if (shape === 'square') {
        canvas.style.border    = wallWrap ? '2px solid #0088ff' : '2px solid #000';
        canvas.style.boxShadow = 'none';
        canvas.style.borderRadius = '4px';
        setBoardHalo(wallWrap ? 'blue' : 'green');
        drawGridLines(gridCtx);
      } else {
        // No square border — the shape IS the boundary
        canvas.style.border    = 'none';
        canvas.style.boxShadow = 'none';
        canvas.style.borderRadius = '0';
        setBoardHalo('none');

        const cfg = LEVEL_CONFIG[shape];

        // Fill entire canvas with solid dark "wall" so outside the shape looks impassable
        gridCtx.fillStyle = '#060608';
        gridCtx.fillRect(0, 0, canvas.width, canvas.height);

        // Fill arena interior
        buildArenaPath(gridCtx);
        gridCtx.fillStyle = cfg.interior;
        gridCtx.fill();

        // Grid lines clipped to arena interior
        gridCtx.save();
        buildArenaPath(gridCtx);
        gridCtx.clip();
        gridCtx.strokeStyle = cfg.gridColor;
        gridCtx.lineWidth   = 0.5;
        for (let x = 0; x <= canvas.width;  x += CELL) {
          gridCtx.beginPath(); gridCtx.moveTo(x, 0); gridCtx.lineTo(x, canvas.height); gridCtx.stroke();
        }
        for (let y = 0; y <= canvas.height; y += CELL) {
          gridCtx.beginPath(); gridCtx.moveTo(0, y); gridCtx.lineTo(canvas.width, y); gridCtx.stroke();
        }
        gridCtx.restore();

        // Arena border — this IS the wall; turns blue when Blue Apple is active on circle
        const borderActive = wallWrap && shape === 'circle';
        buildArenaPath(gridCtx);
        gridCtx.strokeStyle  = borderActive ? '#0088ff' : cfg.borderColor;
        gridCtx.lineWidth    = 6;
        gridCtx.shadowColor  = borderActive ? '#0088ff' : 'transparent';
        gridCtx.shadowBlur   = borderActive ? 18 : 0;
        gridCtx.stroke();
        gridCtx.shadowBlur   = 0;
      }
    }

    function buildGameplayLayerCache() {
      if (!gameplayCanvas) {
        gameplayCanvas = document.createElement('canvas');
        gameplayCanvas.width = canvas.width;
        gameplayCanvas.height = canvas.height;
        gameplayCtx = gameplayCanvas.getContext('2d');
      }
      gameplayLayerDirty = true;
    }

    function buildBackgroundCache(force = false) {
      if (!force && backgroundCanvas) return;  // static — only build once

      if (!backgroundCanvas) {
        backgroundCanvas = document.createElement('canvas');
        backgroundCanvas.width = canvas.width;
        backgroundCanvas.height = canvas.height;
        backgroundCtx = backgroundCanvas.getContext('2d');
      }

      backgroundCtx.fillStyle = '#0f0820';
      backgroundCtx.fillRect(0, 0, canvas.width, canvas.height);
    }

    function drawAnimatedBackgroundLayer() {
      buildBackgroundCache();
      ctx.drawImage(backgroundCanvas, 0, 0);
    }

    function drawGridLines(targetCtx) {
      targetCtx.strokeStyle = 'rgba(255,255,255,0.03)';
      targetCtx.lineWidth   = 0.5;
      for (let x = 0; x <= canvas.width;  x += CELL) {
        targetCtx.beginPath(); targetCtx.moveTo(x, 0); targetCtx.lineTo(x, canvas.height); targetCtx.stroke();
      }
      for (let y = 0; y <= canvas.height; y += CELL) {
        targetCtx.beginPath(); targetCtx.moveTo(0, y); targetCtx.lineTo(canvas.width, y); targetCtx.stroke();
      }
    }

    function drawStaticGridLayer() {
      if (!gridCanvas) buildGridCache();
      ctx.drawImage(gridCanvas, 0, 0);
    }

    function drawSnakeSegments(targetCtx, snakeSegments, options = {}) {
      if (!snakeSegments || snakeSegments.length === 0) return;

      const {
        color = '#39ff14',
        dead = false,
        multiplayer = false,
        playerId = null,
      } = options;

      snakeSegments.forEach((seg, i) => {
        const x = seg.x * CELL + 1;
        const y = seg.y * CELL + 1;
        const s = CELL - 2;
        const isHead = i === 0;

        const partyVisuals = partyMode && !multiplayer;
        const levelConfig = LEVEL_CONFIG[getArenaShape()];

        if (dead) {
          const corpseCollisionEnabled = isCorpseCollisionEnabled();
          const corpseDamage = playerId ? getCorpseDamage(playerId, seg) : 0;
          targetCtx.shadowBlur = 0;
          if (corpseCollisionEnabled && corpseDamage >= 1) {
            targetCtx.fillStyle = isHead
              ? 'rgba(255,214,102,0.98)'
              : 'rgba(255,166,77,0.96)';
          } else {
            targetCtx.fillStyle = isHead
              ? (corpseCollisionEnabled ? 'rgba(184,184,184,0.96)' : 'rgba(170,170,170,0.28)')
              : (corpseCollisionEnabled ? 'rgba(116,116,116,0.94)' : 'rgba(120,120,120,0.14)');
          }
        } else if (isHead) {
          const headColor = partyVisuals && levelConfig.snakeHead ? levelConfig.snakeHead : color;
          targetCtx.shadowColor = invincible && partyVisuals ? `hsl(${(Date.now() / 25 + i * 18) % 360}, 100%, 65%)` : headColor;
          targetCtx.shadowBlur  = 16;
          targetCtx.fillStyle = invincible && partyVisuals
            ? `hsl(${(Date.now() / 25 + i * 18) % 360}, 100%, 72%)`
            : headColor;
        } else {
          if (invincible && partyVisuals) {
            const hue = (Date.now() / 25 + i * 18) % 360;
            const pulse = 0.55 + 0.45 * Math.sin(Date.now() / 140 + i * 0.4);
            targetCtx.shadowColor = `hsl(${hue}, 100%, 65%)`;
            targetCtx.shadowBlur  = 22 * pulse;
            targetCtx.fillStyle   = `hsl(${hue}, 100%, 58%)`;
          } else {
            targetCtx.shadowBlur = 0;
            targetCtx.fillStyle = multiplayer
              ? hexToRgba(color, 0.65 - (i / snakeSegments.length) * 0.3)
              : (partyVisuals && levelConfig.snakeHead
                ? levelConfig.snakeBodyFn(i, snakeSegments.length)
                : `rgb(30, ${Math.round(200 - (i / snakeSegments.length) * 90)}, 20)`);
          }
        }

        targetCtx.beginPath();
        targetCtx.roundRect(x, y, s, s, isHead ? 5 : 3);
        targetCtx.fill();
      });
    }

    function drawPartyPowerUps(targetCtx) {
      const now = Date.now();
      powerUps.forEach((powerUp) => {
        const px = powerUp.x * CELL + 2;
        const py = powerUp.y * CELL + 2;
        const ps = CELL - 4;
        const cx = px + ps / 2;
        const cy = py + ps / 2;
        const radius = ps / 2;

        if (powerUp.type === 'INVINCIBLE') {
          const pulse = 0.7 + 0.3 * Math.sin(now / 180);
          const hue = (now / 18) % 360;
          const gradient = targetCtx.createRadialGradient(cx, cy, 0, cx, cy, radius);
          gradient.addColorStop(0, `hsla(${hue}, 100%, 85%, ${pulse})`);
          gradient.addColorStop(0.5, `hsla(${(hue + 120) % 360}, 100%, 60%, ${pulse * 0.85})`);
          gradient.addColorStop(1, `hsla(${(hue + 240) % 360}, 100%, 40%, 0)`);
          targetCtx.shadowColor = `hsl(${hue}, 100%, 70%)`;
          targetCtx.shadowBlur = 14 * pulse;
          targetCtx.fillStyle = gradient;
          targetCtx.beginPath();
          targetCtx.arc(cx, cy, radius, 0, Math.PI * 2);
          targetCtx.fill();
          targetCtx.shadowBlur = 0;
          return;
        }

        if (powerUp.type === 'ROTTEN') {
          targetCtx.shadowColor = '#1a5a1a';
          targetCtx.shadowBlur = 10;
          const rottenGradient = targetCtx.createRadialGradient(cx - radius * 0.2, cy - radius * 0.2, 0, cx, cy, radius);
          rottenGradient.addColorStop(0, '#2d6b2d');
          rottenGradient.addColorStop(1, '#0f2e0f');
          targetCtx.fillStyle = rottenGradient;
          targetCtx.beginPath();
          targetCtx.arc(cx, cy, radius, 0, Math.PI * 2);
          targetCtx.fill();
          targetCtx.shadowBlur = 0;
          targetCtx.font = `bold ${Math.floor(ps * 0.72)}px serif`;
          targetCtx.textAlign = 'center';
          targetCtx.textBaseline = 'middle';
          targetCtx.fillStyle = '#7ddb7d';
          targetCtx.fillText('☠', cx, cy + 1);
          targetCtx.textBaseline = 'alphabetic';
          return;
        }

        const pulse = 0.75 + 0.25 * Math.sin(now / 280);
        targetCtx.shadowColor = '#00aaff';
        targetCtx.shadowBlur = 18 * pulse;
        const blueGradient = targetCtx.createRadialGradient(cx - radius * 0.25, cy - radius * 0.25, 0, cx, cy, radius);
        blueGradient.addColorStop(0, '#55ccff');
        blueGradient.addColorStop(1, '#0055cc');
        targetCtx.fillStyle = blueGradient;
        targetCtx.beginPath();
        targetCtx.arc(cx, cy, radius, 0, Math.PI * 2);
        targetCtx.fill();
        targetCtx.shadowBlur = 0;
        targetCtx.fillStyle = 'rgba(200,240,255,0.45)';
        targetCtx.beginPath();
        targetCtx.arc(cx - radius * 0.28, cy - radius * 0.28, radius * 0.32, 0, Math.PI * 2);
        targetCtx.fill();
      });
    }

    function drawSpecialItems(targetCtx) {
      specialItems.forEach((item) => {
        const cx = item.x * CELL + CELL / 2;
        const cy = item.y * CELL + CELL / 2;
        const radius = CELL * 0.28;

        targetCtx.shadowBlur = 14;
        if (item.type === 'ammo') {
          targetCtx.shadowColor = '#39a6ff';
          targetCtx.fillStyle = '#39a6ff';
          targetCtx.beginPath();
          targetCtx.arc(cx, cy, radius, 0, Math.PI * 2);
          targetCtx.fill();
          targetCtx.shadowBlur = 0;
          targetCtx.fillStyle = 'rgba(255,255,255,0.9)';
          targetCtx.beginPath();
          targetCtx.arc(cx - 2, cy - 2, radius * 0.36, 0, Math.PI * 2);
          targetCtx.fill();
          return;
        }

        targetCtx.shadowColor = '#ffd84d';
        targetCtx.fillStyle = '#ffd84d';
        targetCtx.save();
        targetCtx.translate(cx, cy);
        targetCtx.rotate(Math.PI / 4);
        targetCtx.fillRect(-radius, -radius, radius * 2, radius * 2);
        targetCtx.restore();
        targetCtx.shadowBlur = 0;
        targetCtx.fillStyle = 'rgba(60,40,0,0.95)';
        targetCtx.fillRect(cx - 1.5, cy - radius * 0.65, 3, radius * 1.3);
        targetCtx.fillRect(cx - radius * 0.65, cy - 1.5, radius * 1.3, 3);
      });
    }

    function drawGameplayObjects(targetCtx) {
      foods.forEach((foodItem) => {
        targetCtx.shadowColor = '#ff4136';
        targetCtx.shadowBlur = 14;
        targetCtx.fillStyle = '#ff4136';
        const fx = foodItem.x * CELL + 2;
        const fy = foodItem.y * CELL + 2;
        const fs = CELL - 4;
        targetCtx.beginPath();
        targetCtx.arc(fx + fs / 2, fy + fs / 2, fs / 2, 0, Math.PI * 2);
        targetCtx.fill();
      });
      if (partyMode) drawPartyPowerUps(targetCtx);
      if (multiplayerMode) drawSpecialItems(targetCtx);
      targetCtx.shadowBlur = 0;
      targetCtx.globalAlpha = 1;
      drawSnakeSegments(targetCtx, snake, {
        color: myColor,
        dead: multiplayerMode && spectating,
        multiplayer: multiplayerMode,
        playerId: currentUser?.username,
      });
      targetCtx.shadowBlur  = 0;
      targetCtx.globalAlpha = 1;

      // ── Eyes (only when alive) ─────────────────────────────
      if (!spectating) {
        const lcfg = LEVEL_CONFIG[getArenaShape()];
        targetCtx.fillStyle = (!multiplayerMode && lcfg.eyeColor) ? lcfg.eyeColor : '#111';
        getEyePositions(snake[0].x * CELL, snake[0].y * CELL, dir, 5).forEach(([ex, ey]) => {
          targetCtx.beginPath();
          targetCtx.arc(ex, ey, 2.5, 0, Math.PI * 2);
          targetCtx.fill();
        });
      }
    }

    function drawPeerSnakes(targetCtx) {
      const now = performance.now();
      peers.forEach((peer, username) => {
        if (!peer.snake || peer.snake.length === 0) return;
        const peerColor = playerColors.get(username) || peer.color || '#ccc';
        const elapsed = now - (peer.updatedAt || now);
        const lerpFactor = peer.dead ? 1 : Math.min(elapsed / TICK, 1);
        const drawSnake = peer.dead
          ? peer.snake
          : peer.snake.map((segment, index) => {
            const previous = peer.prevSnake?.[index] || segment;
            return {
              x: previous.x + (segment.x - previous.x) * lerpFactor,
              y: previous.y + (segment.y - previous.y) * lerpFactor,
            };
          });
        targetCtx.globalAlpha = 1;
        drawSnakeSegments(targetCtx, drawSnake, {
          color: peerColor,
          dead: Boolean(peer.dead),
          multiplayer: true,
          playerId: username,
        });
        targetCtx.shadowBlur  = 0;
        targetCtx.globalAlpha = 1;
      });
    }

    function getEyePositions(hx, hy, d, o) {
      const cx = hx + CELL / 2, cy = hy + CELL / 2;
      if (d.x ===  1) return [[cx + 4, cy - o], [cx + 4, cy + o]];
      if (d.x === -1) return [[cx - 4, cy - o], [cx - 4, cy + o]];
      if (d.y === -1) return [[cx - o, cy - 4], [cx + o, cy - 4]];
      return                  [[cx - o, cy + 4], [cx + o, cy + 4]];
    }

    function drawCachedLayers() {
      drawAnimatedBackgroundLayer();
      drawStaticGridLayer();
    }

    function rebuildGameplayLayer() {
      if (!gameplayCanvas) buildGameplayLayerCache();
      gameplayCtx.clearRect(0, 0, canvas.width, canvas.height);
      const shape = getArenaShape();
      if (shape !== 'square') {
        gameplayCtx.save();
        buildArenaPath(gameplayCtx);
        gameplayCtx.clip();
      }
      if (multiplayerMode) drawPeerSnakes(gameplayCtx);
      drawGameplayObjects(gameplayCtx);
      if (shape !== 'square') gameplayCtx.restore();
      // Stay dirty when animated power-up items or effects are on screen
      gameplayLayerDirty = invincible || powerUps.length > 0;
    }

    function drawDynamicLayers() {
      if (gameplayLayerDirty) rebuildGameplayLayer();
      ctx.drawImage(gameplayCanvas, 0, 0);
    }

    function drawShotEffects() {
      const effects = getActiveShotEffects();
      if (!effects.length) return;

      effects.forEach((effect) => {
        const startX = effect.origin.x * CELL + CELL / 2;
        const startY = effect.origin.y * CELL + CELL / 2;
        const endX = effect.cell.x * CELL + CELL / 2;
        const endY = effect.cell.y * CELL + CELL / 2;
        const age = Math.min(1, (Date.now() - effect.createdAt) / SHOT_EFFECT_MS);
        const alpha = Math.max(0, 1 - age);
        const shotColor = getDisplayColorForPlayer(effect.shooterId);

        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = hexToRgba(shotColor, Math.max(0.22, alpha));
        ctx.lineWidth = 4;
        ctx.lineCap = 'round';
        ctx.shadowColor = shotColor;
        ctx.shadowBlur = 18;
        ctx.beginPath();
        ctx.moveTo(startX, startY);
        ctx.lineTo(endX, endY);
        ctx.stroke();

        ctx.strokeStyle = `rgba(255,255,255,${Math.max(0.35, alpha)})`;
        ctx.lineWidth = 1.6;
        ctx.shadowBlur = 0;
        ctx.beginPath();
        ctx.moveTo(startX, startY);
        ctx.lineTo(endX, endY);
        ctx.stroke();

        const impactAlpha = effect.result === 'miss'
          ? Math.max(0.2, alpha * 0.7)
          : Math.max(0.34, alpha);
        ctx.fillStyle = effect.result === 'miss'
          ? `rgba(255,255,255,${impactAlpha})`
          : `rgba(255,214,102,${impactAlpha})`;
        ctx.shadowColor = effect.result === 'miss' ? '#ffffff' : '#ffd666';
        ctx.shadowBlur = 14;
        ctx.beginPath();
        ctx.arc(endX, endY, effect.result === 'miss' ? 5.2 : 6.2, 0, Math.PI * 2);
        ctx.fill();

        ctx.shadowBlur = 0;
        ctx.strokeStyle = effect.result === 'miss'
          ? `rgba(255,255,255,${Math.max(0.18, alpha * 0.5)})`
          : `rgba(255,245,214,${Math.max(0.26, alpha * 0.85)})`;
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.arc(endX, endY, effect.result === 'miss' ? 7.4 : 8.6, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      });
    }

    function drawSpectatingOverlay() {
      ctx.fillStyle    = 'rgba(0,0,0,0.25)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'top';
      ctx.font         = 'bold 16px system-ui';
      ctx.fillStyle    = 'rgba(255,255,255,0.5)';
      ctx.fillText('You died — spectating', canvas.width / 2, 14);
      ctx.textBaseline = 'alphabetic';
    }

    function renderFrame() {
      drawCachedLayers();
      drawDynamicLayers();
      drawShotEffects();
      renderMultiplayerHud();
      if (spectating) drawSpectatingOverlay();
    }

    async function endGame(options = {}) {
      gameOver = true;

      if (multiplayerMode) {
        stopSimulation();
        spectating = true;
        gameplayLayerDirty = true; // redraw without the local snake while spectating
        const deathPayload = {
          id: currentUser.username,
          score,
          head: options.head || snake?.[0] || null,
          reason: options.cause || 'unknown',
          matchId: currentMatchId,
          resolvedAt: Date.now(),
        };
        deathPayload.survivalMs = Math.max(0, deathPayload.resolvedAt - (matchStartAt || deathPayload.resolvedAt));

        if (isHost) {
          broadcastResolvedDeath(deathPayload);
          if (options.collision?.type === 'head') {
            broadcastResolvedDeath(buildResolvedDeathPayload(options.collision.playerId, { reason: 'head-on' }));
          }
        } else {
          matchResults.set(currentUser.username, {
            score,
            survivalMs: deathPayload.survivalMs,
            resolvedAt: deathPayload.resolvedAt,
          });
          deadPlayers.add(currentUser.username);
          checkAllDead();
          requestDeathResolution(deathPayload);
        }
        return;
      }

      // Solo game over
      stopGameLoop();
      renderFrame();
      await submitScore(score);

      document.getElementById('solo-end-overlay').style.display = 'flex';
    }

    // ── Input ─────────────────────────────────────────────────
    function getDirectionFromKey(key) {
      if (INPUT_DIRECTIONS[key]) return INPUT_DIRECTIONS[key];
      return INPUT_DIRECTIONS[String(key).toLowerCase()] || null;
    }

    function isSameDirection(a, b) { return a.x === b.x && a.y === b.y; }

    function getEffectiveDirection(queue = inputQueue) { return queue[queue.length - 1] || dir; }

    function isValidQueuedDirection(direction, queue = inputQueue) {
      const eff = getEffectiveDirection(queue);
      if (isSameDirection(direction, eff)) return false;
      return direction.x !== -eff.x || direction.y !== -eff.y;
    }

    function enqueueDirection(direction) {
      if (!isValidQueuedDirection(direction)) return false;
      if (inputQueue.length >= MAX_INPUT_QUEUE) {
        const compactQueue = inputQueue.slice(0, -1);
        if (!isValidQueuedDirection(direction, compactQueue)) return false;
        inputQueue[inputQueue.length - 1] = direction;
        return true;
      }
      inputQueue.push(direction);
      return true;
    }

    function handleDirectionInput(event) {
      const direction = getDirectionFromKey(event?.key);
      if (!direction) return false;
      if (event?.repeat) return true;

      if (countdownActive) {
        const openingDirection = getInitialSpawnState().dir;
        const isReverse = direction.x === -openingDirection.x && direction.y === -openingDirection.y;
        if (!isReverse) {
          pendingStartDirection = direction;
        }
        return true;
      }

      enqueueDirection(direction);
      return Boolean(direction);
    }

    function handleShootInput(event) {
      const isSpace = event.code === 'Space' || event.key === ' ' || event.key === 'Spacebar';
      if (!isSpace) return false;
      if (!multiplayerMode || roomStage !== 'playing') return false;
      if (event.repeat) return true;
      if (!canCurrentPlayerShoot()) return true;

      if (isHost) {
        return resolveShotFire({
          matchId: currentMatchId,
          playerId: currentUser.username,
          head: snake?.[0] || null,
          direction: dir,
        });
      }

      return requestShotFire(dir);
    }

    function handleKeydown(e) {
      if (handleDirectionInput(e) || handleShootInput(e)) e.preventDefault();
    }

    function handleCanvasClick(e) {
      if (!gameOver || !canvas._btn) return;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const { x, y, w, h } = canvas._btn;
      if (mx >= x && mx <= x + w && my >= y && my <= y + h) {
        canvas._btn = null;
        init();
      }
      focusGameplaySurface();
    }

    function updateCanvasCursor(e) {
      if (!gameOver || !canvas._btn) { canvas.style.cursor = 'default'; return; }
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const { x, y, w, h } = canvas._btn;
      canvas.style.cursor = (mx >= x && mx <= x + w && my >= y && my <= y + h) ? 'pointer' : 'default';
    }

    document.addEventListener('keydown', handleKeydown);
    canvas.addEventListener('click', handleCanvasClick);
    canvas.style.cursor = 'default';
    canvas.addEventListener('mousemove', updateCanvasCursor);

    // ── roundRect polyfill ────────────────────────────────────
    if (!CanvasRenderingContext2D.prototype.roundRect) {
      CanvasRenderingContext2D.prototype.roundRect = function(x, y, w, h, r) {
        this.beginPath();
        this.moveTo(x + r, y); this.lineTo(x + w - r, y);
        this.quadraticCurveTo(x + w, y, x + w, y + r);
        this.lineTo(x + w, y + h - r);
        this.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        this.lineTo(x + r, y + h);
        this.quadraticCurveTo(x, y + h, x, y + h - r);
        this.lineTo(x, y + r);
        this.quadraticCurveTo(x, y, x + r, y);
        this.closePath();
      };
    }

    // ── Boot ──────────────────────────────────────────────────
    bootAuth();
