 (function ymSyncPlayerSyncModule() {
  const app = window.__ymSync;
  const MODULE_NAME = 'playerSyncBroadcastBridge';

  if (!app || (app.modules && app.modules[MODULE_NAME])) {
    return;
  }

  app.modules = app.modules || {};
  app.modules[MODULE_NAME] = true;

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

  const getTransportSource = function getTransportSource(rawSource) {
    const source = String(rawSource || '').trim();
    if (source) {
      return source;
    }
    if (typeof app.getTransportSource === 'function') {
      return app.getTransportSource();
    }
    const fallback = app.STATE.transport && app.STATE.transport.source;
    return String(fallback || 'broadcast').trim() || 'broadcast';
  };

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

  function getCurrentTrackIdFromLocation() {
    if (typeof app.getTrackIdFromLocationFallback === 'function') {
      return app.getTrackIdFromLocationFallback();
    }
    return '';
  }

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
    const hostId = (app.STATE.syncState && app.STATE.syncState.hostClientId) || app.STATE.clientId;
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
      transportSource: getTransportSource(),
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
      if (typeof app.updateTransportHealth === 'function') {
        app.updateTransportHealth({ status: 'ready', source: 'pageHook', lastEventAt: Date.now() });
      }
      return;
    }

    if (payload.eventType === 'transport-health') {
      if (typeof app.updateTransportHealth === 'function') {
        app.updateTransportHealth({
          status: payload.status || 'unknown',
          source: getTransportSource(payload.source),
          lastEventAt: Date.now(),
          error: payload.error,
        });
      }
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
    if (typeof app.updateTransportHealth === 'function') {
      app.updateTransportHealth({
        status: 'connected',
        source: getTransportSource(payload.source),
        lastEventAt: Date.now(),
        lastTrackId: playback.trackId || '',
      });
    }

    setMediaTrackMeta(playback);
    if (isHost()) {
      broadcastPlaybackState(playback, getTransportSource(payload.source));
      return;
    }

    applyPlaybackSnapshot(playback, { eventType: 'transport', transportSource: getTransportSource(payload.source) });
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
    app.STATE.syncState = app.STATE.syncState || {};
    app.STATE.syncState.pendingCommandIds = app.STATE.syncState.pendingCommandIds || {};
    app.STATE.playerSync = app.STATE.playerSync || {};
    app.STATE.playerSync.peers = app.STATE.playerSync.peers || {};
    app.STATE.playerSync.mediaTrackId = '';
    app.STATE.playerSync.mediaPosition = 0;
    app.STATE.playerSync.mediaDuration = 0;
    app.STATE.playerSync.mediaPaused = true;
    app.STATE.playerSync.lastCommandAt = 0;
    if (typeof app.logInitializationObjects === 'function') {
      app.logInitializationObjects();
    }

    if (typeof app.setTransportEventHandler === 'function') {
      app.setTransportEventHandler(onTransportMessage);
    } else {
      app.STATE.playerSync.__transportMessageHandler = onTransportMessage;
    }
    if (typeof app.setTransportSource === 'function') {
      app.setTransportSource('broadcast');
    }
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
