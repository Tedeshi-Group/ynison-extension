(function ymSyncClientApiModule() {
  const app = window.__ymSync;
  if (!app || (app.modules && app.modules.clientApi)) {
    return;
  }

  app.modules.clientApi = true;

  const originalDisconnectRoom = app.disconnectFromRoom;
  const protocolVersion = app.constants.API_PROTOCOL_VERSION || 1;
  const maxReconnectDelay = 12000;
  let reconnectTimer = null;
  let reconnectDelay = 750;
  let isManualClose = false;
  let reconnectRoleHint = 'listener';

  app.getWsUrl = function getWsUrl(roomId, roleHint = 'listener') {
    const backend = app.getBackendConfig ? app.getBackendConfig() : null;
    const wsRawUrl = (backend && backend.API_WS_URL) || app.constants.API_WS_URL;
    const wsUrl = new URL(wsRawUrl);
    const profile = app.STATE.profile || {};
    const clientId = app.STATE.clientId || app.getSelfClientId();

    wsUrl.searchParams.set('roomId', roomId);
    wsUrl.searchParams.set('clientId', clientId);
    wsUrl.searchParams.set('roleHint', roleHint);
    wsUrl.searchParams.set('role', roleHint);
    wsUrl.searchParams.set('nickname', profile.nickname || '');
    wsUrl.searchParams.set('avatarUrl', profile.avatarUrl || '');
    wsUrl.searchParams.set('v', String(protocolVersion));
    return wsUrl.toString();
  };

  app.resetConnectionState = function resetConnectionState() {
    app.STATE.wsReadyState = WebSocket.CLOSED;
    app.STATE.isConnectedToBackend = false;
    app.STATE._backendConnectedAt = 0;
  };

  app.scheduleReconnect = function scheduleReconnect() {
    if (isManualClose || !app.STATE.roomId) {
      return;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    reconnectTimer = window.setTimeout(() => {
      if (!app.STATE.roomId) {
        return;
      }
      app.connectToRoom(app.STATE.roomId, reconnectRoleHint).catch(() => {});
    }, reconnectDelay);

    reconnectDelay = Math.min(maxReconnectDelay, Math.max(750, reconnectDelay * 1.7));
  };

  app.cancelReconnect = function cancelReconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    reconnectDelay = 750;
  };

  const normalizeNonNegativeNumber = (value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return 0;
    }
    return parsed < 0 ? 0 : parsed;
  };

  const normalizePlaybackIsPaused = function normalizePlaybackIsPaused(state) {
    const raw = state && typeof state === 'object' ? state : {};
    if (typeof raw.is_paused === 'boolean') {
      return raw.is_paused;
    }
    if (typeof raw.isPaused === 'boolean') {
      return raw.isPaused;
    }
    if (typeof raw.paused === 'boolean') {
      return raw.paused;
    }
    if (typeof raw.isPlaying === 'boolean') {
      return !raw.isPlaying;
    }
    return undefined;
  };

  const normalizePlaybackPayloadState = function normalizePlaybackPayloadState(state = {}) {
    const rawState = state && typeof state === 'object' ? state : {};
    const isPaused = normalizePlaybackIsPaused(rawState);
    const isPlaying = typeof rawState.isPlaying === 'boolean'
      ? rawState.isPlaying
      : (typeof isPaused === 'boolean' ? !isPaused : false);
    const durationRaw = Number.isFinite(Number(rawState.durationSec))
      ? rawState.durationSec
      : rawState.duration;
    return {
      isPlaying,
      is_paused: typeof isPaused === 'boolean' ? isPaused : !isPlaying,
      paused: typeof isPaused === 'boolean' ? isPaused : !isPlaying,
      positionSec: normalizeNonNegativeNumber(rawState.positionSec),
      durationSec: normalizeNonNegativeNumber(durationRaw),
      positionAtServerMs: Number(rawState.positionAtServerMs || Date.now()),
    };
  };

  const normalizeIncomingPlaybackState = function normalizeIncomingPlaybackState(playback = {}) {
    const raw = playback && typeof playback === 'object' ? playback : {};
    const isPaused = normalizePlaybackIsPaused(raw);
    if (typeof raw.isPlaying === 'boolean' || typeof isPaused !== 'boolean') {
      return raw;
    }
    return {
      ...raw,
      isPlaying: !isPaused,
    };
  };

  app.sendApiMessage = function sendApiMessage(type, payload = {}) {
    if (!app.STATE.ws || app.STATE.ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    const envelope = {
      type,
      roomId: app.STATE.roomId,
      clientId: app.STATE.clientId,
      ts: Date.now(),
      v: protocolVersion,
      payload,
    };

    try {
      app.STATE.ws.send(JSON.stringify(envelope));
      return true;
    } catch (_error) {
      return false;
    }
  };

  app.connectToRoom = async function connectToRoom(rawRoomId, roleHint = 'listener') {
    const roomId = app.extractRoomId(rawRoomId);
    if (!roomId) {
      app.setError('Введите корректный ID комнаты');
      return false;
    }

    const normalizedRole = roleHint === 'host' ? 'host' : 'listener';
    app.STATE.clientId = app.getSelfClientId();
    app.STATE.roomId = roomId;
    app.STATE.inviteLink = app.buildInviteLink(roomId);
    app.STATE.joinInput = roomId;
    app.STATE.roomState = app.buildLocalRoom(roomId, normalizedRole);
    app.updateStoredRoomInfo();
    app.STATE.roomRole = normalizedRole;
    app.STATE.isConnectedToBackend = false;
    app.STATE.roomPermissions = {
      isHost: normalizedRole === 'host',
      canControl: normalizedRole === 'host',
      canDelegate: normalizedRole === 'host',
    };

    app.cancelReconnect();
    isManualClose = false;
    reconnectRoleHint = normalizedRole;

    const previousSocket = app.STATE.ws;
    if (previousSocket) {
      app.STATE.ws = null;
      try {
        previousSocket.close(4000, 'reconnect');
      } catch (_error) {
        // Keep going with a fresh connection.
      }
    }

    app.STATE.wsReadyState = WebSocket.CONNECTING;
    app.STATE._backendConnectedAt = 0;
    const socket = new WebSocket(app.getWsUrl(roomId, normalizedRole));
    app.STATE.ws = socket;

    socket.addEventListener('open', () => {
      app.STATE.wsReadyState = WebSocket.OPEN;
      app.STATE._backendConnectedAt = Date.now();
      app.cancelReconnect();
      reconnectDelay = 750;
      const hello = {
        clientId: app.STATE.clientId,
        roomId,
        roleHint: normalizedRole,
        nickname: app.STATE.profile?.nickname || app.constants.DEFAULT_NICKNAME,
        avatarUrl: app.STATE.profile?.avatarUrl || '',
        clientVersion: `ym-sync-client-${protocolVersion}`,
      };
      app.sendApiMessage('HELLO', hello);
    });

    socket.addEventListener('message', (event) => {
      app.onApiMessage(event.data);
    });

    socket.addEventListener('close', () => {
      if (app.STATE.ws !== socket) {
        return;
      }

      app.STATE.wsReadyState = WebSocket.CLOSED;
      app.STATE.isConnectedToBackend = false;
      app.STATE.ws = null;
      app.render();

      if (!isManualClose) {
        app.scheduleReconnect();
      }
    });

    socket.addEventListener('error', () => {
      app.STATE.isConnectedToBackend = false;
      app.STATE.wsReadyState = WebSocket.CLOSED;
    });

    await new Promise((resolve) => {
      const startAt = Date.now();
      const poll = () => {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) {
          resolve();
          return;
        }
        if (Date.now() - startAt > 7000) {
          resolve();
          return;
        }
        window.setTimeout(poll, 100);
      };
      poll();
    });

    if (typeof app.resetListenerTrackAutomation === 'function') {
      app.resetListenerTrackAutomation();
    }

    return true;
  };

  app.onApiMessage = function onApiMessage(rawPayload) {
    let parsed;
    try {
      parsed = typeof rawPayload === 'string' ? JSON.parse(rawPayload) : rawPayload;
    } catch (_error) {
      return;
    }

    if (!parsed || typeof parsed !== 'object' || !parsed.type) {
      return;
    }

    const { type, payload = {}, roomId } = parsed;
    if (roomId && roomId !== app.STATE.roomId) {
      return;
    }

    if (!app.STATE.isConnectedToBackend && type !== 'CONNECTED') {
      app.STATE.isConnectedToBackend = true;
    }

    switch (type) {
      case 'CONNECTED': {
        if (payload.clientId) {
          app.STATE.clientId = payload.clientId;
        }
        const normalizedRole = payload.role || payload.roleHint || app.STATE.roomRole || 'listener';
        app.STATE.roomRole = normalizedRole === 'host' ? 'host' : 'listener';
        app.applyPermissionsFromMessage(payload.permissions, app.STATE.roomRole);
        app.updateRoomFromServer(payload.roomState || payload.state || {});
        app.STATE.isConnectedToBackend = true;
        app.STATE.wsReadyState = WebSocket.OPEN;
        app.render();
        break;
      }
      case 'ROOM_SNAPSHOT':
        app.updateRoomFromServer(payload);
        app.STATE.isConnectedToBackend = true;
        break;
      case 'ROOM_PARTICIPANTS':
        app.applyParticipants(payload);
        break;
      case 'TRACK_INFO':
        app.applyTrackInfo(payload);
        break;
      case 'PLAYBACK_STATE':
        app.applyPlayback(payload);
        break;
      case 'COMMAND_TO_HOST':
        if (typeof app.handleIncomingCommandToHost === 'function') {
          app.handleIncomingCommandToHost(payload);
        }
        break;
      case 'CONTROL_TRANSFER':
      case 'CONTROL_GRANTED':
        app.applyPermissionsFromMessage(payload.permissions, payload.role);
        app.render();
        if (typeof app.onRoomPermissionsChanged === 'function') {
          app.onRoomPermissionsChanged(app.STATE.roomPermissions, app.STATE.roomRole);
        }
        break;
      case 'ERROR':
        app.setError(payload.message || payload.error || 'Ошибка синхронизации');
        break;
      case 'ROOM_CLOSED':
      case 'CLOSED':
        app.disconnectFromRoom();
        break;
      default:
        break;
    }
  };

  app.applyPermissionsFromMessage = function applyPermissionsFromMessage(
    permissions = {},
    role,
  ) {
    const normalizedRole = typeof role === 'string' ? role.toLowerCase() : '';
    const isHostRole = normalizedRole === 'host' || (app.STATE.roomRole || '').toLowerCase() === 'host';
    app.STATE.roomRole = normalizedRole || (isHostRole ? 'host' : app.STATE.roomRole || 'listener');
    app.STATE.roomPermissions = {
      isHost: normalizedRole === 'host' ? true : isHostRole,
      canControl: Boolean(permissions.canControl || permissions.canControlPlayback || isHostRole),
      canDelegate: Boolean(permissions.canDelegate || permissions.canPassControl || isHostRole),
    };

    app.updateAvatarFallbackPermissions();
  };

  app.updateAvatarFallbackPermissions = function updateAvatarFallbackPermissions() {
    if (app.STATE.roomPermissions.canControl) {
      app.STATE.roomPermissions.canDelegate = app.STATE.roomPermissions.canDelegate || app.STATE.roomPermissions.isHost;
    }
  };

  app.updateRoomFromServer = function updateRoomFromServer(snapshot = {}) {
    if (!snapshot || typeof snapshot !== 'object') {
      return;
    }

    const incomingVersion = Number(snapshot.stateVersion);
    if (Number.isFinite(incomingVersion) && incomingVersion <= app.STATE.lastStateVersion) {
      return;
    }

    if (Number.isFinite(incomingVersion)) {
      app.STATE.lastStateVersion = incomingVersion;
    }

    const participants = Array.isArray(snapshot.participants) ? snapshot.participants : [];
    const track = snapshot.track || snapshot.activeTrack || snapshot.currentTrack || null;
    const playbackState = snapshot.playbackState || snapshot.playback || null;
    const permissions = snapshot.permissions || {};
    const roleHint = snapshot.participantRole || snapshot.role || null;

    app.applyPermissionsFromMessage(permissions, roleHint);

    const hostClientId = snapshot.hostClientId || '';
    const roomId = snapshot.id || snapshot.roomId || app.STATE.roomId;
    const trackState = snapshot.trackState || null;

    app.STATE.roomState = {
      ...(app.STATE.roomState || {}),
      id: roomId,
      hostClientId,
      participants,
      track,
      trackState,
      playbackState: playbackState || trackState || null,
      permissions: app.STATE.roomPermissions,
      updatedAt: snapshot.updatedAt || Date.now(),
    };

    if (app.STATE.clientId && participants.length > 0) {
      const self = participants.find((member) => member.clientId === app.STATE.clientId);
      if (self && self.role) {
        app.STATE.roomRole = self.role === 'host' ? 'host' : 'listener';
      }
      app.applyPermissionsFromMessage(permissions, app.STATE.roomRole);
    }

    if (typeof app.handleIncomingRoomSnapshot === 'function') {
      app.handleIncomingRoomSnapshot(app.STATE.roomState);
    }

    app.applyTrackAndPlaybackFromState(snapshot);
    app.render();
  };

  app.applyParticipants = function applyParticipants(payload = {}) {
    if (!app.STATE.roomState) {
      app.STATE.roomState = {
        id: app.STATE.roomId,
        participants: [],
        permissions: app.STATE.roomPermissions,
      };
    }
    if (Array.isArray(payload.participants)) {
      app.STATE.roomState.participants = payload.participants;
    }
    if (payload.permissions) {
      app.applyPermissionsFromMessage(payload.permissions, payload.role);
    }
    if (typeof app.handleIncomingParticipants === 'function') {
      app.handleIncomingParticipants(app.STATE.roomState.participants || []);
    }
    app.render();
  };

  app.applyTrackInfo = function applyTrackInfo(payload = {}) {
    const version = Number(payload.stateVersion ?? payload.state?.stateVersion);
    if (Number.isFinite(version) && version <= app.STATE.lastStateVersion) {
      return;
    }
    if (Number.isFinite(version)) {
      app.STATE.lastStateVersion = version;
    }

    const track = payload.track || payload.currentTrack || null;
    const playback = normalizeIncomingPlaybackState(payload.state || payload.playback || null);
    const trackFingerprint = app.buildTrackFingerprint(track || {});

    if (!app.STATE.roomState) {
      app.STATE.roomState = {
        id: app.STATE.roomId,
        participants: [],
      };
    }
    app.STATE.roomState.track = track;
    app.STATE.roomState.trackState = playback;
    app.STATE.roomState.trackFingerprint = trackFingerprint;
    app.STATE.roomState.lastServerUpdateAt = Date.now();
    app.STATE.roomState.playbackState = playback || app.STATE.roomState.playbackState || null;

    if (typeof app.handleIncomingTrackInfo === 'function') {
      app.handleIncomingTrackInfo({
        track,
        playback,
      });
    }
    app.render();
  };

  app.applyPlayback = function applyPlayback(payload = {}) {
    const version = Number(payload.stateVersion ?? payload.state?.stateVersion);
    if (Number.isFinite(version) && version <= app.STATE.lastStateVersion) {
      return;
    }
    if (Number.isFinite(version)) {
      app.STATE.lastStateVersion = version;
    }

    const playback = normalizeIncomingPlaybackState(payload.state || payload || null);
    if (!app.STATE.roomState) {
      app.STATE.roomState = {
        id: app.STATE.roomId,
        participants: [],
      };
    }
    app.STATE.roomState.playbackState = playback;
    app.STATE.roomState.lastServerUpdateAt = Date.now();

    if (typeof app.handleIncomingPlaybackState === 'function') {
      app.handleIncomingPlaybackState(playback);
    }
    app.render();
  };

  app.applyTrackAndPlaybackFromState = function applyTrackAndPlaybackFromState(snapshot = {}) {
    if (!snapshot) {
      return;
    }

    const hasTrack = Boolean(snapshot.track || snapshot.activeTrack || snapshot.currentTrack);
    const hasPlayback = Boolean(snapshot.playbackState || snapshot.playback || snapshot.trackState);
    if (hasTrack) {
      app.applyTrackInfo({
        track: snapshot.track || snapshot.activeTrack || snapshot.currentTrack,
        state: snapshot.playbackState || snapshot.trackState || snapshot.playback,
      });
      return;
    }

    if (hasPlayback) {
      app.applyPlayback(snapshot.playbackState || snapshot.playback || snapshot.trackState);
    }
  };

  app.broadcastHostTrack = function broadcastHostTrack(track, state = {}) {
    const normalizedTrack = track && typeof track === 'object' ? track : {};
    const normalizedState = state && typeof state === 'object' ? state : {};
    const trackDurationSec = normalizeNonNegativeNumber(
      Number.isFinite(Number(normalizedTrack.durationSec))
        ? normalizedTrack.durationSec
        : normalizedTrack.duration
    );
    const trackId = String(
      normalizedTrack.trackId || normalizedTrack.id || normalizedTrack.playableId || ''
    ).trim();
    const trackUrl = String(
      normalizedTrack.trackUrl || normalizedTrack.url || normalizedState.trackUrl || normalizedState.mediaSrc || ''
    ).trim();
    const mediaSrc = String(
      normalizedTrack.mediaSrc || normalizedTrack.src || normalizedState.mediaSrc || ''
    ).trim();
    const stateDurationSec = normalizeNonNegativeNumber(
      Number.isFinite(Number(normalizedState.durationSec)) ? normalizedState.durationSec : trackDurationSec
    );
    const nextStateVersion = ++app.STATE.lastStateVersion;
    const playback = normalizePlaybackPayloadState({
      ...normalizedState,
      durationSec: stateDurationSec,
    });
    const currentTrack = {
      title: normalizedTrack.title || '',
      artists: Array.isArray(normalizedTrack.artists) ? normalizedTrack.artists : [],
      durationSec: trackDurationSec,
      ...(trackId ? { trackId } : {}),
      ...(trackUrl ? { trackUrl } : {}),
      ...(mediaSrc ? { mediaSrc } : {}),
    };

    const payload = {
      track: currentTrack,
      currentTrack,
      state: {
        ...playback,
        positionSec: normalizeNonNegativeNumber(normalizedState.positionSec),
        durationSec: stateDurationSec,
        positionAtServerMs: Number(normalizedState.positionAtServerMs || Date.now()),
        stateVersion: nextStateVersion,
      },
      trackMetaVersion: Number(normalizedState.trackMetaVersion || nextStateVersion),
      stateVersion: nextStateVersion,
    };

    app.sendApiMessage('TRACK_INFO', payload);
  };

  app.broadcastPlayback = function broadcastPlayback(state = {}) {
    const normalizedState = state && typeof state === 'object' ? state : {};
    const playback = normalizePlaybackPayloadState(normalizedState);
    const playbackTrackId = String(
      normalizedState.trackId || normalizedState.id || normalizedState.playableId || ''
    ).trim();
    const playbackTrackUrl = String(
      normalizedState.trackUrl || normalizedState.mediaSrc || normalizedState.url || ''
    ).trim();
    const playbackMediaSrc = String(
      normalizedState.mediaSrc || normalizedState.src || ''
    ).trim();
    const nextStateVersion = ++app.STATE.lastStateVersion;
    const currentTrack = {
      ...(playbackTrackId ? { trackId: playbackTrackId } : {}),
      ...(playbackTrackUrl ? { trackUrl: playbackTrackUrl } : {}),
      ...(playbackMediaSrc ? { mediaSrc: playbackMediaSrc } : {}),
    };
    const payload = {
      stateVersion: nextStateVersion,
      ...(Object.keys(currentTrack).length > 0 ? { currentTrack } : {}),
      state: {
        ...playback,
        positionSec: normalizeNonNegativeNumber(state.positionSec),
        durationSec: normalizeNonNegativeNumber(state.durationSec),
        positionAtServerMs: Number(state.positionAtServerMs || Date.now()),
        stateVersion: nextStateVersion,
        ...(playbackTrackId ? { trackId: playbackTrackId } : {}),
        ...(playbackTrackUrl ? { trackUrl: playbackTrackUrl } : {}),
        ...(playbackMediaSrc ? { mediaSrc: playbackMediaSrc } : {}),
      },
    };
    app.sendApiMessage('PLAYBACK_STATE', payload);
  };

  app.requestHostAction = function requestHostAction(action, actionPayload = {}) {
    if (!app.STATE.ws || app.STATE.ws.readyState !== WebSocket.OPEN) {
      if (typeof app.toast === 'function') {
        app.toast('Нет соединения с сервером комнаты');
      }
      return;
    }

    const requestId = `req-${app.STATE.clientId || 'unknown'}-${++app.STATE.commandSeq}-${Date.now()}`;
    app.STATE.commandRequests[requestId] = { action, payload: actionPayload, sentAt: Date.now() };
    app.sendApiMessage('COMMAND_REQUEST', {
      requestId,
      action,
      ...actionPayload,
    });
  };

  app.sendControlTransfer = function sendControlTransfer(targetClientId, canControl = true) {
    if (app.STATE.roomRole !== 'host' && !app.STATE.roomPermissions.canDelegate) {
      app.setError('Недостаточно прав для передачи управления');
      return;
    }
    app.sendApiMessage('CONTROL_TRANSFER', {
      targetClientId,
      canControl: Boolean(canControl),
    });
  };

  app.sendKick = function sendKick(targetClientId) {
    app.requestHostAction('kick', { targetClientId });
  };

  app.closeRoom = function closeRoom() {
    app.requestHostAction('closeRoom');
    app.disconnectFromRoom();
  };

  app.createRoom = async function createRoomWithServer(options = {}) {
    const { silentToast = false } = options || {};
    if (app.STATE.isBusy) {
      return false;
    }

    app.setBusy(true);
    app.clearError();

    try {
      const createdRoomId = `room-${Date.now().toString(36)}`;
      app.STATE.clientId = app.getSelfClientId();
      app.STATE.roomRole = 'host';
      await app.connectToRoom(createdRoomId, 'host');
      app.STATE.joinInput = app.STATE.roomId;
      if (!silentToast) {
        app.toast('Комната создана и подключена к серверу');
      }
      return true;
    } catch (error) {
      app.setError(error);
      return false;
    } finally {
      app.setBusy(false);
      app.render();
    }
  };

  app.joinRoom = async function joinRoomWithServer(rawValue, options = {}) {
    const {
      silentToast = false,
      roleHint = 'listener',
    } = options || {};
    const roomId = app.extractRoomId(rawValue);
    if (!roomId) {
      app.setError('Введите корректный ID комнаты');
      return false;
    }

    if (app.STATE.isBusy) {
      return false;
    }

    app.setBusy(true);
    app.clearError();
    const normalizedRole = roleHint === 'host' ? 'host' : 'listener';
    app.STATE.roomRole = normalizedRole;
    app.STATE.roomPermissions = {
      isHost: normalizedRole === 'host',
      canControl: normalizedRole === 'host',
      canDelegate: normalizedRole === 'host',
    };

    try {
      await app.connectToRoom(roomId, normalizedRole);
      if (!silentToast) {
        app.toast(`Подключаемся к комнате ${roomId}`);
      }
      return true;
    } catch (error) {
      app.setError(error);
      return false;
    } finally {
      app.setBusy(false);
      app.render();
    }
  };

  app.disconnectFromRoom = function disconnectFromRoomFromServer() {
    isManualClose = true;
    app.cancelReconnect();

    if (app.STATE.ws) {
      app.sendApiMessage('LEAVE', { reason: 'user_close' });
      try {
        const currentSocket = app.STATE.ws;
        app.STATE.ws = null;
        currentSocket.close(1000, 'user_close');
      } catch (_error) {
        // Nothing to do.
      }
    }
    app.cancelReconnect();
    app.resetConnectionState();
    app.STATE.roomRole = 'listener';
    app.STATE.roomPermissions = {
      isHost: false,
      canControl: false,
      canDelegate: false,
    };
    app.STATE.lastStateVersion = 0;

    if (typeof originalDisconnectRoom === 'function') {
      originalDisconnectRoom();
    } else {
      app.STATE.roomId = '';
      app.STATE.roomState = null;
      app.STATE.inviteLink = '';
      app.STATE.joinInput = '';
    }

    app.updateStoredRoomInfo();
    if (typeof app.resetListenerTrackAutomation === 'function') {
      app.resetListenerTrackAutomation();
    }
    app.render();
  };

  app.recreateRoom = async function recreateRoomFromServer() {
    return app.createRoom();
  };

  app.connectToRoomServer = app.connectToRoom;
  app.sendHostPlaybackUpdate = app.broadcastPlayback;
  app.sendHostTrackUpdate = app.broadcastHostTrack;
  app.sendHostAction = app.requestHostAction;
})();
