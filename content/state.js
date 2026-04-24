(function ymSyncStateModule() {
  const app = (window.__ymSync = window.__ymSync || {});
  if (app.modules && app.modules.state) {
    return;
  }

  app.modules = app.modules || {};
  app.modules.state = true;

  app.constants = {
    STORAGE_DEBUG_KEY: 'ym-sync-debug',
    STORAGE_ROOM_KEY: 'ym-sync-room-id',
    STORAGE_CLIENT_KEY: 'ym-sync-client-id',
    STORAGE_BACKEND_MODE_KEY: 'ym-sync-backend-mode',
    BACKEND_MODE_DEFAULT: 'production',
    BACKEND_MODES: {
      production: {
        API_ORIGIN: 'https://ynison.tedeshi.ru',
        API_HTTP_URL: 'https://ynison.tedeshi.ru/api',
        API_WS_URL: 'wss://ynison.tedeshi.ru/api/ws',
      },
      lan: {
        API_ORIGIN: 'https://192.168.31.205:10001',
        API_HTTP_URL: 'https://192.168.31.205:10001/api',
        API_WS_URL: 'wss://192.168.31.205:10001/api/ws',
      },
    },
    INVITE_LINK_MARKER: 'vika',
    API_ORIGIN: 'https://ynison.tedeshi.ru',
    API_HTTP_URL: 'https://ynison.tedeshi.ru/api',
    API_WS_URL: 'wss://ynison.tedeshi.ru/api/ws',
    API_PROTOCOL_VERSION: 1,
    DEFAULT_NICKNAME: 'Гость',
    REMOTE_SEEK_MIN_DRIFT_MS: 3000,
    REMOTE_SEEK_FORCE_DRIFT_MS: 3000,
  };

  app.STATE = {
    profile: { nickname: '', avatarUrl: '' },
    roomId: '',
    clientId: '',
    roomState: null,
    roomRole: 'listener',
  joinRoleHint: '',
    roomPermissions: {
      isHost: false,
      canControl: false,
      canDelegate: false,
    },
    isConnectedToBackend: false,
    lastStateVersion: 0,
    wsReadyState: WebSocket.CLOSED,
    commandSeq: 0,
    commandRequests: {},
    inviteLink: '',
    isPageOpen: false,
    joinInput: '',
    isBusy: false,
    lastError: '',
    avatarWatcherStarted: false,
  };

  app.UI = {
    sidebarLink: null,
    sidebarItem: null,
    pageRoot: null,
    mainHost: null,
    statusText: null,
    roomRoleText: null,
    roomControlText: null,
    roomMeta: null,
    participantsWrap: null,
    inviteInput: null,
    toast: null,
    copyInviteBtn: null,
    playerBarCopyBtn: null,
    joinInput: null,
    closeButton: null,
  };

  app.isDebugEnabled = function isDebugEnabled() {
    try {
      const value = localStorage.getItem(app.constants.STORAGE_DEBUG_KEY);
      const normalized = String(value || '').trim().toLowerCase();
      return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
    } catch (_error) {
      return false;
    }
  };

  app.debug = function debug(...args) {
    if (!app.isDebugEnabled()) {
      return;
    }
    // eslint-disable-next-line no-console
    console.log('[YM Sync]', ...args);
  };

  app.debugWarn = function debugWarn(...args) {
    if (!app.isDebugEnabled()) {
      return;
    }
    // eslint-disable-next-line no-console
    console.warn('[YM Sync]', ...args);
  };

  app.normalizeRoomId = function normalizeRoomId(value) {
    return String(value || '').trim();
  };

  app.readRoomIdFromUrl = function readRoomIdFromUrl(url) {
    if (!url) {
      return '';
    }

    const roomId = app.normalizeRoomId(url.searchParams.get('roomId'));
    const session = app.normalizeRoomId(url.searchParams.get('session'));
    const together = app.undecorateInviteCode(app.normalizeRoomId(url.searchParams.get('together')));
    const fromTogether = together && together !== '1' ? together : '';
    return roomId || session || fromTogether || '';
  };

  app.getShortRoomId = function getShortRoomId(value) {
    const normalized = app.normalizeRoomId(value);
    if (!normalized) {
      return '';
    }

    if (normalized.startsWith('room-')) {
      const [, shortId = ''] = normalized.slice(5).split('-');
      if (shortId) {
        return shortId;
      }
      return normalized.slice(5);
    }

    return normalized;
  };

  app.canonicalServerRoomId = function canonicalServerRoomId(token) {
    const t = app.normalizeRoomId(token);
    if (!t) {
      return '';
    }
    if (t.startsWith('local-') || t.startsWith('room-')) {
      return t;
    }
    if (/^[a-z0-9]+$/i.test(t) && t.length >= 4 && t.length <= 40) {
      return `room-${t}`;
    }
    return t;
  };

  app.isLegacySegmentedRoomId = function isLegacySegmentedRoomId(roomId) {
    const n = app.normalizeRoomId(roomId);
    if (!n.startsWith('room-')) {
      return false;
    }
    return n.slice(5).includes('-');
  };

  app.getInviteCodeMarker = function getInviteCodeMarker() {
    return app.normalizeRoomId(app.constants.INVITE_LINK_MARKER || 'vika');
  };

  app.decorateInviteCode = function decorateInviteCode(rawValue) {
    const value = app.normalizeRoomId(rawValue);
    const marker = app.getInviteCodeMarker();
    if (!value || !marker) {
      return value;
    }

    const center = Math.floor(value.length / 2);
    return `${value.slice(0, center)}${marker}${value.slice(center)}`;
  };

  app.undecorateInviteCode = function undecorateInviteCode(rawValue) {
    const value = app.normalizeRoomId(rawValue);
    const marker = app.getInviteCodeMarker();
    if (!value || !marker || !value.includes(marker)) {
      return value;
    }

    const expectedCenter = Math.floor((value.length - marker.length) / 2);
    if (expectedCenter >= 0 && value.slice(expectedCenter, expectedCenter + marker.length) === marker) {
      return `${value.slice(0, expectedCenter)}${value.slice(expectedCenter + marker.length)}`;
    }

    return value;
  };

  app.getInviteTogetherParam = function getInviteTogetherParam(roomId) {
    const n = app.normalizeRoomId(roomId);
    if (!n) {
      return '';
    }
    return app.decorateInviteCode(app.getShortRoomId(n) || n);
  };

  app.extractRoomId = function extractRoomId(raw) {
    const value = app.undecorateInviteCode(app.normalizeRoomId(raw));
    if (!value) {
      return '';
    }

    try {
      const url = new URL(value);
      return app.canonicalServerRoomId(app.undecorateInviteCode(app.readRoomIdFromUrl(url)));
    } catch (_error) {
      return app.canonicalServerRoomId(value);
    }
  };

  app.buildInviteLink = function buildInviteLink(roomId) {
    const normalized = app.normalizeRoomId(roomId);
    if (!normalized) {
      return '';
    }

    const target = new URL(`${window.location.origin}/`);
    target.searchParams.set('together', app.getInviteTogetherParam(normalized));
    return target.toString();
  };

  app.setBusy = function setBusy(value) {
    app.STATE.isBusy = Boolean(value);
    if (typeof app.render === 'function') {
      app.render();
    }
  };

  app.setError = function setError(error) {
    app.STATE.lastError = error instanceof Error ? error.message : String(error || 'Ошибка');
    if (typeof app.render === 'function') {
      app.render();
    }
    if (typeof app.toast === 'function') {
      app.toast(app.STATE.lastError);
    }
  };

  app.clearError = function clearError() {
    app.STATE.lastError = '';
  };

  app.escapeHtml = function escapeHtml(value) {
    return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  };

  app.escapeAttr = function escapeAttr(value) {
    return app.escapeHtml(value).replaceAll('"', '&quot;');
  };

  app.normalizeNickname = function normalizeNickname(rawValue) {
    return String(rawValue || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  };

  app.avatarFromName = function avatarFromName(seed) {
    return `https://api.dicebear.com/9.x/thumbs/svg?seed=${encodeURIComponent(seed || 'anon')}`;
  };

  app.normalizeYandexAvatarSize = function normalizeYandexAvatarSize(rawValue) {
    const value = String(rawValue || '').trim();
    if (!value) {
      return '';
    }

    return value.replace('/islands-middle', '/islands-200');
  };

  app.readAvatarFromKnownXPath = function readAvatarFromKnownXPath() {
    try {
      const img = document.evaluate(
        '/html/body/div/div/div/div[1]/div[2]/div/span/a/div/img',
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null
      ).singleNodeValue;

      if (img instanceof HTMLImageElement && img.src) {
        return img.src;
      }
      if (img instanceof Element && img.getAttribute('src')) {
        return img.getAttribute('src');
      }
    } catch (_error) {
      // Ignore XPath failures, fallback to existing avatar extraction methods.
    }
    return '';
  };

  app.readTextFromKnownXPath = function readTextFromKnownXPath(xpath) {
    try {
      const node = document.evaluate(
        xpath,
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null
      ).singleNodeValue;

      if (!node) {
        return '';
      }
      return app.normalizeNickname(node.textContent);
    } catch (_error) {
      // Ignore XPath failures, fallback to existing nickname extraction.
    }
    return '';
  };

  app.readNicknameFromKnownXPath = function readNicknameFromKnownXPath() {
    return app.readTextFromKnownXPath('/html/body/div[4]/div/div/aside/div/div[3]/div/div[2]/div')
      || app.readTextFromKnownXPath('/html/body/div[4]/div/div/aside/div/div[3]/div/div[1]/a/div/div/div/div/div/div/div/div[2]/h1');
  };

  app.extractStyleImageUrl = function extractStyleImageUrl(rawValue) {
    if (!rawValue || rawValue === 'none') {
      return '';
    }

    const match = String(rawValue).match(/url\(["']?(.*?)["']?\)/i);
    return match ? match[1] : '';
  };

  app.readAvatarFromUserBadge = function readAvatarFromUserBadge() {
    const avatarFromXPath = app.readAvatarFromKnownXPath();
    if (avatarFromXPath) {
      return app.normalizeYandexAvatarSize(avatarFromXPath);
    }

    const avatarRoot = document.querySelector('div.UserID-Avatar');
    if (!avatarRoot) {
      return '';
    }

    const nestedImg = avatarRoot.querySelector('img');
    if (nestedImg && nestedImg.src) {
      return app.normalizeYandexAvatarSize(nestedImg.src);
    }

    const styleImage = app.extractStyleImageUrl(avatarRoot.style.backgroundImage);
    if (styleImage) {
      return app.normalizeYandexAvatarSize(styleImage);
    }

    const computed = getComputedStyle(avatarRoot);
    return app.normalizeYandexAvatarSize(app.extractStyleImageUrl(computed.backgroundImage));
  };

  app.buildProfileFromPage = function buildProfileFromPage() {
    const profileButton = document.querySelector('button[aria-label*="профиль"], button[aria-label*="Profile"]');
    const nicknameFromTitle = app.normalizeNickname(profileButton ? profileButton.getAttribute('title') : '');
    const nicknameFromButtonText = app.normalizeNickname(profileButton ? profileButton.textContent : '');
    const nicknameFromXPath = app.readNicknameFromKnownXPath();
    const sidebarAvatar = app.readAvatarFromUserBadge();
    const anyAvatar = document.querySelector('img[src*="avatars"], img[src*="avatar"], img[alt*="profile"]');

    return {
      nickname: nicknameFromTitle || nicknameFromXPath || nicknameFromButtonText || app.constants.DEFAULT_NICKNAME,
      avatarUrl: sidebarAvatar || (anyAvatar ? anyAvatar.src : ''),
    };
  };

app.getBackendMode = function getBackendMode() {
  try {
    const value = localStorage.getItem(app.constants.STORAGE_BACKEND_MODE_KEY);
    const mode = String(value || '').trim().toLowerCase();
    if (mode === 'lan' || mode === '1' || mode === 'true' || mode === 'on' || mode === 'yes') {
      return 'lan';
    }
    if (mode === 'production' || mode === 'prod' || mode === '0' || mode === 'false' || mode === 'off' || mode === 'no') {
      return app.constants.BACKEND_MODE_DEFAULT;
    }
  } catch (_error) {
    // localStorage can be unavailable in restricted contexts.
  }
  return app.constants.BACKEND_MODE_DEFAULT;
};

app.getBackendConfig = function getBackendConfig() {
  const mode = app.getBackendMode();
  const presets = app.constants.BACKEND_MODES || {};
  return presets[mode] || presets[app.constants.BACKEND_MODE_DEFAULT];
};

app.applyBackendConfig = function applyBackendConfig() {
  const config = app.getBackendConfig();
  if (!config) {
    return null;
  }
  app.constants.API_ORIGIN = config.API_ORIGIN || app.constants.API_ORIGIN;
  app.constants.API_HTTP_URL = config.API_HTTP_URL || app.constants.API_HTTP_URL;
  app.constants.API_WS_URL = config.API_WS_URL || app.constants.API_WS_URL;
  return config;
};

app.applyBackendConfig();

  app.getSelfParticipant = function getSelfParticipant() {
    if (!app.STATE.roomState || !Array.isArray(app.STATE.roomState.participants)) {
      return null;
    }

    return app.STATE.roomState.participants.find((member) => member.clientId === app.STATE.clientId) ||
      app.STATE.roomState.participants[0] ||
      null;
  };

  app.buildLocalRoom = function buildLocalRoom(roomId, roleHint = 'host') {
    const profile = app.STATE && app.STATE.profile ? app.STATE.profile : { nickname: app.constants.DEFAULT_NICKNAME, avatarUrl: '' };
    const avatar = profile.avatarUrl || app.avatarFromName(profile.nickname || 'host');

    return {
      id: roomId,
      participants: [
        {
          clientId: app.STATE.clientId || 'host',
          nickname: profile.nickname || app.constants.DEFAULT_NICKNAME,
          avatarUrl: avatar,
          role: roleHint === 'host' ? 'host' : 'listener',
          isConnected: true,
        },
      ],
    };
  };

  const makeLocalRoomId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  app.createRoom = async function createRoom(options = {}) {
    const { silentToast = false } = options;

    if (app.STATE.isBusy) {
      return false;
    }

    app.setBusy(true);
    app.clearError();

    try {
      app.STATE.clientId = app.STATE.clientId || `local-${makeLocalRoomId()}`;
      app.STATE.roomId = `local-${makeLocalRoomId()}`;
      app.STATE.roomState = app.buildLocalRoom(app.STATE.roomId);
      app.STATE.inviteLink = app.buildInviteLink(app.STATE.roomId);
      app.STATE.joinInput = app.STATE.roomId;
      app.updateStoredRoomInfo();

      if (!silentToast && typeof app.toast === 'function') {
        app.toast('Комната создана локально');
      }
      return true;
    } catch (error) {
      app.setError(error);
      return false;
    } finally {
      app.setBusy(false);
      if (typeof app.render === 'function') {
        app.render();
      }
    }
  };

  app.getSelfClientId = function getSelfClientId() {
    if (app.STATE.clientId) {
      return app.STATE.clientId;
    }

    const generated = `ext-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    app.STATE.clientId = generated;
    return generated;
  };

  app.normalizeTrackText = function normalizeTrackText(value) {
    return String(value || '')
      .normalize('NFKD')
      .replace(/[^\w\sа-яА-ЯёЁ\-\.'":,]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  };

  app.buildTrackFingerprint = function buildTrackFingerprint(track = {}) {
    const trackId = String(
      track.trackId || track.id || track.playableId || track.playable_id || ''
    ).trim();
    const title = app.normalizeTrackText(track.title);
    const artists = Array.isArray(track.artists)
      ? track.artists.map((artist) => app.normalizeTrackText(artist))
      : [];
    return `${trackId ? `${trackId}::` : ''}${title}::${artists.join('|')}`;
  };

  app.isHost = function isHost() {
    return app.STATE.roomRole === 'host' || app.STATE.roomPermissions.isHost;
  };

  app.canControl = function canControl() {
    return app.isHost() || Boolean(app.STATE.roomPermissions.canControl);
  };

  app.ensureAutoRoom = async function ensureAutoRoom() {
    if (app.STATE.roomId) {
      return;
    }
    await app.createRoom({ silentToast: true });
  };

  app.joinRoom = async function joinRoom(rawValue, options = {}) {
    const { silentToast = false } = options;

    const roomId = app.extractRoomId(rawValue);
    if (!roomId) {
      app.setError('Введите корректный ID комнаты');
      return false;
    }

    app.setBusy(true);
    app.clearError();

    try {
      app.STATE.roomId = roomId;
      app.STATE.roomState = {
        id: roomId,
        participants: app.buildLocalRoom(roomId).participants,
      };
      app.STATE.inviteLink = app.buildInviteLink(roomId);
      app.STATE.joinInput = roomId;
      app.updateStoredRoomInfo();

      if (!silentToast && typeof app.toast === 'function') {
        app.toast('Локальная комната подключена');
      }
      return true;
    } catch (error) {
      app.setError(error);
      return false;
    } finally {
      app.setBusy(false);
      if (typeof app.render === 'function') {
        app.render();
      }
    }
  };

  app.disconnectFromRoom = function disconnectFromRoom() {
    app.STATE.roomId = '';
    app.STATE.roomState = null;
    app.STATE.inviteLink = '';
    app.STATE.joinInput = '';
    app.updateStoredRoomInfo();

    if (typeof app.render === 'function') {
      app.render();
    }
  };

  app.recreateRoom = async function recreateRoom() {
    return app.createRoom();
  };

  app.updateStoredRoomInfo = function updateStoredRoomInfo() {
    if (!app.STATE.roomId) {
      localStorage.removeItem(app.constants.STORAGE_ROOM_KEY);
      return;
    }
    localStorage.setItem(app.constants.STORAGE_ROOM_KEY, app.STATE.roomId);
  };

  app.initAvatarWatcher = function initAvatarWatcher() {
    if (app.STATE.avatarWatcherStarted) {
      return;
    }
    app.STATE.avatarWatcherStarted = true;

    const observer = new MutationObserver(() => {
      const latestProfile = app.buildProfileFromPage();
      if (!latestProfile || !app.STATE.profile) {
        return;
      }

      const nextNickname = latestProfile.nickname || app.STATE.profile.nickname || app.constants.DEFAULT_NICKNAME;
      const nextAvatar = latestProfile.avatarUrl || app.STATE.profile.avatarUrl;

      if (app.STATE.profile.nickname === nextNickname && app.STATE.profile.avatarUrl === nextAvatar) {
        return;
      }
      app.STATE.profile.nickname = nextNickname;
      app.STATE.profile.avatarUrl = nextAvatar;

      if (typeof app.render === 'function') {
        app.render();
      }
    });

    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['src', 'srcset', 'style', 'class'],
    });
  };
})();
