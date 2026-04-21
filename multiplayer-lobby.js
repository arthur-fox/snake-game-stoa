const GLOBAL_LOBBY_CHANNEL = 'snake:lobby';
const LOBBY_RECONNECT_DELAY_MS = 600;
const LOBBY_JOIN_VERIFY_DELAY_MS = 900;
const HOST_PRESENCE_GRACE_MS = 8000;
const HOST_HANDOFF_LOCK_MS = 5000;
const LOBBY_CONNECTION_STATE = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  READY: 'ready',
  RECONNECTING: 'reconnecting',
  DISCONNECTING: 'disconnecting',
};
const LOBBY_UI_STATE = {
  IDLE: 'idle',
  BROWSING: 'browsing',
  CONNECTING_LOBBY: 'connecting_lobby',
  RECONNECTING_LOBBY: 'reconnecting_lobby',
  CREATING_ROOM: 'creating_room',
  JOINING_ROOM: 'joining_room',
  IN_LOBBY: 'in_lobby',
  LEAVING_ROOM: 'leaving_room',
};

let lobbyReconnectTimer = null;
let lobbyDisconnectExpected = false;
let lobbyConnectionState = LOBBY_CONNECTION_STATE.DISCONNECTED;
let lastLobbyPresencePayloadKey = null;
let lobbyUiState = LOBBY_UI_STATE.IDLE;
let lobbyUiPendingMessage = '';
let lobbyBrowseNotice = '';
let lobbyJoinVerificationTimer = null;
let activeLobbyJoinAttemptId = 0;
let hostResolutionTimer = null;
let roomDisconnectExpected = false;
let pendingRoomPresenceRefreshReason = null;
let pendingDepartedRoomSessions = new Map();
let recentHostRelinquish = null;
const debugSnapshotCache = new Map();

function isLobbyDebugEnabled(topic = null) {
  if (typeof window.mpIsDebugEnabled === 'function') {
    return window.mpIsDebugEnabled(topic, 'lobby');
  }
  return false;
}

function lobbyDebug(event, details = null, topic = null) {
  if (typeof window.mpDebugLog === 'function') {
    window.mpDebugLog('lobby', event, details, {
      topic,
      sessionId: clientSessionId,
    });
    return;
  }

  if (!isLobbyDebugEnabled(topic)) return;

  const sessionSuffix = typeof clientSessionId === 'string'
    ? clientSessionId.slice(-4)
    : '????';

  if (details === null) {
    console.debug(`[snake:lobby:${sessionSuffix}] ${event}`);
    return;
  }

  console.debug(`[snake:lobby:${sessionSuffix}] ${event}`, details);
}

function lobbyLifecycleDebug(event, details = null) {
  lobbyDebug(event, details, 'lifecycle');
}

function lobbyPresenceDebug(event, details = null) {
  lobbyDebug(event, details, 'presence');
}

function lobbyDiscoveryDebug(event, details = null) {
  lobbyDebug(event, details, 'discovery');
}

function lobbyRoomStateDebug(event, details = null) {
  lobbyDebug(event, details, 'room_state');
}

function lobbyHandoffDebug(event, details = null) {
  lobbyDebug(event, details, 'handoff');
}

function lobbyUiDebug(event, details = null) {
  lobbyDebug(event, details, 'ui');
}

function serializeDebugSnapshot(snapshot) {
  try {
    return JSON.stringify(snapshot);
  } catch (error) {
    return String(snapshot);
  }
}

function shouldLogDebugSnapshot(cacheKey, snapshot) {
  const nextSnapshotKey = serializeDebugSnapshot(snapshot);
  if (debugSnapshotCache.get(cacheKey) === nextSnapshotKey) {
    return false;
  }
  debugSnapshotCache.set(cacheKey, nextSnapshotKey);
  return true;
}

function clearLobbyDebugSnapshots() {
  debugSnapshotCache.clear();
}

function getChannelPresenceSnapshot(channel) {
  return getPresenceEntries(channel)
    .map((presence) => ({
      sessionId: presence.sessionId || '?',
      username: presence.username || '?',
      roomId: presence.roomId || null,
      roomStage: presence.roomStage || null,
      isHost: Boolean(presence.isHost),
      color: presence.color || null,
      updatedAt: presence.updatedAt || 0,
    }))
    .sort((a, b) =>
      a.sessionId.localeCompare(b.sessionId) ||
      a.username.localeCompare(b.username)
    );
}

function logLobbyPresenceSync(channel) {
  const details = {
    entries: getChannelPresenceSnapshot(channel),
  };
  if (!shouldLogDebugSnapshot('lobby:presence-sync', details)) return;
  lobbyPresenceDebug('lobbyChannel:presence-sync', details);
}

function logRoomPresenceSync(channel, currentRoomId) {
  const details = {
    roomId: currentRoomId,
    participants: getChannelPresenceSnapshot(channel),
  };
  if (!shouldLogDebugSnapshot('room:presence-sync', details)) return;
  lobbyPresenceDebug('roomChannel:presence-sync', details);
}

function buildRenderRoomDebugSnapshot(room) {
  return {
    roomId: room?.id || null,
    status: 'open',
    hostUsername: room?.host || '?',
    playerCount: Math.max(0, Number(room?.playerCount) || 0),
  };
}

function buildRenderAvailableRoomsSnapshot(eventName, details = {}) {
  const snapshot = { eventName };

  if (eventName === 'pending') {
    snapshot.hasLobbyChannel = Boolean(details.hasLobbyChannel);
    snapshot.lobbyConnectionState = details.lobbyConnectionState || null;
    snapshot.lobbyChannelError = details.lobbyChannelError || null;
    return snapshot;
  }

  if (eventName === 'error') {
    snapshot.lobbyChannelError = details.lobbyChannelError || null;
    return snapshot;
  }

  snapshot.rooms = Array.isArray(details.rooms)
    ? details.rooms.map(buildRenderRoomDebugSnapshot)
    : [];

  return snapshot;
}

function logRenderAvailableRooms(eventName, details) {
  const snapshot = buildRenderAvailableRoomsSnapshot(eventName, details);
  if (!shouldLogDebugSnapshot('renderAvailableRooms', snapshot)) return;
  lobbyDiscoveryDebug(`renderAvailableRooms:${eventName}`, details);
}

function clearPendingDepartedRoomSessions() {
  pendingDepartedRoomSessions.clear();
}

function clearHostResolutionTimer() {
  if (!hostResolutionTimer) return;
  clearTimeout(hostResolutionTimer);
  hostResolutionTimer = null;
}

function scheduleHostResolutionRecheck(currentRoomState, participants = []) {
  clearHostResolutionTimer();
  if (
    !mpChannel ||
    !roomId ||
    roomStage !== 'lobby' ||
    !currentRoomState?.hostSessionId ||
    currentRoomState.hostSessionId === clientSessionId
  ) {
    return;
  }

  if (participants.some((participant) => participant.sessionId === currentRoomState.hostSessionId)) {
    return;
  }

  const hostStateAgeMs = Date.now() - (Number(currentRoomState.updatedAt) || 0);
  const delay = Math.max(0, HOST_PRESENCE_GRACE_MS - hostStateAgeMs);
  const scheduledRoomId = roomId;
  const scheduledHostSessionId = currentRoomState.hostSessionId;

  lobbyHandoffDebug('hostResolutionRecheck:schedule', {
    roomId: scheduledRoomId,
    hostSessionId: scheduledHostSessionId,
    delay,
  });

  hostResolutionTimer = setTimeout(() => {
    hostResolutionTimer = null;
    if (!mpChannel || roomStage !== 'lobby' || roomId !== scheduledRoomId) {
      return;
    }

    lobbyHandoffDebug('hostResolutionRecheck:run', {
      roomId: scheduledRoomId,
      hostSessionId: scheduledHostSessionId,
    });
    updateLobbyList();
  }, delay + 20);
}

function clearRecentHostRelinquish(reason = 'unspecified') {
  if (!recentHostRelinquish) return;
  lobbyHandoffDebug('recentHostRelinquish:clear', {
    roomId: recentHostRelinquish.roomId,
    nextHostSessionId: recentHostRelinquish.nextHostSessionId,
    reason,
  });
  recentHostRelinquish = null;
}

function recordRecentHostRelinquish(roomIdToRecord, nextHostSessionId, updatedAt = Date.now()) {
  if (!roomIdToRecord || !nextHostSessionId) return;
  recentHostRelinquish = {
    roomId: roomIdToRecord,
    nextHostSessionId,
    updatedAt: Number(updatedAt) || Date.now(),
  };
  lobbyHandoffDebug('recentHostRelinquish:record', {
    roomId: roomIdToRecord,
    nextHostSessionId,
    updatedAt: recentHostRelinquish.updatedAt,
  });
}

function hasActiveHostRelinquishLock(targetRoomId, payloadUpdatedAt = 0) {
  if (!recentHostRelinquish || recentHostRelinquish.roomId !== targetRoomId) return false;
  if (Date.now() - recentHostRelinquish.updatedAt > HOST_HANDOFF_LOCK_MS) {
    clearRecentHostRelinquish('expired');
    return false;
  }
  if (payloadUpdatedAt && payloadUpdatedAt > recentHostRelinquish.updatedAt + HOST_HANDOFF_LOCK_MS) {
    clearRecentHostRelinquish('superseded');
    return false;
  }
  return true;
}

function shouldIgnoreIncomingRoomState(payload, source = 'remote') {
  if (!payload?.roomId || source === 'local-handoff') return false;
  if (!hasActiveHostRelinquishLock(payload.roomId, Number(payload.updatedAt) || 0)) return false;
  if (payload.hostSessionId !== clientSessionId) return false;

  lobbyHandoffDebug('incomingRoomState:ignore-reclaim', {
    source,
    roomId: payload.roomId,
    hostSessionId: payload.hostSessionId,
    nextHostSessionId: recentHostRelinquish?.nextHostSessionId || null,
  });
  return true;
}

function markPendingDepartedRoomSession(sessionId, updatedAt = Date.now(), reason = 'unspecified') {
  if (!sessionId) return;
  pendingDepartedRoomSessions.set(sessionId, Number(updatedAt) || Date.now());
  lobbyPresenceDebug('pendingDepartedRoomSession:mark', {
    roomId,
    sessionId,
    updatedAt: Number(updatedAt) || Date.now(),
    reason,
  });
}

function clearPendingDepartedRoomSession(sessionId, reason = 'unspecified') {
  if (!sessionId) return;
  if (!pendingDepartedRoomSessions.delete(sessionId)) return;
  lobbyPresenceDebug('pendingDepartedRoomSession:clear', {
    roomId,
    sessionId,
    reason,
  });
}

function shouldIgnorePendingDepartedPresence(presence) {
  const sessionId = presence?.sessionId || presence?.username || '?';
  if (!pendingDepartedRoomSessions.has(sessionId)) return false;

  const departedAt = pendingDepartedRoomSessions.get(sessionId) || 0;
  const presenceUpdatedAt = Number(presence?.updatedAt) || 0;
  if (presenceUpdatedAt > departedAt) {
    clearPendingDepartedRoomSession(sessionId, 'presence-refreshed');
    return false;
  }

  return true;
}

function setLobbyConnectionState(nextState, details = null) {
  if (lobbyConnectionState === nextState) return;
  const previousState = lobbyConnectionState;
  lobbyConnectionState = nextState;
  lobbyChannelReady = nextState === LOBBY_CONNECTION_STATE.READY;
  if (nextState === LOBBY_CONNECTION_STATE.DISCONNECTED) {
    lobbyChannelError = null;
  }
  lobbyLifecycleDebug('lobbyConnectionState:change', {
    previousState,
    nextState,
    ...(details || {}),
  });
}

function isLobbyStateConnected() {
  return lobbyConnectionState === LOBBY_CONNECTION_STATE.CONNECTING
    || lobbyConnectionState === LOBBY_CONNECTION_STATE.READY
    || lobbyConnectionState === LOBBY_CONNECTION_STATE.RECONNECTING;
}

function resetLobbyPresenceTracking() {
  lastLobbyPresencePayloadKey = null;
}

function serializeLobbyPresencePayload(payload) {
  return JSON.stringify([
    payload.sessionId || '',
    payload.username || '',
    payload.roomId || '',
    payload.isHost ? 1 : 0,
    payload.roomStage || '',
  ]);
}

function getLobbyBrowseStatusMessage() {
  switch (lobbyConnectionState) {
    case LOBBY_CONNECTION_STATE.CONNECTING:
      return 'Connecting to room list…';
    case LOBBY_CONNECTION_STATE.RECONNECTING:
      return 'Reconnecting room list…';
    case LOBBY_CONNECTION_STATE.DISCONNECTING:
      return 'Updating room list…';
    case LOBBY_CONNECTION_STATE.DISCONNECTED:
      return lobbyChannelError || 'Room list unavailable right now.';
    default:
      return null;
  }
}

function isLobbyBrowseUiState(state = lobbyUiState) {
  return state === LOBBY_UI_STATE.BROWSING
    || state === LOBBY_UI_STATE.CONNECTING_LOBBY
    || state === LOBBY_UI_STATE.RECONNECTING_LOBBY
    || state === LOBBY_UI_STATE.IDLE;
}

function getLobbyUiStateForConnection() {
  switch (lobbyConnectionState) {
    case LOBBY_CONNECTION_STATE.CONNECTING:
      return LOBBY_UI_STATE.CONNECTING_LOBBY;
    case LOBBY_CONNECTION_STATE.RECONNECTING:
    case LOBBY_CONNECTION_STATE.DISCONNECTING:
      return LOBBY_UI_STATE.RECONNECTING_LOBBY;
    case LOBBY_CONNECTION_STATE.READY:
    case LOBBY_CONNECTION_STATE.DISCONNECTED:
    default:
      return LOBBY_UI_STATE.BROWSING;
  }
}

function syncLobbyBrowseUiState(force = false) {
  if (!force && !isLobbyBrowseUiState()) return;
  setLobbyUiState(getLobbyUiStateForConnection());
}

function setLobbyUiState(nextState, options = {}) {
  const { message } = options;
  const previousState = lobbyUiState;
  if (typeof message === 'string') {
    lobbyUiPendingMessage = message;
  } else if (
    nextState !== LOBBY_UI_STATE.CREATING_ROOM &&
    nextState !== LOBBY_UI_STATE.JOINING_ROOM &&
    nextState !== LOBBY_UI_STATE.LEAVING_ROOM
  ) {
    lobbyUiPendingMessage = '';
  }

  if (previousState === nextState && typeof message !== 'string') {
    return;
  }

  lobbyUiState = nextState;
  lobbyUiDebug('lobbyUiState:change', {
    previousState,
    nextState,
    message: lobbyUiPendingMessage || null,
  });
  renderLobbyUiState();
}

function setLobbyBrowseNotice(message = '') {
  lobbyBrowseNotice = message || '';
}

function clearLobbyJoinVerificationTimer() {
  if (!lobbyJoinVerificationTimer) return;
  clearTimeout(lobbyJoinVerificationTimer);
  lobbyJoinVerificationTimer = null;
}

function hasConfirmedLobbyJoin(expectedRoomId = roomId) {
  if (!expectedRoomId || roomId !== expectedRoomId || roomStage !== 'lobby') {
    return false;
  }

  const participants = getRoomParticipants();
  if (participants.some((participant) => participant.sessionId !== clientSessionId)) {
    return true;
  }

  const currentRoomState = typeof getCurrentLobbyRoomState === 'function'
    ? getCurrentLobbyRoomState()
    : null;
  if (!currentRoomState || currentRoomState.roomId !== expectedRoomId || currentRoomState.status !== 'open') {
    return false;
  }

  return Boolean(
    currentRoomState.hostSessionId && currentRoomState.hostSessionId !== clientSessionId
  );
}

async function recoverFailedLobbyJoin(options = {}) {
  const {
    roomId: failedRoomId = roomId,
    channel = mpChannel,
    message = 'Room is no longer available. Please choose another room.',
    reason = 'join-recovery',
  } = options;

  lobbyLifecycleDebug('recoverFailedLobbyJoin:start', {
    reason,
    failedRoomId,
    currentRoomId: roomId,
    roomStage,
    lobbyUiState,
  });

  clearLobbyJoinVerificationTimer();
  activeLobbyJoinAttemptId++;

  if (channel) {
    try {
      await channel.unsubscribe();
    } catch (error) {}
  }
  if (!channel || mpChannel === channel) {
    mpChannel = null;
  }

  multiplayerMode = false;
  roomId = null;
  roomStage = 'browse';
  isHost = false;
  gameOver = false;
  spectating = false;
  countdownActive = false;
  pendingStartDirection = null;

  if (typeof clearCurrentLobbyRoomState === 'function') {
    clearCurrentLobbyRoomState();
  }
  if (typeof resetPublishedLobbyRoomState === 'function') {
    resetPublishedLobbyRoomState();
  }
  clearHostResolutionTimer();
  releaseMultiplayerSessionLock();

  clearCurrentMatchSnapshot();
  resetRoomSettings();
  resetCombatState();
  peers.clear();
  deadPlayers.clear();
  document.getElementById('mp-end-overlay').style.display = 'none';

  if (typeof requestLobbyRoomRegistry === 'function') {
    await requestLobbyRoomRegistry(reason);
  }

  setLobbyBrowseNotice(message);
  showMpEntry();
  lobbyLifecycleDebug('recoverFailedLobbyJoin:done', {
    reason,
    failedRoomId,
  });
}

function scheduleLobbyJoinVerification(channel, expectedRoomId, attemptId, phase = 1) {
  clearLobbyJoinVerificationTimer();
  lobbyJoinVerificationTimer = setTimeout(async () => {
    if (attemptId !== activeLobbyJoinAttemptId || mpChannel !== channel) {
      return;
    }

    if (hasConfirmedLobbyJoin(expectedRoomId)) {
      clearLobbyJoinVerificationTimer();
      lobbyLifecycleDebug('scheduleLobbyJoinVerification:confirmed', {
        expectedRoomId,
        phase,
      });
      return;
    }

    if (phase === 1) {
      lobbyLifecycleDebug('scheduleLobbyJoinVerification:retry', {
        expectedRoomId,
        phase,
      });
      if (typeof requestLobbyRoomRegistry === 'function') {
        await requestLobbyRoomRegistry('join-verify-retry');
      }
      if (channel === mpChannel) {
        channel.send({
          type: 'broadcast',
          event: 'room:refresh-request',
          payload: { roomId: expectedRoomId, reason: 'join-verify-retry' },
        });
      }
      requestRoomSettingsSync();
      scheduleLobbyJoinVerification(channel, expectedRoomId, attemptId, 2);
      return;
    }

    await recoverFailedLobbyJoin({
      roomId: expectedRoomId,
      channel,
      message: 'Room closed before you could join. Please choose another room.',
      reason: 'join-verify-failed',
    });
  }, LOBBY_JOIN_VERIFY_DELAY_MS);
}

function clearLobbyReconnectTimer() {
  if (!lobbyReconnectTimer) return;
  clearTimeout(lobbyReconnectTimer);
  lobbyReconnectTimer = null;
}

function scheduleLobbyReconnect(reason) {
  if (lobbyDisconnectExpected || !currentUser || !sb) {
    lobbyLifecycleDebug('scheduleLobbyReconnect:skip', {
      reason,
      lobbyDisconnectExpected,
      hasCurrentUser: Boolean(currentUser),
      hasSupabase: Boolean(sb),
      lobbyConnectionState,
    });
    return;
  }
  if (lobbyReconnectTimer) {
    lobbyLifecycleDebug('scheduleLobbyReconnect:already-pending', { reason });
    return;
  }

  lobbyChannelError = 'Reconnecting room list…';
  setLobbyConnectionState(LOBBY_CONNECTION_STATE.RECONNECTING, { reason });
  syncLobbyBrowseUiState();
  renderAvailableRooms();
  lobbyLifecycleDebug('scheduleLobbyReconnect:queued', { reason });

  lobbyReconnectTimer = setTimeout(async () => {
    lobbyReconnectTimer = null;
    if (lobbyDisconnectExpected || !currentUser || !sb || lobbyChannel) {
      lobbyLifecycleDebug('scheduleLobbyReconnect:aborted', {
        reason,
        lobbyDisconnectExpected,
        hasCurrentUser: Boolean(currentUser),
        hasSupabase: Boolean(sb),
        hasLobbyChannel: Boolean(lobbyChannel),
        lobbyConnectionState,
      });
      return;
    }

    lobbyLifecycleDebug('scheduleLobbyReconnect:run', { reason });
    await ensureLobbyChannel();
  }, LOBBY_RECONNECT_DELAY_MS);
}

async function ensureLobbyChannel() {
  lobbyDisconnectExpected = false;
  clearLobbyReconnectTimer();
  lobbyLifecycleDebug('ensureLobbyChannel:enter', {
    hasCurrentUser: Boolean(currentUser),
    hasSupabase: Boolean(sb),
    lobbyConnectionState,
    hasLobbyChannel: Boolean(lobbyChannel),
  });
  if (!currentUser || !sb) return;

  if (lobbyChannel && isLobbyStateConnected()) {
    if (lobbyConnectionState === LOBBY_CONNECTION_STATE.READY) {
      syncLobbyPresence();
    }
    syncLobbyBrowseUiState();
    renderAvailableRooms();
    return;
  }

  const nextState = lobbyConnectionState === LOBBY_CONNECTION_STATE.RECONNECTING
    ? LOBBY_CONNECTION_STATE.RECONNECTING
    : LOBBY_CONNECTION_STATE.CONNECTING;
  setLobbyConnectionState(nextState);
  syncLobbyBrowseUiState();
  lobbyChannelError = null;

  const channel = sb.channel(GLOBAL_LOBBY_CHANNEL, {
    config: {
      presence: { key: clientSessionId },
    }
  });
  lobbyChannel = channel;
  clearLobbyDebugSnapshots();
  lobbyLifecycleDebug('ensureLobbyChannel:create', {
    channel: GLOBAL_LOBBY_CHANNEL,
    presenceKey: clientSessionId,
  });

  channel
    .on('broadcast', { event: 'room:registry-request' }, ({ payload }) => {
      if (
        isHost &&
        roomId &&
        roomStage === 'lobby' &&
        payload?.requesterSessionId !== clientSessionId &&
        typeof syncLobbyRoomState === 'function'
      ) {
        void syncLobbyRoomState({
          force: true,
          eventName: 'room:announce',
          reason: 'registry-request',
        });
      }
    })
    .on('broadcast', { event: 'room:announce' }, ({ payload }) => {
      handleLobbyRoomBroadcast('room:announce', payload);
      renderAvailableRooms();
    })
    .on('broadcast', { event: 'room:update' }, ({ payload }) => {
      handleLobbyRoomBroadcast('room:update', payload);
      renderAvailableRooms();
    })
    .on('broadcast', { event: 'room:heartbeat' }, ({ payload }) => {
      handleLobbyRoomBroadcast('room:heartbeat', payload);
      renderAvailableRooms();
    })
    .on('broadcast', { event: 'room:close' }, ({ payload }) => {
      handleLobbyRoomBroadcast('room:close', payload);
      if (
        payload?.roomId &&
        payload.roomId === roomId &&
        roomStage === 'lobby' &&
        !isHost
      ) {
        void recoverFailedLobbyJoin({
          roomId: payload.roomId,
          message: 'Room was closed. Please choose another room.',
          reason: 'room-close-broadcast',
        });
      }
      renderAvailableRooms();
    })
    .on('presence', { event: 'sync' }, () => {
      if (lobbyChannel !== channel) return;
      logLobbyPresenceSync(channel);
      renderAvailableRooms();
    })
    .subscribe(async (status) => {
      if (lobbyChannel !== channel) return;
      lobbyLifecycleDebug('lobbyChannel:subscribe-status', {
        status,
        entries: getChannelPresenceSnapshot(channel),
      });

      if (status === 'SUBSCRIBED') {
        lobbyChannelError = null;
        setLobbyConnectionState(LOBBY_CONNECTION_STATE.READY, { status });
        syncLobbyBrowseUiState();
        resetLobbyPresenceTracking();
        await syncLobbyPresence(true);
        if (typeof requestLobbyRoomRegistry === 'function') {
          await requestLobbyRoomRegistry('lobby-channel-subscribed');
        }
        if (typeof syncLobbyRoomState === 'function') {
          await syncLobbyRoomState({
            force: true,
            eventName: roomStage === 'lobby' ? 'room:announce' : 'room:update',
            reason: 'lobby-channel-subscribed',
          });
        }
        renderAvailableRooms();
        return;
      }

      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        if (lobbyChannel === channel) {
          lobbyChannel = null;
        }
        if (lobbyDisconnectExpected || lobbyConnectionState === LOBBY_CONNECTION_STATE.DISCONNECTING) {
          lobbyChannelError = null;
          setLobbyConnectionState(LOBBY_CONNECTION_STATE.DISCONNECTED, { status });
          syncLobbyBrowseUiState();
          renderAvailableRooms();
        } else {
          lobbyChannelError = 'Reconnecting room list…';
          setLobbyConnectionState(LOBBY_CONNECTION_STATE.RECONNECTING, { status });
          syncLobbyBrowseUiState();
          renderAvailableRooms();
          scheduleLobbyReconnect(status);
        }
      }
    });

  renderAvailableRooms();
}

async function disconnectLobbyChannel() {
  lobbyDisconnectExpected = true;
  clearLobbyReconnectTimer();
  setLobbyConnectionState(LOBBY_CONNECTION_STATE.DISCONNECTING);
  if (!lobbyChannel) {
    lobbyChannelError = null;
    resetLobbyPresenceTracking();
    if (typeof clearLobbyOpenRooms === 'function') clearLobbyOpenRooms();
    setLobbyConnectionState(LOBBY_CONNECTION_STATE.DISCONNECTED);
    return;
  }
  lobbyLifecycleDebug('disconnectLobbyChannel:start', {
    entries: getChannelPresenceSnapshot(lobbyChannel),
  });
  try {
    await lobbyChannel.unsubscribe();
  } catch (error) {}
  lobbyChannel = null;
  lobbyChannelError = null;
  resetLobbyPresenceTracking();
  if (typeof clearLobbyOpenRooms === 'function') clearLobbyOpenRooms();
  setLobbyConnectionState(LOBBY_CONNECTION_STATE.DISCONNECTED);
  lobbyLifecycleDebug('disconnectLobbyChannel:done');
}

function getLobbyPresencePayload() {
  return {
    sessionId: clientSessionId,
    username: currentUser.username,
    roomId,
    isHost,
    roomStage,
    updatedAt: Date.now(),
  };
}

async function syncLobbyPresence(force = false) {
  if (!lobbyChannel || !currentUser || !sb || lobbyConnectionState !== LOBBY_CONNECTION_STATE.READY) {
    lobbyPresenceDebug('syncLobbyPresence:skip', {
      force,
      hasLobbyChannel: Boolean(lobbyChannel),
      hasCurrentUser: Boolean(currentUser),
      hasSupabase: Boolean(sb),
      lobbyConnectionState,
    });
    return;
  }
  const payload = getLobbyPresencePayload();
  const payloadKey = serializeLobbyPresencePayload(payload);
  if (!force && payloadKey === lastLobbyPresencePayloadKey) {
    lobbyPresenceDebug('syncLobbyPresence:deduped', payload);
    return;
  }
  lobbyPresenceDebug('syncLobbyPresence:track', payload);
  try {
    await lobbyChannel.track(payload);
    lastLobbyPresencePayloadKey = payloadKey;
  } catch (error) {
    lobbyPresenceDebug('syncLobbyPresence:error', {
      message: error?.message || String(error),
    });
  }
}

function getPresenceEntries(channel) {
  if (!channel) return [];
  const state = channel.presenceState();

  return Object.entries(state).map(([presenceKey, presences]) => {
    const latestPresence = [...(presences || [])]
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0] || {};

    return {
      ...latestPresence,
      sessionId: latestPresence.sessionId || presenceKey,
      username: latestPresence.username || presenceKey,
    };
  });
}

function getRoomParticipants() {
  const participantsBySessionId = new Map();

  getPresenceEntries(mpChannel).forEach((presence) => {
    if (shouldIgnorePendingDepartedPresence(presence)) {
      return;
    }
    participantsBySessionId.set(presence.sessionId || presence.username || '?', {
      sessionId: presence.sessionId || presence.username || '?',
      username: presence.username || '?',
      color: presence.color || '#fff',
      isHost: Boolean(presence.isHost),
    });
  });

  return Array.from(participantsBySessionId.values())
    .sort((a, b) => a.username.localeCompare(b.username) || a.sessionId.localeCompare(b.sessionId));
}

async function syncRoomPresence() {
  if (!mpChannel || !currentUser) return;
  try {
    await mpChannel.track({
      sessionId: clientSessionId,
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

function sortLobbyParticipants(participants = []) {
  return [...participants].sort((a, b) =>
    a.username.localeCompare(b.username) || a.sessionId.localeCompare(b.sessionId)
  );
}

function summarizeLobbyParticipantsForDebug(participants = []) {
  return participants.map((participant) => ({
    sessionId: participant?.sessionId || null,
    username: participant?.username || null,
    isHost: Boolean(participant?.isHost),
  }));
}

function isHostGraceWindowActive(currentRoomState = null) {
  const hostSessionId = currentRoomState?.hostSessionId || null;
  const updatedAt = Number(currentRoomState?.updatedAt) || 0;
  if (!hostSessionId || !updatedAt) return false;
  return Date.now() - updatedAt < HOST_PRESENCE_GRACE_MS;
}

function resolveHostAssignmentDecision(participants = [], currentRoomState = null) {
  const sortedParticipants = sortLobbyParticipants(participants);
  const participantsBySessionId = new Map(
    sortedParticipants.map((participant) => [participant.sessionId, participant])
  );
  const stateHostSessionId = currentRoomState?.hostSessionId || null;
  const stateHostUsername = currentRoomState?.hostUsername || null;
  const stateHostParticipant = stateHostSessionId
    ? participantsBySessionId.get(stateHostSessionId) || null
    : null;

  if (stateHostParticipant) {
    return {
      reason: 'state-host-present',
      resolvedHostParticipant: stateHostParticipant,
      hostSessionId: stateHostParticipant.sessionId,
      hostUsername: stateHostParticipant.username,
      preserveStateAge: false,
      shouldScheduleRecheck: false,
    };
  }

  if (participants.length === 1) {
    return {
      reason: 'promote-single-participant',
      resolvedHostParticipant: participants[0],
      hostSessionId: participants[0].sessionId,
      hostUsername: participants[0].username,
      preserveStateAge: false,
      shouldScheduleRecheck: false,
    };
  }

  if (isHostGraceWindowActive(currentRoomState)) {
    return {
      reason: 'state-host-grace',
      resolvedHostParticipant: null,
      hostSessionId: stateHostSessionId,
      hostUsername: stateHostUsername,
      preserveStateAge: true,
      shouldScheduleRecheck: true,
    };
  }

  const flaggedHostParticipant = participants.find((participant) => participant.isHost) || null;
  const fallbackHostParticipant = flaggedHostParticipant || sortedParticipants[0] || null;

  return {
    reason: flaggedHostParticipant ? 'presence-host-flag' : 'sorted-fallback',
    resolvedHostParticipant: fallbackHostParticipant,
    hostSessionId: fallbackHostParticipant?.sessionId || null,
    hostUsername: fallbackHostParticipant?.username || stateHostUsername || null,
    preserveStateAge: false,
    shouldScheduleRecheck: false,
  };
}

function syncResolvedHostRole(nextIsHost) {
  if (nextIsHost === isHost) return;

  const previousIsHost = isHost;
  isHost = nextIsHost;
  lobbyHandoffDebug('hostRole:change', {
    roomId,
    previousIsHost,
    nextIsHost,
    username: currentUser?.username || null,
  });

  syncRoomPresence();
  syncLobbyPresence();
  if (isHost) {
    if (typeof syncLobbyRoomState === 'function') {
      void syncLobbyRoomState({
        force: true,
        eventName: 'room:update',
        reason: 'host-assigned',
      });
    }
    broadcastRoomSettings();
    return;
  }

  if (typeof resetPublishedLobbyRoomState === 'function') {
    resetPublishedLobbyRoomState();
  }
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
  if (typeof syncLobbyRoomState === 'function') {
    void syncLobbyRoomState({
      force: true,
      eventName: 'room:update',
      reason: 'corpse-mode-toggle',
    });
  }
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
  if (typeof syncLobbyRoomState === 'function') {
    void syncLobbyRoomState({
      force: true,
      eventName: 'room:update',
      reason: 'shooting-mode-toggle',
    });
  }
}

function selectNextHostParticipant(participants = []) {
  if (!Array.isArray(participants) || !participants.length) return null;
  return sortLobbyParticipants(participants)[0] || null;
}

async function broadcastLobbyHostHandoff(nextHostParticipant, remainingParticipants = []) {
  if (
    !lobbyChannel ||
    lobbyConnectionState !== LOBBY_CONNECTION_STATE.READY ||
    !roomId ||
    !nextHostParticipant
  ) {
    return false;
  }

  const handoffState = {
    roomId,
    hostSessionId: nextHostParticipant.sessionId,
    hostUsername: nextHostParticipant.username,
    status: 'open',
    playerCount: Math.max(1, remainingParticipants.length),
    settings: typeof getRoomSettings === 'function' ? getRoomSettings() : {},
    updatedAt: Date.now(),
  };

  if (typeof applyCurrentLobbyRoomState === 'function') {
    applyCurrentLobbyRoomState(handoffState, 'local-handoff');
  }
  if (typeof upsertLobbyOpenRoom === 'function') {
    upsertLobbyOpenRoom(handoffState, 'local-handoff');
  }
  recordRecentHostRelinquish(roomId, nextHostParticipant.sessionId, handoffState.updatedAt);

  await lobbyChannel.send({
    type: 'broadcast',
    event: 'room:update',
    payload: handoffState,
  });

  lobbyHandoffDebug('broadcastLobbyHostHandoff', {
    roomId,
    nextHostSessionId: nextHostParticipant.sessionId,
    nextHostUsername: nextHostParticipant.username,
    playerCount: remainingParticipants.length,
  });
  return true;
}

function getRemainingRoomParticipantsAfterLocalLeave() {
  return getRoomParticipants().filter((participant) => participant.sessionId !== clientSessionId);
}

async function publishHostLeaveOutcome(remainingParticipants = getRemainingRoomParticipantsAfterLocalLeave()) {
  const nextHostParticipant = selectNextHostParticipant(remainingParticipants);
  const shouldCloseRoom = remainingParticipants.length === 0;

  lobbyHandoffDebug('leaveRoom:host-decision', {
    roomId,
    shouldCloseRoom,
    remainingParticipants: summarizeLobbyParticipantsForDebug(remainingParticipants),
    nextHostSessionId: nextHostParticipant?.sessionId || null,
    nextHostUsername: nextHostParticipant?.username || null,
  });

  if (shouldCloseRoom) {
    await syncLobbyRoomState({
      force: true,
      eventName: 'room:close',
      reason: 'host-left-empty-room',
    });
    return;
  }

  if (nextHostParticipant) {
    await broadcastLobbyHostHandoff(nextHostParticipant, remainingParticipants);
  }
}

function syncHostAssignment(participants) {
  const currentRoomState = typeof getCurrentLobbyRoomState === 'function'
    ? getCurrentLobbyRoomState()
    : null;
  if (!participants.length) {
    clearHostResolutionTimer();
    lobbyHandoffDebug('syncHostAssignment:skip-empty', {
      roomId,
      currentUsername: currentUser?.username || null,
      isHost,
    });
    return isHost ? currentUser?.username || null : null;
  }

  const resolution = resolveHostAssignmentDecision(participants, currentRoomState);

  if (resolution.shouldScheduleRecheck) {
    scheduleHostResolutionRecheck(currentRoomState, participants);
  } else {
    clearHostResolutionTimer();
  }

  if (resolution.reason === 'promote-single-participant') {
    lobbyHandoffDebug('syncHostAssignment:promote-single-participant', {
      roomId,
      previousHostSessionId: currentRoomState?.hostSessionId || null,
      nextHostSessionId: resolution.hostSessionId,
      nextHostUsername: resolution.hostUsername,
    });
  }

  const hostSessionId = resolution.hostSessionId;
  const hostUsername = resolution.hostUsername;
  const nextIsHost = hostSessionId
    ? hostSessionId === clientSessionId
    : hostUsername === currentUser.username;
  const nextRoomStateUpdatedAt = resolution.preserveStateAge
    ? currentRoomState.updatedAt
    : Date.now();

  if (
    typeof applyCurrentLobbyRoomState === 'function' &&
    currentRoomState &&
    (
      currentRoomState.hostSessionId !== hostSessionId ||
      currentRoomState.hostUsername !== hostUsername ||
      currentRoomState.playerCount !== participants.length
    )
  ) {
    applyCurrentLobbyRoomState({
      ...currentRoomState,
      hostSessionId,
      hostUsername,
      playerCount: participants.length,
      updatedAt: nextRoomStateUpdatedAt,
    }, 'local-host-resolution');
  }

  syncResolvedHostRole(nextIsHost);

  return hostUsername;
}

async function createRoom() {
  if (!claimMultiplayerSessionLock()) {
    setLobbyBrowseNotice(getMultiplayerSessionBlockedMessage());
    showMpEntry();
    return;
  }
  const id = Math.random().toString(36).substr(2, 6).toUpperCase();
  lobbyLifecycleDebug('createRoom', { roomId: id });
  await joinChannel(id, true);
}

async function joinRoomFromInput(roomToJoin = null) {
  if (!claimMultiplayerSessionLock()) {
    setLobbyBrowseNotice(getMultiplayerSessionBlockedMessage());
    showMpEntry();
    return;
  }
  const roomInput = document.getElementById('room-input');
  const raw = roomToJoin || (roomInput ? roomInput.value.trim().toUpperCase() : '');
  if (!raw) {
    releaseMultiplayerSessionLock();
    return;
  }
  if (roomToJoin && !getDiscoveredOpenRooms().some((room) => room.id === raw)) {
    releaseMultiplayerSessionLock();
    lobbyDiscoveryDebug('joinRoomFromInput:not-found', {
      roomId: raw,
      rooms: getDiscoveredOpenRooms(),
    });
    return;
  }
  lobbyLifecycleDebug('joinRoomFromInput', {
    roomId: raw,
    viaRoomList: Boolean(roomToJoin),
  });
  await joinChannel(raw, false);
}

async function joinChannel(id, hosting) {
  const pendingUiState = hosting
    ? LOBBY_UI_STATE.CREATING_ROOM
    : LOBBY_UI_STATE.JOINING_ROOM;
  const pendingMessage = hosting ? 'Creating room…' : 'Joining room…';
  const attemptId = ++activeLobbyJoinAttemptId;
  let roomChannelHasSubscribed = false;
  let roomChannelReconnectAttempted = false;
  lobbyLifecycleDebug('joinChannel:start', {
    roomId: id,
    hosting,
    previousRoomId: roomId,
    attemptId,
  });
  clearLobbyJoinVerificationTimer();
  setLobbyBrowseNotice('');
  setLobbyUiState(pendingUiState, { message: pendingMessage });
  if (!sb) {
    releaseMultiplayerSessionLock();
    showMpEntry();
    return;
  }
  await ensureLobbyChannel();

  if (mpChannel) {
    roomDisconnectExpected = true;
    try {
      await mpChannel.unsubscribe();
    } catch (error) {}
    roomDisconnectExpected = false;
  }

  if (typeof clearCurrentLobbyRoomState === 'function') {
    clearCurrentLobbyRoomState();
  }
  clearLobbyDebugSnapshots();
  clearPendingDepartedRoomSessions();
  clearHostResolutionTimer();

  roomId = id;
  isHost = hosting;
  roomStage = 'lobby';
  multiplayerMode = true;
  if (hosting) resetRoomSettings();
  if (!hosting && typeof getLobbyOpenRoom === 'function') {
    const knownRoom = getLobbyOpenRoom(id);
    if (knownRoom && typeof applyCurrentLobbyRoomState === 'function') {
      applyCurrentLobbyRoomState(knownRoom, 'lobby-registry');
    }
  }
  peers.clear();
  deadPlayers.clear();
  setLobbyUiState(pendingUiState, { message: pendingMessage });
  if (hosting && typeof syncLobbyRoomState === 'function') {
    await syncLobbyRoomState({
      force: true,
      eventName: 'room:announce',
      reason: 'create-room',
    });
  }

  const channel = sb.channel('snake:room-' + id, {
    config: {
      broadcast: { self: false },
      presence: { key: clientSessionId },
    }
  });
  mpChannel = channel;

  channel
    .on('presence', { event: 'sync' }, async () => {
      if (mpChannel !== channel) return;
      logRoomPresenceSync(channel, roomId);
      if (typeof handlePresenceSync === 'function') {
        await handlePresenceSync();
      } else {
        updateLobbyList();
      }
      if (isHost && typeof syncLobbyRoomState === 'function') {
        const refreshReason = pendingRoomPresenceRefreshReason || 'room-presence-sync';
        pendingRoomPresenceRefreshReason = null;
        await syncLobbyRoomState({
          eventName: 'room:update',
          reason: refreshReason,
        });
      }
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
    .on('broadcast', { event: 'room:refresh-request' }, ({ payload }) => {
      if (!isHost || payload?.roomId !== roomId) return;
      const reason = payload.reason || 'room-refresh-request';
      if (reason === 'guest-left-room') {
        markPendingDepartedRoomSession(payload?.sessionId, payload?.updatedAt, reason);
        pendingRoomPresenceRefreshReason = reason;
        if (typeof scheduleLobbyRoomRefresh === 'function') {
          scheduleLobbyRoomRefresh(reason, 300);
        }
        return;
      }
      if (reason === 'guest-joined-room') {
        clearPendingDepartedRoomSession(payload?.sessionId, reason);
      }
      if (typeof scheduleLobbyRoomRefresh === 'function') {
        scheduleLobbyRoomRefresh(reason);
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
      if (mpChannel !== channel) return;
      lobbyLifecycleDebug('roomChannel:subscribe-status', {
        roomId: id,
        status,
        participants: getChannelPresenceSnapshot(channel),
      });
      if (status !== 'SUBSCRIBED') {
        if (
          status === 'CHANNEL_ERROR' ||
          status === 'TIMED_OUT' ||
          status === 'CLOSED'
        ) {
          if (roomDisconnectExpected) {
            lobbyLifecycleDebug('roomChannel:expected-close', {
              roomId: id,
              status,
              hosting,
              roomStage,
            });
            return;
          }

          if (roomChannelHasSubscribed) {
            lobbyLifecycleDebug('roomChannel:closed-after-subscribe', {
              roomId: id,
              status,
              roomStage,
              hosting,
            });

            if (mpChannel === channel) {
              mpChannel = null;
            }

            if (
              roomStage === 'lobby' &&
              roomId === id &&
              !roomChannelReconnectAttempted
            ) {
              roomChannelReconnectAttempted = true;
              setLobbyUiState(LOBBY_UI_STATE.JOINING_ROOM, { message: 'Rejoining room…' });
              setTimeout(() => {
                if (roomStage === 'lobby' && roomId === id && !mpChannel) {
                  void joinChannel(id, false);
                }
              }, 0);
              return;
            }

            await recoverFailedLobbyJoin({
              roomId: id,
              channel: null,
              message: 'Room connection was lost. Please join again.',
              reason: 'room-channel-closed-after-subscribe',
            });
            return;
          }

          lobbyLifecycleDebug('joinChannel:failed', {
            roomId: id,
            status,
            hosting,
          });

          if (hosting && typeof syncLobbyRoomState === 'function') {
            await syncLobbyRoomState({
              force: true,
              eventName: 'room:close',
              reason: 'room-channel-subscribe-failed',
            });
          }

          if (typeof resetPublishedLobbyRoomState === 'function') {
            resetPublishedLobbyRoomState();
          }
          if (typeof clearCurrentLobbyRoomState === 'function') {
            clearCurrentLobbyRoomState();
          }

          if (mpChannel === channel) {
            mpChannel = null;
          }
          multiplayerMode = false;
          roomId = null;
          roomStage = 'browse';
          isHost = false;
          releaseMultiplayerSessionLock();
          resetRoomSettings();
          peers.clear();
          deadPlayers.clear();
          showMpEntry();
        }
        return;
      }
      roomDisconnectExpected = false;
      roomChannelHasSubscribed = true;
      myColor = PLAYER_COLORS[0];
      await syncRoomPresence();
      if (typeof syncPlayerColors === 'function') {
        await syncPlayerColors();
      }
      await syncLobbyPresence();
      refreshMultiplayerSessionLock();
      if (isHost) {
        if (typeof syncLobbyRoomState === 'function') {
          await syncLobbyRoomState({
            force: true,
            eventName: hosting ? 'room:announce' : 'room:update',
            reason: 'room-channel-subscribed',
          });
        }
        broadcastRoomSettings();
      } else {
        channel.send({
          type: 'broadcast',
          event: 'room:refresh-request',
          payload: {
            roomId: id,
            reason: 'guest-joined-room',
            sessionId: clientSessionId,
            updatedAt: Date.now(),
          },
        });
        requestRoomSettingsSync();
        scheduleLobbyJoinVerification(channel, id, attemptId);
      }
      showLobby();
    });
}

function updateLobbyList() {
  const list = document.getElementById('lobby-players');
  if (!list) return;

  const participants = getRoomParticipants();
  const hostUsername = syncHostAssignment(participants);
  const currentRoomState = typeof getCurrentLobbyRoomState === 'function'
    ? getCurrentLobbyRoomState()
    : null;
  const displayHostUsername = currentRoomState?.hostUsername || hostUsername;
  const displayHostSessionId = currentRoomState?.hostSessionId || null;
  if (!isHost && hasConfirmedLobbyJoin()) {
    clearLobbyJoinVerificationTimer();
  }
  renderCorpseModeControl();
  renderShootingModeControl();
  list.innerHTML = '';

  participants.forEach((participant) => {
    const li = document.createElement('li');
    const isDisplayHost = displayHostSessionId
      ? participant.sessionId === displayHostSessionId
      : participant.username === displayHostUsername;
    const hostBadge = isDisplayHost ? '<span class="lobby-badge">Host</span>' : '';
    const participantColor = playerColors.get(participant.username) || participant.color || '#fff';

    li.innerHTML = `
      <span class="lobby-dot" style="background:${escHtml(participantColor)}"></span>
      <span class="lobby-name">${escHtml(participant.username)}</span>
      ${hostBadge}
    `;
    list.appendChild(li);
  });

  renderLobbyStatus(currentRoomState?.playerCount || participants.length, displayHostUsername);
}

function hostStartGame() {
  if (!isHost || !mpChannel) return;
  const startPayload = prepareMatchStartPayload();
  mpChannel.send({ type: 'broadcast', event: 'game:start', payload: startPayload });
  startCountdown(startPayload);
}

async function leaveRoom() {
  const leavingAsHost = isHost;
  const effectiveRoomParticipants = getRoomParticipants();

  lobbyLifecycleDebug('leaveRoom:start', {
    roomId,
    roomStage,
    isHost: leavingAsHost,
    lobbyEntries: getChannelPresenceSnapshot(lobbyChannel),
    roomEntries: getChannelPresenceSnapshot(mpChannel),
    effectiveParticipants: summarizeLobbyParticipantsForDebug(effectiveRoomParticipants),
  });
  spectating = false;
  gameOver = true;
  stopGameLoop();
  document.getElementById('mp-end-overlay').style.display = 'none';
  clearLobbyJoinVerificationTimer();
  activeLobbyJoinAttemptId++;
  setLobbyUiState(LOBBY_UI_STATE.LEAVING_ROOM, { message: 'Leaving room…' });

  if (typeof syncLobbyRoomState === 'function' && leavingAsHost) {
    const remainingParticipants = effectiveRoomParticipants
      .filter((participant) => participant.sessionId !== clientSessionId);
    await publishHostLeaveOutcome(remainingParticipants);
  }

  if (typeof resetPublishedLobbyRoomState === 'function') {
    resetPublishedLobbyRoomState();
  }

  releaseMultiplayerSessionLock();

  if (mpChannel && !leavingAsHost) {
    mpChannel.send({
      type: 'broadcast',
      event: 'room:refresh-request',
      payload: {
        roomId,
        reason: 'guest-left-room',
        sessionId: clientSessionId,
        updatedAt: Date.now(),
      },
    });
  }

  if (mpChannel) {
    roomDisconnectExpected = true;
    try {
      await mpChannel.unsubscribe();
    } catch (error) {}
    mpChannel = null;
  }
  roomDisconnectExpected = false;
  clearLobbyDebugSnapshots();
  clearPendingDepartedRoomSessions();
  clearHostResolutionTimer();

  multiplayerMode = false;
  roomId = null;
  roomStage = 'browse';
  isHost = false;
  resetBoardSize();
  if (typeof clearCurrentLobbyRoomState === 'function') {
    clearCurrentLobbyRoomState();
  }
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
  lobbyLifecycleDebug('leaveRoom:done', {
    lobbyEntries: getChannelPresenceSnapshot(lobbyChannel),
  });
  showMpEntry();
}

window.addEventListener('beforeunload', () => {
  releaseMultiplayerSessionLock();
});
