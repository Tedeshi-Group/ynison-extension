(function ymSyncPlayerSyncModule() {
  const app = window.__ymSync;
  if (!app || (app.modules && app.modules.playerSync)) {
    return;
  }

  app.modules.playerSync = true;
  const TRACK_NAV_GUARD_KEY = "ym-sync-last-track-nav";

  app.installDocumentActionWatcher = function installDocumentActionWatcher() {
    document.addEventListener(
      "click",
      (event) => {
        const button = event.target instanceof Element ? event.target.closest("button") : null;
        if (!button) {
          return;
        }

        const label = (button.getAttribute("aria-label") || button.getAttribute("title") || "").trim();
        if (!label) {
          return;
        }

        if (app.constants.NEXT_BUTTON_LABELS.some((value) => label.includes(value))) {
          app.handleLocalControlIntent("next");
        }
      },
      true
    );
  };

  app.applyIncomingPlaybackState = function applyIncomingPlaybackState(playback) {
    const audio = app.getAudioElement();
    const localPlayback = app.readPlaybackState();
    if (!playback) {
      return;
    }
    const effectivePlayback = app.buildEffectivePlaybackSnapshot(playback);
    app.debug("Apply incoming playback state", { incoming: effectivePlayback, local: localPlayback });

    app.STATE.suppressLocalEventsUntil = Date.now() + app.constants.REMOTE_GUARD_MS;

    const incomingTrackId = String(effectivePlayback.trackId || "");
    const localTrackId = String((localPlayback && localPlayback.trackId) || "");
    const trackMismatch = Boolean(incomingTrackId) && incomingTrackId !== localTrackId;

    if (trackMismatch || !localPlayback) {
      app.debugWarn("Track mismatch detected", { incomingTrackId, localTrackId, hasLocalPlayback: Boolean(localPlayback) });
      const now = Date.now();
      if (app.STATE.pendingTrackId !== incomingTrackId) {
        app.STATE.pendingTrackId = incomingTrackId;
        app.STATE.pendingTrackAttempts = 0;
        app.STATE.pendingTrackFirstSeenAt = now;
      }

      app.STATE.pendingRemotePlayback = effectivePlayback;
      app.STATE.remoteApplyToken = now;
      app.STATE.playerMismatchHint = "Трек у listener отличается, пробую синхронизировать по trackId.";
      app.queueRemotePlaybackControl(effectivePlayback, "track-mismatch");
      if (typeof app.render === "function") {
        app.render();
      }
      return;
    }

    app.STATE.pendingRemotePlayback = null;
    app.STATE.pendingTrackId = "";
    app.STATE.pendingTrackAttempts = 0;
    app.STATE.pendingTrackFirstSeenAt = 0;
    app.STATE.playerMismatchHint = "";

    const settled = app.applyRemotePlaybackToCurrentTrack(effectivePlayback, {
      audio,
      localPlayback,
      reason: "incoming-state",
    });
    if (!settled) {
      app.queueRemotePlaybackControl(effectivePlayback, "incoming-state-retry");
    }

    if (typeof app.render === "function") {
      app.render();
    }
  };

  app.coercePlaybackNumber = function coercePlaybackNumber(value, fallback = 0) {
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue)) {
      return fallback;
    }
    return numberValue;
  };

  app.clampPlaybackPosition = function clampPlaybackPosition(positionMs, durationMs) {
    const safePosition = Math.max(0, Math.round(app.coercePlaybackNumber(positionMs, 0)));
    const safeDuration = Math.max(0, Math.round(app.coercePlaybackNumber(durationMs, 0)));
    if (!safeDuration) {
      return safePosition;
    }
    return Math.min(safePosition, safeDuration);
  };

  app.getExpectedRemotePositionMs = function getExpectedRemotePositionMs(playback) {
    if (!playback) {
      return 0;
    }
    const now = Date.now();
    const paused = Boolean(playback.paused);
    const basePosition = app.clampPlaybackPosition(playback.positionMs, playback.durationMs);
    if (paused) {
      return basePosition;
    }

    const serverTs = app.coercePlaybackNumber(playback.serverTs, 0);
    if (!serverTs) {
      return basePosition;
    }

    const lagMs = Math.max(0, now - serverTs);
    return app.clampPlaybackPosition(basePosition + lagMs, playback.durationMs);
  };

  app.buildEffectivePlaybackSnapshot = function buildEffectivePlaybackSnapshot(playback) {
    if (!playback) {
      return playback;
    }
    return {
      ...playback,
      positionMs: app.getExpectedRemotePositionMs(playback),
    };
  };

  app.isRemotePlaybackSettled = function isRemotePlaybackSettled(targetPlayback, localPlayback, audio) {
    if (!targetPlayback || !localPlayback) {
      return false;
    }
    if (String(targetPlayback.trackId || "") !== String(localPlayback.trackId || "")) {
      return false;
    }

    const expectedPaused = Boolean(targetPlayback.paused);
    const actualPaused = audio ? Boolean(audio.paused) : Boolean(localPlayback.paused);
    if (expectedPaused !== actualPaused) {
      return false;
    }

    const targetPosition = app.getExpectedRemotePositionMs(targetPlayback);
    const localPosition = app.clampPlaybackPosition(localPlayback.positionMs, localPlayback.durationMs);
    const maxDrift = expectedPaused ? app.constants.REMOTE_SEEK_MIN_DRIFT_MS : app.constants.PLAYER_DRIFT_MS;
    return Math.abs(localPosition - targetPosition) <= maxDrift;
  };

  app.clearRemotePlaybackControlRetry = function clearRemotePlaybackControlRetry() {
    app.STATE.pendingRemotePlaybackControl = null;
    if (app.STATE.remotePlaybackRetryTimer) {
      window.clearTimeout(app.STATE.remotePlaybackRetryTimer);
      app.STATE.remotePlaybackRetryTimer = 0;
    }
  };

  app.queueRemotePlaybackControl = function queueRemotePlaybackControl(playback, reason) {
    if (!playback) {
      return;
    }
    const now = Date.now();
    app.STATE.pendingRemotePlaybackControl = {
      playback,
      reason: String(reason || "remote-control"),
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    app.scheduleRemotePlaybackControlRetry(120);
  };

  app.scheduleRemotePlaybackControlRetry = function scheduleRemotePlaybackControlRetry(delayMs = app.constants.REMOTE_APPLY_RETRY_MS) {
    if (app.STATE.remotePlaybackRetryTimer) {
      window.clearTimeout(app.STATE.remotePlaybackRetryTimer);
    }
    app.STATE.remotePlaybackRetryTimer = window.setTimeout(() => {
      app.STATE.remotePlaybackRetryTimer = 0;
      app.processPendingRemotePlaybackControl();
    }, Math.max(0, Number(delayMs) || 0));
  };

  app.processPendingRemotePlaybackControl = function processPendingRemotePlaybackControl() {
    const pending = app.STATE.pendingRemotePlaybackControl;
    if (!pending || !pending.playback) {
      return;
    }

    const now = Date.now();
    if (now - pending.createdAt > app.constants.REMOTE_APPLY_TTL_MS) {
      app.debugWarn("Pending remote control dropped by TTL", pending.reason, pending.attempts);
      app.clearRemotePlaybackControlRetry();
      return;
    }

    pending.attempts += 1;
    pending.updatedAt = now;

    const settled = app.applyRemotePlaybackToCurrentTrack(pending.playback, {
      reason: `retry-${pending.reason}-${pending.attempts}`,
    });
    if (settled || pending.attempts >= app.constants.REMOTE_APPLY_MAX_ATTEMPTS) {
      if (!settled) {
        app.debugWarn("Pending remote control dropped by attempts", pending.reason, pending.attempts);
      }
      app.clearRemotePlaybackControlRetry();
      return;
    }

    app.scheduleRemotePlaybackControlRetry(app.constants.REMOTE_APPLY_RETRY_MS);
  };

  app.applyRemotePlaybackToCurrentTrack = function applyRemotePlaybackToCurrentTrack(targetPlayback, options = {}) {
    const audio = options.audio || app.getAudioElement();
    const localPlayback = options.localPlayback || app.readPlaybackState();
    if (!targetPlayback || !localPlayback) {
      return false;
    }

    const targetTrackId = String(targetPlayback.trackId || "");
    const localTrackId = String(localPlayback.trackId || "");
    if (targetTrackId && localTrackId && targetTrackId !== localTrackId) {
      return false;
    }

    app.STATE.suppressLocalEventsUntil = Date.now() + app.constants.REMOTE_GUARD_MS;
    const targetPosition = app.getExpectedRemotePositionMs(targetPlayback);
    const localPosition = app.clampPlaybackPosition(localPlayback.positionMs, localPlayback.durationMs);
    const driftMs = Math.abs(localPosition - targetPosition);
    const hasHardDrift = driftMs >= app.constants.REMOTE_SEEK_FORCE_DRIFT_MS;
    const hasSoftDrift = driftMs > app.constants.REMOTE_SEEK_MIN_DRIFT_MS;
    if (
      audio &&
      Number.isFinite(targetPosition) &&
      (hasHardDrift || hasSoftDrift)
    ) {
      if (hasHardDrift) {
        app.debugWarn("Hard seek reconcile triggered", {
          driftMs,
          targetPosition,
          localPosition,
          reason: options.reason || "unknown",
        });
      }
      app.setAudioPosition(targetPosition);
    }

    const expectedPaused = Boolean(targetPlayback.paused);
    const actualPaused = audio ? Boolean(audio.paused) : Boolean(localPlayback.paused);
    if (expectedPaused !== actualPaused) {
      if (expectedPaused) {
        app.pauseAudio();
      } else {
        app.playAudio();
      }
    }

    const refreshedLocal = app.readPlaybackState();
    if (hasHardDrift && app.STATE.pendingRemotePlaybackControl) {
      app.scheduleRemotePlaybackControlRetry(120);
    }
    return app.isRemotePlaybackSettled(targetPlayback, refreshedLocal, app.getAudioElement());
  };

  app.applyIncomingControl = function applyIncomingControl(payload) {
    app.STATE.suppressLocalEventsUntil = Date.now() + app.constants.REMOTE_GUARD_MS;
    app.debug("Apply incoming control", payload);

    if (payload.action === "play") {
      app.playAudio();
      return;
    }

    if (payload.action === "pause") {
      app.pauseAudio();
      return;
    }

    if (payload.action === "seek") {
      app.setAudioPosition(Number(payload.payload && payload.payload.positionMs));
      return;
    }

    if (payload.action === "next") {
      app.clickNextTrack();
      return;
    }

    if (payload.action === "queue" && typeof app.toast === "function") {
      app.toast("Изменение очереди пока не привязано в UI");
    }
  };

  app.syncPlaybackNow = async function syncPlaybackNow(options = {}) {
    const { force = false, respectAuthority = false } = options;
    if (!app.STATE.roomId || !app.STATE.clientId) {
      app.debug("syncPlaybackNow skipped: roomId/clientId missing");
      return;
    }

    if (Date.now() < app.STATE.suppressLocalEventsUntil) {
      app.debug("syncPlaybackNow skipped: suppressLocalEventsUntil active");
      return;
    }

    const playback = app.readPlaybackState();
    if (!playback) {
      app.debug("syncPlaybackNow skipped: no playback snapshot");
      return;
    }

    if ((!force || respectAuthority) && !app.canPublishPlayback()) {
      app.debug("syncPlaybackNow skipped: no authority", { force, respectAuthority });
      return;
    }

    const now = Date.now();
    const shouldSend =
      force ||
      !app.STATE.lastSentPlayback ||
      playback.trackId !== app.STATE.lastSentPlayback.trackId ||
      playback.title !== app.STATE.lastSentPlayback.title ||
      playback.artist !== app.STATE.lastSentPlayback.artist ||
      playback.paused !== app.STATE.lastSentPlayback.paused ||
      playback.durationMs !== app.STATE.lastSentPlayback.durationMs ||
      Math.abs(playback.positionMs - app.STATE.lastSentPlayback.positionMs) > app.constants.PLAYER_DRIFT_MS ||
      now - app.STATE.lastPlaybackSentAt >= app.constants.PLAYER_HEARTBEAT_MS;

    if (!shouldSend) {
      return;
    }

    const sent = app.sendSocketMessage({
      type: "state_update",
      trackId: playback.trackId,
      title: playback.title,
      artist: playback.artist,
      durationMs: playback.durationMs,
      positionMs: playback.positionMs,
      paused: playback.paused,
    });

    if (!sent) {
      app.debugWarn("state_update not sent: socket unavailable");
      return;
    }
    app.debug("state_update sent", playback);

    app.STATE.lastSentPlayback = playback;
    app.STATE.lastPlaybackSentAt = now;
    app.patchPlaybackState({
      ...playback,
      source: app.STATE.clientId,
      serverTs: now,
    });
  };

  app.canPublishPlayback = function canPublishPlayback() {
    const self = app.getSelfParticipant();
    if (!self) {
      return true;
    }

    if (self.role === "host") {
      return true;
    }

    if (Date.now() < app.STATE.localAuthorityUntil) {
      return true;
    }

    if (app.STATE.pendingRemotePlayback) {
      return false;
    }

    const playback = app.STATE.roomState && app.STATE.roomState.playback;
    return !playback || !playback.source || playback.source === app.STATE.clientId;
  };

  app.installPlayerWatchers = function installPlayerWatchers() {
    app.installPlayerUiObserver();

    window.setInterval(() => {
      app.bindAudioEvents();
      app.attemptPendingRemoteTrackSync();
      app.processPendingRemotePlaybackControl();
      void app.syncPlaybackNow();
    }, app.constants.PLAYER_SYNC_INTERVAL_MS);

    window.setInterval(() => {
      if (app.STATE.roomId && app.STATE.clientId && app.STATE.socketState === "connected") {
        app.sendSocketMessage({ type: "ping" });
      }
    }, 15000);
  };

  app.installPlayerUiObserver = function installPlayerUiObserver() {
    if (app.STATE.playerUiObserverStarted) {
      return;
    }
    app.STATE.playerUiObserverStarted = true;
    app.debug("Player UI observer started");

    let flushTimer = 0;
    const flush = () => {
      flushTimer = 0;
      const isReady = app.hasPlayerInterfaceReady();
      if (!isReady) {
        if (app.STATE.playerUiReady) {
          app.STATE.playerUiReady = false;
          app.debug("Player UI observer: interface became unavailable");
        }
        return;
      }

      if (app.STATE.playerUiReady) {
        return;
      }

      app.STATE.playerUiReady = true;
      app.debug("Player UI observer: interface became ready");
      app.bindAudioEvents();
      app.attemptPendingRemoteTrackSync();
      void app.syncPlaybackNow({ force: true, respectAuthority: true });
    };

    const observer = new MutationObserver(() => {
      if (flushTimer) {
        return;
      }
      flushTimer = window.setTimeout(flush, 220);
    });

    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
    });

    app.STATE.playerUiObserver = observer;
    flush();
  };

  app.hasPlayerInterfaceReady = function hasPlayerInterfaceReady() {
    if (app.getAudioElement()) {
      return true;
    }

    const queueButton =
      document.querySelector('button[aria-label="Playback queue"]') ||
      document.querySelector('button[aria-label="Очередь воспроизведения"]');
    if (queueButton) {
      return true;
    }

    const playbackToggle = app.findPlayerControlButton([
      /pause/i,
      /пауза/i,
      /паузу/i,
      /play/i,
      /воспроиз/i,
      /продолж/i,
      /слушат/i,
      /включ/i,
      /игра(ть|ет|ем)/i,
    ]);
    return Boolean(playbackToggle);
  };

  app.bindAudioEvents = function bindAudioEvents() {
    const audio = app.getAudioElement();
    if (!audio || app.STATE.boundAudio === audio) {
      return;
    }

    if (app.STATE.boundAudio) {
      app.STATE.boundAudio.removeEventListener("play", app.handleAudioPlay);
      app.STATE.boundAudio.removeEventListener("pause", app.handleAudioPause);
      app.STATE.boundAudio.removeEventListener("seeked", app.handleAudioSeeked);
      app.STATE.boundAudio.removeEventListener("loadedmetadata", app.handleAudioLoadedMetadata);
    }

    app.STATE.boundAudio = audio;
    app.debug("Audio element bound", {
      src: audio.currentSrc || audio.src || "",
      paused: audio.paused,
    });
    audio.addEventListener("play", app.handleAudioPlay);
    audio.addEventListener("pause", app.handleAudioPause);
    audio.addEventListener("seeked", app.handleAudioSeeked);
    audio.addEventListener("loadedmetadata", app.handleAudioLoadedMetadata);
  };

  app.handleAudioPlay = function handleAudioPlay() {
    app.handleLocalControlIntent("play");
  };

  app.handleAudioPause = function handleAudioPause() {
    app.handleLocalControlIntent("pause");
  };

  app.handleAudioSeeked = function handleAudioSeeked() {
    const playback = app.readPlaybackState();
    app.handleLocalControlIntent("seek", {
      positionMs: playback ? playback.positionMs : 0,
    });
  };

  app.handleAudioLoadedMetadata = function handleAudioLoadedMetadata() {
    window.setTimeout(() => {
      void app.syncPlaybackNow({ force: true });
    }, 150);
    window.setTimeout(() => {
      app.processPendingRemotePlaybackControl();
    }, 220);
  };

  app.handleLocalControlIntent = function handleLocalControlIntent(action, payload = {}) {
    if (!app.STATE.roomId || !app.STATE.clientId || Date.now() < app.STATE.suppressLocalEventsUntil) {
      app.debug("Local control skipped by guard", { action, payload });
      return;
    }

    if (app.STATE.pendingRemotePlayback) {
      app.debug("Local control skipped: pending remote playback exists", { action, payload });
      return;
    }

    app.debug("Local control intent", { action, payload });
    if (action === "seek") {
      app.sendControl("seek", { positionMs: Number(payload.positionMs || 0) });
    } else {
      app.sendControl(action, {});
    }

    window.setTimeout(() => {
      void app.syncPlaybackNow({ force: true });
    }, 180);
  };

  app.getAudioElement = function getAudioElement() {
    return document.querySelector("audio, video");
  };

  app.readPlaybackState = function readPlaybackState() {
    const audio = app.getAudioElement();
    const metadata = navigator.mediaSession && navigator.mediaSession.metadata ? navigator.mediaSession.metadata : null;
    const metaRoot = app.resolvePlayerMetaRoot();
    const trackLink = (metaRoot && metaRoot.querySelector('a[href*="/track/"]')) || document.querySelector('a[href*="/track/"]');
    const trackId = trackLink ? app.extractTrackId(trackLink.getAttribute("href")) : "";
    const visibleTiming = app.readVisibleTimeState(metaRoot);
    const sliderTiming = app.readSliderTiming(metaRoot, visibleTiming.durationMs || 0);
    const titleFromDom = app.readTextFromSelectors(metaRoot, [
      '[class*="PlayerBarDesktopWithBackgroundProgressBar_triggerModal"] a[href*="/track/"][title]',
      'a[href*="/track/"][title]',
      'a[href*="/track/"]',
      '[class*="PlayerBarDesktopWithBackgroundProgressBar_triggerModal"] [title]',
      '[class*="PlayerBarDesktop"] [title]',
    ]);
    const artistFromDom = app.readTextFromSelectors(metaRoot, [
      '[class*="PlayerBarDesktopWithBackgroundProgressBar_triggerModal"] a[href*="/artist/"]',
      'a[href*="/artist/"]',
      'a[href*="/artists/"]',
    ]);

    const durationMs = app.pickTimingValue([
      audio && Number.isFinite(audio.duration) ? Math.max(0, Math.round(audio.duration * 1000)) : 0,
      sliderTiming.durationMs,
      visibleTiming.durationMs,
    ]);
    const positionMs = app.pickTimingValue([
      audio && Number.isFinite(audio.currentTime) ? Math.max(0, Math.round(audio.currentTime * 1000)) : 0,
      sliderTiming.positionMs,
      visibleTiming.positionMs,
    ]);
    const paused = audio ? Boolean(audio.paused) : app.inferPausedFromControls(metaRoot);

    if (!trackId && !((metadata && metadata.title) || titleFromDom || "") && !durationMs && !positionMs && !audio) {
      return null;
    }

    return {
      trackId,
      title: (metadata && metadata.title) || titleFromDom || "",
      artist: (metadata && metadata.artist) || artistFromDom || "",
      durationMs,
      positionMs,
      paused,
    };
  };

  app.resolvePlayerMetaRoot = function resolvePlayerMetaRoot() {
    const directRoot =
      document.querySelector('[class*="PlayerBarDesktopWithBackgroundProgressBar_playerBar"]') ||
      document.querySelector('[class*="PlayerBarDesktopWithBackgroundProgressBar_triggerModal"]') ||
      document.querySelector('[class*="PlayerBar_root"]');

    if (directRoot) {
      return directRoot;
    }

    const queueButton =
      document.querySelector('button[aria-label="Playback queue"]') ||
      document.querySelector('button[aria-label="Очередь воспроизведения"]');

    if (!queueButton) {
      return document.querySelector("footer") || document.body;
    }

    return (
      queueButton.closest('[class*="PlayerBarDesktopWithBackgroundProgressBar"]') ||
      queueButton.closest("footer") ||
      queueButton.closest('[class*="PlayerBar"]') ||
      queueButton.parentElement ||
      document.body
    );
  };

  app.readVisibleTimeState = function readVisibleTimeState(root) {
    if (!root) {
      return { positionMs: 0, durationMs: 0 };
    }

    const matches = Array.from(String(root.textContent || "").matchAll(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g)).map((item) =>
      app.parseTimeLabel(item[0])
    );
    const unique = matches.filter((value, index) => value > 0 && matches.indexOf(value) === index);
    if (unique.length < 2) {
      return { positionMs: 0, durationMs: 0 };
    }

    return {
      positionMs: unique[0],
      durationMs: unique[unique.length - 1],
    };
  };

  app.readSliderTiming = function readSliderTiming(root, fallbackDurationMs) {
    if (!root) {
      return { positionMs: 0, durationMs: 0 };
    }

    const slider =
      root.querySelector('[role="slider"][aria-valuenow]') ||
      root.querySelector('input[type="range"][max][value]') ||
      document.querySelector('[role="slider"][aria-valuenow]') ||
      document.querySelector('input[type="range"][max][value]');

    if (!slider) {
      return { positionMs: 0, durationMs: 0 };
    }

    const rawNow =
      slider.getAttribute("aria-valuenow") || slider.getAttribute("value") || (slider.value !== undefined ? slider.value : "");
    const rawMax =
      slider.getAttribute("aria-valuemax") || slider.getAttribute("max") || (slider.max !== undefined ? slider.max : "");
    const now = Number(rawNow);
    const max = Number(rawMax);
    if (!Number.isFinite(now) || !Number.isFinite(max) || max <= 0) {
      return { positionMs: 0, durationMs: 0 };
    }

    if (fallbackDurationMs > 0 && max <= 100) {
      return {
        positionMs: Math.round((fallbackDurationMs * now) / max),
        durationMs: fallbackDurationMs,
      };
    }

    if (max <= 60 * 60 * 12) {
      return {
        positionMs: Math.round(now * 1000),
        durationMs: Math.round(max * 1000),
      };
    }

    return {
      positionMs: Math.round(now),
      durationMs: Math.round(max),
    };
  };

  app.pickTimingValue = function pickTimingValue(values) {
    for (const value of values) {
      if (Number.isFinite(value) && value > 0) {
        return Math.round(value);
      }
    }

    return 0;
  };

  app.parseTimeLabel = function parseTimeLabel(value) {
    const parts = String(value || "")
      .trim()
      .split(":")
      .map((item) => Number(item));
    if (!parts.length || parts.some((item) => !Number.isFinite(item))) {
      return 0;
    }

    let seconds = 0;
    for (const part of parts) {
      seconds = seconds * 60 + part;
    }
    return seconds * 1000;
  };

  app.inferPausedFromControls = function inferPausedFromControls(root) {
    const scope = root || document;
    const buttons = Array.from(scope.querySelectorAll("button"));
    for (const button of buttons) {
      const label = (button.getAttribute("aria-label") || button.getAttribute("title") || "").toLowerCase();
      if (!label) {
        continue;
      }

      if (label.includes("pause") || label.includes("пауза")) {
        return false;
      }

      if (label.includes("play") || label.includes("воспроизвести")) {
        return true;
      }
    }

    return true;
  };

  app.readTextFromSelectors = function readTextFromSelectors(root, selectors) {
    if (!root) {
      return "";
    }

    for (const selector of selectors) {
      const node = root.querySelector(selector);
      if (!node) {
        continue;
      }

      const value = (node.getAttribute("title") || node.textContent || "").trim();
      if (value) {
        return value;
      }
    }

    return "";
  };

  app.extractTrackId = function extractTrackId(href) {
    const match = String(href || "").match(/\/track\/(\d+)/);
    return match ? match[1] : "";
  };

  app.openTrackRoute = function openTrackRoute(trackId) {
    const href = `/track/${encodeURIComponent(trackId)}`;
    const existingAnchor = document.querySelector(`a[href*="/track/${encodeURIComponent(trackId)}"]`);
    if (existingAnchor && existingAnchor instanceof HTMLAnchorElement) {
      existingAnchor.click();
      return;
    }
    window.location.assign(href);
  };

  app.getCurrentTrackIdFromLocation = function getCurrentTrackIdFromLocation() {
    const match = String(window.location.pathname || "").match(/\/track\/(\d+)/);
    return match ? match[1] : "";
  };

  app.canNavigateToTrackNow = function canNavigateToTrackNow(trackId) {
    const currentTrackId = app.getCurrentTrackIdFromLocation();
    if (currentTrackId && currentTrackId === String(trackId)) {
      return false;
    }

    const now = Date.now();
    try {
      const raw = sessionStorage.getItem(TRACK_NAV_GUARD_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        const sameTrack = parsed && parsed.trackId === String(trackId);
        const isFresh = parsed && Number.isFinite(parsed.at) && now - parsed.at < app.constants.TRACK_ROUTE_PENDING_TTL_MS;
        if (sameTrack && isFresh) {
          return false;
        }
      }
    } catch (_error) {
      // noop
    }

    return true;
  };

  app.markTrackNavigation = function markTrackNavigation(trackId) {
    try {
      sessionStorage.setItem(
        TRACK_NAV_GUARD_KEY,
        JSON.stringify({
          trackId: String(trackId),
          at: Date.now(),
        })
      );
    } catch (_error) {
      // noop
    }
  };

  app.attemptPendingRemoteTrackSync = function attemptPendingRemoteTrackSync() {
    const pending = app.STATE.pendingRemotePlayback;
    if (!pending || !pending.trackId) {
      return;
    }

    const self = app.getSelfParticipant();
    if (self && self.role === "host") {
      app.STATE.pendingRemotePlayback = null;
      app.STATE.pendingTrackId = "";
      app.STATE.pendingTrackAttempts = 0;
      app.STATE.playerMismatchHint = "";
      app.clearRemotePlaybackControlRetry();
      return;
    }

    const now = Date.now();
    if (
      app.STATE.pendingTrackFirstSeenAt &&
      now - app.STATE.pendingTrackFirstSeenAt > app.constants.TRACK_ROUTE_PENDING_TTL_MS
    ) {
      app.STATE.pendingRemotePlayback = null;
      app.STATE.pendingTrackId = "";
      app.STATE.pendingTrackAttempts = 0;
      app.STATE.playerMismatchHint = "Не удалось автоматически догнать трек. Открой его вручную по ссылке.";
      app.clearRemotePlaybackControlRetry();
      if (typeof app.render === "function") {
        app.render();
      }
      return;
    }

    const localPlayback = app.readPlaybackState();
    const currentTrackId = app.getCurrentTrackIdFromLocation();

    if (currentTrackId && currentTrackId === String(pending.trackId)) {
      const nowControl = Date.now();
      const onCooldown =
        nowControl - app.STATE.lastPendingTrackControlAt < app.constants.PENDING_TRACK_CONTROL_COOLDOWN_MS;
      if (!onCooldown) {
        app.STATE.lastPendingTrackControlAt = nowControl;
        app.STATE.suppressLocalEventsUntil = Date.now() + app.constants.REMOTE_GUARD_MS;
        app.debug("Pending track route matches, applying targeted control");
        if (pending.paused) {
          app.pauseAudio();
        } else {
          const startedTargetTrack = app.playTrackById(pending.trackId);
          if (!startedTargetTrack) {
            app.playAudio();
          }
        }
      }
    }

    if (localPlayback && localPlayback.trackId === pending.trackId) {
      const pendingResolvedPlayback = pending;
      app.STATE.pendingRemotePlayback = null;
      app.STATE.pendingTrackId = "";
      app.STATE.pendingTrackAttempts = 0;
      app.STATE.playerMismatchHint = "";
      app.STATE.lastPendingTrackControlAt = 0;
      app.queueRemotePlaybackControl(pendingResolvedPlayback, "pending-track-ready");
      if (typeof app.render === "function") {
        app.render();
      }
      return;
    }

    if (Date.now() - app.STATE.lastTrackNavigationAt < app.constants.TRACK_ROUTE_SYNC_COOLDOWN_MS) {
      return;
    }

    if (
      app.STATE.lastOpenedTrackId === pending.trackId &&
      app.STATE.pendingTrackAttempts >= app.constants.TRACK_ROUTE_MAX_ATTEMPTS
    ) {
      app.STATE.playerMismatchHint = "Автопереход к треку остановлен, чтобы избежать loop. Нужен ручной запуск.";
      if (typeof app.render === "function") {
        app.render();
      }
      return;
    }

    if (!app.canNavigateToTrackNow(pending.trackId)) {
      app.STATE.playerMismatchHint = "Жду, пока плеер подхватит нужный трек, без повторного автоперехода.";
      if (typeof app.render === "function") {
        app.render();
      }
      return;
    }

    app.STATE.pendingTrackAttempts += 1;
    app.STATE.lastOpenedTrackId = pending.trackId;
    app.STATE.lastTrackNavigationAt = Date.now();
    app.STATE.playerMismatchHint = `Пробую открыть трек ${pending.trackId} у listener.`;
    app.STATE.suppressLocalEventsUntil = Date.now() + app.constants.REMOTE_GUARD_MS * 2;
    if (typeof app.render === "function") {
      app.render();
    }
    app.markTrackNavigation(pending.trackId);
    app.openTrackRoute(pending.trackId);
  };

  app.playAudio = function playAudio() {
    const audio = app.getAudioElement();
    app.debug("playAudio called", { hasAudio: Boolean(audio) });
    if (audio) {
      void audio.play().catch(() => {
        app.debugWarn("audio.play() rejected, fallback to playback toggle");
        app.clickPlaybackToggle(false);
      });
      window.setTimeout(() => {
        if (audio.paused) {
          app.debugWarn("audio still paused after play attempt, fallback toggle");
          app.clickPlaybackToggle(false);
        }
      }, 220);
      return;
    }

    app.clickPlaybackToggle(false);
  };

  app.playTrackById = function playTrackById(trackId) {
    const normalizedTrackId = String(trackId || "").trim();
    if (!normalizedTrackId) {
      return false;
    }

    const escapedTrackId = normalizedTrackId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const trackLinkCandidates = Array.from(document.querySelectorAll('a[href*="/track/"]')).filter((anchor) =>
      new RegExp(`/track/${escapedTrackId}(?:$|[/?#])`).test(String(anchor.getAttribute("href") || ""))
    );
    if (!trackLinkCandidates.length) {
      app.debugWarn("No track link candidates for target track", normalizedTrackId);
      return false;
    }

    const playMatchers = [/play/i, /воспроиз/i, /слушат/i, /продолж/i, /включ/i, /игра(ть|ет|ем)/i];
    for (const link of trackLinkCandidates) {
      const scopes = [link, link.parentElement, link.closest("li"), link.closest("article"), link.closest("section")].filter(Boolean);
      for (const scope of scopes) {
        const buttons = Array.from(scope.querySelectorAll("button"));
        const button = buttons.find((candidate) => {
          const label = app.normalizeControlLabel(candidate);
          return label && playMatchers.some((matcher) => matcher.test(label));
        });
        if (button) {
          app.debug("Play target track by nearby play button", {
            trackId: normalizedTrackId,
            label: app.normalizeControlLabel(button),
          });
          button.click();
          return true;
        }
      }
    }

    const targetLink = trackLinkCandidates[0];
    if (targetLink instanceof HTMLAnchorElement) {
      app.debug("Play target track fallback: click track link", normalizedTrackId);
      targetLink.click();
      return true;
    }

    return false;
  };

  app.pauseAudio = function pauseAudio() {
    const audio = app.getAudioElement();
    app.debug("pauseAudio called", { hasAudio: Boolean(audio) });
    if (audio) {
      audio.pause();
      window.setTimeout(() => {
        if (!audio.paused) {
          app.debugWarn("audio still playing after pause attempt, fallback toggle");
          app.clickPlaybackToggle(true);
        }
      }, 180);
      return;
    }

    app.clickPlaybackToggle(true);
  };

  app.setAudioPosition = function setAudioPosition(positionMs) {
    const audio = app.getAudioElement();
    if (!audio || !Number.isFinite(positionMs) || positionMs < 0) {
      return;
    }

    try {
      audio.currentTime = positionMs / 1000;
    } catch (_error) {
      // noop
    }
  };

  app.normalizeControlLabel = function normalizeControlLabel(button) {
    return (
      button.getAttribute("aria-label") ||
      button.getAttribute("title") ||
      button.textContent ||
      ""
    )
      .trim()
      .toLowerCase();
  };

  app.collectPlayerControlScopes = function collectPlayerControlScopes() {
    const scopes = [];
    const pushScope = (node) => {
      if (!node || scopes.includes(node)) {
        return;
      }
      scopes.push(node);
    };

    const metaRoot = app.resolvePlayerMetaRoot();
    pushScope(metaRoot);
    pushScope(metaRoot && metaRoot.closest("footer"));
    pushScope(document.querySelector("footer"));
    pushScope(document.body);
    return scopes;
  };

  app.findPlayerControlButton = function findPlayerControlButton(matchers) {
    for (const scope of app.collectPlayerControlScopes()) {
      const buttons = Array.from(scope.querySelectorAll("button"));
      const inFooter = buttons.filter((button) => button.closest("footer"));
      const pool = inFooter.length ? inFooter : buttons;
      const target = pool.find((button) => {
        const label = app.normalizeControlLabel(button);
        return label && matchers.some((matcher) => matcher.test(label));
      });
      if (target) {
        app.debug("Player control button found", app.normalizeControlLabel(target));
        return target;
      }
    }

    app.debugWarn("Player control button not found", matchers.map((matcher) => String(matcher)));
    return null;
  };

  app.clickPlaybackToggle = function clickPlaybackToggle(expectPaused) {
    const pauseMatchers = [/pause/i, /пауза/i, /паузу/i];
    const playMatchers = [/play/i, /воспроиз/i, /продолж/i, /слушат/i, /включ/i, /игра(ть|ет|ем)/i];
    const target = app.findPlayerControlButton(expectPaused ? pauseMatchers : playMatchers);
    if (target) {
      app.debug("Click playback toggle", {
        expectPaused,
        label: app.normalizeControlLabel(target),
      });
      target.click();
    }
  };

  app.clickNextTrack = function clickNextTrack() {
    const target = app.findPlayerControlButton([/next/i, /следующ/i]);
    if (target) {
      app.debug("Click next track", app.normalizeControlLabel(target));
      target.click();
    }
  };
})();
