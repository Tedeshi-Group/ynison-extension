(function ymSyncPlayerModule() {
  const app = window.__ymSync;
  if (!app || (app.modules && app.modules.playerSync)) {
    return;
  }

  app.modules.playerSync = true;

  app.STATE.ym = app.STATE.ym || {
    remotePlayerState: null,
    remotePlayerStateAt: 0,
    remotePlayerStateReceivedAt: 0,
  };

  const SYNC_INTERVAL_MS = 1000;
  const REMOTE_COMMAND_COOLDOWN_MS = 500;
  const SEEK_COOLDOWN_MS = 300;
  const SEEK_APPLY_MIN_DRIFT_MS = 3000;
  const HOST_ACTION_SYNC_DEBOUNCE_MS = 120;
  const HOST_MEDIA_SYNC_EVENTS = ['play', 'pause', 'seeked', 'ended', 'loadedmetadata', 'loadeddata'];
  const remoteActionCooldown = {};

  const hostState = {
    syncTimer: null,
    lastTrackFingerprint: '',
    lastTrackMetaVersion: 0,
    lastTrackUpdateAt: 0,
    lastPlaybackReadAt: 0,
    lastRemoteTrackFingerprint: '',
    remoteApplyTimer: null,
    interceptBound: false,
    controlContainer: null,
    hostControlInterceptBound: false,
    hostControlContainer: null,
    pendingSeekTimer: null,
    listenerSearchNavCompleted: false,
    hostSyncDebounceTimer: null,
    hostMediaElement: null,
  };

  const LISTENER_SEARCH_UI_SELECTORS = {
    SIDEBAR_SEARCH_LINK_SELECTOR: 'a[href="/search"], a[href="/search/"], a[href*="/search?"], a[href*="/search/"]',
  };

  const LISTENER_PLAYER_BAR_SELECTORS = {
    SEEK_INPUT: 'section[class*="PlayerBarDesktopWithBackgroundProgressBar_"] input[type="range"]',
  };

  const listenerUiState = {
    syncTimer: null,
    mediaElement: null,
    overlay: null,
    slider: null,
    lockedButtons: [],
    seekInput: null,
  };

  let _lastListenerSeekAt = 0;
  const LISTENER_SEEK_MIN_INTERVAL_MS = 750;

  const SEEK_ARIA_RES = [/manage time code/i, /time code/i, /тайм[\s-]?код/i, /позици/i];

  const isSeekRangeElementVisible = function isSeekRangeElementVisible(el) {
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
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) {
        return false;
      }
      x = x.parentElement;
    }
    return true;
  };

  const getMainSeekRangeInput = function getMainSeekRangeInput() {
    try {
      const ranges = document.querySelectorAll('input[type="range"]');
      let best = null;
      let bestScore = -1;
      for (let i = 0; i < ranges.length; i++) {
        const el = ranges[i];
        if (!isSeekRangeElementVisible(el)) {
          continue;
        }
        const aria = el.getAttribute('aria-label') || '';
        const cls = el.getAttribute('class') || '';
        let score = 0;
        if (aria && SEEK_ARIA_RES.some((re) => re.test(aria))) {
          score += 100;
        }
        if (cls.includes('ChangeTimecodeBackground') && cls.includes('slider')) {
          score += 50;
        }
        if (cls.includes('PlayerBar') && cls.includes('slider')) {
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
      const cls = best ? best.getAttribute('class') || '' : '';
      if (best && cls.includes('ChangeTimecodeBackground')) {
        return best;
      }
    } catch (_e) {
      // noop
    }
    return null;
  };

  const inferSeekSliderScale = function inferSeekSliderScale(maxVal, durationMs) {
    if (!Number.isFinite(maxVal) || maxVal <= 0 || !Number.isFinite(durationMs) || durationMs < 800) {
      return 'ms';
    }
    if (maxVal >= durationMs * 0.2) {
      return 'ms';
    }
    const durSec = durationMs / 1000;
    if (Math.abs(maxVal - durSec) <= Math.max(1.5, durSec * 0.12)) {
      return 'sec';
    }
    if (maxVal < durationMs / 20 && maxVal >= 2 && durationMs > 8000) {
      return 'sec';
    }
    return 'ms';
  };

  const readLocalSeekMs = function readLocalSeekMs(input, durationFallbackMs) {
    const max = Number(input.max);
    const v = Number(input.value);
    const dur = Number.isFinite(durationFallbackMs) && durationFallbackMs > 0 ? durationFallbackMs : 0;
    if (Number.isFinite(max) && max > 0 && dur > 0) {
      const scale = inferSeekSliderScale(max, dur);
      if (scale === 'sec') {
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

  const pickSeekDurationMs = function pickSeekDurationMs(seekInput) {
    const media = document.querySelector('audio, video');
    if (media && Number.isFinite(media.duration) && media.duration > 0) {
      return Math.round(media.duration * 1000);
    }
    const max = Number(seekInput.max) || 0;
    if (max <= 0) {
      return 0;
    }
    if (max < 7200) {
      return Math.round(max * 1000);
    }
    return Math.round(max);
  };

  const normalizeWsPlayerState = function normalizeWsPlayerState(playerState) {
    if (!playerState || typeof playerState !== 'object') {
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

    const trackId = current && (current.playable_id || current.playableId)
      ? String(current.playable_id || current.playableId)
      : '';
    const title = current && typeof current.title === 'string' ? current.title : '';

    return {
      paused,
      durationMs,
      positionMs: Math.max(0, Math.min(progressMs, durationMs || progressMs)),
      trackId,
      title,
      raw: playerState,
    };
  };

  const estimateRemotePositionMs = function estimateRemotePositionMs(remote, receivedAtLocal) {
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

  const LISTENER_LOCKED_CONTROL_LABELS = [
    'playback queue',
    'context menu',
    'shuffle',
    'repeat',
    'previous song',
    'next song',
    'playback',
    'очередь воспроизведения',
    'контекстное меню',
    'перемешивание',
    'повтор',
    'предыдущий',
    'предыдущий трек',
    'следующий',
    'следующий трек',
    'воспроизведение',
  ];

  const setListenerControlLockState = function setListenerControlLockState(button, isLocked) {
    if (!button) {
      return;
    }
    if (!isLocked) {
      if (button.getAttribute('data-ym-sync-listener-locked') !== '1') {
        return;
      }
      button.classList.remove('ym-sync-listener-locked-control');
      button.disabled = false;
      button.style.visibility = '';
      button.style.display = '';
      button.style.pointerEvents = '';
      button.removeAttribute('data-ym-sync-listener-locked');
      button.removeAttribute('aria-disabled');
      return;
    }

    button.classList.add('ym-sync-listener-locked-control');
    button.setAttribute('data-ym-sync-listener-locked', '1');
    button.disabled = true;
    button.setAttribute('aria-disabled', 'true');
    button.style.visibility = 'hidden';
    button.style.pointerEvents = 'none';
  };

  const getListenerLockedButtons = function getListenerLockedButtons(controlsRoot) {
    if (!controlsRoot) {
      return [];
    }

    const buttons = Array.from(controlsRoot.querySelectorAll('button'));
    const lockedButtons = [];
    for (const button of buttons) {
      const label = String(button.getAttribute('aria-label') || '').trim().toLowerCase();
      if (!label || button.getAttribute('data-ym-sync-listener-locked') === '1') {
        continue;
      }
      const isLockedByLabel = LISTENER_LOCKED_CONTROL_LABELS.some((labelValue) => (
        label === labelValue
        || label.startsWith(`${labelValue} `)
        || label.includes(labelValue)
      ));
      if (isLockedByLabel) {
        lockedButtons.push(button);
      }
    }

    return lockedButtons;
  };

  const restoreListenerLockedButtons = function restoreListenerLockedButtons() {
    const buttons = Array.from(document.querySelectorAll('button[data-ym-sync-listener-locked="1"]'));
    for (const button of buttons) {
      setListenerControlLockState(button, false);
    }
    listenerUiState.lockedButtons = [];
  };

  const blockSeekInputInteraction = function blockSeekInputInteraction(event) {
    if (!listenerUiState.seekInput) {
      return;
    }
    if (!event.isTrusted) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  const updateListenerSeekInput = function updateListenerSeekInput(controlsRoot) {
    const root = controlsRoot || document;
    const seekInput = app.findPlayerSeekRange()
      || root.querySelector('input[type="range"][aria-label*="time" i]');

    if (!seekInput) {
      if (listenerUiState.seekInput) {
        listenerUiState.seekInput.disabled = false;
        listenerUiState.seekInput.removeEventListener('pointerdown', blockSeekInputInteraction, true);
        listenerUiState.seekInput.removeEventListener('mousedown', blockSeekInputInteraction, true);
        listenerUiState.seekInput.removeEventListener('click', blockSeekInputInteraction, true);
        listenerUiState.seekInput.removeEventListener('input', blockSeekInputInteraction, true);
        listenerUiState.seekInput.removeEventListener('change', blockSeekInputInteraction, true);
        listenerUiState.seekInput.removeAttribute('data-ym-sync-listener-locked-seek');
        listenerUiState.seekInput.classList.remove('ym-sync-listener-slider-disabled');
        listenerUiState.seekInput.style.pointerEvents = '';
        listenerUiState.seekInput.style.cursor = '';
      }
      listenerUiState.seekInput = null;
      return;
    }

    if (app.canControl()) {
      if (seekInput.getAttribute('data-ym-sync-listener-locked-seek') === '1') {
        seekInput.removeEventListener('pointerdown', blockSeekInputInteraction, true);
        seekInput.removeEventListener('mousedown', blockSeekInputInteraction, true);
        seekInput.removeEventListener('click', blockSeekInputInteraction, true);
        seekInput.removeEventListener('input', blockSeekInputInteraction, true);
        seekInput.removeEventListener('change', blockSeekInputInteraction, true);
      }
      seekInput.removeAttribute('data-ym-sync-listener-locked-seek');
      seekInput.removeAttribute('aria-disabled');
      seekInput.classList.remove('ym-sync-listener-slider-disabled');
      seekInput.style.pointerEvents = '';
      seekInput.style.cursor = '';
      seekInput.disabled = false;
      listenerUiState.seekInput = null;
      return;
    }

    if (seekInput.getAttribute('data-ym-sync-listener-locked-seek') !== '1') {
      seekInput.addEventListener('pointerdown', blockSeekInputInteraction, true);
      seekInput.addEventListener('mousedown', blockSeekInputInteraction, true);
      seekInput.addEventListener('click', blockSeekInputInteraction, true);
      seekInput.addEventListener('input', blockSeekInputInteraction, true);
      seekInput.addEventListener('change', blockSeekInputInteraction, true);
      seekInput.classList.remove('ym-sync-listener-slider-disabled');
    }

    seekInput.setAttribute('data-ym-sync-listener-locked-seek', '1');
    seekInput.setAttribute('aria-disabled', 'true');
    seekInput.classList.add('ym-sync-listener-slider-disabled');
    seekInput.style.pointerEvents = 'auto';
    seekInput.style.cursor = 'not-allowed';
    seekInput.disabled = false;
    listenerUiState.seekInput = seekInput;
  };

  const findFullscreenControlsRoot = function findFullscreenControlsRoot() {
    return document.querySelector(
      '[class*="FullscreenPlayerDesktopControls_root"], [class*="ktopControl_root"]',
    ) || document.querySelector('[class*="FullscreenPlayerDesktopControls"]');
  };

  const findFullscreenMediaElement = function findFullscreenMediaElement() {
    return document.querySelector('audio,video');
  };

  const findFullscreenContentRoot = function findFullscreenContentRoot(controlsRoot) {
    const anchor = controlsRoot || findFullscreenControlsRoot();
    if (!anchor) {
      return null;
    }
    return anchor.closest('[class*="ktopContent_root"], [class*="ktopContent__"], [class*="ktopContent_full"]') || anchor.parentElement;
  };

  /** Куда вешать overlay громкости: внутри модалки плеера, иначе окажется под её z-index и фоном. */
  const findListenerVolumeMountRoot = function findListenerVolumeMountRoot(controlsRoot) {
    if (!controlsRoot) {
      return document.body;
    }
    return controlsRoot.closest('[class*="FullscreenPlayerDesktop_modalContent"]')
      || controlsRoot.closest('[class*="ktop_modalContent"]')
      || controlsRoot.closest('[class*="DesktopContent_root"], [class*="ktopContent_root"]')
      || document.body;
  };

  const getLargestTrackImage = function getLargestTrackImage(contentRoot) {
    if (!contentRoot) {
      return null;
    }

    const candidates = Array.from(contentRoot.querySelectorAll('img')).filter((image) => {
      const rect = image.getBoundingClientRect();
      return rect.width >= 90 && rect.height >= 90;
    });
    if (!candidates.length) {
      return null;
    }

    candidates.sort((left, right) => {
      const leftRect = left.getBoundingClientRect();
      const rightRect = right.getBoundingClientRect();
      return rightRect.width * rightRect.height - leftRect.width * leftRect.height;
    });
    return candidates[0];
  };

  const positionVolumeControl = function positionVolumeControl(controlsRoot, controlWrap) {
    if (!controlWrap) {
      return;
    }
    const contentRoot = findFullscreenContentRoot(controlsRoot);
    const coverImage = getLargestTrackImage(contentRoot);
    if (!coverImage) {
      controlWrap.style.top = '14px';
      controlWrap.style.left = 'unset';
      controlWrap.style.right = '16px';
      return;
    }

    const coverRect = coverImage.getBoundingClientRect();
    const wrapRect = controlWrap.getBoundingClientRect();
    const gap = 12;
    const desiredLeft = Math.round(coverRect.right + gap);
    const maxLeft = Math.max(12, Math.round(window.innerWidth - wrapRect.width - 12));
    const normalizedLeft = Math.min(desiredLeft, maxLeft);
    const desiredTop = Math.round(Math.max(0, coverRect.top + 10));
    controlWrap.style.left = `${normalizedLeft}px`;
    controlWrap.style.top = `${desiredTop}px`;
    controlWrap.style.right = 'unset';
  };

  const setVolumeSliderBackground = function setVolumeSliderBackground(slider) {
    const value = Number(slider.value) || 0;
    slider.style.backgroundSize = `${value}% 100%`;
    slider.style.setProperty('--seek-before-width', `${value}%`);
  };

  const ensureVolumeControl = function ensureVolumeControl(mediaElement, controlsRoot) {
    if (!controlsRoot) {
      return null;
    }

    const mountRoot = findListenerVolumeMountRoot(controlsRoot);
    let overlay = document.querySelector('[data-ym-sync-overlay="1"]');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.setAttribute('data-ym-sync-overlay', '1');
      overlay.className = 'ym-sync-listener-overlay';
      mountRoot.appendChild(overlay);
    } else if (overlay.parentElement !== mountRoot) {
      mountRoot.appendChild(overlay);
    }

    let controlWrap = overlay.querySelector('[data-ym-sync-volume-wrap="1"]');
    if (!controlWrap) {
      controlWrap = document.createElement('div');
      controlWrap.setAttribute('data-ym-sync-volume-wrap', '1');
      controlWrap.className = 'ym-sync-listener-volume-wrap';

      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '0';
      slider.max = '100';
      slider.step = '1';
      slider.className = 'ym-sync-listener-volume-slider';
      slider.setAttribute('aria-label', 'Уровень громкости');
      slider.setAttribute('data-ym-sync-volume-slider', '1');

      slider.addEventListener('input', () => {
        const currentMedia = listenerUiState.mediaElement || mediaElement;
        if (!currentMedia) {
          return;
        }
        const volume = Number(slider.value) / 100;
        if (!Number.isFinite(volume)) {
          return;
        }
        currentMedia.volume = volume;
        currentMedia.muted = volume <= 0;
        setVolumeSliderBackground(slider);
      });

      controlWrap.appendChild(slider);
      overlay.appendChild(controlWrap);
      listenerUiState.slider = slider;
    }

    if (!mediaElement) {
      return controlWrap;
    }

    const volumePercent = Math.max(0, Math.min(100, Math.round(mediaElement.volume * 100)));
    if (listenerUiState.slider) {
      listenerUiState.slider.value = String(volumePercent);
      setVolumeSliderBackground(listenerUiState.slider);
    }

    positionVolumeControl(controlsRoot, controlWrap);
    return controlWrap;
  };

  const hideCloseButton = function hideCloseButton(controlsRoot) {
    const closeButton = controlsRoot.querySelector('button[class*="FullscreenPlayerDesktop_closeButton"], button[aria-label="Close"]');
    if (!closeButton || closeButton.getAttribute('data-ym-sync-locked-close') === '1') {
      return;
    }
    closeButton.style.visibility = 'hidden';
    closeButton.style.pointerEvents = 'none';
    closeButton.setAttribute('data-ym-sync-locked-close', '1');
  };

  const restoreCloseButton = function restoreCloseButton(controlsRoot) {
    const closeButton = controlsRoot.querySelector('button[data-ym-sync-locked-close="1"]');
    if (!closeButton) {
      return;
    }
    closeButton.style.visibility = '';
    closeButton.style.pointerEvents = '';
    closeButton.removeAttribute('data-ym-sync-locked-close');
  };

  const removeListenerOverlay = function removeListenerOverlay(controlsRoot) {
    if (!controlsRoot) {
      const overlay = document.querySelector('[data-ym-sync-overlay="1"]');
      if (overlay) {
        overlay.remove();
      }
      listenerUiState.overlay = null;
      listenerUiState.slider = null;
      restoreListenerLockedButtons();
      updateListenerSeekInput(null);
      return;
    }
    const overlay = document.querySelector('[data-ym-sync-overlay="1"]');
    if (overlay) {
      overlay.remove();
    }
    controlsRoot.style.position = '';
    listenerUiState.overlay = null;
    listenerUiState.slider = null;
    restoreListenerLockedButtons();
    updateListenerSeekInput(controlsRoot);
  };

  app.applyListenerUiLock = function applyListenerUiLock() {
    const isLocked = Boolean(app.STATE.roomId) && !app.canControl();
    const controlsRoot = findFullscreenControlsRoot();

    if (!controlsRoot) {
      removeListenerOverlay();
      return;
    }

    if (!isLocked) {
      restoreCloseButton(controlsRoot);
      removeListenerOverlay(controlsRoot);
      restoreListenerLockedButtons();
      updateListenerSeekInput(controlsRoot);
      return;
    }

    controlsRoot.style.position = 'relative';
    const lockedButtons = getListenerLockedButtons(controlsRoot);
    listenerUiState.lockedButtons = lockedButtons;
    for (const button of lockedButtons) {
      setListenerControlLockState(button, true);
    }
    updateListenerSeekInput(controlsRoot);

    const mediaElement = findFullscreenMediaElement();
    ensureVolumeControl(mediaElement, controlsRoot);
    hideCloseButton(controlsRoot);
    listenerUiState.mediaElement = mediaElement;
    listenerUiState.overlay = document.querySelector('[data-ym-sync-overlay="1"]');
  };

  app.startListenerUiWatcher = function startListenerUiWatcher() {
    if (app.STATE.__listenerUiWatcherStarted) {
      return;
    }

    app.STATE.__listenerUiWatcherStarted = true;
    app.STATE.__listenerUiTimer = window.setInterval(() => {
      app.applyListenerUiLock();
    }, 700);
    app.applyListenerUiLock();
  };

  app.getPlayerBar = function getPlayerBar() {
    return document.querySelector('section[class*="PlayerBar_root"]')
      || document.querySelector('section[class*="PlayerBar"]')
      || document.querySelector('[data-testid="player-bar"]');
  };

  app.findPlayerSeekRange = function findPlayerSeekRange() {
    const scored = getMainSeekRangeInput();
    if (scored) {
      return scored;
    }
    const byBarSelector = document.querySelector(LISTENER_PLAYER_BAR_SELECTORS.SEEK_INPUT);
    if (byBarSelector && byBarSelector.tagName === 'INPUT' && String(byBarSelector.type || '').toLowerCase() === 'range') {
      return byBarSelector;
    }
    const root = app.getPlayerBar();
    if (root) {
      const fromBar = root.querySelector('input[type="range"][aria-label="Manage time code"]')
        || root.querySelector('input[type="range"][class*="ChangeTimecodeBackground_slider"]')
        || root.querySelector('input[type="range"][class*="ChangeTimecodeBackground"]');
      if (fromBar) {
        return fromBar;
      }
    }
    return document.querySelector('input[type="range"][aria-label="Manage time code"]')
      || document.querySelector('input[type="range"][class*="ChangeTimecodeBackground_slider"]')
      || document.querySelector('input[type="range"][class*="ChangeTimecodeBackground"]')
      || document.querySelector('input[type="range"][aria-label*="time code" i]');
  };

  app.getTrackElements = function getTrackElements() {
    const root = app.getPlayerBar();
    if (!root) {
      return { title: '', artists: [], durationSec: 0 };
    }

    const titleElement = root.querySelector('[class*="Meta_title"]')
      || document.querySelector('[class*="Meta_title"]');
    const artistNodes = root.querySelectorAll(
      '[class*="Meta_artistCaption"], [class*="Meta_artist"]',
    );

    const title = titleElement ? titleElement.textContent.trim() : '';
    const artists = Array.from(artistNodes)
      .map((node) => node.textContent.trim())
      .filter(Boolean)
      .filter((value, idx, all) => all.indexOf(value) === idx);

    const progressInput = app.findPlayerSeekRange();
    const durationSec = progressInput ? Number(progressInput.getAttribute('max')) || 0 : 0;
    const valueSec = progressInput ? Number(progressInput.value) || 0 : 0;

    return {
      title,
      artists,
      durationSec,
      elapsedSec: valueSec,
      progressInput,
    };
  };

  const resolvePlaybackStateFromHref = function resolvePlaybackStateFromHref(iconHref) {
    const href = String(iconHref || '').toLowerCase();
    if (href.includes('pause_filled_l')) {
      return true;
    }
    if (href.includes('play_filled_l')) {
      return false;
    }
    return undefined;
  };

  const getPlaybackIconState = function getPlaybackIconState(button) {
    if (!button || typeof button.querySelector !== 'function') {
      return undefined;
    }

    const iconUse = button.querySelector('svg use[href], svg use[xlink\\:href], use[href], use[xlink\\:href]');
    if (!iconUse) {
      return undefined;
    }

    return resolvePlaybackStateFromHref(
      iconUse.getAttribute('href') || iconUse.getAttribute('xlink:href') || '',
    );
  };

  const getPlaybackFromIcons = function getPlaybackFromIcons(root) {
    const scope = root || document;
    const buttons = Array.from(scope.querySelectorAll('button'));
    for (const button of buttons) {
      const iconState = getPlaybackIconState(button);
      if (typeof iconState === 'boolean') {
        return { isPlaying: iconState, control: button };
      }
    }

    const iconUses = Array.from(scope.querySelectorAll('svg use, use'));
    for (const iconUse of iconUses) {
      const iconState = resolvePlaybackStateFromHref(
        iconUse.getAttribute('href') || iconUse.getAttribute('xlink:href') || '',
      );
      if (typeof iconState !== 'boolean') {
        continue;
      }

      const control = iconUse.closest('button');
      if (control && (!root || root.contains(control))) {
        return { isPlaying: iconState, control };
      }
    }
    return undefined;
  };

  app.getPlayingState = function getPlayingState() {
    const root = app.getPlayerBar();
    if (!root) {
      return getPlaybackFromIcons() || { isPlaying: undefined };
    }

    const playbackFromIcons = getPlaybackFromIcons(root);
    if (playbackFromIcons) {
      return playbackFromIcons;
    }

    const pauseButton = root.querySelector('button[aria-label*="pause" i], button[aria-label*="пауза" i]');
    const playButton = root.querySelector('button[aria-label*="play" i], button[aria-label*="воспроизвести" i]');
    if (pauseButton) {
      return { isPlaying: true, control: pauseButton };
    }
    if (playButton) {
      return { isPlaying: false, control: playButton };
    }
    return { isPlaying: undefined };
  };

  app.readCurrentHostTrackState = function readCurrentHostTrackState() {
    const track = app.getTrackElements();
    const playback = app.getPlayingState();
    const mediaElement = document.querySelector('audio, video');
    const mediaState = mediaElement ? !mediaElement.paused : undefined;
    const mediaPosition = mediaElement && Number.isFinite(mediaElement.currentTime) ? mediaElement.currentTime : null;
    return {
      title: track.title,
      artists: track.artists,
      durationSec: track.durationSec,
      positionSec: mediaPosition !== null ? mediaPosition : track.elapsedSec,
      isPlaying: typeof mediaState === 'boolean'
        ? mediaState
        : (playback.isPlaying === true || playback.isPlaying === false ? playback.isPlaying : false),
      timestamp: Date.now(),
    };
  };

  app.broadcastHostTrackState = function broadcastHostTrackState(state) {
    if (!app.canControl() || !app.STATE.isConnectedToBackend) {
      return;
    }
    const payload = {
      title: state.title,
      artists: state.artists,
      durationSec: state.durationSec,
    };
    app.sendHostTrackUpdate(payload, state);
  };

  app.broadcastHostPlaybackState = function broadcastHostPlaybackState(state) {
    if (!app.canControl() || !app.STATE.isConnectedToBackend) {
      return;
    }
    app.sendHostPlaybackUpdate(state);
  };

  const scheduleHostSync = function scheduleHostSync(delayMs = HOST_ACTION_SYNC_DEBOUNCE_MS) {
    if (!app.isHost()) {
      return;
    }

    if (hostState.hostSyncDebounceTimer) {
      window.clearTimeout(hostState.hostSyncDebounceTimer);
      hostState.hostSyncDebounceTimer = null;
    }

    hostState.hostSyncDebounceTimer = window.setTimeout(() => {
      hostState.hostSyncDebounceTimer = null;
      app.syncHostPlayback({ force: true });
    }, delayMs);
  };

  const onHostMediaPlaybackEvent = function onHostMediaPlaybackEvent() {
    scheduleHostSync();
  };

  const detachHostMediaSyncListeners = function detachHostMediaSyncListeners(mediaElement) {
    if (!mediaElement) {
      return;
    }
    for (const eventName of HOST_MEDIA_SYNC_EVENTS) {
      mediaElement.removeEventListener(eventName, onHostMediaPlaybackEvent, true);
    }
  };

  const bindHostMediaSyncListeners = function bindHostMediaSyncListeners() {
    if (!app.isHost()) {
      if (hostState.hostMediaElement) {
        detachHostMediaSyncListeners(hostState.hostMediaElement);
        hostState.hostMediaElement = null;
      }
      return;
    }

    const mediaElement = document.querySelector('audio, video');
    if (!mediaElement) {
      return;
    }
    if (hostState.hostMediaElement === mediaElement) {
      return;
    }
    if (hostState.hostMediaElement) {
      detachHostMediaSyncListeners(hostState.hostMediaElement);
    }
    for (const eventName of HOST_MEDIA_SYNC_EVENTS) {
      mediaElement.addEventListener(eventName, onHostMediaPlaybackEvent, true);
    }
    hostState.hostMediaElement = mediaElement;
  };

  app.syncHostPlayback = function syncHostPlayback(options = {}) {
    const force = Boolean(options.force);
    const now = Date.now();
    if (!force && now - hostState.lastPlaybackReadAt < 250) {
      return;
    }
    hostState.lastPlaybackReadAt = now;

    const currentState = app.readCurrentHostTrackState();
    if (!currentState.title && !currentState.artists.length) {
      return;
    }

    const fingerprint = app.buildTrackFingerprint(currentState);
    const trackChanged = fingerprint !== hostState.lastTrackFingerprint;
    const positionChanged = Math.abs(currentState.positionSec - (app.__lastSentPositionSec || 0)) >= 1;
    const stateNow = currentState.isPlaying;

    if (trackChanged) {
      hostState.lastTrackFingerprint = fingerprint;
      hostState.lastTrackMetaVersion += 1;
      app.broadcastHostTrackState({
        title: currentState.title,
        artists: currentState.artists,
        durationSec: currentState.durationSec,
      });
      app.__lastSentPositionSec = currentState.positionSec;
      app.broadcastHostPlaybackState({
        isPlaying: Boolean(stateNow),
        positionSec: currentState.positionSec,
        durationSec: currentState.durationSec,
        positionAtServerMs: Date.now(),
        stateVersion: ++hostState.lastTrackMetaVersion,
      });
      return;
    }

    if (force || positionChanged || now - hostState.lastTrackUpdateAt > SYNC_INTERVAL_MS) {
      hostState.lastTrackUpdateAt = now;
      app.__lastSentPositionSec = currentState.positionSec;
      app.broadcastHostPlaybackState({
        isPlaying: Boolean(stateNow),
        positionSec: currentState.positionSec,
        durationSec: currentState.durationSec,
        positionAtServerMs: Date.now(),
      });
    }
  };

  app.startHostSyncLoop = function startHostSyncLoop() {
    if (hostState.syncTimer) {
      bindHostMediaSyncListeners();
      bindHostControlSyncInterceptors();
      return;
    }

    hostState.syncTimer = window.setInterval(() => {
      bindHostMediaSyncListeners();
      bindHostControlSyncInterceptors();
      if (!app.isHost()) {
        return;
      }
      app.syncHostPlayback();
    }, SYNC_INTERVAL_MS);

    bindHostMediaSyncListeners();
    app.syncHostPlayback({ force: true });
  };

  app.stopHostSyncLoop = function stopHostSyncLoop() {
    if (!hostState.syncTimer) {
      return;
    }
    clearInterval(hostState.syncTimer);
    hostState.syncTimer = null;
    if (hostState.hostMediaElement) {
      detachHostMediaSyncListeners(hostState.hostMediaElement);
      hostState.hostMediaElement = null;
    }
    if (hostState.hostSyncDebounceTimer) {
      window.clearTimeout(hostState.hostSyncDebounceTimer);
      hostState.hostSyncDebounceTimer = null;
    }
    if (hostState.hostControlInterceptBound && hostState.hostControlContainer) {
      hostState.hostControlContainer.removeEventListener('click', app.onHostPlayerControlSync, true);
      hostState.hostControlContainer.removeEventListener('input', app.onHostPlayerControlSync, true);
      hostState.hostControlContainer.removeEventListener('change', app.onHostPlayerControlSync, true);
      hostState.hostControlContainer = null;
      hostState.hostControlInterceptBound = false;
    }
  };

  app.waitFor = function waitFor(getter, timeoutMs = 2500, stepMs = 100) {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const tick = () => {
        const value = getter();
        if (value) {
          resolve(value);
          return;
        }
        if (Date.now() - startedAt >= timeoutMs) {
          resolve(null);
          return;
        }
        window.setTimeout(tick, stepMs);
      };
      tick();
    });
  };

  app.sleep = function sleep(ms) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, ms);
    });
  };

  app.queryXPathFirst = function queryXPathFirst(expression) {
    try {
      const result = document.evaluate(
        expression,
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null,
      );
      const node = result.singleNodeValue;
      if (node && node.nodeType === Node.ELEMENT_NODE) {
        return node;
      }
      return null;
    } catch (_error) {
      return null;
    }
  };

  const setNativeInputValue = function setNativeInputValue(input, nextValue) {
    if (input instanceof HTMLTextAreaElement) {
      const proto = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
      if (proto && proto.set) {
        proto.set.call(input, nextValue);
        return;
      }
    } else if (input instanceof HTMLInputElement) {
      const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      if (proto && proto.set) {
        proto.set.call(input, nextValue);
        return;
      }
    }
    input.value = nextValue;
  };

  const dispatchSeekPointerSequence = function dispatchSeekPointerSequence(input, clientX, clientY) {
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
      if (typeof PointerEvent === 'function') {
        input.dispatchEvent(
          new PointerEvent('pointerdown', {
            ...common,
            pointerId: 1,
            pointerType: 'mouse',
            isPrimary: true,
          }),
        );
        input.dispatchEvent(
          new PointerEvent('pointerup', {
            ...common,
            pointerId: 1,
            pointerType: 'mouse',
            isPrimary: true,
            buttons: 0,
          }),
        );
      }
    } catch (_e) {
      // noop
    }
    input.dispatchEvent(new MouseEvent('mousedown', common));
    input.dispatchEvent(new MouseEvent('mouseup', { ...common, buttons: 0 }));
    input.dispatchEvent(new MouseEvent('click', { ...common, buttons: 0 }));
  };

  const seekSliderByRatio = function seekSliderByRatio(input, ratio, durationMs) {
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
        input.setAttribute('value', String(ms));
      } catch (_e2) {
        // noop
      }
    }
    return true;
  };

  const applySeekMsToSlider = function applySeekMsToSlider(input, positionMs, durationMs) {
    if (!input || !durationMs || durationMs < 500) {
      return false;
    }
    const dur = Math.round(durationMs);
    const pos = Math.max(0, Math.min(Math.round(positionMs), dur));
    const maxDom = Number(input.max);
    const scale = Number.isFinite(maxDom) && maxDom > 0
      ? inferSeekSliderScale(maxDom, dur)
      : inferSeekSliderScale(Math.round(dur / 1000), dur);

    let maxAttr;
    let valueStr;
    if (scale === 'sec') {
      const durSec = Math.max(1, Math.round(dur / 1000));
      const posSec = Math.max(0, Math.min(Math.round(pos / 1000), durSec));
      maxAttr = String(durSec);
      valueStr = String(posSec);
    } else {
      maxAttr = String(dur);
      valueStr = String(pos);
    }

    if (input.getAttribute('max') !== maxAttr) {
      try {
        input.setAttribute('max', maxAttr);
      } catch (_e) {
        // noop
      }
    }
    try {
      input.max = maxAttr;
    } catch (_e2) {
      // noop
    }
    setNativeInputValue(input, valueStr);
    try {
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (_e3) {
      // noop
    }
    const after = readLocalSeekMs(input, dur);
    if (Math.abs(after - pos) > 1200) {
      seekSliderByRatio(input, pos / dur, dur);
    }
    return true;
  };

  const tryApplyRemoteSeekViaDom = function tryApplyRemoteSeekViaDom() {
    try {
      const self = typeof app.getSelfParticipant === 'function' ? app.getSelfParticipant() : null;
      if (!self || self.role === 'host') {
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
      const minDrift = Number(app.constants.REMOTE_SEEK_MIN_DRIFT_MS) || SEEK_APPLY_MIN_DRIFT_MS;
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

  let _listenerYmSeekTimer = 0;
  app.setRemoteYmPlayerState = function setRemoteYmPlayerState(playerState, at = Date.now()) {
    if (!playerState || typeof playerState !== 'object') {
      return;
    }
    app.STATE.ym.remotePlayerState = playerState;
    app.STATE.ym.remotePlayerStateAt = Number(at || Date.now());
    app.STATE.ym.remotePlayerStateReceivedAt = Date.now();

    if (_listenerYmSeekTimer) {
      window.clearTimeout(_listenerYmSeekTimer);
      _listenerYmSeekTimer = 0;
    }
    _listenerYmSeekTimer = window.setTimeout(() => {
      _listenerYmSeekTimer = 0;
      window.requestAnimationFrame(() => {
        tryApplyRemoteSeekViaDom();
      });
    }, 200);
  };

  const findListenerSearchInput = function findListenerSearchInput() {
    const bySearchContainer = document.querySelector(
      '[role="search"] input[type="search"], [role="search"] input[type="text"], [role="search"] textarea',
    );
    if (bySearchContainer && bySearchContainer.type !== 'hidden') {
      return bySearchContainer;
    }

    const bySearchForm = document.querySelector(
      'form[action*="/search"] input[type="search"], form[action*="/search"] input[type="text"], form[action*="/search"] textarea',
    );
    if (bySearchForm && bySearchForm.type !== 'hidden') {
      return bySearchForm;
    }

    const byPlaceholderOrAria = document.querySelector(
      'input[placeholder*="поиск" i], input[aria-label*="поиск" i], input[placeholder*="search" i], input[aria-label*="search" i]',
    );
    if (byPlaceholderOrAria && byPlaceholderOrAria.type !== 'hidden') {
      return byPlaceholderOrAria;
    }

    return document.querySelector(
      'input[type="search"], input[placeholder], input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea',
    );
  };

  const findSearchPageLink = function findSearchPageLink() {
    const candidates = Array.from(
      document.querySelectorAll(LISTENER_SEARCH_UI_SELECTORS.SIDEBAR_SEARCH_LINK_SELECTOR),
    );
    const links = candidates.length > 0
      ? candidates
      : Array.from(document.querySelectorAll('a[href]'));
    const byPath = links.find((link) => {
      const rawHref = link.getAttribute('href');
      if (!rawHref) {
        return false;
      }
      try {
        const path = new URL(rawHref, window.location.origin).pathname;
        return path === '/search' || path === '/search/' || path.startsWith('/search/');
      } catch (_err) {
        return false;
      }
    });
    if (byPath) {
      return byPath;
    }
    return links.find((link) => /поиск|search/i.test(link.textContent || ''));
  };

  app.resetListenerTrackAutomation = function resetListenerTrackAutomation() {
    hostState.listenerSearchNavCompleted = false;
    hostState.lastRemoteTrackFingerprint = '';
    if (hostState.remoteApplyTimer) {
      window.clearTimeout(hostState.remoteApplyTimer);
      hostState.remoteApplyTimer = null;
    }
  };

  app.ensureSearchPage = async function ensureSearchPage() {
    const hasSearchInput = () => findListenerSearchInput();

    if (hostState.listenerSearchNavCompleted) {
      await app.waitFor(hasSearchInput, 5000, 120);
      return;
    }

    if (!window.location.pathname.includes('/search')) {
      const link = findSearchPageLink();
      if (link && typeof link.click === 'function') {
        link.click();
        await app.waitFor(
          () => window.location.pathname.includes('/search') || Boolean(hasSearchInput()),
          5000,
          120,
        );
      } else {
        window.location.href = `${window.location.origin}/search`;
        await app.sleep(500);
      }
    }

    await app.waitFor(hasSearchInput, 5000, 120);
    hostState.listenerSearchNavCompleted = true;
  };

  app.fillSearchInput = async function fillSearchInput(value) {
    const queryInput = await app.waitFor(() => findListenerSearchInput(), 5000, 120);
    if (!queryInput) {
      return;
    }

    queryInput.focus();
    setNativeInputValue(queryInput, '');
    queryInput.dispatchEvent(new Event('input', { bubbles: true }));
    setNativeInputValue(queryInput, value);
    queryInput.dispatchEvent(new Event('input', { bubbles: true }));
    queryInput.dispatchEvent(new Event('change', { bubbles: true }));
    queryInput.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      bubbles: true,
    }));
    queryInput.dispatchEvent(new KeyboardEvent('keyup', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      bubbles: true,
    }));
  };

  const searchLog = function searchLog(...args) {
    if (typeof console !== 'undefined' && console && typeof console.log === 'function') {
      console.log('[ymSync][search]', ...args);
    }
  };

  const initLog = function initLog(...args) {
    if (typeof console !== 'undefined' && console && typeof console.log === 'function') {
      console.log('[ymSync][init]', ...args);
    }
  };

  const isPlayActionLabel = function isPlayActionLabel(label) {
    if (!label) {
      return false;
    }
    return /(?:^|\b)(play|воспроизв\w*)/i.test(label) && !/\bpause\b|пауза/i.test(label);
  };

  const getSearchResultsContainer = function getSearchResultsContainer() {
    const searchInput = findListenerSearchInput();
    if (searchInput) {
      const byInputScope = searchInput.closest('[class*="SearchPage"]')
        || searchInput.closest('main')
        || searchInput.closest('section')
        || searchInput.closest('form');
      if (byInputScope) {
        return byInputScope;
      }
    }
    return document.querySelector('[class*="SearchPage"]')
      || document.querySelector('[role="search"]')
      || document.querySelector('main')
      || document.body;
  };

  const getFirstCandidatePlayButton = function getFirstCandidatePlayButton(buttons) {
    if (!buttons || buttons.length === 0) {
      return null;
    }
    const playable = buttons.find((button) => isPlayActionLabel(button.getAttribute('aria-label') || ''));
    return playable || buttons[0];
  };

  const findPlayButtonInSearchResults = function findPlayButtonInSearchResults() {
    const scope = getSearchResultsContainer();
    const selectors = [
      'button[class*="PlayButtonWithCover_"]',
      '[aria-label*="play" i][class*="playButton"]',
      'button[data-testid*="play"]',
    ];
    const all = [];
    for (let i = 0; i < selectors.length; i += 1) {
      const nodes = Array.from(scope.querySelectorAll(selectors[i]));
      for (let j = 0; j < nodes.length; j += 1) {
        const node = nodes[j];
        if (node && node.tagName === 'BUTTON' && !node.closest('aside')) {
          all.push(node);
        }
      }
    }
    const uniqueButtons = Array.from(new Set(all));
    if (uniqueButtons.length === 0) {
      return null;
    }
    const firstInScope = uniqueButtons[0];
    searchLog('findPlayButtonInSearchResults: raw candidates', uniqueButtons.length, firstInScope.className?.slice(0, 120));
    return getFirstCandidatePlayButton(uniqueButtons);
  };

  const logSearchCandidates = function logSearchCandidates(sourceName, buttons) {
    if (!buttons || buttons.length === 0) {
      searchLog(sourceName, 'no candidates');
      return;
    }
    searchLog(sourceName, 'candidates', buttons.length, buttons.map((button) => button.className?.slice(0, 120)));
  };

  const lastClickContext = {
    button: null,
    at: 0,
  };

  const describeNodeForLog = function describeNodeForLog(node) {
    if (!node) {
      return null;
    }
    const item = {
      tag: node.tagName || '(no-tag)',
      id: node.id || '',
      className: (node.className || '').toString().slice(0, 180),
      text: (node.textContent || '').trim().slice(0, 120),
      href: node.href || '',
    };
    if (node instanceof HTMLInputElement) {
      item.type = node.type || '';
      item.placeholder = node.placeholder || '';
      item.name = node.name || '';
      item.ariaLabel = node.getAttribute('aria-label') || '';
      item.value = node.value || '';
    }
    return item;
  };

  const logInitializationObjects = function logInitializationObjects() {
    const candidates = {
      searchLinks: Array.from(document.querySelectorAll(LISTENER_SEARCH_UI_SELECTORS.SIDEBAR_SEARCH_LINK_SELECTOR)),
      playButtons: Array.from(document.querySelectorAll('button[class*="PlayButtonWithCover_"]')),
      seekInputs: Array.from(document.querySelectorAll('input[type="range"]')),
    };

    const resolved = {
      searchLink: findSearchPageLink(),
      searchInput: findListenerSearchInput(),
      playerBar: app.getPlayerBar(),
      seekRange: app.findPlayerSeekRange(),
      searchPlayButton: app.findSearchPlayButton(),
      fullscreenControlsRoot: findFullscreenControlsRoot(),
      fullscreenMedia: findFullscreenMediaElement(),
    };

    initLog('initialization found objects');
    initLog('search links candidates', candidates.searchLinks.length, candidates.searchLinks.map(describeNodeForLog));
    initLog('play button candidates', candidates.playButtons.length, candidates.playButtons.map(describeNodeForLog));
    initLog('seek range candidates', candidates.seekInputs.length);
    initLog('resolved searchLink', describeNodeForLog(resolved.searchLink));
    initLog('resolved searchInput', describeNodeForLog(resolved.searchInput));
    initLog('resolved playerBar', describeNodeForLog(resolved.playerBar));
    initLog('resolved seekRange', describeNodeForLog(resolved.seekRange));
    initLog('resolved searchPlayButton', describeNodeForLog(resolved.searchPlayButton));
    initLog('resolved fullscreenControlsRoot', describeNodeForLog(resolved.fullscreenControlsRoot));
    initLog('resolved fullscreenMedia', describeNodeForLog(resolved.fullscreenMedia));
  };

  const findPlayButtonByClassPrefix = function findPlayButtonByClassPrefix() {
    const buttons = document.querySelectorAll('button[class*="PlayButtonWithCover_"]');
    if (buttons.length > 0) {
      const arr = Array.from(buttons);
      logSearchCandidates('findPlayButtonByClassPrefix', arr);
      return getFirstCandidatePlayButton(arr);
    }
    searchLog('findPlayButtonByClassPrefix: none');
    return null;
  };

  app.findSearchPlayButton = function findSearchPlayButton() {
    const bySearchResults = findPlayButtonInSearchResults();
    if (bySearchResults) {
      searchLog('findSearchPlayButton: selected inside search results');
      return bySearchResults;
    }

    const byCover = findPlayButtonByClassPrefix();
    if (byCover) {
      searchLog('findSearchPlayButton: selected by PlayButtonWithCover_');
      return byCover;
    }

    const byAria = document.querySelector('[aria-label*="play" i][class*="playButton"]');
    if (byAria) {
      searchLog('findSearchPlayButton: selected by aria-label+playButton');
      return byAria;
    }

    const byTestId = document.querySelector('button[data-testid*="play"]');
    if (byTestId) {
      searchLog('findSearchPlayButton: selected by data-testid');
      return byTestId;
    }

    searchLog('findSearchPlayButton: no candidate');
    return null;
  };

  const simulatePointerHover = function simulatePointerHover(target) {
    if (!target || typeof target.getBoundingClientRect !== 'function') {
      return;
    }
    const rect = target.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const common = {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      view: window,
    };

    target.dispatchEvent(new MouseEvent('mousemove', common));
    target.dispatchEvent(new MouseEvent('mouseover', common));
    try {
      target.dispatchEvent(new MouseEvent('mouseenter', { ...common, bubbles: false }));
    } catch (_e) {
      // ignore
    }
    if (typeof PointerEvent === 'function') {
      try {
        const pointerOpts = {
          ...common,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
        };
        target.dispatchEvent(new PointerEvent('pointerover', pointerOpts));
        target.dispatchEvent(new PointerEvent('pointermove', pointerOpts));
      } catch (_e2) {
        // ignore
      }
    }
  };

  const hoverFirstSearchResultRow = function hoverFirstSearchResultRow() {
    searchLog('hoverFirstSearchResultRow: start');
    let node = app.findSearchPlayButton();
    if (!node) {
      searchLog('hoverFirstSearchResultRow: fallback by SearchPage track selector');
      node = document.querySelector('[class*="SearchPage"] [class*="track"]')
        || document.querySelector('[class*="SearchPage"] li[class*="item"]');
      if (!node) {
        searchLog('hoverFirstSearchResultRow: no track fallback found');
      } else {
        searchLog('hoverFirstSearchResultRow: fallback node', node.tagName, node.className?.slice(0, 120));
      }
    } else {
      searchLog('hoverFirstSearchResultRow: primary node', node.tagName, node.className?.slice(0, 120));
    }
    if (!node) {
      return;
    }
    let depth = 0;
    while (node && depth < 6) {
      simulatePointerHover(node);
      if (depth === 0) {
        searchLog('hoverFirstSearchResultRow: hovering', node.tagName, node.className?.slice(0, 120));
      }
      node = node.parentElement;
      depth += 1;
    }
  };

  app.clickFirstResult = async function clickFirstResult() {
    searchLog('clickFirstResult: start');
    await app.sleep(750);
    hoverFirstSearchResultRow();
    await app.sleep(150);

    const resolvePlayButton = () => {
      const btn = app.findSearchPlayButton();
      if (!btn) {
        searchLog('resolvePlayButton: no button found by findSearchPlayButton');
      } else {
        searchLog(
          'resolvePlayButton: candidate',
          btn.tagName,
          btn.className?.slice(0, 120),
          'aria-label=',
          btn.getAttribute('aria-label'),
        );
      }
      return btn && btn.tagName === 'BUTTON' ? btn : null;
    };

    let button = resolvePlayButton();
    searchLog('clickFirstResult: attempt#1', button ? 'ok' : 'empty');
    if (!button) {
      hoverFirstSearchResultRow();
      await app.sleep(120);
      button = resolvePlayButton();
      searchLog('clickFirstResult: attempt#2', button ? 'ok' : 'empty');
    }
    if (!button) {
      button = await app.waitFor(resolvePlayButton, 2500, 120);
      searchLog('clickFirstResult: attempt#3(waitFor)', button ? 'ok' : 'empty');
    }
    if (!button) {
      hoverFirstSearchResultRow();
      await app.sleep(180);
      button = resolvePlayButton();
      searchLog('clickFirstResult: attempt#4', button ? 'ok' : 'empty');
    }
    if (!button) {
      searchLog('clickFirstResult: failed, no button found');
      return false;
    }

    simulatePointerHover(button);
    await app.sleep(60);
    button.focus();
    if (lastClickContext.button === button && Date.now() - lastClickContext.at < 1800) {
      searchLog('clickFirstResult: duplicate click blocked to avoid immediate re-toggle');
      return false;
    }
    searchLog(
      'clickFirstResult: clicking',
      button.className?.slice(0, 120),
      'aria-label=',
      button.getAttribute('aria-label'),
    );
    lastClickContext.button = button;
    lastClickContext.at = Date.now();
    button.click();
    searchLog('clickFirstResult: clicked');
    return true;
  };

  app.setProgressInput = function setProgressInput(seconds, options = {}) {
    const seekInput = app.findPlayerSeekRange();
    if (!seekInput || !Number.isFinite(Number(seconds))) {
      return false;
    }
    const sec = Math.max(0, Number(seconds));
    const media = document.querySelector('audio, video');
    const force = Boolean(options.force);

    const durationMs = pickSeekDurationMs(seekInput);
    if (!durationMs || durationMs < 500) {
      if (media) {
        try {
          media.currentTime = sec;
        } catch (_e) {
          return false;
        }
        return true;
      }
      return false;
    }

    const positionMs = Math.round(sec * 1000);
    const localMs = readLocalSeekMs(seekInput, durationMs);
    const minSeekMs = force ? 0 : (Number(app.constants.REMOTE_SEEK_MIN_DRIFT_MS) || SEEK_APPLY_MIN_DRIFT_MS);
    if (Math.abs(localMs - positionMs) < minSeekMs) {
      return true;
    }

    applySeekMsToSlider(seekInput, positionMs, durationMs);

    if (media && Number.isFinite(media.duration) && media.duration > 0) {
      const t = Math.max(0, Math.min(media.duration, sec));
      try {
        if (Math.abs((media.currentTime || 0) - t) > 0.4) {
          media.currentTime = t;
        }
      } catch (_e2) {
        // ignore
      }
    }
    return true;
  };

  app.getToggleButton = function getToggleButton() {
    const root = app.getPlayerBar();
    if (!root) {
      return null;
    }

    const playbackFromIcons = getPlaybackFromIcons(root);
    if (playbackFromIcons) {
      return playbackFromIcons.control;
    }

    return (
      root.querySelector('button[aria-label*="pause" i], button[aria-label*="пауза" i]')
      || root.querySelector('button[aria-label*="play" i], button[aria-label*="воспроизвести" i]')
    );
  };

  app.ensurePlayState = function ensurePlayState(wantPlaying) {
    const current = app.getPlayingState();
    const shouldPlay = Boolean(wantPlaying);
    if (current.isPlaying === undefined || current.isPlaying === shouldPlay) {
      return;
    }

    const control = app.getToggleButton();
    if (!control) {
      return;
    }
    control.click();
  };

  app.applyRemoteState = function applyRemoteState(playback = {}) {
    const position = Number(playback.positionSec);
    const isPlaying = playback.isPlaying;
    if (isPlaying === true || isPlaying === false) {
      app.ensurePlayState(isPlaying);
    }
    if (Number.isFinite(position)) {
      const playbackSnapshot = normalizeListenerPlayback(playback);
      const targetPositionSec = computeCatchUpPositionSec(playbackSnapshot);
      const shouldForceSeek = isPlaying === false;
      window.requestAnimationFrame(() => {
        app.setProgressInput(targetPositionSec, { force: shouldForceSeek });
      });
    }
  };

  const normalizeListenerPlayback = function normalizeListenerPlayback(raw) {
    if (!raw || typeof raw !== 'object') {
      return {
        positionSec: NaN,
        durationSec: NaN,
        isPlaying: undefined,
        positionAtServerMs: NaN,
      };
    }
    return {
      positionSec: Number(raw.positionSec),
      durationSec: Number(raw.durationSec),
      isPlaying: raw.isPlaying,
      positionAtServerMs: Number(raw.positionAtServerMs),
    };
  };

  const computeCatchUpPositionSec = function computeCatchUpPositionSec(pb) {
    const base = Number(pb.positionSec);
    if (!Number.isFinite(base) || base < 0) {
      return 0;
    }
    const atMs = Number(pb.positionAtServerMs);
    const hostPaused = pb.isPlaying === false;
    let driftSec = 0;
    if (!hostPaused && Number.isFinite(atMs) && atMs > 0) {
      driftSec = Math.max(0, (Date.now() - atMs) / 1000);
    }
    const dur = Number(pb.durationSec);
    const total = base + driftSec;
    if (Number.isFinite(dur) && dur > 0) {
      return Math.min(total, dur);
    }
    return total;
  };

  app.syncListenerPlaybackCatchUp = async function syncListenerPlaybackCatchUp(rawPlayback) {
    const playback = normalizeListenerPlayback(rawPlayback);
    const hostWantsPause = playback.isPlaying === false;

    if (!hostWantsPause) {
      app.ensurePlayState(true);
    }

    const media = await app.waitFor(() => {
      const m = document.querySelector('audio, video');
      if (!m) {
        return null;
      }
      const dur = Number(m.duration);
      if (Number.isFinite(dur) && dur > 0) {
        return m;
      }
      if (m.readyState >= 1) {
        return m;
      }
      return null;
    }, 12000, 100);

    if (!hostWantsPause) {
      await app.waitFor(() => {
        const m = document.querySelector('audio, video');
        if (!m) {
          return null;
        }
        if (!m.paused) {
          return m;
        }
        const ui = app.getPlayingState();
        if (ui && ui.isPlaying === true) {
          return m;
        }
        return null;
      }, 8000, 80);
    }

    await app.sleep(160);
    const positionSec = computeCatchUpPositionSec(playback);
    if (Number.isFinite(positionSec) && positionSec >= 0) {
      app.setProgressInput(positionSec, { force: hostWantsPause });
    }

    if (playback.isPlaying === true) {
      app.ensurePlayState(true);
    } else if (playback.isPlaying === false) {
      app.ensurePlayState(false);
    }
  };

  app.handleIncomingTrackInfo = function handleIncomingTrackInfo({ track, playback }) {
    if (app.isHost()) {
      return;
    }
    const fingerprint = app.buildTrackFingerprint(track || {});
    if (!fingerprint || fingerprint === hostState.lastRemoteTrackFingerprint) {
      app.applyRemoteState(playback || {});
      return;
    }

    hostState.lastRemoteTrackFingerprint = fingerprint;
    if (hostState.remoteApplyTimer) {
      clearTimeout(hostState.remoteApplyTimer);
    }

    hostState.remoteApplyTimer = window.setTimeout(() => {
      app.handleIncomingTrack(track, playback).catch(() => {});
    }, 120);
  };

  app.handleIncomingTrack = async function handleIncomingTrack(track, playback) {
    const title = String(track?.title || '').trim();
    const artists = Array.isArray(track?.artists) ? track.artists : [];
    const artistsPart = artists.map((a) => String(a || '').trim()).filter(Boolean).join(' ');
    const query = [title, artistsPart].filter(Boolean).join(' ').trim();
    if (!query) {
      return;
    }

    await app.ensureSearchPage();
    await app.fillSearchInput(query);
    const started = await app.clickFirstResult();
    if (!started) {
      return;
    }
    await app.syncListenerPlaybackCatchUp(playback);
  };

  app.handleIncomingPlaybackState = function handleIncomingPlaybackState(playback = {}) {
    if (app.isHost()) {
      return;
    }
    if (!playback || typeof playback !== 'object') {
      return;
    }
    app.applyRemoteState(playback);
  };

  app.parseActionFromNode = function parseActionFromNode(node) {
    const button = node.closest('button');
    if (!button) {
      return null;
    }
    const label = (
      button.getAttribute('aria-label')
      || button.getAttribute('title')
      || button.textContent
      || ''
    ).toLowerCase();
    if (label.includes('pause') || label.includes('пауза')) {
      return 'pause';
    }
    if (label.includes('play') || label.includes('воспроизвести') || label.includes('старт')) {
      return 'play';
    }
    if (label.includes('next') || label.includes('следующий')) {
      return 'next';
    }
    if (label.includes('previous') || label.includes('предыдущий') || label.includes('назад')) {
      return 'previous';
    }
    return null;
  };

  app.isSeekInput = function isSeekInput(node) {
    return node && node.matches && node.matches('input[type="range"]')
      && (
        node.className.includes('ChangeTimecodeBackground')
        || node.getAttribute('aria-label')?.toLowerCase().includes('time')
      );
  };

  app.sendRemoteSeek = function sendRemoteSeek(position) {
    const now = Date.now();
    if (now - (remoteActionCooldown.seek || 0) < REMOTE_COMMAND_COOLDOWN_MS) {
      return;
    }
    remoteActionCooldown.seek = now;

    app.requestHostAction('seek', {
      positionSec: position,
    });
  };

  app.sendRemotePlayPause = function sendRemotePlayPause(action) {
    const now = Date.now();
    const cooldown = remoteActionCooldown.play ?? 0;
    if (now - cooldown < REMOTE_COMMAND_COOLDOWN_MS) {
      return;
    }
    remoteActionCooldown.play = now;
    app.requestHostAction(action);
  };

  app.sendRemoteTrackNavigation = function sendRemoteTrackNavigation(action) {
    const now = Date.now();
    if (now - (remoteActionCooldown.nav || 0) < REMOTE_COMMAND_COOLDOWN_MS) {
      return;
    }
    remoteActionCooldown.nav = now;
    app.requestHostAction(action);
  };

  app.onLocalPlayerInterceptClick = function onLocalPlayerInterceptClick(event) {
    if (app.isHost()) {
      return;
    }
    if (!app.STATE.roomId || app.STATE.roomState === null) {
      return;
    }
    if (event && event.isTrusted === false) {
      return;
    }
    if (!app.canControl()) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const now = Date.now();
      if (now - (remoteActionCooldown.blockHint || 0) > 2500) {
        remoteActionCooldown.blockHint = now;
        if (typeof app.toast === 'function') {
          app.toast('Вы в режиме наблюдателя, действия недоступны');
        }
      }
      return;
    }

    const action = app.parseActionFromNode(event.target);
    if (!action) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    if (!action) {
      return;
    }

    switch (action) {
      case 'play':
      case 'pause':
        app.sendRemotePlayPause(action);
        break;
      case 'next':
      case 'previous':
        app.sendRemoteTrackNavigation(action);
        break;
      default:
        break;
    }
  };

  app.onLocalPlayerSeek = function onLocalPlayerSeek(event) {
    if (!app.STATE.roomId || app.isHost()) {
      return;
    }
    if (event && event.isTrusted === false) {
      return;
    }
    if (!app.canControl()) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const now = Date.now();
      if (now - (remoteActionCooldown.blockHint || 0) > 2500) {
        remoteActionCooldown.blockHint = now;
        if (typeof app.toast === 'function') {
          app.toast('Вы в режиме наблюдателя, действия недоступны');
        }
      }
      return;
    }
    if (!app.isSeekInput(event.target)) {
      return;
    }

    if (hostState.pendingSeekTimer) {
      clearTimeout(hostState.pendingSeekTimer);
    }
    const seekEl = event.target;
    const durationMs = pickSeekDurationMs(seekEl);
    const positionSec = readLocalSeekMs(seekEl, durationMs) / 1000;
    hostState.pendingSeekTimer = window.setTimeout(() => {
      app.sendRemoteSeek(positionSec);
    }, SEEK_COOLDOWN_MS);
  };

  app.onHostPlayerControlSync = function onHostPlayerControlSync(event) {
    if (!app.isHost() || !app.STATE.roomId || app.STATE.roomState === null) {
      return;
    }
    if (event && event.isTrusted === false) {
      return;
    }

    const target = event.target;
    if (!target) {
      return;
    }

    const action = app.parseActionFromNode(target);
    if (hostState.hostSyncDebounceTimer) {
      window.clearTimeout(hostState.hostSyncDebounceTimer);
      hostState.hostSyncDebounceTimer = null;
    }

    const isSeekInteraction = (event.type === 'input' || event.type === 'change') && app.isSeekInput(target);
    if (event.type === 'click' || isSeekInteraction) {
      hostState.hostSyncDebounceTimer = window.setTimeout(() => {
        hostState.hostSyncDebounceTimer = null;
        app.syncHostPlayback({ force: true });
      }, 0);
    }

    if (action === 'next' || action === 'previous') {
      window.setTimeout(() => {
        app.syncHostPlayback({ force: true });
      }, 350);
    }
  };

  const bindHostControlSyncInterceptors = function bindHostControlSyncInterceptors() {
    if (!app.isHost()) {
      if (hostState.hostControlInterceptBound && hostState.hostControlContainer) {
        hostState.hostControlContainer.removeEventListener('click', app.onHostPlayerControlSync, true);
        hostState.hostControlContainer.removeEventListener('input', app.onHostPlayerControlSync, true);
        hostState.hostControlContainer.removeEventListener('change', app.onHostPlayerControlSync, true);
        hostState.hostControlContainer = null;
        hostState.hostControlInterceptBound = false;
      }
      return;
    }

    const bar = app.getPlayerBar();
    if (!bar) {
      if (hostState.hostControlInterceptBound && hostState.hostControlContainer) {
        hostState.hostControlContainer.removeEventListener('click', app.onHostPlayerControlSync, true);
        hostState.hostControlContainer.removeEventListener('input', app.onHostPlayerControlSync, true);
        hostState.hostControlContainer.removeEventListener('change', app.onHostPlayerControlSync, true);
        hostState.hostControlContainer = null;
        hostState.hostControlInterceptBound = false;
      }
      return;
    }

    if (hostState.hostControlInterceptBound && hostState.hostControlContainer === bar) {
      return;
    }

    if (hostState.hostControlInterceptBound && hostState.hostControlContainer && hostState.hostControlContainer !== bar) {
      hostState.hostControlContainer.removeEventListener('click', app.onHostPlayerControlSync, true);
      hostState.hostControlContainer.removeEventListener('input', app.onHostPlayerControlSync, true);
      hostState.hostControlContainer.removeEventListener('change', app.onHostPlayerControlSync, true);
    }

    bar.addEventListener('click', app.onHostPlayerControlSync, true);
    bar.addEventListener('input', app.onHostPlayerControlSync, true);
    bar.addEventListener('change', app.onHostPlayerControlSync, true);
    hostState.hostControlInterceptBound = true;
    hostState.hostControlContainer = bar;
  };

  app.ensureLocalInterceptors = function ensureLocalInterceptors() {
    const bar = app.getPlayerBar();
    if (!bar || hostState.interceptBound) {
      return;
    }

    bar.addEventListener('click', app.onLocalPlayerInterceptClick, true);
    bar.addEventListener('input', app.onLocalPlayerSeek, true);
    bar.addEventListener('change', app.onLocalPlayerSeek, true);
    hostState.interceptBound = true;
    hostState.controlContainer = bar;
  };

  app.disableLocalInterceptors = function disableLocalInterceptors() {
    if (!hostState.interceptBound || !hostState.controlContainer) {
      return;
    }
    hostState.controlContainer.removeEventListener('click', app.onLocalPlayerInterceptClick, true);
    hostState.controlContainer.removeEventListener('input', app.onLocalPlayerSeek, true);
    hostState.controlContainer.removeEventListener('change', app.onLocalPlayerSeek, true);
    hostState.controlContainer = null;
    hostState.interceptBound = false;
  };

  app.handleIncomingCommandToHost = function handleIncomingCommandToHost(payload = {}) {
    if (!app.isHost()) {
      return;
    }

    const action = payload.action;
    const now = Date.now();
    const cooldown = remoteActionCooldown[`command-${action}`] || 0;
    if (now - cooldown < 350) {
      return;
    }
    remoteActionCooldown[`command-${action}`] = now;

    switch (action) {
      case 'play':
        app.ensurePlayState(true);
        break;
      case 'pause':
        app.ensurePlayState(false);
        break;
      case 'seek': {
        const position = Number(payload.positionSec);
        app.setProgressInput(position);
        break;
      }
      case 'next': {
        const nextBtn = app.getPlayerBar()?.querySelector(
          'button[aria-label*="next" i], button[aria-label*="следующий" i]',
        );
        if (nextBtn) {
          nextBtn.click();
        }
        break;
      }
      case 'previous': {
        const prevBtn = app.getPlayerBar()?.querySelector(
          'button[aria-label*="previous" i], button[aria-label*="предыдущий" i]',
        );
        if (prevBtn) {
          prevBtn.click();
        }
        break;
      }
      case 'closeRoom':
        app.disconnectFromRoom();
        break;
      default:
        break;
    }

    scheduleHostSync(HOST_ACTION_SYNC_DEBOUNCE_MS);
  };

  app.handleIncomingRoomSnapshot = function handleIncomingRoomSnapshot(roomState = {}) {
    if (app.isHost()) {
      app.startHostSyncLoop();
      bindHostControlSyncInterceptors();
      bindHostMediaSyncListeners();
      app.disableLocalInterceptors();
      return;
    }

    app.stopHostSyncLoop();
    if (app.canControl()) {
      app.disableLocalInterceptors();
    } else {
      app.ensureLocalInterceptors();
    }

    if (!app.canControl()) {
      return;
    }

    if (roomState.track) {
      app.applyRemoteState(roomState.playbackState || {});
    }
  };

  app.startupPlayerSync = function startupPlayerSync() {
    app.startHostSyncLoop();
    bindHostControlSyncInterceptors();
    app.handleIncomingRoomSnapshot(app.STATE.roomState || {});
    app.startListenerUiWatcher();

    app.onRoomPermissionsChanged = function onRoomPermissionsChanged() {
      app.handleIncomingRoomSnapshot(app.STATE.roomState || {});
      app.applyListenerUiLock();
    };
  };

  app.startupPlayerSync();
})();
(function ymSyncPlayerSyncModule() {
  const app = window.__ymSync;
  if (!app || (app.modules && app.modules.playerSync)) {
    return;
  }

  app.modules = app.modules || {};
  app.modules.playerSync = true;

  const DRIFT_THRESHOLD_SEC = 0.5;
  const PRESENCE_TTL_MS = 25_000;
  const PRESENCE_INTERVAL_MS = 8_000;
  const LOCAL_BROADCAST_THROTTLE_MS = 700;
  const COMMAND_TTL_MS = 20_000;
  const CHANNEL_PREFIX = 'ym-sync-room:';

  let mediaElement = null;
  let mediaObserver = null;
  let mediaWatchTimer = null;
  let presenceTimer = null;
  let channel = null;
  let lastBroadcastAt = 0;
  let currentlyApplying = false;

  const makeCommandId = function makeCommandId() {
    return `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  };

  const parseNum = function parseNum(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) {
      return 0;
    }
    return num;
  };

  const getChannelName = function getChannelName(roomId) {
    return `${CHANNEL_PREFIX}${roomId}`;
  };

  const getCurrentTrackIdFromLocation = function getCurrentTrackIdFromLocation() {
    const path = window.location.pathname || '';
    const query = window.location.search || '';
    const pathMatch = path.match(/track\/(\d+)/i);
    if (pathMatch && pathMatch[1]) {
      return pathMatch[1];
    }

    const queryMatch = query.match(/(?:\?|&)track(?:Id)?=(\d+)/i);
    if (queryMatch && queryMatch[1]) {
      return queryMatch[1];
    }

    const meta = document.querySelector('meta[name="music:track_id"], meta[property="music:track_id"]');
    const content = meta && meta.getAttribute('content');
    if (content) {
      return String(content).trim();
    }

    return '';
  };

  const extractTrackId = function extractTrackId(value) {
    if (!value || typeof value !== 'object') {
      return getCurrentTrackIdFromLocation();
    }
    if (value.trackId) {
      return String(value.trackId);
    }
    if (value.track && value.track.id) {
      return String(value.track.id);
    }
    if (value.id) {
      return String(value.id);
    }
    if (value.url) {
      const fromUrl = String(value.url).match(/(?:track|id)=([0-9]+)/i) || window.location.pathname.match(/track\/(\d+)/i);
      if (fromUrl && fromUrl[1]) {
        return String(fromUrl[1]);
      }
    }
    return getCurrentTrackIdFromLocation();
  };

  const toPlaybackSnapshot = function toPlaybackSnapshot() {
    if (!mediaElement) {
      return null;
    }
    const trackId = extractTrackId({
      trackId: mediaElement.getAttribute?.('data-track-id'),
      url: window.location.href,
    });

    return {
      trackId,
      trackUrl: window.location.href,
      position: parseNum(mediaElement.currentTime),
      duration: parseNum(mediaElement.duration),
      paused: Boolean(mediaElement.paused),
      at: Date.now(),
    };
  };

  const setMediaTrackMeta = function setMediaTrackMeta(snapshot) {
    if (!mediaElement || !snapshot || !snapshot.trackId) {
      return;
    }
    mediaElement.setAttribute('data-ym-sync-track-id', snapshot.trackId);
  };

  const isHost = function isHost() {
    const roomId = app.STATE.roomId;
    if (!roomId) {
      return false;
    }
    const hostId = app.STATE.syncState.hostClientId || app.STATE.clientId;
    return hostId === app.STATE.clientId;
  };

  const prunePeers = function prunePeers() {
    const now = Date.now();
    if (!app.STATE.playerSync || !app.STATE.playerSync.peers) {
      return;
    }
    for (const [clientId, peer] of Object.entries(app.STATE.playerSync.peers)) {
      if (!peer || typeof peer.seenAt !== 'number' || now - peer.seenAt > PRESENCE_TTL_MS) {
        delete app.STATE.playerSync.peers[clientId];
      }
    }
  };

  const recalcHost = function recalcHost() {
    const now = Date.now();
    const candidates = [{ clientId: app.STATE.clientId, seenAt: now }];

    const peers = app.STATE.playerSync && app.STATE.playerSync.peers ? app.STATE.playerSync.peers : {};
    for (const [clientId, peer] of Object.entries(peers)) {
      if (peer && peer.seenAt && now - peer.seenAt <= PRESENCE_TTL_MS) {
        candidates.push({ clientId, seenAt: peer.seenAt });
      }
    }

    candidates.sort((left, right) => {
      if (left.clientId === right.clientId) {
        return right.seenAt - left.seenAt;
      }
      return left.clientId.localeCompare(right.clientId);
    });

    app.STATE.syncState.hostClientId = candidates[0] ? candidates[0].clientId : app.STATE.clientId;
    app.STATE.playerSync.isHost = app.STATE.syncState.hostClientId === app.STATE.clientId;
    app.STATE.syncState.hostUpdatedAt = Date.now();
  };

  const cleanupOldCommands = function cleanupOldCommands() {
    const now = Date.now();
    const pending = app.STATE.syncState.pendingCommandIds;
    for (const [commandId, commandAt] of Object.entries(pending)) {
      if (!commandAt || now - commandAt > COMMAND_TTL_MS) {
        delete pending[commandId];
      }
    }
  };

  const shouldIgnoreCommand = function shouldIgnoreCommand(commandId) {
    if (!commandId) {
      return true;
    }
    const pending = app.STATE.syncState.pendingCommandIds;
    if (pending[commandId]) {
      return true;
    }
    pending[commandId] = Date.now();
    cleanupOldCommands();
    return false;
  };

  const ensureChannel = function ensureChannel() {
    const roomId = app.STATE.roomId;
    const channelName = roomId ? getChannelName(roomId) : '';
    if (!roomId || !channelName) {
      return null;
    }
    if (channel && channel.name === channelName) {
      return channel;
    }
    if (channel) {
      try {
        channel.close();
      } catch (_error) {
        // ignore
      }
    }

    channel = new BroadcastChannel(channelName);
    channel.addEventListener('message', (event) => {
      if (!event || !event.data) {
        return;
      }
      onBroadcastMessage(event.data);
    });
    return channel;
  };

  const broadcastPresence = function broadcastPresence() {
    const syncChannel = ensureChannel();
    if (!syncChannel || !app.STATE.roomId) {
      return;
    }

    const payload = {
      eventType: 'presence',
      from: app.STATE.clientId || '',
      roomId: app.STATE.roomId,
      seenAt: Date.now(),
      media: toPlaybackSnapshot(),
      transportSource: app.STATE.transport.source,
    };
    syncChannel.postMessage(payload);
  };

  const broadcastPlaybackState = function broadcastPlaybackState(playbackState, source) {
    if (!isHost()) {
      return;
    }
    const syncChannel = ensureChannel();
    if (!syncChannel || !app.STATE.roomId || !playbackState) {
      return;
    }

    const command = {
      eventType: 'command',
      commandType: 'playback',
      commandId: makeCommandId(),
      from: app.STATE.clientId,
      roomId: app.STATE.roomId,
      sentAt: Date.now(),
      source: source || 'media',
      playback: playbackState,
    };
    syncChannel.postMessage(command);
  };

  const applyPlaybackSnapshot = function applyPlaybackSnapshot(playbackState, source) {
    if (!playbackState) {
      return;
    }

    const commandId = source?.commandId;
    if (commandId && shouldIgnoreCommand(commandId)) {
      return;
    }

    if (!mediaElement) {
      setMediaTrackMeta(playbackState);
      if (playbackState.trackUrl && playbackState.trackUrl !== window.location.href) {
        app.debugWarn && app.debugWarn('[playerSync] no media element, fallback to URL sync', playbackState.trackUrl);
        window.history.replaceState({}, '', playbackState.trackUrl);
      }
      return;
    }

    if (!currentlyApplying && source && source.eventType === 'command' && source.from !== app.STATE.clientId) {
      currentlyApplying = true;
    }

    const localTrackId = getCurrentTrackIdFromLocation();
    const targetTrackId = String(playbackState.trackId || '').trim();
    const targetUrl = String(playbackState.trackUrl || '').trim();
    if (targetUrl && targetUrl !== window.location.href && targetTrackId && localTrackId && targetTrackId !== localTrackId) {
      window.history.replaceState({}, '', targetUrl);
      setTimeout(() => {
        app.debug && app.debug('[playerSync] navigation to synced track');
      }, 0);
    }

    const targetPosition = parseNum(playbackState.position);
    const currentPosition = parseNum(mediaElement.currentTime);
    if (Math.abs(currentPosition - targetPosition) > DRIFT_THRESHOLD_SEC) {
      mediaElement.currentTime = targetPosition;
    }

    if (typeof playbackState.duration === 'number' && playbackState.duration > 0) {
      app.STATE.playerSync.mediaDuration = playbackState.duration;
    }

    if (typeof playbackState.paused === 'boolean' && mediaElement.paused !== playbackState.paused) {
      if (playbackState.paused) {
        mediaElement.pause();
      } else {
        mediaElement.play().catch(() => {
          // play may fail due to page policy
        });
      }
    }

    app.STATE.playerSync.mediaTrackId = targetTrackId || localTrackId;
    app.STATE.playerSync.mediaPosition = targetPosition;
    app.STATE.playerSync.mediaPaused = Boolean(playbackState.paused);
    app.updateTransportHealth({
      status: 'connected',
      source: source?.transportSource || 'broadcast',
      lastEventAt: Date.now(),
      lastTrackId: targetTrackId,
    });

    window.setTimeout(() => {
      currentlyApplying = false;
    }, 1200);
  };

  const onBroadcastMessage = function onBroadcastMessage(data) {
    if (!data || typeof data !== 'object') {
      return;
    }
    if (data.roomId && data.roomId !== app.STATE.roomId) {
      return;
    }
    if (data.eventType === 'presence') {
      if (data.from && data.from !== app.STATE.clientId && data.seenAt) {
        app.STATE.playerSync.peers[data.from] = {
          seenAt: data.seenAt,
          media: data.media || null,
        };
        prunePeers();
        recalcHost();
      }
      return;
    }
    if (data.eventType === 'command' && data.commandType === 'playback') {
      if (isHost()) {
        return;
      }
      applyPlaybackSnapshot(data.playback, data);
      return;
    }
  };

  const normalizeTransportEvent = function normalizeTransportEvent(payload) {
    if (!payload || typeof payload !== 'object') {
      return null;
    }
    if (payload.eventType === 'playback' && payload.playback && typeof payload.playback === 'object') {
      return {
        trackId: String(payload.playback.trackId || '').trim(),
        trackUrl: String(payload.playback.trackUrl || '').trim(),
        position: parseNum(payload.playback.position),
        duration: parseNum(payload.playback.duration),
        paused: Boolean(payload.playback.paused),
      };
    }
    if (payload.eventType === 'raw' && payload.payload && typeof payload.payload === 'object') {
      return {
        trackId: extractTrackId(payload.payload),
        trackUrl: String(payload.url || '').trim(),
        position: parseNum(payload.payload.position || payload.payload.currentTime),
        duration: parseNum(payload.payload.duration),
        paused: Boolean(payload.payload.paused),
      };
    }
    return null;
  };

  const onTransportMessage = function onTransportMessage(payload) {
    if (!payload || typeof payload !== 'object') {
      return;
    }

    if (payload.type && payload.type === 'bridge-ready') {
      app.updateTransportHealth({ status: 'ready', source: 'pageHook', lastEventAt: Date.now() });
      return;
    }

    if (payload.eventType === 'transport-health') {
      app.updateTransportHealth({
        status: payload.status || 'unknown',
        source: payload.source || 'ynison',
        lastEventAt: Date.now(),
        error: payload.error,
      });
      return;
    }

    const playback = normalizeTransportEvent(payload);
    if (!playback) {
      return;
    }

    app.STATE.playerSync.mediaTrackId = playback.trackId || app.STATE.playerSync.mediaTrackId;
    app.STATE.playerSync.mediaPosition = playback.position || 0;
    app.STATE.playerSync.mediaPaused = Boolean(playback.paused);
    if (playback.duration) {
      app.STATE.playerSync.mediaDuration = playback.duration;
    }
    app.STATE.playerSync.lastCommandAt = Date.now();
    app.updateTransportHealth({
      status: 'connected',
      source: payload.source || 'ynison',
      lastEventAt: Date.now(),
      lastTrackId: playback.trackId || '',
    });

    setMediaTrackMeta(playback);
    if (isHost()) {
      broadcastPlaybackState(playback, payload.source || 'ynison');
      return;
    }

    applyPlaybackSnapshot(playback, { eventType: 'transport', transportSource: payload.source });
  };

  const onLocalMediaChange = function onLocalMediaChange() {
    if (!mediaElement || currentlyApplying) {
      return;
    }
    const now = Date.now();
    if (now - lastBroadcastAt < LOCAL_BROADCAST_THROTTLE_MS) {
      return;
    }
    const snapshot = toPlaybackSnapshot();
    if (!snapshot) {
      return;
    }
    lastBroadcastAt = now;
    app.STATE.playerSync.mediaTrackId = snapshot.trackId;
    app.STATE.playerSync.mediaPosition = snapshot.position;
    app.STATE.playerSync.mediaPaused = snapshot.paused;
    app.STATE.playerSync.mediaDuration = snapshot.duration;

    if (isHost()) {
      broadcastPlaybackState(snapshot, 'local-media');
    }
  };

  const bindMediaElement = function bindMediaElement(media) {
    if (!media || media.__ymSyncBound) {
      return;
    }
    media.__ymSyncBound = true;

    media.addEventListener('play', onLocalMediaChange);
    media.addEventListener('pause', onLocalMediaChange);
    media.addEventListener('seeked', onLocalMediaChange);
    media.addEventListener('timeupdate', onLocalMediaChange);
    media.addEventListener('ended', onLocalMediaChange);
  };

  const updateMediaElement = function updateMediaElement() {
    const next = document.querySelector('audio,video');
    if (!next || next === mediaElement) {
      return;
    }
    mediaElement = next;
    bindMediaElement(mediaElement);
    onLocalMediaChange();
  };

  const startWatchers = function startWatchers() {
    if (!mediaWatchTimer) {
      mediaWatchTimer = window.setInterval(updateMediaElement, 1_000);
    }
    updateMediaElement();
    if (mediaObserver) {
      return;
    }
    mediaObserver = new MutationObserver(() => {
      updateMediaElement();
    });
    mediaObserver.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['src'],
    });
  };

  const startPresenceLoop = function startPresenceLoop() {
    if (presenceTimer) {
      return;
    }
    presenceTimer = window.setInterval(() => {
      if (!app.STATE.roomId) {
        return;
      }
      prunePeers();
      recalcHost();
      broadcastPresence();
    }, PRESENCE_INTERVAL_MS);
  };

  app.installPlayerSync = function installPlayerSync() {
    if (app.STATE.__playerSyncInstalled) {
      return;
    }
    app.STATE.__playerSyncInstalled = true;
    app.STATE.playerSync = app.STATE.playerSync || {};
    app.STATE.playerSync.peers = app.STATE.playerSync.peers || {};
    app.STATE.playerSync.mediaTrackId = '';
    app.STATE.playerSync.mediaPosition = 0;
    app.STATE.playerSync.mediaDuration = 0;
    app.STATE.playerSync.mediaPaused = true;
    app.STATE.playerSync.lastCommandAt = 0;
    logInitializationObjects();

    app.setTransportEventHandler(onTransportMessage);
    recalcHost();
    startWatchers();
    startPresenceLoop();
    ensureChannel();
    const snapshot = toPlaybackSnapshot();
    setMediaTrackMeta(snapshot || {});
    if (isHost()) {
      broadcastPlaybackState(snapshot || {}, 'sync-start');
    }
    app.render();
  };
})();
