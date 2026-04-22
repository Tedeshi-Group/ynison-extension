(() => {
  const SRC = "ym-sync";
  const KIND = "ym_ws";
  const BRIDGE_KIND = "ym_state";
  const DEBUG_KEY = "ym-sync-debug";

  const NativeWebSocket = window.WebSocket;
  if (!NativeWebSocket || NativeWebSocket.__ymSyncPatched) {
    return;
  }

  const isDebug = () => {
    try {
      return localStorage.getItem(DEBUG_KEY) === "1";
    } catch (_error) {
      return false;
    }
  };

  const log = (...args) => {
    if (!isDebug()) {
      return;
    }
    // eslint-disable-next-line no-console
    console.debug("[YM Sync][wsHook]", ...args);
  };

  let remotePlayerState = null;
  let remotePlayerStateAt = 0;
  let overrideEnabled = false;
  let lastOverrideAt = 0;
  let lastOverrideInfo = null;

  const readTrackId = (playerState) => {
    try {
      const queue = playerState && playerState.player_queue ? playerState.player_queue : null;
      const list = queue && Array.isArray(queue.playable_list) ? queue.playable_list : [];
      const idx = Number(queue && queue.current_playable_index);
      const cur = idx >= 0 && idx < list.length ? list[idx] : null;
      const id = cur && (cur.playable_id || cur.playableId);
      return id ? String(id) : "";
    } catch (_error) {
      return "";
    }
  };

  const publishState = () => {
    try {
      window.__ymSyncWsHookDebug = {
        overrideEnabled,
        remotePlayerStateAt,
        remoteTrackId: readTrackId(remotePlayerState),
        lastOverrideAt,
        lastOverrideInfo,
        debug: isDebug(),
      };
    } catch (_error) {
      // noop
    }
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window) {
      return;
    }
    const data = event.data;
    if (!data || data.source !== SRC || data.kind !== BRIDGE_KIND) {
      return;
    }
    if (data.type !== "ym_player_state") {
      return;
    }
    if (!data.playerState || typeof data.playerState !== "object") {
      return;
    }

    remotePlayerState = data.playerState;
    remotePlayerStateAt = Number(data.at || Date.now());
    overrideEnabled = !Boolean(data.isHost);
    log("bridge ym_player_state", {
      at: remotePlayerStateAt,
      overrideEnabled,
      isHost: Boolean(data.isHost),
      keys: Object.keys(remotePlayerState || {}).slice(0, 8),
    });
    publishState();
  });

  const safeToText = async (data) => {
    try {
      if (typeof data === "string") {
        return data;
      }
      if (data instanceof ArrayBuffer) {
        return new TextDecoder().decode(new Uint8Array(data));
      }
      if (ArrayBuffer.isView(data)) {
        return new TextDecoder().decode(data);
      }
      if (data instanceof Blob) {
        return await data.text();
      }
    } catch (_error) {
      // noop
    }
    return null;
  };

  const safeJsonParse = (text) => {
    if (typeof text !== "string") {
      return null;
    }
    const t = text.trim();
    if (!t || (!t.startsWith("{") && !t.startsWith("["))) {
      return null;
    }
    try {
      return JSON.parse(t);
    } catch (_error) {
      return null;
    }
  };

  const post = (direction, payload, meta) => {
    try {
      window.postMessage({ source: SRC, kind: KIND, direction, payload, meta }, "*");
    } catch (_error) {
      // noop
    }
  };

  const buildOverriddenWsPayload = (originalPayload, remotePlayerState) => {
    if (!originalPayload || typeof originalPayload !== "object") {
      return null;
    }
    if (!remotePlayerState || typeof remotePlayerState !== "object") {
      return null;
    }
    if (!originalPayload.player_state || typeof originalPayload.player_state !== "object") {
      return null;
    }

    return {
      ...originalPayload,
      player_state: remotePlayerState,
    };
  };

  const canOverrideIncoming = () => {
    if (!overrideEnabled) {
      return false;
    }
    if (!remotePlayerState) {
      return false;
    }

    const ageMs = Date.now() - Number(remotePlayerStateAt || 0);
    return ageMs >= 0 && ageMs < 15000;
  };

  const overrideIncomingMessageEvent = (event) => {
    if (!event) {
      return event;
    }
    if (!canOverrideIncoming()) {
      return event;
    }

    const remote = remotePlayerState;
    if (!remote || typeof remote !== "object") {
      return event;
    }

    const raw = event.data;

    const patchFromText = (text) => {
      if (!text) {
        return event;
      }

      const originalPayload = safeJsonParse(text);
      if (!originalPayload || !originalPayload.player_state) {
        return event;
      }

      const overridden = buildOverriddenWsPayload(originalPayload, remote);
      if (!overridden) {
        return event;
      }

      const beforeTrack = readTrackId(originalPayload.player_state);
      const afterTrack = readTrackId(remote);
      if (beforeTrack !== afterTrack) {
        log("override applied trackId changed", { beforeTrack, afterTrack });
      } else {
        log("override applied", { trackId: afterTrack || beforeTrack });
      }
      lastOverrideAt = Date.now();
      lastOverrideInfo = { beforeTrack, afterTrack, rid: originalPayload.rid, session_id: originalPayload.session_id };
      publishState();

      const newText = JSON.stringify(overridden);
      let newData = newText;

      try {
        if (raw instanceof ArrayBuffer) {
          newData = new TextEncoder().encode(newText).buffer;
        } else if (ArrayBuffer.isView(raw)) {
          newData = new TextEncoder().encode(newText);
        } else if (raw instanceof Blob) {
          newData = new Blob([newText], { type: raw.type || "application/json" });
        }
      } catch (_error) {
        newData = newText;
      }

      try {
        return new MessageEvent("message", {
          data: newData,
          origin: event.origin,
          lastEventId: event.lastEventId,
          source: event.source,
          ports: event.ports,
        });
      } catch (_error) {
        return event;
      }
    };

    if (typeof raw === "string") {
      const res = patchFromText(raw);
      if (res === event && isDebug()) {
        const parsed = safeJsonParse(raw);
        if (parsed && parsed.player_state) {
          log("override skipped (string) reason", {
            overrideEnabled,
            hasRemote: Boolean(remotePlayerState),
            ageMs: Date.now() - Number(remotePlayerStateAt || 0),
          });
        }
      }
      return res;
    }

    try {
      if (raw instanceof ArrayBuffer) {
        const text = new TextDecoder().decode(new Uint8Array(raw));
        return patchFromText(text);
      }
      if (ArrayBuffer.isView(raw)) {
        const text = new TextDecoder().decode(raw);
        return patchFromText(text);
      }
    } catch (_error) {
      return event;
    }

    if (raw instanceof Blob) {
      return raw
        .text()
        .then((text) => patchFromText(text))
        .catch(() => event);
    }

    return event;
  };

  const listenerMapBySocket = new WeakMap();

  const wrapMessageListener = (ws, listener) => {
    if (typeof listener !== "function" || !ws) {
      return listener;
    }

    let socketMap = listenerMapBySocket.get(ws);
    if (!socketMap) {
      socketMap = new WeakMap();
      listenerMapBySocket.set(ws, socketMap);
    }

    const existing = socketMap.get(listener);
    if (existing) {
      return existing;
    }

    const wrapped = function (event) {
      const patched = overrideIncomingMessageEvent(event);
      if (patched && typeof patched.then === "function") {
        patched.then((resolved) => {
          try {
            listener.call(this, resolved);
          } catch (_error) {
            // noop
          }
        });
        return;
      }

      try {
        listener.call(this, patched);
      } catch (_error) {
        // noop
      }
    };

    socketMap.set(listener, wrapped);
    return wrapped;
  };

  const Patched = function (url, protocols) {
    const ws =
      protocols !== undefined ? new NativeWebSocket(url, protocols) : new NativeWebSocket(url);
    try {
      ws.addEventListener("message", (event) => {
        const raw = event && event.data;
        if (typeof raw === "string") {
          const parsed = safeJsonParse(raw);
          if (parsed && (parsed.player_state || parsed.update_player_state)) {
            post("in", parsed, { url: String(url || ""), type: "text" });
          }
          return;
        }

        Promise.resolve(safeToText(raw)).then((text) => {
          if (!text) {
            return;
          }
          const parsed = safeJsonParse(text);
          if (parsed && (parsed.player_state || parsed.update_player_state)) {
            post("in", parsed, { url: String(url || ""), type: "binary->text" });
          }
        });
      });
    } catch (_error) {
      // noop
    }
    return ws;
  };

  Patched.prototype = NativeWebSocket.prototype;
  Object.setPrototypeOf(Patched, NativeWebSocket);

  const nativeSend = NativeWebSocket.prototype.send;
  NativeWebSocket.prototype.send = function (data) {
    try {
      if (typeof data === "string") {
        const parsed = safeJsonParse(data);
        if (parsed && (parsed.player_state || parsed.update_player_state)) {
          post("out", parsed, { url: String((this && this.url) || ""), type: "text" });
        }
      } else {
        Promise.resolve(safeToText(data)).then((text) => {
          if (!text) {
            return;
          }
          const parsed = safeJsonParse(text);
          if (parsed && (parsed.player_state || parsed.update_player_state)) {
            post("out", parsed, { url: String((this && this.url) || ""), type: "binary->text" });
          }
        });
      }
    } catch (_error) {
      // noop
    }
    return nativeSend.apply(this, arguments);
  };

  const nativeAddEventListener = NativeWebSocket.prototype.addEventListener;
  NativeWebSocket.prototype.addEventListener = function (type, listener, options) {
    if (type === "message") {
      return nativeAddEventListener.call(this, type, wrapMessageListener(this, listener), options);
    }
    return nativeAddEventListener.call(this, type, listener, options);
  };

  const nativeRemoveEventListener = NativeWebSocket.prototype.removeEventListener;
  NativeWebSocket.prototype.removeEventListener = function (type, listener, options) {
    if (type === "message" && listener && typeof listener === "function") {
      const socketMap = listenerMapBySocket.get(this);
      const wrapped = socketMap ? socketMap.get(listener) : null;
      return nativeRemoveEventListener.call(this, type, wrapped || listener, options);
    }
    return nativeRemoveEventListener.call(this, type, listener, options);
  };

  try {
    const desc = Object.getOwnPropertyDescriptor(NativeWebSocket.prototype, "onmessage");
    if (desc && (typeof desc.set === "function" || typeof desc.get === "function")) {
      Object.defineProperty(NativeWebSocket.prototype, "onmessage", {
        configurable: true,
        enumerable: desc.enumerable,
        get() {
          return desc.get ? desc.get.call(this) : null;
        },
        set(handler) {
          if (typeof handler !== "function") {
            if (desc.set) {
              desc.set.call(this, handler);
            }
            return;
          }
          const wrapped = wrapMessageListener(this, handler);
          if (desc.set) {
            desc.set.call(this, wrapped);
          }
        },
      });
    }
  } catch (_error) {
    // noop
  }

  window.WebSocket = Patched;
  window.WebSocket.__ymSyncPatched = true;
})();

