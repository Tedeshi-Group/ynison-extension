(function ymSyncPlayerSyncModule() {
  const app = window.__ymSync;
  if (!app || (app.modules && app.modules.playerSync)) {
    return;
  }

  app.modules.playerSync = true;

  const POST_MESSAGE_SOURCE = "ym-sync";
  const POST_MESSAGE_KIND = "ym_ws";

  const getPlayerStateFromOutgoing = (payload) => {
    const root = payload && payload.update_player_state;
    return root && root.player_state ? root.player_state : null;
  };

  const getPlayerStateFromIncoming = (payload) => {
    return payload && payload.player_state ? payload.player_state : null;
  };

  const normalizeWsPlayerState = (playerState) => {
    if (!playerState || typeof playerState !== "object") {
      return null;
    }

    const status = playerState.status || {};
    const queue = playerState.player_queue || {};

    const durationMs = Number(status.duration_ms ?? status.durationMs ?? 0) || 0;
    const progressMs = Number(status.progress_ms ?? status.progressMs ?? 0) || 0;
    const paused = Boolean(status.paused);

    const playableList = Array.isArray(queue.playable_list) ? queue.playable_list : [];
    const currentIndex = Number(queue.current_playable_index ?? queue.currentPlayableIndex ?? -1);
    const current = currentIndex >= 0 && currentIndex < playableList.length ? playableList[currentIndex] : null;

    const trackId = current && (current.playable_id || current.playableId) ? String(current.playable_id || current.playableId) : "";
    const title = current && typeof current.title === "string" ? current.title : "";

    return {
      paused,
      durationMs,
      positionMs: Math.max(0, Math.min(progressMs, durationMs || progressMs)),
      trackId,
      title,
      raw: playerState,
    };
  };

  app.STATE.ym = app.STATE.ym || {
    installed: false,
    lastOutgoing: null,
    lastIncoming: null,
    lastOutgoingAt: 0,
    lastIncomingAt: 0,
    lastSnapshot: null,
    lastSnapshotAt: 0,
    remotePlayerState: null,
    remotePlayerStateAt: 0,
    lastBroadcastAt: 0,
  };

  app.installYmWebSocketInterceptor = function installYmWebSocketInterceptor() {
    if (app.STATE.ym.installed) {
      return;
    }
    app.STATE.ym.installed = true;

    window.addEventListener("message", (event) => {
      if (event.source !== window) {
        return;
      }

      const data = event.data;
      if (!data || data.source !== POST_MESSAGE_SOURCE || data.kind !== POST_MESSAGE_KIND) {
        return;
      }

      const direction = data.direction === "out" ? "out" : "in";
      const payload = data.payload && typeof data.payload === "object" ? data.payload : null;
      if (!payload) {
        return;
      }

      app.handleYmWsPayload(direction, payload);
    });
  };

  app.handleYmWsPayload = function handleYmWsPayload(direction, payload) {
    const now = Date.now();
    if (direction === "out") {
      app.STATE.ym.lastOutgoing = payload;
      app.STATE.ym.lastOutgoingAt = now;
    } else {
      app.STATE.ym.lastIncoming = payload;
      app.STATE.ym.lastIncomingAt = now;
    }

    const playerState =
      direction === "out" ? getPlayerStateFromOutgoing(payload) : getPlayerStateFromIncoming(payload);
    const snapshot = normalizeWsPlayerState(playerState);
    if (!snapshot) {
      return;
    }

    app.STATE.ym.lastSnapshot = snapshot;
    app.STATE.ym.lastSnapshotAt = now;
    app.debug("YM WS player snapshot", direction, snapshot);

    app.maybeBroadcastYmPlayerState(snapshot, now);
  };

  app.maybeBroadcastYmPlayerState = function maybeBroadcastYmPlayerState(snapshot, now = Date.now()) {
    try {
      const self = typeof app.getSelfParticipant === "function" ? app.getSelfParticipant() : null;
      const isHost = Boolean(self && self.role === "host");
      if (!isHost) {
        return;
      }

      if (typeof app.sendSocketMessage !== "function" || !app.STATE.socket || app.STATE.socket.readyState !== WebSocket.OPEN) {
        return;
      }

      const lastAt = Number(app.STATE.ym.lastBroadcastAt || 0);
      if (now - lastAt < 250) {
        return;
      }

      if (!snapshot || !snapshot.raw || typeof snapshot.raw !== "object") {
        return;
      }

      const sent = app.sendSocketMessage({
        type: "ym_player_state",
        at: now,
        source: app.STATE.clientId || "",
        playerState: snapshot.raw,
        trackId: snapshot.trackId,
      });
      if (sent) {
        app.STATE.ym.lastBroadcastAt = now;
      }
    } catch (_error) {
      // noop
    }
  };

  app.setRemoteYmPlayerState = function setRemoteYmPlayerState(playerState, at = Date.now()) {
    if (!playerState || typeof playerState !== "object") {
      return;
    }
    app.STATE.ym.remotePlayerState = playerState;
    app.STATE.ym.remotePlayerStateAt = Number(at || Date.now());
  };

  // --- Совместимость со старым кодом (bootstrap/clientApi) ---

  app.installDocumentActionWatcher = function installDocumentActionWatcher() {
    // Раньше тут были DOM-клики/next. Теперь источник истины — WebSocket.
  };

  app.installPlayerWatchers = function installPlayerWatchers() {
    app.installYmWebSocketInterceptor();
  };

  app.readPlaybackState = function readPlaybackState() {
    const snap = app.STATE.ym && app.STATE.ym.lastSnapshot;
    if (!snap) {
      return null;
    }
    return {
      trackId: snap.trackId,
      title: snap.title,
      artist: "",
      durationMs: snap.durationMs,
      positionMs: snap.positionMs,
      paused: snap.paused,
    };
  };

  app.syncPlaybackNow = async function syncPlaybackNow() {
    // В старой архитектуре это слало состояние в нашу комнату.
    // Сейчас оставляем no-op, чтобы `clientApi.js` не падал.
  };

  app.applyIncomingPlaybackState = function applyIncomingPlaybackState() {
    // Управление YM-плеером через DOM/audio удалено.
  };

  app.applyIncomingControl = function applyIncomingControl() {
    // Управление YM-плеером через DOM/audio удалено.
  };

  app.handleLocalControlIntent = function handleLocalControlIntent() {
    // Локальные интенты теперь приходят как исходящие `update_player_state`.
  };

  // Авто-старт перехвата как можно раньше.
  app.installYmWebSocketInterceptor();
})();
