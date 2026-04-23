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

  void app.start();
})();
