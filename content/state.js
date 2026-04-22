(function ymSyncStateModule() {
  const app = (window.__ymSync = window.__ymSync || {});
  if (app.modules && app.modules.state) {
    return;
  }

  app.modules = app.modules || {};
  app.modules.state = true;

  app.constants = {
    REMOTE_API_ORIGIN: "https://ynison.tedeshi.ru",
    LAN_API_ORIGIN: "https://192.168.31.205:10001",
    DEFAULT_API_BASE: "https://ynison.tedeshi.ru/api",
    STORAGE_CLIENT_KEY: "ym-sync-client-id",
    STORAGE_ROOM_KEY: "ym-sync-room-id",
    STORAGE_API_TARGET_KEY: "ym-sync-api-target",
    STORAGE_DEBUG_KEY: "ym-sync-debug",
    REMOTE_GUARD_MS: 2200,
    PLAYER_SYNC_INTERVAL_MS: 1000,
    PLAYER_HEARTBEAT_MS: 5000,
    PLAYER_DRIFT_MS: 1800,
    RECONNECT_DELAY_MS: 2000,
    TRACK_ROUTE_SYNC_COOLDOWN_MS: 6000,
    TRACK_ROUTE_MAX_ATTEMPTS: 2,
    TRACK_ROUTE_PENDING_TTL_MS: 20000,
    PENDING_TRACK_CONTROL_COOLDOWN_MS: 1800,
    REMOTE_APPLY_RETRY_MS: 320,
    REMOTE_APPLY_MAX_ATTEMPTS: 18,
    REMOTE_APPLY_TTL_MS: 9000,
    REMOTE_SEEK_MIN_DRIFT_MS: 900,
    REMOTE_SEEK_FORCE_DRIFT_MS: 3000,
    NEXT_BUTTON_LABELS: ["Next", "Следующий", "Следующий трек"],
  };

  app.STATE = {
    profile: null,
    apiTarget: "domain",
    apiBase: app.constants.DEFAULT_API_BASE,
    roomId: "",
    clientId: "",
    roomState: null,
    inviteLink: "",
    isPageOpen: false,
    avatarWatcherStarted: false,
    joinInput: "",
    socket: null,
    socketState: "idle",
    shouldReconnect: false,
    reconnectTimer: 0,
    lastError: "",
    isBusy: false,
    suppressLocalEventsUntil: 0,
    localAuthorityUntil: 0,
    lastSentPlayback: null,
    lastPlaybackSentAt: 0,
    playerMismatchHint: "",
    boundAudio: null,
    pendingRemotePlayback: null,
    lastTrackNavigationAt: 0,
    pendingTrackId: "",
    lastOpenedTrackId: "",
    pendingTrackAttempts: 0,
    pendingTrackFirstSeenAt: 0,
    remoteApplyToken: 0,
    playerUiObserverStarted: false,
    playerUiObserver: null,
    playerUiReady: false,
    lastPendingTrackControlAt: 0,
    pendingRemotePlaybackControl: null,
    remotePlaybackRetryTimer: 0,
  };

  try {
    const storedApiTarget = localStorage.getItem(app.constants.STORAGE_API_TARGET_KEY);
    if (storedApiTarget === "lan" || storedApiTarget === "domain") {
      app.STATE.apiTarget = storedApiTarget;
    }
  } catch (_error) {
    // ignore
  }

  app.UI = {
    sidebarLink: null,
    sidebarItem: null,
    pageRoot: null,
    mainHost: null,
    statusText: null,
    roomMeta: null,
    participantsWrap: null,
    inviteInput: null,
    toast: null,
    copyInviteBtn: null,
    playerBarCopyBtn: null,
    apiTargetDomainBtn: null,
    apiTargetLanBtn: null,
  };

  app.normalizeRoomId = function normalizeRoomId(value) {
    return String(value || "").trim();
  };

  app.readRoomIdFromUrl = function readRoomIdFromUrl(url) {
    if (!url) {
      return "";
    }
    const roomId = app.normalizeRoomId(url.searchParams.get("roomId"));
    const session = app.normalizeRoomId(url.searchParams.get("session"));
    const together = app.normalizeRoomId(url.searchParams.get("together"));
    const fromTogether = together && together !== "1" ? together : "";
    return roomId || session || fromTogether || "";
  };

  app.extractRoomId = function extractRoomId(value) {
    const rawValue = app.normalizeRoomId(value);
    if (!rawValue) {
      return "";
    }

    try {
      const url = new URL(rawValue);
      return app.readRoomIdFromUrl(url);
    } catch (_error) {
      return rawValue;
    }
  };

  app.normalizeApiBase = function normalizeApiBase(value) {
    try {
      const url = new URL(String(value || app.constants.DEFAULT_API_BASE).trim() || app.constants.DEFAULT_API_BASE);
      url.pathname = "/";
      url.search = "";
      url.hash = "";
      return url.toString().replace(/\/$/, "");
    } catch (_error) {
      return app.constants.DEFAULT_API_BASE;
    }
  };

  app.buildInviteLink = function buildInviteLink(roomId) {
    const id = app.normalizeRoomId(roomId);
    if (!id) {
      return "";
    }
    const url = new URL(`${window.location.origin}/`);
    url.searchParams.set("together", id);
    return url.toString();
  };

  app.setBusy = function setBusy(value) {
    app.STATE.isBusy = Boolean(value);
    if (typeof app.render === "function") {
      app.render();
    }
  };

  app.setError = function setError(error) {
    app.STATE.lastError = error instanceof Error ? error.message : String(error || "Произошла ошибка");
    if (typeof app.render === "function") {
      app.render();
    }
    if (typeof app.toast === "function") {
      app.toast(app.STATE.lastError);
    }
  };

  app.clearError = function clearError() {
    app.STATE.lastError = "";
  };

  app.escapeHtml = function escapeHtml(value) {
    return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  };

  app.escapeAttr = function escapeAttr(value) {
    return app.escapeHtml(value).replaceAll('"', "&quot;");
  };

  app.avatarFromName = function avatarFromName(seed) {
    return `https://api.dicebear.com/9.x/thumbs/svg?seed=${encodeURIComponent(seed)}`;
  };

  app.isDebugEnabled = function isDebugEnabled() {
    return true; // TODO: remove this
    try {
      const value = localStorage.getItem(app.constants.STORAGE_DEBUG_KEY);
      if (!value) {
        return false;
      }
      const normalized = String(value).trim().toLowerCase();
      return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
    } catch (_error) {
      return false;
    }
  };

  app.debug = function debug(...args) {
    if (!app.isDebugEnabled()) {
      return;
    }
    console.log("[YM Sync]", ...args);
  };

  app.debugWarn = function debugWarn(...args) {
    if (!app.isDebugEnabled()) {
      return;
    }
    console.warn("[YM Sync]", ...args);
  };

  app.extractStyleImageUrl = function extractStyleImageUrl(rawValue) {
    if (!rawValue || rawValue === "none") {
      return "";
    }

    const match = rawValue.match(/url\(["']?(.*?)["']?\)/i);
    return match ? match[1] : "";
  };

  app.readAvatarFromUserBadge = function readAvatarFromUserBadge() {
    const avatarRoot = document.querySelector("div.UserID-Avatar");
    if (!avatarRoot) {
      return "";
    }

    const nestedImg = avatarRoot.querySelector("img");
    if (nestedImg && nestedImg.src) {
      return nestedImg.src;
    }

    const styleImage = app.extractStyleImageUrl(avatarRoot.style.backgroundImage);
    if (styleImage) {
      return styleImage;
    }

    const computed = getComputedStyle(avatarRoot);
    return app.extractStyleImageUrl(computed.backgroundImage);
  };

  app.buildProfileFromPage = function buildProfileFromPage() {
    const profileButton = document.querySelector('button[aria-label*="профиль"], button[aria-label*="Profile"]');
    const nicknameFromTitle = profileButton ? profileButton.getAttribute("title") : "";
    const sidebarAvatar = app.readAvatarFromUserBadge();
    const anyAvatar = document.querySelector('img[src*="avatars"], img[src*="avatar"], img[alt*="profile"]');

    return {
      nickname: (nicknameFromTitle && nicknameFromTitle.trim()) || "Вы",
      avatarUrl: sidebarAvatar || (anyAvatar ? anyAvatar.src : ""),
    };
  };

  app.getSelfParticipant = function getSelfParticipant() {
    if (!app.STATE.roomState || !Array.isArray(app.STATE.roomState.participants)) {
      return null;
    }

    return app.STATE.roomState.participants.find((participant) => participant.clientId === app.STATE.clientId) || null;
  };
})();
