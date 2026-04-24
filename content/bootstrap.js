(function ymSyncBootstrapModule() {
  const app = window.__ymSync;
  if (!app || app.modules.bootstrap) {
    return;
  }

  app.modules.bootstrap = true;

  if (window.top !== window) {
    return;
  }

  if (app.STATE.__bootstrapped) {
    return;
  }
  app.STATE.__bootstrapped = true;
  const NATIVE_PLAYER_CAPTURE_POLL_MS = 250;
  const NATIVE_PLAYER_CAPTURE_TIMEOUT_MS = 300000;
  const NATIVE_PLAYER_READY_EVENT = 'ym-sync-native-player-ready';

  app.start = async function start() {
    app.STATE.profile = app.buildProfileFromPage();
    const invitedRoomId = app.consumeInviteParamFromLocation();
    if (invitedRoomId) {
      app.STATE.joinRoleHint = 'listener';
    }
    const rawJoin = invitedRoomId || app.readRoomIdFromLocation() || '';
    app.STATE.joinInput = rawJoin ? app.extractRoomId(rawJoin) : '';

    app.initAvatarWatcher();
    app.installSidebarEntry();
    app.installPlayerBarCopyButton();
    app.installNavigationWatcher();
    app.render();
    app.installNativePlayerBridge();

    if (invitedRoomId || app.shouldOpenTogetherPage()) {
      await app.openSyncPage({
        joinRoleHint: app.STATE.joinRoleHint || 'listener',
      });
    }
  };

  app.shouldOpenTogetherPage = function shouldOpenTogetherPage() {
    return app.isTogetherUrl(window.location.href);
  };

  app.getLocationUrl = function getLocationUrl(value) {
    if (value instanceof URL) {
      return value;
    }

    try {
      return value ? new URL(value, window.location.href) : new URL(window.location.href);
    } catch (_error) {
      return null;
    }
  };

  app.readTogetherRoomFromUrl = function readTogetherRoomFromUrl(url) {
    if (!url) {
      return '';
    }

    const together = app.normalizeRoomId(url.searchParams.get('together'));
    if (!together || together === '1') {
      return '';
    }

    return together;
  };

  app.isTogetherUrl = function isTogetherUrl(value) {
    const url = app.getLocationUrl(value);
    if (!url) {
      return false;
    }

    const together = app.readTogetherRoomFromUrl(url);
    if (together) {
      return true;
    }

    if (url.pathname === '/together' || url.pathname === '/together/') {
      return true;
    }

    return false;
  };

  app.consumeInviteParamFromLocation = function consumeInviteParamFromLocation() {
    const currentUrl = app.getLocationUrl();
    if (!currentUrl) {
      return '';
    }

    const invitedRoomId = app.readTogetherRoomFromUrl(currentUrl);
    if (!currentUrl.searchParams.has('together')) {
      return '';
    }

    try {
      const nextState = typeof history.state === 'object' && history.state !== null ? { ...history.state } : {};
      nextState.__ymSyncInternal = true;
      currentUrl.searchParams.delete('together');
      history.replaceState(nextState, '', currentUrl.toString());
      return invitedRoomId;
    } catch (_error) {
      return invitedRoomId;
    }
  };

  app.onNavigationChanged = function onNavigationChanged() {
    const invitedRoomId = app.consumeInviteParamFromLocation();
    const roomIdFromRoute = app.readRoomIdFromLocation();
    const rawRoomId = invitedRoomId || roomIdFromRoute;
    const roomId = rawRoomId ? app.extractRoomId(rawRoomId) : '';
    app.STATE.joinInput = roomId;

    if (invitedRoomId || app.isTogetherUrl()) {
      const host = app.ensureMainHost();
      const isPageRootAttached = Boolean(
        app.UI.pageRoot &&
          app.UI.pageRoot.isConnected &&
          app.UI.mainHost &&
          app.UI.mainHost === host
      );

      if (!app.STATE.isPageOpen || !isPageRootAttached) {
        void app.openSyncPage({
          updateHistory: false,
          joinRoleHint: app.STATE.joinRoleHint || app.STATE.roomRole || 'listener',
        });
        return;
      }

      if (roomId) {
        if (app.STATE.roomId !== roomId) {
          const joinRoleHint = invitedRoomId
            ? 'listener'
            : app.STATE.joinRoleHint || app.STATE.roomRole || 'listener';
          void app.joinRoom(roomId, {
            silentToast: true,
            roleHint: joinRoleHint,
          });
          app.STATE.joinRoleHint = '';
        }
        return;
      }

      if (!app.STATE.roomId) {
        void app.ensureAutoRoom();
      }
      return;
    }

    if (app.STATE.isPageOpen) {
      app.hideSyncPage();
    }
    app.render();
  };

  app.handleNavigationClick = function handleNavigationClick(event) {
    if (!app.STATE.isPageOpen) {
      return;
    }

    const target = event.target.closest('a[href]');
    if (!target) {
      return;
    }

    if (target.closest('.ym-sync-page')) {
      return;
    }

    const href = target.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) {
      return;
    }

    const targetUrl = new URL(href, window.location.href);
    if (targetUrl.origin !== window.location.origin) {
      return;
    }

    if (app.isTogetherUrl(targetUrl)) {
      return;
    }

    app.hideSyncPage();
  };

  app.readRoomIdFromLocation = function readRoomIdFromLocation() {
    return app.readRoomIdFromUrl(new URL(window.location.href));
  };

  app.installNavigationWatcher = function installNavigationWatcher() {
    if (app.STATE.__navigationWatchersInstalled) {
      return;
    }
    app.STATE.__navigationWatchersInstalled = true;

    const observer = new MutationObserver(() => {
      app.installSidebarEntry();
      app.installPlayerBarCopyButton();
    });
    observer.observe(document.documentElement, { subtree: true, childList: true });

    document.addEventListener('click', app.handleNavigationClick, true);
    window.addEventListener('popstate', () => {
      app.onNavigationChanged();
    });

    const patchHistoryMethod = (method) => {
      const original = history[method];
      if (typeof original !== 'function' || original.__ymSyncPatched) {
        return;
      }

      history[method] = function patchedState(...args) {
        const result = original.apply(this, args);
        app.onNavigationChanged();
        return result;
      };
      history[method].__ymSyncPatched = true;
    };

    patchHistoryMethod('pushState');
    patchHistoryMethod('replaceState');
  };

  app.copyToClipboard = function copyToClipboard(text, successMessage) {
    navigator.clipboard.writeText(text).then(
      () => app.toast(successMessage),
      () => app.toast('Не удалось скопировать')
    );
  };

  app.toast = function toast(text) {
    if (!app.UI.toast) {
      return;
    }

    app.UI.toast.textContent = text;
    window.clearTimeout(app.UI.toast.__timer);
    app.UI.toast.__timer = window.setTimeout(() => {
      app.UI.toast.textContent = '';
    }, 2500);
  };

  app.installNativePlayerBridge = function installNativePlayerBridge() {
    if (app.STATE.__nativePlayerBridgeInstalled) {
      return;
    }
    app.STATE.__nativePlayerBridgeInstalled = true;

    const state = {
      player: null,
      source: '',
      capturedAt: 0,
      timer: null,
      waiters: [],
      bridgeInjected: false,
    };
    app.STATE.nativePlayer = state;

    app.waitForNativePlayer = function waitForNativePlayer() {
      if (state.player) {
        return Promise.resolve(state.player);
      }
      return new Promise((resolve) => {
        state.waiters.push(resolve);
      });
    };

    app.getNativePlayer = function getNativePlayer() {
      return state.player || null;
    };

    const isFallbackMediaPlayer = function isFallbackMediaPlayer(value) {
      if (!value || typeof value !== 'object') {
        return false;
      }
      const tagName = String(value.tagName || '').toUpperCase();
      return tagName === 'AUDIO' || tagName === 'VIDEO';
    };

    const shouldReplacePlayer = function shouldReplacePlayer(existingPlayer, existingSource, nextPlayer, nextSource) {
      if (!existingPlayer) {
        return true;
      }
      if (isFallbackMediaPlayer(existingPlayer) && !isFallbackMediaPlayer(nextPlayer)) {
        return true;
      }
      if (isFallbackMediaPlayer(existingPlayer) && nextSource === 'poll.windowProperty') {
        return true;
      }
      return existingSource === 'fallback.mediaElement';
    };

    const emitNativePlayer = function emitNativePlayer(player, source) {
      const normalizedSource = source || 'unknown';
      const isFallback = isFallbackMediaPlayer(player);
      const nextSource = isFallback ? 'fallback.mediaElement' : normalizedSource;
      if (state.player && !shouldReplacePlayer(state.player, state.source, player, nextSource)) {
        return;
      }

      state.player = player;
      state.source = nextSource;
      state.capturedAt = Date.now();

      state.waiters.forEach((resolve) => {
        resolve(player);
      });
      state.waiters.length = 0;

      if (state.timer && state.source !== 'fallback.mediaElement') {
        window.clearInterval(state.timer);
        state.timer = null;
      }
    };

    const handleBridgeReady = function handleBridgeReady(data) {
      if (!data || data.__ymSyncNativePlayerReady !== true) {
        return;
      }
      const player = window.__ymSyncNativePlayer || { __pageHosted: true };
      emitNativePlayer(player, data.__ymSyncNativePlayerSource || 'unknown');
    };

    const handleBridgeMessage = function handleBridgeMessage(event) {
      if (!event || !event.data || event.data.__ymSyncNativePlayerReady !== true) {
        return;
      }
      handleBridgeReady(event.data);
    };

    const handleBridgeReadyEvent = function handleBridgeReadyEvent(event) {
      if (!event || !event.detail) {
        return;
      }
      handleBridgeReady(event.detail);
    };

    const detectNativeMediaFallback = function detectNativeMediaFallback() {
      const media = document.querySelector('audio,video');
      if (media) {
        emitNativePlayer(media, 'fallback.mediaElement');
      }
    };

    const detectNativePlayerProperty = function detectNativePlayerProperty() {
      const player = window.__ymSyncNativePlayer;
      if (player) {
        emitNativePlayer(player, 'poll.windowProperty');
      }
    };

    const checkNativePlayer = function checkNativePlayer() {
      if (state.player && state.source !== 'fallback.mediaElement') {
        return;
      }
      detectNativePlayerProperty();
      if (state.player) {
        return;
      }
      detectNativeMediaFallback();
    };

    const injectPageBridge = function injectPageBridge() {
      if (state.bridgeInjected) {
        return;
      }
      const bridge = document.createElement('script');
      bridge.id = 'ym-sync-native-player-bridge';
      bridge.src = chrome.runtime.getURL('content/player-native-bridge.js');
      bridge.async = true;
      bridge.setAttribute('data-ym-sync-native-player-bridge', '1');
      bridge.onload = () => {
        state.bridgeInjected = true;
      };

      const mount = document.documentElement || document.head || document.body;
      if (mount) {
        mount.appendChild(bridge);
      }
    };

    window.addEventListener('message', handleBridgeMessage);
    window.addEventListener(NATIVE_PLAYER_READY_EVENT, handleBridgeReadyEvent);
    injectPageBridge();
    let elapsed = 0;
    state.timer = window.setInterval(() => {
      elapsed += NATIVE_PLAYER_CAPTURE_POLL_MS;
      checkNativePlayer();
      if (state.player) {
        return;
      }
      if (elapsed >= NATIVE_PLAYER_CAPTURE_TIMEOUT_MS) {
        window.clearInterval(state.timer);
        state.timer = null;
      }
    }, NATIVE_PLAYER_CAPTURE_POLL_MS);
    checkNativePlayer();
  };

  void app.start();
})();
