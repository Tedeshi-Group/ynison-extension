(function ymSyncRoomUiModule() {
  const app = window.__ymSync;
  if (!app || (app.modules && app.modules.roomUi)) {
    return;
  }

  app.modules.roomUi = true;

  app.installSidebarEntry = function installSidebarEntry() {
    const existing = document.querySelector('[data-ym-sync-link="1"]');
    if (existing && existing.isConnected) {
      app.UI.sidebarLink = existing;
      app.UI.sidebarItem = existing.closest("li");
      return;
    }

    if (app.UI.sidebarLink && app.UI.sidebarLink.isConnected) {
      return;
    }
    app.UI.sidebarLink = null;
    app.UI.sidebarItem = null;

    const searchLink = document.querySelector('a[href="/search"], a[href*="/search"]');
    if (!searchLink) {
      return;
    }

    const searchItem = searchLink.closest("li");
    const listRoot = searchItem ? searchItem.parentElement : null;
    if (!searchItem || !listRoot) {
      return;
    }

    const item = searchItem.cloneNode(true);
    item.setAttribute("data-ym-sync-item", "1");
    const link = item.querySelector("a");
    if (!link) {
      return;
    }

    link.classList.add("ym-sync-sidebar-link");
    link.setAttribute("data-ym-sync-link", "1");
    link.setAttribute("href", "/together");
    link.setAttribute("aria-label", "Вместе");
    link.removeAttribute("data-cursor-ref");
    app.replaceLinkIcon(link);
    app.replaceFirstTextNode(link, "Вместе");

    link.addEventListener("click", (event) => {
      event.preventDefault();
      app.openSyncPage();
    });

    listRoot.insertBefore(item, searchItem);
    app.UI.sidebarItem = item;
    app.UI.sidebarLink = link;
  };

  app.installPlayerBarCopyButton = function installPlayerBarCopyButton() {
    const queueButton =
      document.querySelector('button[aria-label="Playback queue"]') ||
      document.querySelector('button[aria-label="Очередь воспроизведения"]');
    if (!queueButton) {
      return;
    }

    const metaRoot = queueButton.parentElement;
    if (!metaRoot) {
      return;
    }

    if (app.UI.playerBarCopyBtn && app.UI.playerBarCopyBtn.isConnected) {
      app.updatePlayerBarCopyButton();
      return;
    }

    const copyButton = queueButton.cloneNode(true);
    copyButton.type = "button";
    copyButton.classList.add("ym-sync-player-copy-btn");
    copyButton.removeAttribute("data-cursor-ref");
    copyButton.removeAttribute("data-cursor-element-id");

    const iconHolder = copyButton.querySelector("span") || copyButton;
    iconHolder.innerHTML = "";
    iconHolder.appendChild(app.createUsersIconSvg("ym-sync-player-copy-icon"));
    copyButton.addEventListener("click", () => {
      if (app.STATE.inviteLink) {
        app.copyToClipboard(app.STATE.inviteLink, "Ссылка приглашения скопирована");
        return;
      }

      app.openSyncPage();
      app.toast("Сначала создайте комнату или подключитесь к ней");
    });

    const controls = Array.from(metaRoot.querySelectorAll("button"));
    const targetIndex = Math.max(0, controls.length - 4);
    const anchor = controls[targetIndex] || null;
    metaRoot.insertBefore(copyButton, anchor);
    app.UI.playerBarCopyBtn = copyButton;
    app.updatePlayerBarCopyButton();
  };

  app.updatePlayerBarCopyButton = function updatePlayerBarCopyButton() {
    if (!app.UI.playerBarCopyBtn) {
      return;
    }

    const label = app.STATE.inviteLink ? "Скопировать ссылку комнаты" : "Открыть совместное прослушивание";
    app.UI.playerBarCopyBtn.setAttribute("aria-label", label);
    app.UI.playerBarCopyBtn.setAttribute("title", label);
  };

  app.openSyncPage = function openSyncPage(options = {}) {
    const { updateHistory = true } = options;
    const host = app.ensureMainHost();
    if (!host) {
      return;
    }

    if (!app.UI.pageRoot) {
      app.UI.pageRoot = app.buildSyncPage();
    }

    if (app.UI.pageRoot.parentElement !== host) {
      host.appendChild(app.UI.pageRoot);
    }

    app.UI.mainHost = host;
    app.UI.mainHost.classList.add("ym-sync-content-host", "ym-sync-content-host--active");
    app.UI.pageRoot.hidden = false;
    app.STATE.isPageOpen = true;

    if (updateHistory) {
      app.syncPageUrl();
    }

    app.render();
  };

  app.hideSyncPage = function hideSyncPage() {
    if (!app.UI.pageRoot) {
      return;
    }

    app.UI.pageRoot.hidden = true;
    if (app.UI.mainHost) {
      app.UI.mainHost.classList.remove("ym-sync-content-host--active");
    }
    app.STATE.isPageOpen = false;
  };

  app.closeSyncPage = function closeSyncPage() {
    app.hideSyncPage();
    const url = new URL(window.location.href);
    url.pathname = "/collection";
    url.searchParams.delete("together");
    url.searchParams.delete("roomId");
    url.searchParams.delete("session");
    history.pushState({}, "", url.toString());
  };

  app.syncPageUrl = function syncPageUrl() {
    const url = new URL(window.location.href);
    url.pathname = "/together";
    url.searchParams.set("together", "1");
    url.searchParams.delete("session");
    if (app.STATE.roomId) {
      url.searchParams.set("roomId", app.STATE.roomId);
    } else {
      url.searchParams.delete("roomId");
    }
    history.pushState({}, "", url.toString());
  };

  app.buildSyncPage = function buildSyncPage() {
    const root = document.createElement("section");
    root.className = "ym-sync-page";
    root.hidden = false;

    root.innerHTML = `
      <div class="ym-sync-wrap">
        <div class="ym-sync-top">
          <div>
            <h1 class="ym-sync-title">Совместное прослушивание</h1>
            <p class="ym-sync-subtitle" data-status-text></p>
          </div>
          <div class="ym-sync-actions">
            <button class="ym-sync-btn ym-sync-btn--primary" data-action="close-page">Вернуться к музыке</button>
          </div>
        </div>

        <div class="ym-sync-card ym-sync-card--lobby">
          <div class="ym-sync-avatars" data-participants></div>

          <div class="ym-sync-invite">
            <label for="ym-sync-invite-link">Ссылка для приглашения</label>
            <div class="ym-sync-invite-row">
              <input id="ym-sync-invite-link" class="ym-sync-input" type="text" readonly />
              <button class="ym-sync-btn ym-sync-btn--primary" data-action="copy-link">Скопировать ссылку</button>
            </div>
          </div>

          <div class="ym-sync-actions ym-sync-actions--compact">
            <button class="ym-sync-btn ym-sync-btn--ghost" data-action="recreate-room">Пересоздать комнату</button>
          </div>

          <div class="ym-sync-panel-note" data-panel-note></div>
          <div class="ym-sync-toast" data-toast></div>
        </div>
      </div>
    `;

    app.UI.statusText = root.querySelector("[data-status-text]");
    app.UI.participantsWrap = root.querySelector("[data-participants]");
    app.UI.inviteInput = root.querySelector("#ym-sync-invite-link");
    app.UI.roomMeta = root.querySelector("[data-panel-note]");
    app.UI.toast = root.querySelector("[data-toast]");
    app.UI.copyInviteBtn = root.querySelector('[data-action="copy-link"]');

    app.bindAction(root, "copy-link", () => {
      if (!app.STATE.inviteLink) {
        app.toast("Комната ещё создаётся");
        return;
      }
      app.copyToClipboard(app.STATE.inviteLink, "Ссылка скопирована");
    });
    app.bindAction(root, "recreate-room", () => {
      void app.recreateRoom();
    });
    app.bindAction(root, "close-page", app.closeSyncPage);

    app.UI.apiTargetDomainBtn = root.querySelector('[data-api-target="domain"]');
    app.UI.apiTargetLanBtn = root.querySelector('[data-api-target="lan"]');
    const segmented = root.querySelector(".ym-sync-segmented");
    if (segmented) {
      segmented.addEventListener("click", (event) => {
        const btn = event.target.closest("[data-api-target]");
        if (!btn || !segmented.contains(btn)) {
          return;
        }
        const value = btn.getAttribute("data-api-target");
        if (value === "domain" || value === "lan") {
          void app.applyApiTarget(value);
        }
      });
    }

    return root;
  };

  app.bindAction = function bindAction(root, actionName, handler) {
    const target = root.querySelector(`[data-action="${actionName}"]`);
    if (!target) {
      return;
    }
    target.addEventListener("click", handler);
  };

  app.ensureMainHost = function ensureMainHost() {
    return document.querySelector("main.Content_main__8_wIa") || document.querySelector("main") || document.body;
  };

  app.initAvatarWatcher = function initAvatarWatcher() {
    if (app.STATE.avatarWatcherStarted) {
      return;
    }
    app.STATE.avatarWatcherStarted = true;

    app.refreshAvatarWithRetry(10, 1200);

    const observer = new MutationObserver(() => {
      app.refreshAvatarFromSidebar();
    });
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["src", "srcset", "style", "class"],
    });
  };

  app.refreshAvatarWithRetry = function refreshAvatarWithRetry(attemptsLeft, delayMs) {
    const hasFreshAvatar = app.refreshAvatarFromSidebar();
    if (hasFreshAvatar || attemptsLeft <= 0) {
      return;
    }
    window.setTimeout(() => {
      app.refreshAvatarWithRetry(attemptsLeft - 1, delayMs);
    }, delayMs);
  };

  app.refreshAvatarFromSidebar = function refreshAvatarFromSidebar() {
    const latestAvatar = app.readAvatarFromUserBadge();
    if (!latestAvatar || !app.STATE.profile) {
      return false;
    }

    if (app.STATE.profile.avatarUrl === latestAvatar) {
      return true;
    }

    app.STATE.profile.avatarUrl = latestAvatar;
    const self = app.getSelfParticipant();
    if (self) {
      self.avatarUrl = latestAvatar;
    }
    app.render();
    return true;
  };

  app.replaceLinkIcon = function replaceLinkIcon(link) {
    const existingSvg = link.querySelector("svg");
    const customIcon = app.createUsersIconSvg("ym-sync-nav-icon");
    if (existingSvg) {
      existingSvg.replaceWith(customIcon);
      return;
    }
    link.insertBefore(customIcon, link.firstChild);
  };

  app.replaceFirstTextNode = function replaceFirstTextNode(root, newText) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const value = (node.nodeValue || "").trim();
      if (value) {
        node.nodeValue = newText;
        return;
      }
    }
  };

  app.createUsersIconSvg = function createUsersIconSvg(className) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("focusable", "false");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", className);

    const circleLeft = document.createElementNS(NS, "circle");
    circleLeft.setAttribute("cx", "9");
    circleLeft.setAttribute("cy", "8");
    circleLeft.setAttribute("r", "3.2");

    const circleRight = document.createElementNS(NS, "circle");
    circleRight.setAttribute("cx", "16");
    circleRight.setAttribute("cy", "9");
    circleRight.setAttribute("r", "2.6");

    const bodyLeft = document.createElementNS(NS, "path");
    bodyLeft.setAttribute("d", "M3.5 18.2c0-3.2 3-5.2 5.9-5.2S15.2 15 15.2 18.2");

    const bodyRight = document.createElementNS(NS, "path");
    bodyRight.setAttribute("d", "M13.4 17.8c.3-2.4 2.2-3.9 4.4-3.9 1.1 0 2.2.4 3.1 1.1");

    for (const node of [circleLeft, circleRight, bodyLeft, bodyRight]) {
      node.setAttribute("stroke", "currentColor");
      node.setAttribute("stroke-width", "1.8");
      node.setAttribute("stroke-linecap", "round");
      node.setAttribute("stroke-linejoin", "round");
      svg.appendChild(node);
    }

    return svg;
  };

  app.render = function render() {
    app.updatePlayerBarCopyButton();

    if (!app.STATE.isPageOpen || !app.UI.pageRoot) {
      return;
    }

    const participants =
      (app.STATE.roomState && Array.isArray(app.STATE.roomState.participants) && app.STATE.roomState.participants) || [];
    const self = app.getSelfParticipant();

    app.UI.statusText.textContent = app.buildStatusText(self);
    app.UI.roomMeta.textContent = app.buildPanelNote(self);
    app.UI.inviteInput.value = app.STATE.inviteLink || "";
    app.UI.participantsWrap.innerHTML = participants.length
      ? participants.map((member) => app.renderParticipant(member)).join("")
      : `<div class="ym-sync-empty">Пока в комнате только ты. Отправь ссылку другу, и его аватар появится здесь.</div>`;

    app.UI.copyInviteBtn.disabled = !app.STATE.inviteLink;

    if (app.UI.apiTargetDomainBtn && app.UI.apiTargetLanBtn) {
      const lan = app.STATE.apiTarget === "lan";
      app.UI.apiTargetDomainBtn.classList.toggle("ym-sync-segment--active", !lan);
      app.UI.apiTargetLanBtn.classList.toggle("ym-sync-segment--active", lan);
      app.UI.apiTargetDomainBtn.setAttribute("aria-pressed", lan ? "false" : "true");
      app.UI.apiTargetLanBtn.setAttribute("aria-pressed", lan ? "true" : "false");
      const busy = app.STATE.isBusy;
      app.UI.apiTargetDomainBtn.disabled = busy;
      app.UI.apiTargetLanBtn.disabled = busy;
    }
  };

  app.buildStatusText = function buildStatusText() {
    if (app.STATE.lastError) {
      return `Ошибка: ${app.STATE.lastError}`;
    }

    if (app.STATE.isBusy) {
      return "Подготавливаем комнату...";
    }

    if (!app.STATE.roomId) {
      return "Комната создаётся автоматически.";
    }

    if (app.STATE.socketState === "connecting") {
      return "Подключаемся к комнате...";
    }

    if (app.STATE.socketState === "disconnected") {
      return "Связь потеряна, пробуем переподключиться.";
    }

    return "Комната готова, можно сразу делиться ссылкой.";
  };

  app.buildPanelNote = function buildPanelNote(self) {
    if (!app.STATE.roomId) {
      return "Комната создаётся автоматически, подожди пару секунд.";
    }

    const role = self && self.role === "host" ? "Ты ведущий комнаты" : "Ты слушатель комнаты";
    if (app.STATE.playerMismatchHint) {
      return `${role}. ${app.STATE.playerMismatchHint}`;
    }

    return `${role}.`;
  };

  app.renderParticipant = function renderParticipant(member) {
    const fallbackAvatar = app.avatarFromName(member.nickname || member.clientId || "member");
    const badge = `${member.role || "listener"}${member.isConnected ? "" : " · offline"}`;

    return `
      <div class="ym-sync-member">
        <img class="ym-sync-member-avatar" src="${app.escapeAttr(member.avatarUrl || fallbackAvatar)}" alt="${app.escapeAttr(
          member.nickname || "Участник"
        )}" />
        <div class="ym-sync-member-name">${app.escapeHtml(member.nickname || "Участник")}</div>
        <div class="ym-sync-member-role">${app.escapeHtml(badge)}</div>
      </div>
    `;
  };

  app.copyToClipboard = function copyToClipboard(text, successMessage) {
    navigator.clipboard.writeText(text).then(
      () => app.toast(successMessage),
      () => app.toast("Не удалось скопировать")
    );
  };

  app.toast = function toast(text) {
    if (!app.UI.toast) {
      return;
    }
    app.UI.toast.textContent = text;
    window.clearTimeout(app.UI.toast.__timer);
    app.UI.toast.__timer = window.setTimeout(() => {
      app.UI.toast.textContent = "";
    }, 2500);
  };
})();
