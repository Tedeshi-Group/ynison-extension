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

  const getUseHref = (useEl) => {
    if (!useEl) {
      return "";
    }
    return useEl.getAttribute("href") || useEl.getAttribute("xlink:href") || "";
  };

  const isUsableForHitTest = (el) => {
    if (!el || !el.isConnected) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width < 0.1 && rect.height < 0.1) {
      return false;
    }
    let x = el;
    while (x) {
      if (x === document) {
        return true;
      }
      if (x.hidden) {
        return false;
      }
      const s = getComputedStyle(x);
      if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") {
        return false;
      }
      x = x.parentElement;
    }
    return true;
  };

  const buildMainPlayerPlayScored = () => {
    const uses = document.getElementsByTagName("use");
    const scored = [];
    for (let i = 0; i < uses.length; i++) {
      const u = uses[i];
      const h = getUseHref(u);
      if (h.includes("play_filled_l")) {
        if (!isUsableForHitTest(u)) {
          continue;
        }
        const r = u.getBoundingClientRect();
        const cy = r.top + r.height * 0.5;
        scored.push({ u, paused: true, cy });
      } else if (h.includes("pause_filled_l")) {
        if (!isUsableForHitTest(u)) {
          continue;
        }
        const r = u.getBoundingClientRect();
        const cy = r.top + r.height * 0.5;
        scored.push({ u, paused: false, cy });
      }
    }
    return scored;
  };

  const pickMainPlayerPlay = (scored) => {
    if (scored.length === 0) {
      return null;
    }
    if (scored.length === 1) {
      return scored[0];
    }
    const inBottom = scored.filter((o) => o.cy > window.innerHeight * 0.45);
    const pool = inBottom.length > 0 ? inBottom : scored;
    pool.sort((a, b) => b.cy - a.cy);
    return pool[0];
  };

  const playButtonFromUse = (u) => {
    if (!u) {
      return null;
    }
    return u.closest("button, [role='button']");
  };

  /**
   * #play_filled_l — на паузе, #pause_filled_l — играет.
   * null, если кнопку/иконку не выяснили.
   */
  const getPausedFromMainPlayerPlayButton = () => {
    try {
      const pick = pickMainPlayerPlay(buildMainPlayerPlayScored());
      if (!pick) {
        return null;
      }
      return Boolean(pick.paused);
    } catch (_error) {
      return null;
    }
  };

  const getMainPlayerPlayButtonAndPaused = () => {
    try {
      const pick = pickMainPlayerPlay(buildMainPlayerPlayScored());
      if (!pick) {
        return { localPaused: null, toggleEl: null };
      }
      return { localPaused: Boolean(pick.paused), toggleEl: playButtonFromUse(pick.u) };
    } catch (_error) {
      return { localPaused: null, toggleEl: null };
    }
  };

  let _listenerPlayPauseTimer = 0;
  let _lastListenerPlayPauseClick = 0;
  const LISTENER_PLAYPAUSE_MIN_MS = 450;
  const LISTENER_PLAYPAUSE_DEBOUNCE_MS = 200;

  let _lastListenerSeekAt = 0;
  const LISTENER_SEEK_MIN_INTERVAL_MS = 750;

  const SEEK_ARIA_RES = [/manage time code/i, /time code/i, /тайм[\s-]?код/i, /позици/i];

  const isElementVisible = (el) => {
    if (!el || !el.isConnected) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 1) {
      return false;
    }
    let x = el;
    while (x && x !== document) {
      if (x.hidden) {
        return false;
      }
      const s = getComputedStyle(x);
      if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) {
        return false;
      }
      x = x.parentElement;
    }
    return true;
  };

  const getMainSeekRangeInput = () => {
    try {
      const ranges = document.querySelectorAll('input[type="range"]');
      let best = null;
      let bestScore = -1;
      for (let i = 0; i < ranges.length; i++) {
        const el = ranges[i];
        if (!isElementVisible(el)) {
          continue;
        }
        const aria = el.getAttribute("aria-label") || "";
        const cls = el.getAttribute("class") || "";
        let score = 0;
        if (aria && SEEK_ARIA_RES.some((re) => re.test(aria))) {
          score += 100;
        }
        if (cls.includes("ChangeTimecodeBackground") && cls.includes("slider")) {
          score += 50;
        }
        if (cls.includes("PlayerBar") && cls.includes("slider")) {
          score += 40;
        }
        const r = el.getBoundingClientRect();
        if (r.bottom < window.innerHeight * 0.35) {
          score -= 30;
        }
        if (score > bestScore) {
          bestScore = score;
          best = el;
        }
      }
      if (best && bestScore >= 45) {
        return best;
      }
      const cls = best ? best.getAttribute("class") || "" : "";
      if (best && cls.includes("ChangeTimecodeBackground")) {
        return best;
      }
    } catch (_e) {
      // noop
    }
    return null;
  };

  const inferSeekSliderScale = (maxVal, durationMs) => {
    if (!Number.isFinite(maxVal) || maxVal <= 0 || !Number.isFinite(durationMs) || durationMs < 800) {
      return "ms";
    }
    if (maxVal >= durationMs * 0.2) {
      return "ms";
    }
    const durSec = durationMs / 1000;
    if (Math.abs(maxVal - durSec) <= Math.max(1.5, durSec * 0.12)) {
      return "sec";
    }
    if (maxVal < durationMs / 20 && maxVal >= 2 && durationMs > 8000) {
      return "sec";
    }
    return "ms";
  };

  const readLocalSeekMs = (input, durationFallbackMs) => {
    const max = Number(input.max);
    const v = Number(input.value);
    const dur = Number.isFinite(durationFallbackMs) && durationFallbackMs > 0 ? durationFallbackMs : 0;
    if (Number.isFinite(max) && max > 0 && dur > 0) {
      const scale = inferSeekSliderScale(max, dur);
      if (scale === "sec") {
        const sec = Math.max(0, Math.min(v, max));
        return Math.max(0, Math.min(sec * 1000, dur));
      }
      return Math.max(0, Math.min(v, dur));
    }
    if (dur > 0) {
      return Math.max(0, Math.min(v, dur));
    }
    return Number.isFinite(v) ? Math.max(0, v) : 0;
  };

  const setNativeInputValue = (input, valueStr) => {
    try {
      const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
      if (desc && typeof desc.set === "function") {
        desc.set.call(input, valueStr);
        return;
      }
    } catch (_e) {
      // noop
    }
    input.value = valueStr;
  };

  const dispatchSeekPointerSequence = (input, clientX, clientY) => {
    const common = {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      view: window,
      button: 0,
      buttons: 1,
    };
    try {
      if (typeof PointerEvent === "function") {
        input.dispatchEvent(
          new PointerEvent("pointerdown", {
            ...common,
            pointerId: 1,
            pointerType: "mouse",
            isPrimary: true,
          })
        );
        input.dispatchEvent(
          new PointerEvent("pointerup", {
            ...common,
            pointerId: 1,
            pointerType: "mouse",
            isPrimary: true,
            buttons: 0,
          })
        );
      }
    } catch (_e) {
      // noop
    }
    input.dispatchEvent(new MouseEvent("mousedown", common));
    input.dispatchEvent(new MouseEvent("mouseup", { ...common, buttons: 0 }));
    input.dispatchEvent(new MouseEvent("click", { ...common, buttons: 0 }));
  };

  const seekSliderByRatio = (input, ratio, durationMs) => {
    const r = input.getBoundingClientRect();
    if (r.width < 1) {
      return false;
    }
    const t = Math.max(0, Math.min(1, ratio));
    const x = r.left + t * r.width;
    const y = r.top + r.height * 0.5;
    dispatchSeekPointerSequence(input, x, y);
    if (durationMs > 0) {
      const ms = Math.round(t * durationMs);
      setNativeInputValue(input, String(ms));
      try {
        input.setAttribute("value", String(ms));
      } catch (_e) {
        // noop
      }
    }
    return true;
  };

  const applySeekMsToSlider = (input, positionMs, durationMs) => {
    if (!input || !durationMs || durationMs < 500) {
      return false;
    }
    const dur = Math.round(durationMs);
    const pos = Math.max(0, Math.min(Math.round(positionMs), dur));
    const maxDom = Number(input.max);
    const scale =
      Number.isFinite(maxDom) && maxDom > 0
        ? inferSeekSliderScale(maxDom, dur)
        : inferSeekSliderScale(Math.round(dur / 1000), dur);

    let maxAttr;
    let valueStr;
    if (scale === "sec") {
      const durSec = Math.max(1, Math.round(dur / 1000));
      const posSec = Math.max(0, Math.min(Math.round(pos / 1000), durSec));
      maxAttr = String(durSec);
      valueStr = String(posSec);
    } else {
      maxAttr = String(dur);
      valueStr = String(pos);
    }

    if (input.getAttribute("max") !== maxAttr) {
      try {
        input.setAttribute("max", maxAttr);
      } catch (_e) {
        // noop
      }
    }
    try {
      input.max = maxAttr;
    } catch (_e) {
      // noop
    }
    setNativeInputValue(input, valueStr);
    try {
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    } catch (_e) {
      // noop
    }
    const after = readLocalSeekMs(input, dur);
    if (Math.abs(after - pos) > 1200) {
      seekSliderByRatio(input, pos / dur, dur);
    }
    return true;
  };

  /**
   * Важно: не использовать payload.at (часы хоста) вместе с Date.now() слушателя —
   * при рассинхроне часов получается гигантский elapsed и позиция упирается в конец трека.
   * Экстраполяция только по времени получения снимка на этой машине.
   */
  const estimateRemotePositionMs = (remote, receivedAtLocal) => {
    if (!remote || !remote.durationMs) {
      return 0;
    }
    const dur = remote.durationMs;
    const base = remote.positionMs;
    if (remote.paused) {
      return Math.max(0, Math.min(base, dur));
    }
    const t0 = Number(receivedAtLocal || 0);
    if (!t0 || t0 > Date.now() + 5000) {
      return Math.max(0, Math.min(base, dur));
    }
    const elapsed = Math.max(0, Date.now() - t0);
    return Math.max(0, Math.min(base + elapsed, dur));
  };

  const tryApplyRemoteSeekViaDom = () => {
    try {
      const self = typeof app.getSelfParticipant === "function" ? app.getSelfParticipant() : null;
      if (!self || self.role === "host") {
        return;
      }

      const playerState = app.STATE.ym && app.STATE.ym.remotePlayerState;
      if (!playerState) {
        return;
      }
      const remote = normalizeWsPlayerState(playerState);
      if (!remote || !remote.durationMs || remote.durationMs < 800) {
        return;
      }

      const receivedAt = Number(app.STATE.ym.remotePlayerStateReceivedAt || 0);
      const targetMs = estimateRemotePositionMs(remote, receivedAt);

      const input = getMainSeekRangeInput();
      if (!input) {
        return;
      }

      const localMs = readLocalSeekMs(input, remote.durationMs);
      const drift = Math.abs(targetMs - localMs);
      const minDrift = Number(app.constants.REMOTE_SEEK_MIN_DRIFT_MS) || 900;
      const forceDrift = Number(app.constants.REMOTE_SEEK_FORCE_DRIFT_MS) || 3000;
      if (drift < minDrift) {
        return;
      }

      const now = Date.now();
      const urgent = drift >= forceDrift;
      if (!urgent && now - _lastListenerSeekAt < LISTENER_SEEK_MIN_INTERVAL_MS) {
        return;
      }
      _lastListenerSeekAt = now;

      applySeekMsToSlider(input, targetMs, remote.durationMs);
    } catch (_e) {
      // noop
    }
  };

  const tryApplyRemotePlayPauseViaDom = () => {
    try {
      const self = typeof app.getSelfParticipant === "function" ? app.getSelfParticipant() : null;
      if (!self || (self.role === "host")) {
        return;
      }

      const playerState = app.STATE.ym && app.STATE.ym.remotePlayerState;
      if (!playerState) {
        return;
      }
      const remote = normalizeWsPlayerState(playerState);
      if (!remote) {
        return;
      }

      const { localPaused, toggleEl } = getMainPlayerPlayButtonAndPaused();
      if (localPaused === null) {
        return;
      }
      if (Boolean(remote.paused) === localPaused) {
        return;
      }
      if (!toggleEl) {
        return;
      }
      if (typeof toggleEl.click !== "function") {
        return;
      }

      const now = Date.now();
      if (now - _lastListenerPlayPauseClick < LISTENER_PLAYPAUSE_MIN_MS) {
        return;
      }
      _lastListenerPlayPauseClick = now;
      toggleEl.click();
    } catch (_e) {
      // noop
    }
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
    remotePlayerStateReceivedAt: 0,
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

      const uiPaused = getPausedFromMainPlayerPlayButton();
      const raw =
        uiPaused === null
          ? snapshot.raw
          : {
              ...snapshot.raw,
              status: {
                ...(snapshot.raw.status && typeof snapshot.raw.status === "object" ? snapshot.raw.status : {}),
                paused: uiPaused,
              },
            };

      const sent = app.sendSocketMessage({
        type: "ym_player_state",
        at: now,
        source: app.STATE.clientId || "",
        playerState: raw,
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
    app.STATE.ym.remotePlayerStateReceivedAt = Date.now();

    if (_listenerPlayPauseTimer) {
      window.clearTimeout(_listenerPlayPauseTimer);
      _listenerPlayPauseTimer = 0;
    }
    _listenerPlayPauseTimer = window.setTimeout(() => {
      _listenerPlayPauseTimer = 0;
      requestAnimationFrame(() => {
        tryApplyRemotePlayPauseViaDom();
        tryApplyRemoteSeekViaDom();
      });
    }, LISTENER_PLAYPAUSE_DEBOUNCE_MS);
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
