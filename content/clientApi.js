(function ymSyncClientApiModule() {
  const app = window.__ymSync;
  if (!app || (app.modules && app.modules.clientApi)) {
    return;
  }

  app.modules.clientApi = true;

  app.loadApiBase = async function loadApiBase() {
    try {
      const value = await new Promise((resolve) => {
        if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) {
          resolve(app.constants.DEFAULT_API_BASE);
          return;
        }

        chrome.storage.local.get(["syncApiBase"], (data) => {
          resolve(data && typeof data.syncApiBase === "string" ? data.syncApiBase : app.constants.DEFAULT_API_BASE);
        });
      });

      return app.normalizeApiBase(value);
    } catch (_error) {
      return app.constants.DEFAULT_API_BASE;
    }
  };

  app.buildApiUrl = function buildApiUrl(pathname) {
    const origin = String(app.STATE.apiBase || "").replace(/\/+$/, "");
    const base = new URL(`${origin}/api/`);
    return new URL(pathname.replace(/^\//, ""), base).toString();
  };

  app.buildWsUrl = function buildWsUrl(roomId, clientId) {
    const url = new URL(app.buildApiUrl("/ws"));
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("roomId", roomId);
    url.searchParams.set("clientId", clientId);
    return url.toString();
  };

  app.apiRequest = async function apiRequest(pathname, options = {}) {
    const response = await fetch(app.buildApiUrl(pathname), {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });

    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const message = data && typeof data.error === "string" ? data.error : "Backend request failed";
      throw new Error(message);
    }

    return data;
  };

  app.createRoom = async function createRoom(options = {}) {
    const { silentToast = false } = options;
    if (app.STATE.isBusy) {
      return false;
    }

    app.setBusy(true);
    app.clearError();

    try {
      app.STATE.profile = app.buildProfileFromPage();
      const data = await app.apiRequest("/rooms", {
        method: "POST",
        body: JSON.stringify({
          hostClientId: app.STATE.clientId || undefined,
          hostNickname: app.STATE.profile.nickname,
          hostAvatarUrl: app.STATE.profile.avatarUrl,
          roomName: "Sync lobby",
        }),
      });

      app.applyRoomJoinResult(data);
      if (!silentToast && typeof app.toast === "function") {
        app.toast("Комната создана");
      }
      await app.syncPlaybackNow({ force: true });
      return true;
    } catch (error) {
      app.setError(error);
      return false;
    } finally {
      app.setBusy(false);
      if (typeof app.render === "function") {
        app.render();
      }
    }
  };

  app.ensureAutoRoom = async function ensureAutoRoom() {
    if (app.STATE.roomId || app.STATE.isBusy) {
      return;
    }

    await app.createRoom({ silentToast: true });
  };

  app.joinRoom = async function joinRoom(rawValue, options = {}) {
    const { silentToast = false } = options;
    if (app.STATE.isBusy) {
      return false;
    }

    const roomId = app.extractRoomId(rawValue);
    if (!roomId) {
      app.setError("Укажите ID комнаты или ссылку-приглашение");
      return false;
    }

    app.setBusy(true);
    app.clearError();

    try {
      app.STATE.profile = app.buildProfileFromPage();
      const data = await app.apiRequest(`/rooms/${encodeURIComponent(roomId)}/join`, {
        method: "POST",
        body: JSON.stringify({
          clientId: app.STATE.clientId || undefined,
          nickname: app.STATE.profile.nickname,
          avatarUrl: app.STATE.profile.avatarUrl,
        }),
      });

      app.applyRoomJoinResult(data);
      if (data && data.state && data.state.playback) {
        app.applyIncomingPlaybackState(data.state.playback);
      }
      if (!silentToast && typeof app.toast === "function") {
        app.toast("Подключение к комнате выполнено");
      }
      return true;
    } catch (error) {
      if (localStorage.getItem(app.constants.STORAGE_ROOM_KEY) === roomId) {
        localStorage.removeItem(app.constants.STORAGE_ROOM_KEY);
      }
      app.setError(error);
      return false;
    } finally {
      app.setBusy(false);
      if (typeof app.render === "function") {
        app.render();
      }
    }
  };

  app.applyRoomJoinResult = function applyRoomJoinResult(data) {
    app.STATE.roomId = app.normalizeRoomId(data && data.roomId);
    app.STATE.clientId = app.normalizeRoomId(data && data.clientId) || app.STATE.clientId;
    app.STATE.roomState = data && data.state ? data.state : null;
    app.STATE.inviteLink = app.STATE.roomId ? app.buildInviteLink(app.STATE.roomId) : "";
    app.STATE.joinInput = app.STATE.roomId;
    app.STATE.playerMismatchHint = "";
    app.STATE.pendingRemotePlayback = null;
    app.STATE.pendingTrackId = "";
    app.STATE.pendingTrackAttempts = 0;
    if (typeof app.clearRemotePlaybackControlRetry === "function") {
      app.clearRemotePlaybackControlRetry();
    }

    if (app.STATE.clientId) {
      localStorage.setItem(app.constants.STORAGE_CLIENT_KEY, app.STATE.clientId);
    }
    if (app.STATE.roomId) {
      localStorage.setItem(app.constants.STORAGE_ROOM_KEY, app.STATE.roomId);
    }

    app.connectRoomSocket();
    if (app.STATE.isPageOpen) {
      app.syncPageUrl();
    }
    if (typeof app.render === "function") {
      app.render();
    }
  };

  app.disconnectFromRoom = function disconnectFromRoom() {
    app.closeSocket({ manual: true });
    app.clearReconnectTimer();
    localStorage.removeItem(app.constants.STORAGE_ROOM_KEY);

    app.STATE.roomId = "";
    app.STATE.roomState = null;
    app.STATE.inviteLink = "";
    app.STATE.joinInput = "";
    app.STATE.socketState = "idle";
    app.STATE.playerMismatchHint = "";
    app.STATE.lastSentPlayback = null;
    app.STATE.lastPlaybackSentAt = 0;
    app.STATE.pendingRemotePlayback = null;
    app.STATE.pendingTrackId = "";
    app.STATE.pendingTrackAttempts = 0;
    if (typeof app.clearRemotePlaybackControlRetry === "function") {
      app.clearRemotePlaybackControlRetry();
    }

    app.clearError();
    if (typeof app.render === "function") {
      app.render();
    }
    if (typeof app.toast === "function") {
      app.toast("Локальное подключение к комнате отключено");
    }
  };

  app.reconnectRoom = function reconnectRoom() {
    if (!app.STATE.roomId || !app.STATE.clientId) {
      if (typeof app.toast === "function") {
        app.toast("Нет активной комнаты для переподключения");
      }
      return;
    }

    app.connectRoomSocket();
  };

  app.recreateRoom = async function recreateRoom() {
    if (app.STATE.isBusy) {
      return false;
    }

    if (app.STATE.socket) {
      app.closeSocket({ manual: true });
    }

    app.STATE.roomId = "";
    app.STATE.roomState = null;
    app.STATE.inviteLink = "";
    app.STATE.joinInput = "";
    app.STATE.pendingRemotePlayback = null;
    app.STATE.pendingTrackId = "";
    app.STATE.pendingTrackAttempts = 0;
    if (typeof app.clearRemotePlaybackControlRetry === "function") {
      app.clearRemotePlaybackControlRetry();
    }
    localStorage.removeItem(app.constants.STORAGE_ROOM_KEY);
    if (typeof app.render === "function") {
      app.render();
    }

    const created = await app.createRoom({ silentToast: true });
    if (created && typeof app.toast === "function") {
      app.toast("Комната пересоздана");
    }
    return created;
  };

  app.connectRoomSocket = function connectRoomSocket() {
    if (!app.STATE.roomId || !app.STATE.clientId) {
      return;
    }

    app.closeSocket({ manual: true, preserveState: true });
    app.clearReconnectTimer();

    app.STATE.shouldReconnect = true;
    app.STATE.socketState = "connecting";
    app.STATE.lastError = "";
    app.debug("Connecting socket", { roomId: app.STATE.roomId, clientId: app.STATE.clientId });

    const socket = new WebSocket(app.buildWsUrl(app.STATE.roomId, app.STATE.clientId));
    app.STATE.socket = socket;
    if (typeof app.render === "function") {
      app.render();
    }

    socket.addEventListener("open", () => {
      if (app.STATE.socket !== socket) {
        return;
      }

      app.STATE.socketState = "connected";
      app.debug("Socket connected");
      app.clearError();
      if (typeof app.render === "function") {
        app.render();
      }
      void app.syncPlaybackNow({ force: true, respectAuthority: true });
    });

    socket.addEventListener("message", (event) => {
      if (app.STATE.socket !== socket) {
        return;
      }

      let payload;
      try {
        payload = JSON.parse(String(event.data || ""));
      } catch (_error) {
        return;
      }

      app.handleSocketMessage(payload);
    });

    socket.addEventListener("close", () => {
      if (app.STATE.socket !== socket) {
        return;
      }

      app.debugWarn("Socket closed", { roomId: app.STATE.roomId, clientId: app.STATE.clientId });
      app.STATE.socket = null;
      app.STATE.socketState = app.STATE.roomId && app.STATE.shouldReconnect ? "disconnected" : "idle";
      if (typeof app.render === "function") {
        app.render();
      }

      if (app.STATE.roomId && app.STATE.shouldReconnect) {
        app.scheduleReconnect();
      }
    });

    socket.addEventListener("error", () => {
      if (app.STATE.socket !== socket) {
        return;
      }

      app.debugWarn("Socket error event");
      app.STATE.socketState = "disconnected";
      if (typeof app.render === "function") {
        app.render();
      }
    });
  };

  app.closeSocket = function closeSocket(options = {}) {
    const { manual = false, preserveState = false } = options;
    app.clearReconnectTimer();
    app.STATE.shouldReconnect = !manual && Boolean(app.STATE.roomId);

    const socket = app.STATE.socket;
    app.STATE.socket = null;
    if (!preserveState) {
      app.STATE.socketState = manual ? "idle" : "disconnected";
    }

    if (socket) {
      try {
        socket.close();
      } catch (_error) {
        // noop
      }
    }
  };

  app.scheduleReconnect = function scheduleReconnect() {
    if (app.STATE.reconnectTimer || !app.STATE.roomId || !app.STATE.clientId) {
      return;
    }

    app.STATE.reconnectTimer = window.setTimeout(() => {
      app.STATE.reconnectTimer = 0;
      if (!app.STATE.shouldReconnect || app.STATE.socket || !app.STATE.roomId || !app.STATE.clientId) {
        return;
      }
      app.connectRoomSocket();
    }, app.constants.RECONNECT_DELAY_MS);
  };

  app.clearReconnectTimer = function clearReconnectTimer() {
    if (!app.STATE.reconnectTimer) {
      return;
    }

    window.clearTimeout(app.STATE.reconnectTimer);
    app.STATE.reconnectTimer = 0;
  };

  app.handleSocketMessage = function handleSocketMessage(payload) {
    if (!payload || typeof payload !== "object") {
      return;
    }
    app.debug("Incoming socket message", payload.type, payload);

    if (payload.type === "room_state") {
      app.applyIncomingRoomState(payload.state);
      return;
    }

    if (payload.type === "participant_presence") {
      app.patchParticipantPresence(payload);
      return;
    }

    if (payload.type === "permissions_update") {
      app.patchParticipantPermissions(payload);
      return;
    }

    if (payload.type === "state_update") {
      app.patchPlaybackState(payload.playback);
      if (payload.playback && payload.playback.source !== app.STATE.clientId) {
        app.applyIncomingPlaybackState(payload.playback);
      }
      return;
    }

    if (payload.type === "control") {
      if (payload.from !== app.STATE.clientId) {
        app.applyIncomingControl(payload);
      }
      return;
    }

    if (payload.type === "error") {
      app.setError(payload.error || "Backend error");
    }
  };

  app.applyIncomingRoomState = function applyIncomingRoomState(roomState) {
    if (!roomState || typeof roomState !== "object") {
      return;
    }

    app.STATE.roomState = roomState;
    app.STATE.roomId = app.normalizeRoomId(roomState.id) || app.STATE.roomId;
    app.STATE.inviteLink = app.STATE.roomId ? app.buildInviteLink(app.STATE.roomId) : "";
    if (app.STATE.roomId) {
      app.STATE.joinInput = app.STATE.roomId;
      localStorage.setItem(app.constants.STORAGE_ROOM_KEY, app.STATE.roomId);
    }

    if (typeof app.render === "function") {
      app.render();
    }
    if (roomState.playback && roomState.playback.source !== app.STATE.clientId) {
      app.applyIncomingPlaybackState(roomState.playback);
    }
  };

  app.patchParticipantPresence = function patchParticipantPresence(payload) {
    if (!app.STATE.roomState || !Array.isArray(app.STATE.roomState.participants)) {
      return;
    }

    const participant = app.STATE.roomState.participants.find((item) => item.clientId === payload.clientId);
    if (!participant) {
      return;
    }

    participant.isConnected = Boolean(payload.isConnected);
    participant.lastSeenAt = Number(payload.at || Date.now());
    if (typeof app.render === "function") {
      app.render();
    }
  };

  app.patchParticipantPermissions = function patchParticipantPermissions(payload) {
    if (!app.STATE.roomState || !Array.isArray(app.STATE.roomState.participants)) {
      return;
    }

    const participant = app.STATE.roomState.participants.find((item) => item.clientId === payload.clientId);
    if (!participant) {
      return;
    }

    participant.permissions = payload.permissions || participant.permissions;
    if (typeof app.render === "function") {
      app.render();
    }
  };

  app.patchPlaybackState = function patchPlaybackState(playback) {
    if (!playback) {
      return;
    }

    if (!app.STATE.roomState) {
      app.STATE.roomState = {
        id: app.STATE.roomId,
        participants: [],
        playback,
      };
    } else {
      app.STATE.roomState.playback = playback;
    }
    if (typeof app.render === "function") {
      app.render();
    }
  };

  app.sendSocketMessage = function sendSocketMessage(payload) {
    if (!app.STATE.socket || app.STATE.socket.readyState !== WebSocket.OPEN) {
      app.debugWarn("Socket send skipped: socket not open", payload && payload.type, payload);
      return false;
    }

    app.debug("Socket send", payload.type, payload);
    app.STATE.socket.send(JSON.stringify(payload));
    return true;
  };

  app.sendControl = function sendControl(action, payload = {}) {
    const sent = app.sendSocketMessage({
      type: "control",
      action,
      payload,
    });

    if (sent) {
      app.STATE.localAuthorityUntil = Date.now() + 10000;
    }
  };
})();
