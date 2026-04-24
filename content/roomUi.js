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
      app.UI.sidebarItem = existing.closest('li');
      return;
    }

    if (app.UI.sidebarLink && app.UI.sidebarLink.isConnected) {
      return;
    }

    const searchLink = document.querySelector('a[href="/search"], a[href*="/search"]');
    if (!searchLink) {
      return;
    }

    const searchItem = searchLink.closest('li');
    const listRoot = searchItem ? searchItem.parentElement : null;
    if (!searchItem || !listRoot) {
      return;
    }

    const item = searchItem.cloneNode(true);
    item.setAttribute('data-ym-sync-item', '1');
    const link = item.querySelector('a');
    if (!link) {
      return;
    }

    link.classList.add('ym-sync-sidebar-link');
    link.setAttribute('data-ym-sync-link', '1');
    link.setAttribute('href', '/together');
    link.setAttribute('aria-label', 'Вместе (макет)');
    app.replaceLinkIcon(link);
    app.replaceFirstTextNode(link, 'Вместе');

    link.addEventListener('click', (event) => {
      event.preventDefault();
      app.openSyncPage();
    });

    listRoot.insertBefore(item, searchItem);
    app.UI.sidebarItem = item;
    app.UI.sidebarLink = link;
  };

  app.setActiveSidebarEntry = function setActiveSidebarEntry(isActive) {
    const menuRoot = app.UI.sidebarItem && app.UI.sidebarItem.parentElement
      ? app.UI.sidebarItem.parentElement
      : null;
    if (menuRoot) {
      const siblingLinks = menuRoot.querySelectorAll('a[aria-current="page"]');
      for (const link of siblingLinks) {
        if (link !== app.UI.sidebarLink) {
          link.removeAttribute('aria-current');
        }
      }
    }

    if (app.UI.sidebarLink) {
      if (isActive) {
        app.UI.sidebarLink.setAttribute('aria-current', 'page');
      } else {
        app.UI.sidebarLink.removeAttribute('aria-current');
      }
    }
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
    copyButton.type = 'button';
    copyButton.classList.add('ym-sync-player-copy-btn');
    copyButton.removeAttribute('data-cursor-ref');
    copyButton.removeAttribute('data-cursor-element-id');

    const iconHolder = copyButton.querySelector('span') || copyButton;
    iconHolder.innerHTML = '';
    iconHolder.appendChild(app.createUsersIconSvg('ym-sync-player-copy-icon'));

    copyButton.addEventListener('click', () => {
      app.openSyncPage();
    });

    const controls = Array.from(metaRoot.querySelectorAll('button'));
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

    app.UI.playerBarCopyBtn.setAttribute('aria-label', 'Открыть страницу лобби');
    app.UI.playerBarCopyBtn.setAttribute('title', 'Открыть страницу лобби');
  };

  app.openSyncPage = async function openSyncPage(options = {}) {
    const {
      updateHistory = true,
      joinRoleHint = '',
    } = options || {};
    const host = app.ensureMainHost();
    if (!host) {
      return;
    }

    if (updateHistory && typeof app.getLocationUrl === 'function') {
      const currentUrl = app.getLocationUrl();
      if (currentUrl && currentUrl.pathname !== '/together') {
        app.STATE.__lastMusicPath = currentUrl.pathname;
        app.STATE.__lastMusicSearch = currentUrl.search;
      }
    }

    app.installSidebarEntry();

    if (!app.UI.pageRoot) {
      app.UI.pageRoot = app.buildSyncPage();
    }

    if (app.UI.pageRoot.parentElement !== host) {
      host.appendChild(app.UI.pageRoot);
    }

    app.UI.mainHost = host;
    app.UI.mainHost.classList.add('ym-sync-content-host', 'ym-sync-content-host--active');
    app.UI.pageRoot.hidden = false;
    app.STATE.isPageOpen = true;
    app.setActiveSidebarEntry(true);

    const effectiveJoinRoleHint = joinRoleHint || app.STATE.joinRoleHint || app.STATE.roomRole || 'listener';
    if (app.STATE.joinInput && app.normalizeRoomId(app.STATE.joinInput)) {
      await app.joinRoom(app.STATE.joinInput, {
        silentToast: true,
        roleHint: effectiveJoinRoleHint,
      });
      app.STATE.joinRoleHint = '';
    } else if (!app.STATE.roomId) {
      await app.ensureAutoRoom();
    }

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
    app.UI.pageRoot.style.display = 'none';
    if (app.UI.mainHost) {
      app.UI.mainHost.classList.remove('ym-sync-content-host--active');
      app.UI.mainHost = null;
    }
    if (app.UI.pageRoot.parentElement) {
      app.UI.pageRoot.remove();
    }
    app.UI.pageRoot = null;
    app.STATE.isPageOpen = false;
    app.setActiveSidebarEntry(false);
  };

  app.closeSyncPage = function closeSyncPage() {
    app.hideSyncPage();
    app.STATE.joinInput = '';
    const fallbackPath = app.STATE.__lastMusicPath || '/collection';
    const fallbackSearch = app.STATE.__lastMusicSearch || '';

    const url = app.getLocationUrl(`${window.location.origin}${fallbackPath}${fallbackSearch}`);
    if (!url) {
      return;
    }
    url.searchParams.delete('together');
    url.searchParams.delete('roomId');
    url.searchParams.delete('session');
    history.pushState({}, '', url.toString());
    app.STATE.__lastMusicPath = '';
    app.STATE.__lastMusicSearch = '';
  };

  app.syncPageUrl = function syncPageUrl() {
    const url = new URL(window.location.href);
    url.pathname = '/together';
    url.searchParams.delete('session');
    url.searchParams.delete('roomId');
    url.searchParams.delete('together');

    const nextState = typeof history.state === 'object' && history.state !== null ? { ...history.state } : {};
    nextState.__ymSyncInternal = true;
    history.replaceState(nextState, '', url.toString());
  };

  app.buildSyncPage = function buildSyncPage() {
    const root = document.createElement('section');
    root.className = 'ym-sync-page';
    root.hidden = false;

    root.innerHTML = `
      <div class="ym-sync-wrap">
        <header class="ym-sync-lobby-header">
          <div>
            <h1 class="ym-sync-title">Вместе</h1>
            <p class="ym-sync-subtitle" data-status-text></p>
            <p class="ym-sync-subtitle" data-room-role-text></p>
            <p class="ym-sync-subtitle" data-room-control-text></p>
          </div>
          <div class="ym-sync-actions">
            <button class="ym-sync-btn ym-sync-btn--ghost" data-action="recreate-room">Пересоздать комнату</button>
          </div>
        </header>

        <div class="ym-sync-card ym-sync-card--lobby">
          <p class="ym-sync-room-title">URL комнаты: <span class="ym-sync-room-link" data-action="copy-room-link" data-room-link role="button" tabindex="0" aria-label="Копировать ссылку на комнату"></span></p>
          <p class="ym-sync-subtitle ym-sync-room-hint" data-empty-hint></p>
          <div class="ym-sync-avatars ym-sync-avatars--lobby" data-participants></div>

          <div class="ym-sync-toast" data-toast></div>
        </div>
      </div>
    `;

    app.UI.statusText = root.querySelector('[data-status-text]');
    app.UI.roomRoleText = root.querySelector('[data-room-role-text]');
    app.UI.roomControlText = root.querySelector('[data-room-control-text]');
    app.UI.roomIdText = root.querySelector('[data-room-id]');
    app.UI.roomInviteText = root.querySelector('[data-room-link]');
    app.UI.emptyHint = root.querySelector('[data-empty-hint]');
    app.UI.participantsWrap = root.querySelector('[data-participants]');
    app.UI.toast = root.querySelector('[data-toast]');

    app.bindAction(root, 'recreate-room', () => {
      app.recreateRoom();
    });

    root.addEventListener('click', (event) => {
      const roomLinkTarget = event.target.closest('[data-action="copy-room-link"]');
      if (roomLinkTarget && roomLinkTarget === app.UI.roomInviteText) {
        event.preventDefault();
        void app.copyInviteLink();
        return;
      }

      const target = event.target.closest('[data-action="invite-link"]');
      if (!target || !app.UI.participantsWrap || !app.UI.participantsWrap.contains(target)) {
        return;
      }
      event.preventDefault();
      void app.copyInviteLink();
    });

    root.addEventListener('keydown', (event) => {
      if (event.target !== app.UI.roomInviteText) {
        return;
      }
      if (event.key !== 'Enter' && event.key !== ' ') {
        return;
      }
      event.preventDefault();
      void app.copyInviteLink();
    });

    root.addEventListener('click', (event) => {
      if (app.handleMemberAction(event)) {
        event.preventDefault();
      }
    });

    return root;
  };

  app.copyInviteLink = async function copyInviteLink() {
    if (!app.STATE.roomId || !app.STATE.inviteLink) {
      await app.ensureAutoRoom();
    }

    if (!app.STATE.inviteLink) {
      app.toast('Не удалось получить ссылку для приглашения');
      return;
    }

    app.copyToClipboard(app.STATE.inviteLink, 'Ссылка скопирована');
    app.UI.lastCopied = Date.now();
    app.render();
  };

  app.buildAvatarTile = function buildAvatarTile(member) {
    const item = document.createElement('div');
    item.className = 'ym-sync-member';
    const memberId = member.clientId || '';
    if (memberId) {
      item.dataset.memberId = memberId;
    }

    const readHostNameFromProfileMeta = () => {
      const hostMeta = document.querySelector('.UserProfile_meta___okny');
      if (!hostMeta) {
        return '';
      }
      const userName = hostMeta.querySelector('.UserProfile_userName__PTRuJ');
      if (!userName) {
        return '';
      }
      return app.normalizeNickname(userName.getAttribute('title') || userName.textContent);
    };

    const avatarWrap = document.createElement('div');
    avatarWrap.className = 'ym-sync-member-avatar-wrap';
    const isHost = member.role === 'host';
    const nickname = isHost
      ? (readHostNameFromProfileMeta() || member.nickname || app.constants.DEFAULT_NICKNAME)
      : (member.nickname || app.constants.DEFAULT_NICKNAME);

    const image = document.createElement('img');
    image.className = 'ym-sync-member-avatar';
    image.loading = 'lazy';
    image.decoding = 'async';
    image.alt = nickname || 'Участник комнаты';
    image.src = member.avatarUrl || app.avatarFromName(nickname || 'guest');
    image.addEventListener('error', () => {
      image.style.display = 'none';
      const fallback = document.createElement('div');
      fallback.className = 'ym-sync-member-avatar ym-sync-member-avatar--fallback';
      fallback.textContent = String(nickname || '—').slice(0, 2).toUpperCase();
      avatarWrap.appendChild(fallback);
    }, { once: true });

    if (isHost) {
      avatarWrap.appendChild(app.createCrownIconSvg('ym-sync-host-crown'));
    }

    const name = document.createElement('p');
    name.className = 'ym-sync-member-name';
    name.textContent = nickname || 'Участник';

    const role = document.createElement('span');
    role.className = 'ym-sync-member-role';
    role.textContent = member.role === 'host' ? 'Хост' : 'Участник';

    avatarWrap.appendChild(image);
    item.appendChild(avatarWrap);
    item.appendChild(name);
    item.appendChild(role);

    if (app.STATE.roomPermissions?.canDelegate && member.role !== 'host' && memberId) {
      const actions = document.createElement('div');
      actions.className = 'ym-sync-member-actions';

      const delegate = document.createElement('button');
      delegate.type = 'button';
      delegate.className = 'ym-sync-btn ym-sync-btn--ghost ym-sync-member-action';
      delegate.setAttribute('data-member-action', 'delegate');
      delegate.setAttribute('data-member-id', memberId);
      delegate.textContent = 'Сделать хостом';

      const kick = document.createElement('button');
      kick.type = 'button';
      kick.className = 'ym-sync-btn ym-sync-btn--ghost ym-sync-member-action';
      kick.setAttribute('data-member-action', 'kick');
      kick.setAttribute('data-member-id', memberId);
      kick.textContent = 'Выгнать';

      actions.appendChild(delegate);
      actions.appendChild(kick);
      item.appendChild(actions);
    }

    return item;
  };

  app.buildInviteTile = function buildInviteTile() {
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'ym-sync-member ym-sync-member--plus';
    add.setAttribute('data-action', 'invite-link');
    add.setAttribute('aria-label', 'Скопировать ссылку на приглашение');
    add.setAttribute('title', 'Скопировать ссылку на приглашение');

    const avatar = document.createElement('div');
    avatar.className = 'ym-sync-member-avatar ym-sync-member-avatar--plus';
    avatar.textContent = '+';

    const label = document.createElement('p');
    label.className = 'ym-sync-member-name';
    label.textContent = 'Пригласить';

    const hint = document.createElement('span');
    hint.className = 'ym-sync-member-role';
    hint.textContent = 'Скопировать ссылку';

    add.appendChild(avatar);
    add.appendChild(label);
    add.appendChild(hint);
    return add;
  };

  app.renderParticipants = function renderParticipants() {
    if (!app.UI.participantsWrap) {
      return;
    }

    app.UI.participantsWrap.innerHTML = '';

    const participants = Array.isArray(app.STATE.roomState?.participants)
      ? app.STATE.roomState.participants
      : [];

    for (const member of participants) {
      app.UI.participantsWrap.appendChild(app.buildAvatarTile(member));
    }

    app.UI.participantsWrap.appendChild(app.buildInviteTile());
  };

  app.handleMemberAction = function handleMemberAction(event) {
    const actionButton = event.target.closest('[data-member-action]');
    if (!actionButton) {
      return false;
    }
    if (!app.UI.participantsWrap || !app.UI.participantsWrap.contains(actionButton)) {
      return false;
    }

    const action = actionButton.getAttribute('data-member-action');
    const memberId = actionButton.getAttribute('data-member-id');
    if (!memberId) {
      return true;
    }

    if (action === 'delegate' && typeof app.sendControlTransfer === 'function') {
      app.sendControlTransfer(memberId, true);
      return true;
    }

    if (action === 'kick' && typeof app.sendKick === 'function') {
      app.sendKick(memberId);
      return true;
    }

    return true;
  };

  app.bindAction = function bindAction(root, actionName, handler) {
    const target = root.querySelector(`[data-action="${actionName}"]`);
    if (!target) {
      return;
    }
    target.addEventListener('click', handler);
  };

  app.ensureMainHost = function ensureMainHost() {
    return document.querySelector('main.Content_main__8_wIa') || document.querySelector('main') || document.body;
  };

  app.render = function render() {
    app.updatePlayerBarCopyButton();

    if (!app.STATE.isPageOpen || !app.UI.pageRoot) {
      return;
    }

    app.UI.statusText.textContent = app.buildStatusText();

    if (app.UI.roomInviteText) {
      app.UI.roomInviteText.textContent = app.STATE.inviteLink || '';
    }

    app.renderParticipants();
  };

  app.buildStatusText = function buildStatusText() {
    if (app.STATE.lastError) {
      return `Ошибка: ${app.STATE.lastError}`;
    }

    if (app.STATE.isBusy) {
      return 'Подготавливаю лобби...';
    }

    if (!app.STATE.roomId) {
      return 'Создаём комнату — это займёт доли секунды.';
    }

    return 'Лобби активно. Нажми на “+”, чтобы пригласить других.';
  };

  app.replaceLinkIcon = function replaceLinkIcon(link) {
    const existingSvg = link.querySelector('svg');
    const customIcon = app.createUsersIconSvg('ym-sync-nav-icon');
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
      const value = (node.nodeValue || '').trim();
      if (value) {
        node.nodeValue = newText;
        return;
      }
    }
  };

  app.createUsersIconSvg = function createUsersIconSvg(className) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', className);

    const circleLeft = document.createElementNS(NS, 'circle');
    circleLeft.setAttribute('cx', '9');
    circleLeft.setAttribute('cy', '8');
    circleLeft.setAttribute('r', '3.2');

    const circleRight = document.createElementNS(NS, 'circle');
    circleRight.setAttribute('cx', '16');
    circleRight.setAttribute('cy', '9');
    circleRight.setAttribute('r', '2.6');

    const bodyLeft = document.createElementNS(NS, 'path');
    bodyLeft.setAttribute('d', 'M3.5 18.2c0-3.2 3-5.2 5.9-5.2S15.2 15 15.2 18.2');

    const bodyRight = document.createElementNS(NS, 'path');
    bodyRight.setAttribute('d', 'M13.4 17.8c.3-2.4 2.2-3.9 4.4-3.9 1.1 0 2.2.4 3.1 1.1');

    for (const node of [circleLeft, circleRight, bodyLeft, bodyRight]) {
      node.setAttribute('stroke', 'currentColor');
      node.setAttribute('stroke-width', '1.8');
      node.setAttribute('stroke-linecap', 'round');
      node.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(node);
    }

    return svg;
  };

  app.createCrownIconSvg = function createCrownIconSvg(className) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('width', '24');
    svg.setAttribute('height', '24');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('role', 'img');
    svg.setAttribute('class', className);
    svg.setAttribute('data-testid', 'crown-icon');

    const path = document.createElementNS(NS, 'path');
    path.setAttribute('fill', 'currentColor');
    path.setAttribute('fill-rule', 'evenodd');
    path.setAttribute('clip-rule', 'evenodd');
    path.setAttribute('d', 'M12 2.996a1 1 0 0 1 .929.629l2.78 6.953 4.837-2.468a1 1 0 0 1 1.412 1.178l-3 10A1 1 0 0 1 18 20H6a1 1 0 0 1-.963-.729L2.042 9.288A1 1 0 0 1 3.455 8.11l4.836 2.468 2.78-6.953a1 1 0 0 1 .93-.629M6.744 18h10.512l2.114-7.045-3.728 1.902a1 1 0 0 1-1.383-.52L12 6.69l-2.259 5.649a1 1 0 0 1-1.383.519L4.63 10.955z');
    svg.appendChild(path);

    return svg;
  };
})();
