const GLOBAL_LOBBY_CHANNEL = 'snake:lobby';

function showNothing() {
  document.getElementById('mp-entry').style.display = 'none';
  document.getElementById('mp-lobby').style.display = 'none';
  document.getElementById('canvas-wrap').style.display = 'none';
  document.getElementById('mp-game-hud').style.display = 'none';
  document.getElementById('score-display').style.display = 'none';
  document.getElementById('hint').style.display = 'none';
  setSoloLeaderboardVisible(false);
}

function showMpEntry() {
  showNothing();
  document.getElementById('mp-entry').style.display = 'flex';
  setSoloLeaderboardVisible(true);
  if (!lobbyChannel) ensureLobbyChannel();
  syncLobbyPresence();
  renderAvailableRooms();
}

function showLobby() {
  showNothing();
  document.getElementById('mp-lobby').style.display = 'flex';
  document.getElementById('room-code-display').textContent = roomId;
  updateLobbyList();
  syncLobbyPresence();
}

async function ensureLobbyChannel() {
  if (!currentUser) return;
  if (lobbyChannelReady && lobbyChannel) {
    syncLobbyPresence();
    renderAvailableRooms();
    return;
  }
  if (lobbyChannel) {
    renderAvailableRooms();
    return;
  }

  lobbyChannelReady = false;
  lobbyChannelError = null;

  const channel = sb.channel(GLOBAL_LOBBY_CHANNEL, {
    config: {
      presence: { key: currentUser.username },
    }
  });
  lobbyChannel = channel;

  channel
    .on('presence', { event: 'sync' }, () => {
      if (lobbyChannel !== channel) return;
      renderAvailableRooms();
    })
    .subscribe(async (status) => {
      if (lobbyChannel !== channel) return;

      if (status === 'SUBSCRIBED') {
        lobbyChannelReady = true;
        lobbyChannelError = null;
        await syncLobbyPresence();
        renderAvailableRooms();
        return;
      }

      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        lobbyChannelReady = false;
        lobbyChannelError = 'Room list unavailable right now.';
        lobbyChannel = null;
        renderAvailableRooms();
      }
    });

  renderAvailableRooms();
}

async function disconnectLobbyChannel() {
  if (!lobbyChannel) return;
  try {
    await lobbyChannel.unsubscribe();
  } catch (error) {}
  lobbyChannel = null;
  lobbyChannelReady = false;
  lobbyChannelError = null;
}

function getLobbyPresencePayload() {
  return {
    username: currentUser.username,
    roomId,
    isHost,
    roomStage,
    updatedAt: Date.now(),
  };
}

async function syncLobbyPresence() {
  if (!lobbyChannel || !currentUser) return;
  try {
    await lobbyChannel.track(getLobbyPresencePayload());
  } catch (error) {}
}

function getPresenceEntries(channel) {
  if (!channel) return [];
  const state = channel.presenceState();

  return Object.entries(state).map(([presenceKey, presences]) => {
    const latestPresence = presences[presences.length - 1] || {};
    return {
      ...latestPresence,
      username: latestPresence.username || presenceKey,
    };
  });
}

function resolveHostUsername(players) {
  const explicitHost = players
    .filter((player) => player.isHost)
    .sort((a, b) => a.username.localeCompare(b.username))[0];

  if (explicitHost) return explicitHost.username;

  return players
    .map((player) => player.username)
    .sort((a, b) => a.localeCompare(b))[0] || null;
}

function getOpenRooms() {
  const roomsById = new Map();

  getPresenceEntries(lobbyChannel).forEach((presence) => {
    if (!presence.roomId || presence.roomStage !== 'lobby') return;

    const room = roomsById.get(presence.roomId) || {
      id: presence.roomId,
      players: [],
      updatedAt: 0,
    };

    room.players.push({
      username: presence.username || '?',
      isHost: Boolean(presence.isHost),
    });
    room.updatedAt = Math.max(room.updatedAt, presence.updatedAt || 0);
    roomsById.set(room.id, room);
  });

  return Array.from(roomsById.values())
    .map((room) => ({
      id: room.id,
      host: resolveHostUsername(room.players),
      playerCount: room.players.length,
      updatedAt: room.updatedAt,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

function renderAvailableRooms() {
  const statusEl = document.getElementById('mp-room-list-status');
  const listEl = document.getElementById('mp-room-list');

  if (!statusEl || !listEl) return;

  listEl.innerHTML = '';

  if (lobbyChannelError) {
    statusEl.textContent = lobbyChannelError;
    return;
  }

  if (!lobbyChannel || !lobbyChannelReady) {
    statusEl.textContent = 'Connecting to room list…';
    return;
  }

  const rooms = getOpenRooms();
  if (!rooms.length) {
    statusEl.textContent = 'No open rooms yet. Create one to start.';
    return;
  }

  statusEl.textContent = `${rooms.length} room${rooms.length === 1 ? '' : 's'} open`;

  rooms.forEach((room) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mp-room-card';
    button.addEventListener('click', () => {
      joinRoomFromInput(room.id);
    });

    const waitingLabel = `${room.playerCount} player${room.playerCount === 1 ? '' : 's'} waiting`;
    button.innerHTML = `
      <span class="mp-room-main">
        <span class="mp-room-code">${escHtml(room.id)}</span>
        <span class="mp-room-meta">Host: ${escHtml(room.host || '?')} · ${waitingLabel}</span>
      </span>
      <span class="mp-room-join">Join</span>
    `;

    listEl.appendChild(button);
  });
}

function getRoomParticipants() {
  return getPresenceEntries(mpChannel)
    .map((presence) => ({
      username: presence.username || '?',
      color: presence.color || '#fff',
      isHost: Boolean(presence.isHost),
    }))
    .sort((a, b) => a.username.localeCompare(b.username));
}

async function syncRoomPresence() {
  if (!mpChannel || !currentUser) return;
  try {
    await mpChannel.track({
      username: currentUser.username,
      color: myColor,
      isHost,
    });
  } catch (error) {}
}

function broadcastRoomSettings() {
  if (!mpChannel || !isHost) return;
  mpChannel.send({
    type: 'broadcast',
    event: 'room:settings',
    payload: buildRoomSettingsPayload(),
  });
}

function requestRoomSettingsSync() {
  if (!mpChannel || isHost) return;
  mpChannel.send({
    type: 'broadcast',
    event: 'room:settings:request',
    payload: { roomId, requestedBy: currentUser.username },
  });
}

function applyRoomSettingsSync(payload) {
  if (!payload?.roomId || payload.roomId !== roomId) return;
  if (applyRoomSettings(payload.settings, payload.updatedAt)) {
    renderCorpseModeControl();
    renderShootingModeControl();
  }
}

function renderCorpseModeControl() {
  const toggle = document.getElementById('corpse-mode-toggle');
  if (!toggle) return;
  toggle.checked = isCorpseCollisionEnabled();
  toggle.disabled = !isHost;
}

function renderShootingModeControl() {
  const toggle = document.getElementById('shooting-mode-toggle');
  if (!toggle) return;
  toggle.checked = isShootingEnabled();
  toggle.disabled = !isHost;
}

function handleCorpseModeToggle(event) {
  if (!isHost) {
    event.target.checked = isCorpseCollisionEnabled();
    return;
  }

  updateRoomSettingsLocally({
    ...getRoomSettings(),
    corpseCollisionMode: Boolean(event.target.checked),
  });
  broadcastRoomSettings();
}

function handleShootingModeToggle(event) {
  if (!isHost) {
    event.target.checked = isShootingEnabled();
    return;
  }

  updateRoomSettingsLocally({
    ...getRoomSettings(),
    shootingEnabled: Boolean(event.target.checked),
  });
  broadcastRoomSettings();
}

function renderLobbyStatus(participantCount, hostUsername) {
  const statusEl = document.getElementById('lobby-status');
  const startBtn = document.getElementById('start-btn');

  if (!statusEl || !startBtn) return;

  const waitingLabel = `${participantCount} player${participantCount === 1 ? '' : 's'} waiting`;
  startBtn.style.display = isHost ? 'block' : 'none';

  if (isHost) {
    statusEl.textContent = `${waitingLabel}. You are the host.`;
    return;
  }

  statusEl.textContent = hostUsername
    ? `${waitingLabel}. Waiting for ${hostUsername} to start…`
    : `${waitingLabel}. Waiting for host…`;
}

function syncHostAssignment(participants) {
  const hostUsername = resolveHostUsername(participants);
  const nextIsHost = hostUsername === currentUser.username;

  if (nextIsHost !== isHost) {
    isHost = nextIsHost;
    syncRoomPresence();
    syncLobbyPresence();
    if (isHost) {
      broadcastRoomSettings();
    }
  }

  return hostUsername;
}

async function createRoom() {
  const id = Math.random().toString(36).substr(2, 6).toUpperCase();
  await joinChannel(id, true);
}

async function joinRoomFromInput(roomToJoin = null) {
  const roomInput = document.getElementById('room-input');
  const raw = roomToJoin || (roomInput ? roomInput.value.trim().toUpperCase() : '');
  if (!raw) return;
  if (roomToJoin && !getOpenRooms().some((room) => room.id === raw)) return;
  await joinChannel(raw, false);
}

async function joinChannel(id, hosting) {
  await ensureLobbyChannel();

  if (mpChannel) {
    try {
      await mpChannel.unsubscribe();
    } catch (error) {}
  }

  roomId = id;
  isHost = hosting;
  roomStage = 'lobby';
  multiplayerMode = true;
  if (hosting) resetRoomSettings();
  peers.clear();
  deadPlayers.clear();
  renderCorpseModeControl();
  renderShootingModeControl();

  mpChannel = sb.channel('snake:room-' + id, {
    config: {
      broadcast: { self: false },
      presence: { key: currentUser.username },
    }
  });

  mpChannel
    .on('presence', { event: 'sync' }, () => {
      updateLobbyList();
      if (isHost) {
        broadcastRoomSettings();
      }
    })
    .on('broadcast', { event: 'snake:state' }, ({ payload }) => updatePeer(payload))
    .on('broadcast', { event: 'foods:sync' }, ({ payload }) => applyFoodsSync(payload))
    .on('broadcast', { event: 'food:claim' }, ({ payload }) => {
      if (isHost) resolveFoodClaim(payload.foodId, payload.playerId);
    })
    .on('broadcast', { event: 'special:sync' }, ({ payload }) => applySpecialSync(payload))
    .on('broadcast', { event: 'special:claim' }, ({ payload }) => {
      if (isHost) resolveSpecialClaim(payload.itemId, payload.playerId, payload.matchId);
    })
    .on('broadcast', { event: 'combat:sync' }, ({ payload }) => applyCombatSync(payload))
    .on('broadcast', { event: 'room:settings' }, ({ payload }) => applyRoomSettingsSync(payload))
    .on('broadcast', { event: 'room:settings:request' }, ({ payload }) => {
      if (isHost && payload?.roomId === roomId) {
        broadcastRoomSettings();
      }
    })
    .on('broadcast', { event: 'shot:fire' }, ({ payload }) => {
      if (isHost) resolveShotFire(payload);
    })
    .on('broadcast', { event: 'shot:resolved' }, ({ payload }) => applyShotResolved(payload))
    .on('broadcast', { event: 'game:start' }, ({ payload }) => startCountdown(payload))
    .on('broadcast', { event: 'player:death-claim' }, ({ payload }) => {
      if (isHost) resolveDeathClaim(payload);
    })
    .on('broadcast', { event: 'player:dead' }, ({ payload }) => applyResolvedDeath(payload))
    .subscribe(async (status) => {
      if (status !== 'SUBSCRIBED') return;
      const state = mpChannel.presenceState();
      const count = Object.keys(state).length;
      myColor = PLAYER_COLORS[count % PLAYER_COLORS.length];
      await syncRoomPresence();
      await syncLobbyPresence();
      if (isHost) {
        broadcastRoomSettings();
      } else {
        requestRoomSettingsSync();
      }
      showLobby();
    });
}

function updateLobbyList() {
  const list = document.getElementById('lobby-players');
  if (!list) return;

  const participants = getRoomParticipants();
  const hostUsername = syncHostAssignment(participants);
  renderCorpseModeControl();
  renderShootingModeControl();
  list.innerHTML = '';

  participants.forEach((participant) => {
    const li = document.createElement('li');
    const hostBadge = participant.username === hostUsername
      ? '<span class="lobby-badge">Host</span>'
      : '';

    li.innerHTML = `
      <span class="lobby-dot" style="background:${escHtml(participant.color)}"></span>
      <span class="lobby-name">${escHtml(participant.username)}</span>
      ${hostBadge}
    `;
    list.appendChild(li);
  });

  renderLobbyStatus(participants.length, hostUsername);
}

function hostStartGame() {
  if (!isHost || !mpChannel) return;
  const startPayload = prepareMatchStartPayload();
  mpChannel.send({ type: 'broadcast', event: 'game:start', payload: startPayload });
  startCountdown(startPayload);
}

async function leaveRoom() {
  spectating = false;
  gameOver = true;
  stopGameLoop();
  document.getElementById('mp-end-overlay').style.display = 'none';

  if (mpChannel) {
    try {
      await mpChannel.unsubscribe();
    } catch (error) {}
    mpChannel = null;
  }

  multiplayerMode = false;
  roomId = null;
  roomStage = 'browse';
  isHost = false;
  clearCurrentMatchSnapshot();
  countdownActive = false;
  pendingStartDirection = null;
  resetRoomSettings();
  resetCombatState();
  peers.clear();
  deadPlayers.clear();
  await disconnectLobbyChannel();
  await ensureLobbyChannel();
  renderAvailableRooms();
  showMpEntry();
}
