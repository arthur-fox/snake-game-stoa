const PLAYER_COLORS = ['#39ff14', '#FF6B6B', '#4ECDC4', '#FFE66D', '#A8E6CF'];
const MATCH_COUNTDOWN_MS = 4000;
const MAX_HEAD_LIVES = 2;
const MAX_AMMO = 3;
const BLUE_AMMO_DROP_CHANCE = 0.15;
const YELLOW_LIFE_DROP_CHANCE = 0.05;
const SHOT_EFFECT_MS = 180;

let multiplayerMode = false;
let roomId = null;
let mpChannel = null;
let isHost = false;
let roomStage = 'browse';
let peers = new Map(); // username -> { snake, score, color, dead }
let deadPlayers = new Set();
let myColor = PLAYER_COLORS[0];
let spectating = false;
let pendingGrowth = 0;
let pendingFoodClaims = new Set();
let currentMatchId = null;
let pendingMatchFoods = null;
let matchStartAt = null;
let matchResults = new Map();
let countdownActive = false;
let pendingStartDirection = null;
let lastMultiplayerHudKey = '';
let currentMatchPlayers = [];
let roomSettings = getDefaultRoomSettings();
let roomSettingsUpdatedAt = 0;
let playerCombatState = new Map();
let corpseDamageState = new Map();
let specialItems = [];
let pendingSpecialClaims = new Set();
let pendingShotRequests = 0;
let recentShotEffects = [];

function getDefaultRoomSettings() {
  return {
    corpseCollisionMode: false,
    shootingEnabled: false,
  };
}

function cloneRoomSettings(settings = {}) {
  return {
    corpseCollisionMode: Boolean(settings.corpseCollisionMode),
    shootingEnabled: Boolean(settings.shootingEnabled),
  };
}

function getRoomSettings() {
  return cloneRoomSettings(roomSettings);
}

function setRoomSettings(settings = {}) {
  roomSettings = cloneRoomSettings(settings);
}

function applyRoomSettings(settings = {}, updatedAt = Date.now()) {
  if (updatedAt < roomSettingsUpdatedAt) return false;
  setRoomSettings(settings);
  roomSettingsUpdatedAt = updatedAt;
  return true;
}

function updateRoomSettingsLocally(settings = {}) {
  const updatedAt = Date.now();
  applyRoomSettings(settings, updatedAt);
  return updatedAt;
}

function resetRoomSettings() {
  setRoomSettings(getDefaultRoomSettings());
  roomSettingsUpdatedAt = 0;
}

function isCorpseCollisionEnabled() {
  return Boolean(roomSettings.corpseCollisionMode);
}

function isShootingEnabled() {
  return Boolean(roomSettings.shootingEnabled);
}

function buildRoomSettingsPayload(roomIdOverride = roomId) {
  return {
    roomId: roomIdOverride,
    settings: getRoomSettings(),
    updatedAt: roomSettingsUpdatedAt || Date.now(),
  };
}

function getDefaultPlayerCombatState() {
  return {
    ammo: 0,
    headLives: MAX_HEAD_LIVES,
  };
}

function clonePlayerCombatState(state = {}) {
  return {
    ammo: Math.max(0, Math.min(MAX_AMMO, Number(state.ammo) || 0)),
    headLives: Math.max(0, Math.min(MAX_HEAD_LIVES, Number(state.headLives) || 0)),
  };
}

function getCombatState(playerId) {
  return clonePlayerCombatState(playerCombatState.get(playerId) || getDefaultPlayerCombatState());
}

function getAmmoCount(playerId) {
  return getCombatState(playerId).ammo;
}

function getHeadLives(playerId) {
  return getCombatState(playerId).headLives;
}

function setCombatState(playerId, nextState = {}) {
  if (!playerId) return getDefaultPlayerCombatState();
  const normalized = clonePlayerCombatState(nextState);
  playerCombatState.set(playerId, normalized);
  return normalized;
}

function patchCombatState(playerId, patch = {}) {
  return setCombatState(playerId, {
    ...getCombatState(playerId),
    ...patch,
  });
}

function getCorpseDamageKey(playerId, pos) {
  return `${playerId}:${pos.x}:${pos.y}`;
}

function getCorpseDamage(playerId, pos) {
  return corpseDamageState.get(getCorpseDamageKey(playerId, pos)) || 0;
}

function markCorpseDamage(playerId, pos, hits) {
  const key = getCorpseDamageKey(playerId, pos);
  if (hits > 0) {
    corpseDamageState.set(key, hits);
  } else {
    corpseDamageState.delete(key);
  }
}

function clearAllCorpseDamageForPlayer(playerId) {
  Array.from(corpseDamageState.keys()).forEach((key) => {
    if (key.startsWith(`${playerId}:`)) {
      corpseDamageState.delete(key);
    }
  });
}

function cloneSpecialItems(items = []) {
  return items.map((item) => ({ ...item }));
}

function getSpecialItemAtPosition(pos) {
  return specialItems.find((item) => item.x === pos.x && item.y === pos.y) || null;
}

function resetCombatState() {
  playerCombatState = new Map();
  corpseDamageState = new Map();
  specialItems = [];
  pendingSpecialClaims.clear();
  pendingShotRequests = 0;
  recentShotEffects = [];
}

function initializeCombatStateForMatch() {
  resetCombatState();
  currentMatchPlayers.forEach((player) => {
    setCombatState(player.username, getDefaultPlayerCombatState());
  });
}

function buildCombatSyncPayload() {
  return {
    matchId: currentMatchId,
    players: getTrackedMatchPlayerIds()
      .sort((a, b) => a.localeCompare(b))
      .map((playerId) => ({
        id: playerId,
        ...getCombatState(playerId),
      })),
    corpseDamage: Array.from(corpseDamageState.entries()).map(([key, hits]) => {
      const [playerId, x, y] = key.split(':');
      return {
        playerId,
        x: Number(x),
        y: Number(y),
        hits,
      };
    }),
  };
}

function applyCombatSync(payload) {
  if (payload?.matchId && currentMatchId && payload.matchId !== currentMatchId) return false;
  const previousLocalAmmo = currentUser?.username ? getAmmoCount(currentUser.username) : 0;
  const nextCombatState = new Map();
  (payload?.players || []).forEach((player) => {
    if (!player?.id) return;
    nextCombatState.set(player.id, clonePlayerCombatState(player));
  });
  playerCombatState = nextCombatState;

  const nextCorpseDamage = new Map();
  (payload?.corpseDamage || []).forEach((entry) => {
    if (!entry?.playerId) return;
    const hits = Number(entry.hits) || 0;
    if (hits <= 0) return;
    nextCorpseDamage.set(getCorpseDamageKey(entry.playerId, entry), hits);
  });
  corpseDamageState = nextCorpseDamage;
  const nextLocalAmmo = currentUser?.username ? getAmmoCount(currentUser.username) : 0;
  const ammoSpent = Math.max(0, previousLocalAmmo - nextLocalAmmo);
  if (ammoSpent > 0) {
    pendingShotRequests = Math.max(0, pendingShotRequests - ammoSpent);
  }
  gameplayLayerDirty = true;
  return true;
}

function broadcastCombatSync() {
  if (!mpChannel) return;
  mpChannel.send({
    type: 'broadcast',
    event: 'combat:sync',
    payload: buildCombatSyncPayload(),
  });
}

function buildSpecialSyncPayload() {
  return {
    matchId: currentMatchId,
    items: cloneSpecialItems(specialItems),
  };
}

function applySpecialSync(payload) {
  if (payload?.matchId && currentMatchId && payload.matchId !== currentMatchId) return false;
  specialItems = cloneSpecialItems(payload?.items || []);
  pendingSpecialClaims.forEach((itemId) => {
    if (!specialItems.some((item) => item.id === itemId)) {
      pendingSpecialClaims.delete(itemId);
    }
  });
  gameplayLayerDirty = true;
  return true;
}

function broadcastSpecialSync() {
  if (!mpChannel) return;
  mpChannel.send({
    type: 'broadcast',
    event: 'special:sync',
    payload: buildSpecialSyncPayload(),
  });
}

function cloneSpawnAssignment(spawn) {
  if (!spawn?.head || !spawn?.dir) return null;
  return {
    head: { ...spawn.head },
    dir: { ...spawn.dir },
  };
}

function cloneMatchPlayers(players = []) {
  return players
    .filter((player) => player?.username)
    .map((player) => ({
      username: player.username,
      color: player.color || null,
      spawn: cloneSpawnAssignment(player.spawn),
    }));
}

function clearCurrentMatchSnapshot() {
  currentMatchId = null;
  pendingMatchFoods = null;
  matchStartAt = null;
  currentMatchPlayers = [];
}

function setCurrentMatchPlayers(players = []) {
  currentMatchPlayers = cloneMatchPlayers(players);
}

function getCurrentMatchPlayer(username) {
  return currentMatchPlayers.find((player) => player.username === username) || null;
}

function getTrackedMatchPlayers() {
  if (currentMatchPlayers.length) {
    return cloneMatchPlayers(currentMatchPlayers);
  }

  const fallbackPlayers = [{
    username: currentUser?.username,
    color: myColor,
    spawn: null,
  }];

  peers.forEach((peer, username) => {
    fallbackPlayers.push({
      username,
      color: peer.color || '#ccc',
      spawn: null,
    });
  });

  return cloneMatchPlayers(fallbackPlayers);
}

function getTrackedMatchPlayerIds() {
  return getTrackedMatchPlayers()
    .map((player) => player.username)
    .filter(Boolean);
}

function getCanonicalMatchPlayers() {
  const participants = new Map();
  const presenceState = mpChannel ? mpChannel.presenceState() : {};

  Object.entries(presenceState).forEach(([presenceKey, presences]) => {
    const latestPresence = presences[presences.length - 1] || {};
    const username = latestPresence.username || presenceKey;
    if (!username) return;
    participants.set(username, {
      username,
      color: latestPresence.color || null,
    });
  });

  if (currentUser?.username && !participants.has(currentUser.username)) {
    participants.set(currentUser.username, {
      username: currentUser.username,
      color: myColor,
    });
  }

  const spawnSlots = getMultiplayerSpawnSlots();
  return Array.from(participants.values())
    .sort((a, b) => a.username.localeCompare(b.username))
    .map((player, index) => ({
      ...player,
      spawn: cloneSpawnAssignment(spawnSlots[index % spawnSlots.length]),
    }));
}

function seedPeersFromMatchPlayers() {
  const nextPeers = new Map();

  currentMatchPlayers.forEach((player) => {
    if (player.username === currentUser?.username) {
      if (player.color) myColor = player.color;
      return;
    }

    const existing = peers.get(player.username) || {};
    nextPeers.set(player.username, {
      snake: existing.snake,
      score: existing.score || 0,
      color: player.color || existing.color || '#ccc',
      dead: existing.dead || false,
      survivalMs: existing.survivalMs,
    });
  });

  peers = nextPeers;
}

function updatePeer(payload) {
  const existing = peers.get(payload.id) || {};
  const nextSnake = cloneSnakeSegments(payload.snake || []);
  const previousSnake = existing.snake
    ? cloneSnakeSegments(existing.snake)
    : cloneSnakeSegments(nextSnake);
  peers.set(payload.id, {
    snake: nextSnake,
    prevSnake: previousSnake,
    score: payload.score,
    color: playerColors.get(payload.id) || payload.color || existing.color,
    dead: existing.dead || false,
    updatedAt: performance.now(),
    survivalMs: existing.survivalMs,
  });
  gameplayLayerDirty = true;

  if (multiplayerMode && isHost) {
    resolvePeerStateCollisions(payload.id);
  }

  if (!multiplayerMode || gameOver || spectating || !snake || !snake.length) return;
  const localCollision = getPeerCollision(snake[0]);
  if (localCollision) endGame({ cause: 'peer-state', collision: localCollision });
}

function buildSpawnSnake(head, direction, length = 3) {
  return Array.from({ length }, (_, index) => ({
    x: head.x - direction.x * index,
    y: head.y - direction.y * index,
  }));
}

function getMultiplayerSpawnSlots() {
  const midX = Math.floor(COLS / 2);
  const midY = Math.floor(ROWS / 2);

  return [
    { head: { x: 4, y: midY }, dir: { x: 1, y: 0 } },
    { head: { x: COLS - 5, y: midY }, dir: { x: -1, y: 0 } },
    { head: { x: midX, y: 4 }, dir: { x: 0, y: 1 } },
    { head: { x: midX, y: ROWS - 5 }, dir: { x: 0, y: -1 } },
    { head: { x: 4, y: 4 }, dir: { x: 1, y: 0 } },
    { head: { x: COLS - 5, y: ROWS - 5 }, dir: { x: -1, y: 0 } },
    { head: { x: COLS - 5, y: 4 }, dir: { x: -1, y: 0 } },
    { head: { x: 4, y: ROWS - 5 }, dir: { x: 1, y: 0 } },
  ];
}

function getInitialSpawnState() {
  if (!multiplayerMode || !currentUser) {
    return {
      snake: buildSpawnSnake({ x: 15, y: 15 }, { x: 1, y: 0 }),
      dir: { x: 1, y: 0 },
    };
  }

  const matchPlayer = getCurrentMatchPlayer(currentUser.username);
  if (matchPlayer?.spawn) {
    return {
      snake: buildSpawnSnake(matchPlayer.spawn.head, matchPlayer.spawn.dir),
      dir: { ...matchPlayer.spawn.dir },
    };
  }

  if (!mpChannel) {
    return {
      snake: buildSpawnSnake({ x: 15, y: 15 }, { x: 1, y: 0 }),
      dir: { x: 1, y: 0 },
    };
  }

  const participantIds = Object.keys(mpChannel.presenceState());
  if (!participantIds.includes(currentUser.username)) {
    participantIds.push(currentUser.username);
  }
  participantIds.sort((a, b) => a.localeCompare(b));

  const spawnSlots = getMultiplayerSpawnSlots();
  const slot = spawnSlots[participantIds.indexOf(currentUser.username) % spawnSlots.length] || spawnSlots[0];

  return {
    snake: buildSpawnSnake(slot.head, slot.dir),
    dir: { ...slot.dir },
  };
}

function cloneFoods(foodItems = []) {
  return foodItems.map((foodItem) => ({ ...foodItem }));
}

function startCountdown(startPayload = null) {
  if (startPayload?.matchId) currentMatchId = startPayload.matchId;
  if (multiplayerMode) {
    setCurrentMatchPlayers(startPayload?.players?.length ? startPayload.players : getCanonicalMatchPlayers());
    pendingMatchFoods = startPayload?.foods ? cloneFoods(startPayload.foods) : null;
    matchStartAt = startPayload?.startsAt ?? (Date.now() + MATCH_COUNTDOWN_MS);
  } else {
    setCurrentMatchPlayers([]);
    pendingMatchFoods = null;
    matchStartAt = null;
  }
  score = 0;
  if (typeof scoreEl !== 'undefined' && scoreEl) {
    scoreEl.textContent = '0';
  }
  applyRoomSettings(startPayload?.roomSettings || getDefaultRoomSettings(), startPayload?.roomSettingsUpdatedAt ?? Date.now());
  applyCombatSync({
    matchId: startPayload?.matchId ?? currentMatchId,
    ...(startPayload?.combatState || buildCombatSyncPayload()),
  });
  applySpecialSync({
    matchId: startPayload?.matchId ?? currentMatchId,
    items: startPayload?.specialItems || [],
  });
  matchResults.clear();
  countdownActive = true;
  pendingStartDirection = null;
  lastMultiplayerHudKey = '';
  roomStage = multiplayerMode ? 'playing' : 'browse';
  syncLobbyPresence();
  if (multiplayerMode && typeof syncLobbyRoomState === 'function') {
    void syncLobbyRoomState({
      force: true,
      eventName: 'room:update',
      reason: 'countdown-start',
    });
  }
  showCanvas();
  if (typeof syncLeaderboardToGameMode === 'function') syncLeaderboardToGameMode();
  peers.clear();
  seedPeersFromMatchPlayers();
  deadPlayers.clear();
  if (multiplayerMode) renderMultiplayerHud(true);
  let count = 3;

  function drawCount(n) {
    buildBackgroundCache(true);
    ctx.drawImage(backgroundCanvas, 0, 0);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 120px system-ui';
    ctx.fillStyle = '#39ff14';
    ctx.shadowColor = '#39ff14';
    ctx.shadowBlur = 40;
    ctx.fillText(n > 0 ? String(n) : 'GO!', canvas.width / 2, canvas.height / 2);
    ctx.shadowBlur = 0;
    ctx.textBaseline = 'alphabetic';
    if (multiplayerMode) renderMultiplayerHud();
  }

  drawCount(count);
  const timer = setInterval(() => {
    count--;
    if (count > 0) {
      drawCount(count);
    } else if (count === 0) {
      drawCount(0);
    } else {
      clearInterval(timer);
      countdownActive = false;
      init();
    }
  }, 1000);
}

function getActiveMultiplayerPlayerCount() {
  if (currentMatchPlayers.length) return currentMatchPlayers.length;
  if (!mpChannel) return 1;
  return Math.max(1, Object.keys(mpChannel.presenceState()).length);
}

function getFoodTargetCount() {
  return multiplayerMode ? getActiveMultiplayerPlayerCount() : 1;
}

function generateFoodId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function generateMatchId() {
  return `match-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function generateSpecialItemId(type = 'special') {
  return `${type}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isSamePosition(pos, other) {
  return Boolean(pos && other) && pos.x === other.x && pos.y === other.y;
}

function getSnakeForPlayer(playerId) {
  if (playerId === currentUser?.username) return snake || [];
  return peers.get(playerId)?.snake || [];
}

function setSnakeForPlayer(playerId, nextSnake = []) {
  const clonedSnake = nextSnake.map((segment) => ({ ...segment }));
  if (playerId === currentUser?.username) {
    snake = clonedSnake;
  } else {
    const peer = peers.get(playerId);
    if (peer) {
      peer.snake = clonedSnake;
    }
  }
  gameplayLayerDirty = true;
}

function isPositionOccupiedByPeer(pos) {
  for (const peer of peers.values()) {
    if (!peer?.snake || !peer.snake.length) continue;
    if (peer.dead && !isCorpseCollisionEnabled()) continue;
    if (peer.snake.some((segment) => segment.x === pos.x && segment.y === pos.y)) {
      return true;
    }
  }
  return false;
}

function isFoodBlockedPosition(pos, existingFoods = []) {
  if (Array.isArray(snake) && snake.some((segment) => segment.x === pos.x && segment.y === pos.y)) {
    return true;
  }
  if (isPositionOccupiedByPeer(pos)) {
    return true;
  }
  if (specialItems.some((item) => isSamePosition(item, pos))) {
    return true;
  }
  return existingFoods.some((foodItem) => foodItem.x === pos.x && foodItem.y === pos.y);
}

function isPickupBlockedPosition(pos, existingSpecialItems = []) {
  if (Array.isArray(snake) && snake.some((segment) => isSamePosition(segment, pos))) {
    return true;
  }
  if (peers.size) {
    for (const peer of peers.values()) {
      if (!peer?.snake || !peer.snake.length) continue;
      if (peer.snake.some((segment) => isSamePosition(segment, pos))) {
        return true;
      }
    }
  }
  if (foods.some((foodItem) => isSamePosition(foodItem, pos))) {
    return true;
  }
  return existingSpecialItems.some((item) => isSamePosition(item, pos));
}

function createFoodItem(existingFoods = []) {
  let pos;
  do {
    pos = { x: Math.floor(Math.random() * COLS), y: Math.floor(Math.random() * ROWS) };
  } while (isFoodBlockedPosition(pos, existingFoods));

  return { id: generateFoodId(), x: pos.x, y: pos.y };
}

function createSpecialItem(type, existingItems = []) {
  let pos;
  do {
    pos = { x: Math.floor(Math.random() * COLS), y: Math.floor(Math.random() * ROWS) };
  } while (isPickupBlockedPosition(pos, existingItems));

  return {
    id: generateSpecialItemId(type),
    type,
    x: pos.x,
    y: pos.y,
  };
}

function refillFoods(baseFoods = []) {
  const nextFoods = baseFoods.map((foodItem) => ({ ...foodItem }));
  const targetCount = getFoodTargetCount();

  while (nextFoods.length < targetCount) {
    nextFoods.push(createFoodItem(nextFoods));
  }

  return nextFoods;
}

function resetFoodsForCurrentMode() {
  pendingGrowth = 0;
  pendingFoodClaims.clear();

  if (!multiplayerMode) {
    clearCurrentMatchSnapshot();
    resetCombatState();
    foods = refillFoods([]);
    gameplayLayerDirty = true;
    return;
  }

  if (pendingMatchFoods) {
    foods = cloneFoods(pendingMatchFoods);
    pendingMatchFoods = null;
  } else {
    foods = [];
  }
  gameplayLayerDirty = true;
}

function getFoodAtPosition(pos) {
  return foods.find((foodItem) => foodItem.x === pos.x && foodItem.y === pos.y) || null;
}

function getSpecialItemsByType(type) {
  return specialItems.filter((item) => item.type === type);
}

function maybeSpawnSpecialItems() {
  if (!isShootingEnabled()) return false;

  let changed = false;
  const nextItems = cloneSpecialItems(specialItems);

  if (!getSpecialItemsByType('ammo').length && Math.random() < BLUE_AMMO_DROP_CHANCE) {
    nextItems.push(createSpecialItem('ammo', nextItems));
    changed = true;
  }

  if (!getSpecialItemsByType('life').length && Math.random() < YELLOW_LIFE_DROP_CHANCE) {
    nextItems.push(createSpecialItem('life', nextItems));
    changed = true;
  }

  if (changed) {
    specialItems = nextItems;
    gameplayLayerDirty = true;
  }

  return changed;
}

function broadcastFoodsSync(scoredPlayerId = null, claimedFoodId = null) {
  if (!mpChannel) return;
  mpChannel.send({
    type: 'broadcast',
    event: 'foods:sync',
    payload: {
      matchId: currentMatchId,
      foods,
      scoredPlayerId,
      claimedFoodId,
    },
  });
}

function applyFoodsSync(payload) {
  if (payload.matchId && currentMatchId && payload.matchId !== currentMatchId) return;
  if (payload.matchId) currentMatchId = payload.matchId;
  foods = (payload.foods || []).map((foodItem) => ({ ...foodItem }));

  if (payload.claimedFoodId) {
    pendingFoodClaims.delete(payload.claimedFoodId);
  }

  pendingFoodClaims.forEach((foodId) => {
    if (!foods.some((foodItem) => foodItem.id === foodId)) {
      pendingFoodClaims.delete(foodId);
    }
  });

  if (payload.scoredPlayerId) {
    if (payload.scoredPlayerId === currentUser.username) {
      pendingGrowth += 1;
      score += 10;
      scoreEl.textContent = score;
    } else {
      const peer = peers.get(payload.scoredPlayerId);
      if (peer) peer.score = (peer.score || 0) + 10;
    }
  }

  gameplayLayerDirty = true;
}

function requestFoodClaim(foodId) {
  if (!mpChannel || pendingFoodClaims.has(foodId)) return;
  pendingFoodClaims.add(foodId);
  mpChannel.send({
    type: 'broadcast',
    event: 'food:claim',
    payload: { foodId, playerId: currentUser.username },
  });
}

function resolveFoodClaim(foodId, playerId) {
  if (!isHost) return false;
  if (!foods.some((foodItem) => foodItem.id === foodId)) return false;

  foods = foods.filter((foodItem) => foodItem.id !== foodId);
  foods = refillFoods(foods);
  const spawnedSpecials = maybeSpawnSpecialItems();

  if (playerId === currentUser.username) {
    score += 10;
    scoreEl.textContent = score;
  } else {
    const peer = peers.get(playerId);
    if (peer) peer.score = (peer.score || 0) + 10;
  }

  gameplayLayerDirty = true;
  broadcastFoodsSync(playerId, foodId);
  if (spawnedSpecials) {
    broadcastSpecialSync();
  }
  return true;
}

function requestSpecialClaim(itemId) {
  if (!mpChannel || pendingSpecialClaims.has(itemId)) return;
  pendingSpecialClaims.add(itemId);
  mpChannel.send({
    type: 'broadcast',
    event: 'special:claim',
    payload: {
      itemId,
      playerId: currentUser.username,
      matchId: currentMatchId,
    },
  });
}

function resolveSpecialClaim(itemId, playerId, matchId = currentMatchId) {
  if (!isHost) return false;
  if (matchId && currentMatchId && matchId !== currentMatchId) return false;
  const item = specialItems.find((entry) => entry.id === itemId);
  if (!item) return false;

  specialItems = specialItems.filter((entry) => entry.id !== itemId);
  pendingSpecialClaims.delete(itemId);

  const currentState = getCombatState(playerId);
  if (item.type === 'ammo') {
    setCombatState(playerId, {
      ...currentState,
      ammo: Math.min(MAX_AMMO, currentState.ammo + 1),
    });
  } else if (item.type === 'life') {
    setCombatState(playerId, {
      ...currentState,
      headLives: Math.min(MAX_HEAD_LIVES, currentState.headLives + 1),
    });
  }

  gameplayLayerDirty = true;
  broadcastSpecialSync();
  broadcastCombatSync();
  return true;
}

function isSameCell(a, b) {
  return Boolean(a && b) && a.x === b.x && a.y === b.y;
}

function cloneSnakeSegments(snakeSegments = []) {
  return snakeSegments.map((segment) => ({ ...segment }));
}

function getDisplayColorForPlayer(playerId) {
  if (playerId === currentUser?.username) return myColor;
  return playerColors.get(playerId)
    || peers.get(playerId)?.color
    || getTrackedMatchPlayers().find((player) => player.username === playerId)?.color
    || '#7bd3ff';
}

function addShotEffect(effect) {
  if (!effect?.origin || !effect?.cell) return;
  recentShotEffects.push({
    shooterId: effect.shooterId || null,
    origin: { ...effect.origin },
    cell: { ...effect.cell },
    result: effect.result || 'miss',
    createdAt: Date.now(),
  });
}

function getActiveShotEffects() {
  const now = Date.now();
  recentShotEffects = recentShotEffects.filter((effect) => now - effect.createdAt < SHOT_EFFECT_MS);
  return recentShotEffects;
}

function getSegmentIndexAtPosition(snakeSegments = [], pos) {
  return snakeSegments.findIndex((segment) => isSameCell(segment, pos));
}

function normalizeShotDirection(direction) {
  if (!direction) return null;
  const x = Number(direction.x) || 0;
  const y = Number(direction.y) || 0;
  if (Math.abs(x) + Math.abs(y) !== 1) return null;
  return { x, y };
}

function getAvailableAmmoForShotInput() {
  const ammo = getAmmoCount(currentUser?.username);
  return isHost ? ammo : Math.max(0, ammo - pendingShotRequests);
}

function canCurrentPlayerShoot() {
  return (
    multiplayerMode &&
    roomStage === 'playing' &&
    isShootingEnabled() &&
    !gameOver &&
    !spectating &&
    !countdownActive &&
    !deadPlayers.has(currentUser?.username) &&
    getAvailableAmmoForShotInput() > 0
  );
}

function getShotCollisionAtCell(shooterId, pos) {
  if (currentUser?.username !== shooterId && snake?.length) {
    const localIndex = getSegmentIndexAtPosition(snake, pos);
    if (localIndex >= 0) {
      if (deadPlayers.has(currentUser.username)) {
        if (isCorpseCollisionEnabled()) {
          return { type: 'corpse', targetId: currentUser.username, segmentIndex: localIndex };
        }
      } else {
        return {
          type: localIndex === 0 ? 'head' : 'body',
          targetId: currentUser.username,
          segmentIndex: localIndex,
        };
      }
    }
  }

  for (const [playerId, peer] of peers.entries()) {
    if (playerId === shooterId || !peer?.snake || !peer.snake.length) continue;
    const segmentIndex = getSegmentIndexAtPosition(peer.snake, pos);
    if (segmentIndex < 0) continue;

    if (peer.dead) {
      if (isCorpseCollisionEnabled()) {
        return { type: 'corpse', targetId: playerId, segmentIndex };
      }
      continue;
    }

    return {
      type: segmentIndex === 0 ? 'head' : 'body',
      targetId: playerId,
      segmentIndex,
    };
  }

  return null;
}

function traceShotImpact(shooterId, origin, direction) {
  const normalizedDirection = normalizeShotDirection(direction);
  if (!normalizedDirection || !origin) return { type: 'invalid', cell: null };

  let cursor = {
    x: origin.x + normalizedDirection.x,
    y: origin.y + normalizedDirection.y,
  };

  while (!isOutOfBounds(cursor)) {
    const collision = getShotCollisionAtCell(shooterId, cursor);
    if (collision) {
      return {
        ...collision,
        cell: { ...cursor },
      };
    }

    cursor = {
      x: cursor.x + normalizedDirection.x,
      y: cursor.y + normalizedDirection.y,
    };
  }

  return {
    type: 'wall',
    cell: {
      x: cursor.x - normalizedDirection.x,
      y: cursor.y - normalizedDirection.y,
    },
  };
}

function buildShotResolvedPayload(payload = {}) {
  return {
    matchId: payload.matchId ?? currentMatchId,
    shooterId: payload.shooterId || null,
    targetId: payload.targetId || null,
    result: payload.result || 'miss',
    origin: payload.origin ? { ...payload.origin } : null,
    cell: payload.cell ? { ...payload.cell } : null,
    headLives: typeof payload.headLives === 'number' ? payload.headLives : null,
    targetSnake: Array.isArray(payload.targetSnake) ? cloneSnakeSegments(payload.targetSnake) : null,
  };
}

function broadcastShotResolved(payload) {
  if (!mpChannel) return;
  mpChannel.send({
    type: 'broadcast',
    event: 'shot:resolved',
    payload: buildShotResolvedPayload(payload),
  });
}

function applyShotResolved(payload) {
  if (!payload) return false;
  if (payload.matchId && currentMatchId && payload.matchId !== currentMatchId) return false;
  addShotEffect(payload);
  if (payload.targetId && Array.isArray(payload.targetSnake)) {
    setSnakeForPlayer(payload.targetId, payload.targetSnake);
    if (
      payload.targetId === currentUser?.username &&
      multiplayerMode &&
      !deadPlayers.has(currentUser.username)
    ) {
      broadcastSnakeState();
    }
  }
  gameplayLayerDirty = true;
  return true;
}

function requestShotFire(direction) {
  if (!mpChannel || !canCurrentPlayerShoot()) return false;
  const normalizedDirection = normalizeShotDirection(direction);
  if (!normalizedDirection || !snake?.length) return false;
  pendingShotRequests += 1;
  mpChannel.send({
    type: 'broadcast',
    event: 'shot:fire',
    payload: {
      matchId: currentMatchId,
      playerId: currentUser.username,
      head: { ...snake[0] },
      direction: normalizedDirection,
    },
  });
  return true;
}

function resolveShotFire(payload) {
  if (!isHost || !isShootingEnabled()) return false;
  if (payload?.matchId && currentMatchId && payload.matchId !== currentMatchId) return false;

  const shooterId = payload?.playerId;
  if (!shooterId || deadPlayers.has(shooterId)) return false;

  const shooterSnake = getSnakeForPlayer(shooterId);
  if (!shooterSnake.length) return false;

  const shotDirection = normalizeShotDirection(payload.direction);
  if (!shotDirection) return false;

  const shooterState = getCombatState(shooterId);
  if (shooterState.ammo <= 0) {
    broadcastCombatSync();
    return false;
  }

  setCombatState(shooterId, {
    ...shooterState,
    ammo: shooterState.ammo - 1,
  });

  const impact = traceShotImpact(shooterId, shooterSnake[0], shotDirection);
  const resolvedPayload = {
    matchId: currentMatchId,
    shooterId,
    origin: { ...shooterSnake[0] },
    cell: impact.cell,
    result: 'miss',
  };

  if (impact.type === 'body') {
    const currentSnake = getSnakeForPlayer(impact.targetId);
    const nextSnake = cloneSnakeSegments(currentSnake.slice(0, impact.segmentIndex + 1));
    setSnakeForPlayer(impact.targetId, nextSnake);
    Object.assign(resolvedPayload, {
      result: 'body-cut',
      targetId: impact.targetId,
      targetSnake: nextSnake,
    });
  } else if (impact.type === 'head') {
    const nextHeadLives = Math.max(0, getHeadLives(impact.targetId) - 1);
    setCombatState(impact.targetId, {
      ...getCombatState(impact.targetId),
      headLives: nextHeadLives,
    });
    Object.assign(resolvedPayload, {
      result: 'head-hit',
      targetId: impact.targetId,
      headLives: nextHeadLives,
    });
    if (nextHeadLives <= 0) {
      clearAllCorpseDamageForPlayer(impact.targetId);
      broadcastResolvedDeath(buildResolvedDeathPayload(impact.targetId, {
        reason: 'shot-head',
        head: impact.cell,
      }));
    }
  } else if (impact.type === 'corpse') {
    const damage = getCorpseDamage(impact.targetId, impact.cell);
    if (damage >= 1) {
      markCorpseDamage(impact.targetId, impact.cell, 0);
      const nextSnake = cloneSnakeSegments(
        getSnakeForPlayer(impact.targetId).filter((segment) => !isSameCell(segment, impact.cell))
      );
      setSnakeForPlayer(impact.targetId, nextSnake);
      Object.assign(resolvedPayload, {
        result: 'corpse-opened',
        targetId: impact.targetId,
        targetSnake: nextSnake,
      });
    } else {
      markCorpseDamage(impact.targetId, impact.cell, 1);
      Object.assign(resolvedPayload, {
        result: 'corpse-damaged',
        targetId: impact.targetId,
      });
    }
  }

  applyShotResolved(resolvedPayload);
  broadcastShotResolved(resolvedPayload);
  broadcastCombatSync();
  return true;
}

function getPeerCollision(position) {
  for (const [playerId, peer] of peers.entries()) {
    if (!peer.snake || !peer.snake.length) continue;

    if (peer.dead) {
      if (!isCorpseCollisionEnabled()) continue;
      if (peer.snake.some((segment) => isSameCell(position, segment))) {
        return { type: 'corpse', playerId };
      }
      continue;
    }

    const [peerHead, ...peerBody] = peer.snake;
    if (isSameCell(position, peerHead)) return { type: 'head', playerId };
    if (peerBody.some((segment) => isSameCell(position, segment))) return { type: 'body', playerId };
  }

  return null;
}

function buildResolvedDeathPayload(playerId, overrides = {}) {
  const isCurrentPlayer = playerId === currentUser.username;
  const playerState = isCurrentPlayer ? { snake, score } : peers.get(playerId);
  const resolvedAt = overrides.resolvedAt ?? Date.now();
  const survivalMs = typeof overrides.survivalMs === 'number'
    ? overrides.survivalMs
    : Math.max(0, resolvedAt - (matchStartAt || resolvedAt));

  return {
    id: playerId,
    score: overrides.score ?? playerState?.score ?? 0,
    head: overrides.head ?? playerState?.snake?.[0] ?? null,
    reason: overrides.reason || 'resolved',
    matchId: overrides.matchId ?? currentMatchId,
    resolvedAt,
    survivalMs,
  };
}

function applyResolvedDeath(payload) {
  if (!payload?.id) return false;
  if (payload.matchId && currentMatchId && payload.matchId !== currentMatchId) return false;
  if (deadPlayers.has(payload.id)) return false;

  const resolvedAt = payload.resolvedAt ?? Date.now();
  const survivalMs = typeof payload.survivalMs === 'number'
    ? payload.survivalMs
    : Math.max(0, resolvedAt - (matchStartAt || resolvedAt));

  clearAllCorpseDamageForPlayer(payload.id);
  deadPlayers.add(payload.id);
  matchResults.set(payload.id, {
    score: payload.score ?? 0,
    survivalMs,
    resolvedAt,
  });

  if (payload.id === currentUser.username) {
    gameOver = true;
    spectating = true;
    stopSimulation();
    if (typeof payload.score === 'number') {
      score = payload.score;
      scoreEl.textContent = score;
    }
  } else {
    const peer = peers.get(payload.id);
    if (peer) {
      peer.dead = true;
      if (typeof payload.score === 'number') {
        peer.score = payload.score;
      }
      peer.survivalMs = survivalMs;
    }
  }

  gameplayLayerDirty = true;
  checkAllDead();
  return true;
}

function broadcastResolvedDeath(payload) {
  if (!isHost || !payload?.id) return false;

  const resolvedPayload = {
    ...payload,
    matchId: payload.matchId ?? currentMatchId,
  };

  if (!applyResolvedDeath(resolvedPayload)) return false;

  if (mpChannel) {
    mpChannel.send({
      type: 'broadcast',
      event: 'player:dead',
      payload: resolvedPayload,
    });
  }

  return true;
}

function requestDeathResolution(payload) {
  if (!multiplayerMode || !mpChannel || isHost || !payload?.id) return;

  mpChannel.send({
    type: 'broadcast',
    event: 'player:death-claim',
    payload: {
      ...payload,
      matchId: payload.matchId ?? currentMatchId,
    },
  });
}

function getHeadOnCounterpartId(playerId, head) {
  if (!head) return null;

  if (
    currentUser?.username &&
    currentUser.username !== playerId &&
    !deadPlayers.has(currentUser.username) &&
    snake &&
    snake.length &&
    isSameCell(snake[0], head)
  ) {
    return currentUser.username;
  }

  for (const [otherPlayerId, peer] of peers.entries()) {
    if (otherPlayerId === playerId || peer.dead || !peer.snake || !peer.snake.length) continue;
    if (isSameCell(peer.snake[0], head)) return otherPlayerId;
  }

  return null;
}

function resolveDeathClaim(payload) {
  if (!isHost || !payload?.id) return;
  if (payload.matchId && currentMatchId && payload.matchId !== currentMatchId) return;

  broadcastResolvedDeath(buildResolvedDeathPayload(payload.id, payload));

  const counterpartId = getHeadOnCounterpartId(payload.id, payload.head);
  if (!counterpartId) return;

  broadcastResolvedDeath(buildResolvedDeathPayload(counterpartId, { reason: 'head-on' }));
}

function isSnakeSelfColliding(snakeSegments) {
  if (!snakeSegments || snakeSegments.length < 2) return false;
  const [head, ...body] = snakeSegments;
  return body.some((segment) => isSameCell(head, segment));
}

function resolvePeerStateCollisions(playerId) {
  if (!isHost || deadPlayers.has(playerId)) return;

  const playerState = peers.get(playerId);
  if (!playerState?.snake || !playerState.snake.length) return;

  const [head] = playerState.snake;
  if (isOutOfBounds(head) || isSnakeSelfColliding(playerState.snake)) {
    broadcastResolvedDeath(buildResolvedDeathPayload(playerId, { reason: 'state-invalid', head }));
    return;
  }

  if (
    currentUser.username !== playerId &&
    snake &&
    snake.length &&
    (!deadPlayers.has(currentUser.username) || isCorpseCollisionEnabled())
  ) {
    const [hostHead, ...hostBody] = snake;
    if (!deadPlayers.has(currentUser.username) && isSameCell(head, hostHead)) {
      broadcastResolvedDeath(buildResolvedDeathPayload(playerId, { reason: 'head-on', head }));
      broadcastResolvedDeath(buildResolvedDeathPayload(currentUser.username, { reason: 'head-on' }));
      return;
    }
    if ((deadPlayers.has(currentUser.username) ? snake : hostBody).some((segment) => isSameCell(head, segment))) {
      broadcastResolvedDeath(buildResolvedDeathPayload(playerId, { reason: 'body-collision', head }));
      return;
    }
  }

  for (const [otherPlayerId, otherPeer] of peers.entries()) {
    if (otherPlayerId === playerId || !otherPeer.snake || !otherPeer.snake.length) continue;

    if (otherPeer.dead) {
      if (!isCorpseCollisionEnabled()) continue;
      if (otherPeer.snake.some((segment) => isSameCell(head, segment))) {
        broadcastResolvedDeath(buildResolvedDeathPayload(playerId, { reason: 'corpse-collision', head }));
        return;
      }
      continue;
    }

    const [otherHead, ...otherBody] = otherPeer.snake;
    if (isSameCell(head, otherHead)) {
      broadcastResolvedDeath(buildResolvedDeathPayload(playerId, { reason: 'head-on', head }));
      broadcastResolvedDeath(buildResolvedDeathPayload(otherPlayerId, { reason: 'head-on' }));
      return;
    }
    if (otherBody.some((segment) => isSameCell(head, segment))) {
      broadcastResolvedDeath(buildResolvedDeathPayload(playerId, { reason: 'body-collision', head }));
      return;
    }
  }
}

function prepareMatchStartPayload() {
  currentMatchId = generateMatchId();
  matchStartAt = Date.now() + MATCH_COUNTDOWN_MS;
  matchResults.clear();
  pendingGrowth = 0;
  pendingFoodClaims.clear();
  setCurrentMatchPlayers(getCanonicalMatchPlayers());
  initializeCombatStateForMatch();
  pendingMatchFoods = refillFoods([]);
  return {
    matchId: currentMatchId,
    players: cloneMatchPlayers(currentMatchPlayers),
    foods: cloneFoods(pendingMatchFoods),
    startsAt: matchStartAt,
    roomSettings: getRoomSettings(),
    roomSettingsUpdatedAt,
    combatState: buildCombatSyncPayload(),
    specialItems: cloneSpecialItems(specialItems),
  };
}

function broadcastSnakeState() {
  if (!mpChannel) return;
  mpChannel.send({
    type: 'broadcast',
    event: 'snake:state',
    payload: { id: currentUser.username, snake, score, color: myColor },
  });
}

function checkAllDead() {
  const matchPlayerIds = getTrackedMatchPlayerIds();
  if (!matchPlayerIds.length) return;

  const allResolved = matchPlayerIds.every((playerId) => deadPlayers.has(playerId));
  if (allResolved) {
    spectating = false;
    roomStage = 'ended';
    syncLobbyPresence();
    if (typeof syncLobbyRoomState === 'function') {
      void syncLobbyRoomState({
        force: true,
        eventName: 'room:close',
        reason: 'match-ended',
      });
    }
    stopRenderer();
    showMultiplayerEndScreen();
  }
}

function formatSurvivalTime(ms = 0) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function syncMultiplayerSidePanelLayout() {
  const columnsEl = document.getElementById('columns');
  const hudEl = document.getElementById('mp-game-hud');
  if (!columnsEl || !hudEl) return;

  const hudVisible = getComputedStyle(hudEl).display !== 'none';
  const hudHeight = hudVisible ? Math.ceil(hudEl.getBoundingClientRect().height) : 0;
  columnsEl.style.setProperty('--mp-hud-stack-height', `${hudHeight}px`);
}

function resetMultiplayerHud() {
  const hudEl = document.getElementById('mp-game-hud');
  const legendEl = document.getElementById('mp-legend-panel');
  const listEl = document.getElementById('mp-game-players');
  const timeEl = document.getElementById('mp-match-time');
  if (hudEl) hudEl.style.display = 'none';
  if (legendEl) legendEl.style.display = 'none';
  if (listEl) listEl.innerHTML = '';
  if (timeEl) timeEl.textContent = '0:00';
  lastMultiplayerHudKey = '';
  syncMultiplayerSidePanelLayout();
}

function getCurrentMatchElapsedMs() {
  if (!matchStartAt) return 0;
  return Math.max(0, Date.now() - matchStartAt);
}

function getMultiplayerHudPlayers(nowMs = getCurrentMatchElapsedMs()) {
  const players = getTrackedMatchPlayers().map((player) => {
    const isCurrentPlayer = player.username === currentUser.username;
    const peer = isCurrentPlayer ? null : peers.get(player.username);
    const combatState = getCombatState(player.username);
    return {
      username: player.username,
      color: isCurrentPlayer ? myColor : (player.color || peer?.color || '#ccc'),
      dead: deadPlayers.has(player.username),
      survivalMs: matchResults.get(player.username)?.survivalMs ?? peer?.survivalMs ?? nowMs,
      ammo: combatState.ammo,
      headLives: combatState.headLives,
    };
  });

  return players.sort((a, b) => {
    if (a.dead !== b.dead) return a.dead ? 1 : -1;
    if (!a.dead) return a.username.localeCompare(b.username);
    return b.survivalMs - a.survivalMs || a.username.localeCompare(b.username);
  });
}

function renderMultiplayerHud(force = false) {
  const hudEl = document.getElementById('mp-game-hud');
  const listEl = document.getElementById('mp-game-players');
  const timeEl = document.getElementById('mp-match-time');
  if (!hudEl || !listEl || !timeEl) return;

  const visible = multiplayerMode && (roomStage === 'playing' || countdownActive);
  if (!visible) {
    resetMultiplayerHud();
    return;
  }

  const elapsedMs = getCurrentMatchElapsedMs();
  const players = getMultiplayerHudPlayers(elapsedMs);
  const snapshotKey = JSON.stringify({
    elapsed: Math.floor(elapsedMs / 1000),
    players: players.map((player) => ({
      username: player.username,
      dead: player.dead,
      survival: Math.floor(player.survivalMs / 1000),
      color: player.color,
      ammo: player.ammo,
      headLives: player.headLives,
    })),
  });

  if (!force && snapshotKey === lastMultiplayerHudKey) {
    hudEl.style.display = 'flex';
    syncMultiplayerSidePanelLayout();
    return;
  }

  lastMultiplayerHudKey = snapshotKey;
  hudEl.style.display = 'flex';
  timeEl.textContent = formatSurvivalTime(elapsedMs);

  listEl.innerHTML = '';
  players.forEach((player) => {
    const li = document.createElement('li');
    if (player.dead) li.classList.add('dead');
    const statusMarkup = player.dead
      ? '<span class="mp-player-status dead" aria-label="Dead">&#9760;</span>'
      : `<span class="mp-player-status alive" style="background:${escHtml(player.color)}"></span>`;
    li.innerHTML = `
      ${statusMarkup}
      <span class="mp-player-main">
        <span class="mp-player-name">${escHtml(player.username)}</span>
        <span class="mp-player-meta">${player.headLives}/${MAX_HEAD_LIVES} head · ${player.ammo}/${MAX_AMMO} ammo</span>
      </span>
      <span class="mp-player-time">${escHtml(formatSurvivalTime(player.survivalMs))}</span>
    `;
    listEl.appendChild(li);
  });
  syncMultiplayerSidePanelLayout();
}

function getPlacementLabel(rank) {
  if (rank === 1) return '1st Place';
  if (rank === 2) return '2nd Place';
  if (rank === 3) return '3rd Place';
  return `${rank}th Place`;
}

function showMultiplayerEndScreen() {
  resetMultiplayerHud();
  const results = getTrackedMatchPlayers().map((player) => {
    const isCurrentPlayer = player.username === currentUser.username;
    const peer = isCurrentPlayer ? null : peers.get(player.username);
    return {
      username: player.username,
      score: isCurrentPlayer ? score : (peer?.score || 0),
      color: isCurrentPlayer ? myColor : (player.color || peer?.color || '#ccc'),
      survivalMs: matchResults.get(player.username)?.survivalMs ?? peer?.survivalMs ?? 0,
    };
  });
  results.sort((a, b) => (
    b.survivalMs - a.survivalMs ||
    b.score - a.score ||
    a.username.localeCompare(b.username)
  ));

  results.forEach((entry, index) => {
    entry.rank = index + 1;
  });

  const myResult = results.find((entry) => entry.username === currentUser.username) || results[0];
  const titleEl = document.getElementById('mp-end-title');
  const summaryEl = document.getElementById('mp-end-summary');
  const secondPlace = results[1] || null;
  const hasUniqueWin = myResult.rank === 1 && (!secondPlace || myResult.survivalMs > secondPlace.survivalMs);

  titleEl.textContent = hasUniqueWin
    ? '1st Place - You Won!'
    : getPlacementLabel(myResult.rank);
  summaryEl.textContent = `${myResult.score} pts · survived ${formatSurvivalTime(myResult.survivalMs)}`;

  const ul = document.getElementById('mp-end-scores');
  ul.innerHTML = '';
  results.forEach((r) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="end-rank">${escHtml(getPlacementLabel(r.rank))}</span>
      <span class="end-dot" style="background:${escHtml(r.color)}"></span>
      <span class="end-name">${escHtml(r.username)}</span>
      <span class="end-stat">${r.score} pts</span>
      <span class="end-stat">survived ${escHtml(formatSurvivalTime(r.survivalMs))}</span>
    `;
    ul.appendChild(li);
  });
  document.getElementById('mp-end-overlay').style.display = 'flex';
}
function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
