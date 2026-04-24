function showNothing() {
  document.getElementById('game-col')?.classList.remove('gameplay-active');
  document.getElementById('mp-entry').style.display = 'none';
  document.getElementById('mp-lobby').style.display = 'none';
  document.getElementById('canvas-wrap').style.display = 'none';
  document.getElementById('mp-game-hud').style.display = 'none';
  document.getElementById('score-display').style.display = 'none';
  const levelDisplay = document.getElementById('level-display');
  const legendPanel = document.getElementById('legend-panel');
  const multiplayerLegendPanel = document.getElementById('mp-legend-panel');
  if (levelDisplay) levelDisplay.style.display = 'none';
  if (legendPanel) legendPanel.style.display = 'none';
  if (multiplayerLegendPanel) multiplayerLegendPanel.style.display = 'none';
  document.getElementById('hint').style.display = 'none';
  setSoloLeaderboardVisible(false);
}

function showMpEntry() {
  syncLobbyBrowseUiState(true);
  renderLobbyUiState();
  if (!lobbyChannel) ensureLobbyChannel();
  syncLobbyPresence();
  renderAvailableRooms();
}

function showLobby() {
  setLobbyBrowseNotice('');
  setLobbyUiState(LOBBY_UI_STATE.IN_LOBBY);
}

function renderLobbyPendingState(message) {
  const list = document.getElementById('lobby-players');
  const statusEl = document.getElementById('lobby-status');
  const startBtn = document.getElementById('start-btn');

  if (list) {
    list.innerHTML = `<li>${escHtml(currentUser?.username || 'Player')}</li>`;
  }
  if (statusEl) {
    statusEl.textContent = message;
  }
  if (startBtn) {
    startBtn.style.display = 'none';
  }
  renderCorpseModeControl();
  renderShootingModeControl();
}

function renderLobbyUiState() {
  showNothing();

  if (
    lobbyUiState === LOBBY_UI_STATE.BROWSING ||
    lobbyUiState === LOBBY_UI_STATE.CONNECTING_LOBBY ||
    lobbyUiState === LOBBY_UI_STATE.RECONNECTING_LOBBY
  ) {
    document.getElementById('mp-entry').style.display = 'flex';
    setSoloLeaderboardVisible(true);
    if (typeof setLeaderboardMode === 'function') setLeaderboardMode('multiplayer');
    if (typeof fetchLeaderboard === 'function') fetchLeaderboard('multiplayer');
    renderAvailableRooms();
    return;
  }

  if (
    lobbyUiState === LOBBY_UI_STATE.CREATING_ROOM ||
    lobbyUiState === LOBBY_UI_STATE.JOINING_ROOM ||
    lobbyUiState === LOBBY_UI_STATE.IN_LOBBY ||
    lobbyUiState === LOBBY_UI_STATE.LEAVING_ROOM
  ) {
    document.getElementById('mp-lobby').style.display = 'flex';
    document.getElementById('room-code-display').textContent = roomId || '';

    if (lobbyUiState === LOBBY_UI_STATE.CREATING_ROOM) {
      renderLobbyPendingState(lobbyUiPendingMessage || 'Creating room…');
      return;
    }

    if (lobbyUiState === LOBBY_UI_STATE.JOINING_ROOM) {
      renderLobbyPendingState(lobbyUiPendingMessage || 'Joining room…');
      return;
    }

    if (lobbyUiState === LOBBY_UI_STATE.LEAVING_ROOM) {
      renderLobbyPendingState(lobbyUiPendingMessage || 'Leaving room…');
      return;
    }

    updateLobbyList();
    syncLobbyPresence();
  }
}

function renderAvailableRooms() {
  const statusEl = document.getElementById('mp-room-list-status');
  const listEl = document.getElementById('mp-room-list');

  if (!statusEl || !listEl) return;

  listEl.innerHTML = '';

  if (lobbyConnectionState !== LOBBY_CONNECTION_STATE.READY || !lobbyChannel) {
    statusEl.textContent = getLobbyBrowseStatusMessage() || 'Connecting to room list…';
    logRenderAvailableRooms('pending', {
      hasLobbyChannel: Boolean(lobbyChannel),
      lobbyConnectionState,
      lobbyChannelError,
    });
    return;
  }

  if (lobbyChannelError) {
    statusEl.textContent = lobbyChannelError;
    logRenderAvailableRooms('error', {
      lobbyChannelError,
      entries: getChannelPresenceSnapshot(lobbyChannel),
    });
    return;
  }

  const rooms = getDiscoveredOpenRooms();
  if (lobbyBrowseNotice) {
    statusEl.textContent = lobbyBrowseNotice;
  } else if (!rooms.length) {
    statusEl.textContent = 'No open rooms yet. Create one to start.';
  } else {
    statusEl.textContent = `${rooms.length} room${rooms.length === 1 ? '' : 's'} open`;
  }

  if (!rooms.length) {
    logRenderAvailableRooms('empty', {
      entries: getChannelPresenceSnapshot(lobbyChannel),
      rooms,
    });
    return;
  }

  logRenderAvailableRooms('rooms', {
    rooms,
    entries: getChannelPresenceSnapshot(lobbyChannel),
  });

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

function renderLobbyStatus(participantCount, hostUsername) {
  const statusEl = document.getElementById('lobby-status');
  const startBtn = document.getElementById('start-btn');
  const currentRoomState = typeof getCurrentLobbyRoomState === 'function'
    ? getCurrentLobbyRoomState()
    : null;

  if (!statusEl || !startBtn) return;

  const effectiveParticipantCount = currentRoomState?.playerCount || participantCount;
  const effectiveHostUsername = currentRoomState?.hostUsername || hostUsername;
  const waitingLabel = `${effectiveParticipantCount} player${effectiveParticipantCount === 1 ? '' : 's'} waiting`;
  startBtn.style.display = isHost ? 'block' : 'none';

  if (isHost) {
    statusEl.textContent = `${waitingLabel}. You are the host.`;
    return;
  }

  statusEl.textContent = effectiveHostUsername
    ? `${waitingLabel}. Waiting for ${effectiveHostUsername} to start…`
    : `${waitingLabel}. Waiting for host…`;
}
