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
  };

  app.STATE = {
    profile: { nickname: 'Вы', avatarUrl: '' },
    roomId: '',
    clientId: '',
    roomState: null,
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
    const together = app.normalizeRoomId(url.searchParams.get('together'));
    const fromTogether = together && together !== '1' ? together : '';
    return roomId || session || fromTogether || '';
  };

  app.extractRoomId = function extractRoomId(raw) {
    const value = app.normalizeRoomId(raw);
    if (!value) {
      return '';
    }

    try {
      const url = new URL(value);
      return app.readRoomIdFromUrl(url);
    } catch (_error) {
      return value;
    }
  };

  app.buildInviteLink = function buildInviteLink(roomId) {
    const normalized = app.normalizeRoomId(roomId);
    if (!normalized) {
      return '';
    }

    const target = new URL(`${window.location.origin}/`);
    target.searchParams.set('together', normalized);
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
    const nicknameFromTitle = profileButton ? profileButton.getAttribute('title') : '';
    const sidebarAvatar = app.readAvatarFromUserBadge();
    const anyAvatar = document.querySelector('img[src*="avatars"], img[src*="avatar"], img[alt*="profile"]');

    return {
      nickname: (nicknameFromTitle && String(nicknameFromTitle).trim()) || 'Вы',
      avatarUrl: sidebarAvatar || (anyAvatar ? anyAvatar.src : ''),
    };
  };

  app.getSelfParticipant = function getSelfParticipant() {
    if (!app.STATE.roomState || !Array.isArray(app.STATE.roomState.participants)) {
      return null;
    }

    return app.STATE.roomState.participants.find((member) => member.clientId === app.STATE.clientId) ||
      app.STATE.roomState.participants[0] ||
      null;
  };

  app.buildLocalRoom = function buildLocalRoom(roomId) {
    const profile = app.STATE && app.STATE.profile ? app.STATE.profile : { nickname: 'Вы', avatarUrl: '' };
    const avatar = profile.avatarUrl || app.avatarFromName(profile.nickname || 'host');

    return {
      id: roomId,
      participants: [
        {
          clientId: app.STATE.clientId || 'host',
          nickname: profile.nickname || 'Вы',
          avatarUrl: avatar,
          role: 'host',
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
      const latestAvatar = app.readAvatarFromUserBadge();
      if (!latestAvatar || !app.STATE.profile) {
        return;
      }
      if (app.STATE.profile.avatarUrl === latestAvatar) {
        return;
      }
      app.STATE.profile.avatarUrl = latestAvatar;
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
