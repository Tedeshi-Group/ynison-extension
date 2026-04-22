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
    app.STATE.apiBase = await app.loadApiBase();
    app.STATE.clientId = localStorage.getItem(app.constants.STORAGE_CLIENT_KEY) || "";
    app.STATE.joinInput = app.readRoomIdFromLocation() || localStorage.getItem(app.constants.STORAGE_ROOM_KEY) || "";

    app.initAvatarWatcher();
    app.installSidebarEntry();
    app.installPlayerBarCopyButton();
    app.installNavigationWatcher();
    app.installDocumentActionWatcher();
    app.installPlayerWatchers();
    app.render();

    if (app.shouldOpenTogetherPage()) {
      app.openSyncPage({ updateHistory: false });
      if (app.STATE.joinInput) {
        const joined = await app.joinRoom(app.STATE.joinInput, { silentToast: true });
        if (!joined) {
          await app.ensureAutoRoom();
        }
      } else {
        await app.ensureAutoRoom();
      }
      return;
    }

    if (app.STATE.joinInput) {
      const joined = await app.joinRoom(app.STATE.joinInput, { silentToast: true });
      if (!joined) {
        await app.ensureAutoRoom();
      }
      return;
    }

    await app.ensureAutoRoom();
  };

  app.redirectFromTogetherRouteIfNeeded = function redirectFromTogetherRouteIfNeeded() {
    const currentUrl = new URL(window.location.href);
    if (currentUrl.pathname !== "/together") {
      return false;
    }

    const roomId = app.readRoomIdFromUrl(currentUrl);
    const safeTarget = new URL(`${window.location.origin}/`);
    if (roomId) {
      safeTarget.searchParams.set("together", roomId);
    }
    window.location.replace(safeTarget.toString());
    return true;
  };

  app.shouldOpenTogetherPage = function shouldOpenTogetherPage() {
    const url = new URL(window.location.href);
    if (url.pathname === "/together") {
      return true;
    }
    const together = app.normalizeRoomId(url.searchParams.get("together"));
    if (together === "1") {
      return true;
    }
    if (together && together !== "1") {
      return true;
    }
    return false;
  };

  app.readRoomIdFromLocation = function readRoomIdFromLocation() {
    return app.readRoomIdFromUrl(new URL(window.location.href));
  };

  app.installNavigationWatcher = function installNavigationWatcher() {
    const observer = new MutationObserver(() => {
      app.installSidebarEntry();
      app.installPlayerBarCopyButton();
    });
    observer.observe(document.documentElement, { subtree: true, childList: true });

    window.addEventListener("popstate", () => {
      if (app.shouldOpenTogetherPage()) {
        app.openSyncPage({ updateHistory: false });
        const roomId = app.readRoomIdFromLocation();
        if (roomId && roomId !== app.STATE.roomId) {
          app.STATE.joinInput = roomId;
          void app.joinRoom(roomId, { silentToast: true });
        }
        app.render();
        return;
      }

      app.hideSyncPage();
      app.render();
    });
  };

  if (app.redirectFromTogetherRouteIfNeeded()) {
    return;
  }

  void app.start();
})();
