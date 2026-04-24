/* global window */
(function ymSyncNativePlayerBridge() {
  if (window.__ymSyncNativePlayerBridgeActive) {
    return;
  }
  window.__ymSyncNativePlayerBridgeActive = true;

  var TARGET_PROPERTY = '__ymSyncNativePlayer';
  var READY_EVENT = 'ym-sync-native-player-ready';
  var FALLBACK_CHECK_MS = 250;
  var FALLBACK_TIMEOUT_MS = 300000;

  var diagnostics = {
    checks: 0,
    detected: false,
    source: null,
    readyAt: 0,
    lastError: null,
    lastScanPath: null,
  };
  window.__ymSyncNativePlayerBridgeDiagnostics = diagnostics;

  var safeIsFunction = function safeIsFunction(value, name) {
    try {
      return typeof value[name] === 'function';
    } catch (_error) {
      diagnostics.lastError = 'safeIsFunction:' + name + ':' + _error.message;
      return false;
    }
  };

  var safeGetValue = function safeGetValue(value, name) {
    try {
      return value[name];
    } catch (_error) {
      diagnostics.lastError = 'safeGetValue:' + name + ':' + _error.message;
      return null;
    }
  };

  var safeGetKeys = function safeGetKeys(value) {
    try {
      return Object.keys(value);
    } catch (_error) {
      diagnostics.lastError = 'Object.keys:' + _error.message;
      return [];
    }
  };

  var safeForInValues = function safeForInValues(value) {
    var keys = [];
    try {
      for (var safeForInKey in value) {
        keys.push(safeForInKey);
      }
    } catch (_error) {
      diagnostics.lastError = 'for..in:' + _error.message;
    }
    return keys;
  };

  var emitReady = function emitReady(player, source) {
    if (!player) {
      return;
    }
    if (window.__ymSyncNativePlayer) {
      return;
    }
    diagnostics.detected = true;
    diagnostics.source = source || 'unknown';
    diagnostics.readyAt = Date.now();

    try {
      window[TARGET_PROPERTY] = player;
      window.__ymSyncNativePlayerReady = true;
      window.__ymSyncNativePlayerStatus = {
        source: diagnostics.source,
        capturedAt: diagnostics.readyAt,
      };
      window.__ymSyncNativePlayerSource = diagnostics.source;
      window.__ymSyncNativePlayerCapturedAt = diagnostics.readyAt;
      window.__ymSyncNativePlayerCaptureCount = (window.__ymSyncNativePlayerCaptureCount || 0) + 1;
    } catch (_error) {
      return;
    }

    try {
      window.postMessage({
        __ymSyncNativePlayerReady: true,
        __ymSyncNativePlayerSource: source || 'unknown',
      }, '*');
    } catch (_error) {
      // no-op
    }

    try {
      window.dispatchEvent(new CustomEvent(READY_EVENT, {
        detail: {
          source: source || 'unknown',
          capturedAt: Date.now(),
        },
      }));
    } catch (_error) {
      // no-op
    }
  };

  var isPlayerLike = function isPlayerLike(value) {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
      return false;
    }
    return (
      (safeIsFunction(value, 'play') || safeIsFunction(value, 'playAsync')) &&
      (safeIsFunction(value, 'pause') || safeIsFunction(value, 'stop')) &&
      (
        safeIsFunction(value, 'seek') ||
        safeIsFunction(value, 'seekTo') ||
        safeIsFunction(value, 'setSource') ||
        safeIsFunction(value, 'setCurrentTime') ||
        safeIsFunction(value, 'setCurrentPosition') ||
        safeIsFunction(value, 'getCurrentTime') ||
        safeIsFunction(value, 'getState') ||
        safeIsFunction(value, 'on') ||
        safeIsFunction(value, 'once') ||
        safeIsFunction(value, 'addEventListener') ||
        safeIsFunction(value, 'addListener') ||
        safeIsFunction(value, 'off') ||
        safeIsFunction(value, 'removeListener') ||
        safeIsFunction(value, 'setMuted') ||
        safeIsFunction(value, 'setVolume')
      )
    );
  };

  var seen = [];
  var captureByCandidate = function captureByCandidate(candidate, source) {
    if (isPlayerLike(candidate)) {
      diagnostics.lastScanPath = source || null;
      emitReady(candidate, source);
      return true;
    }
    return false;
  };

  var scanForPlayerCandidates = function scanForPlayerCandidates(node, path, depth) {
    if (!node || (typeof node !== 'object' && typeof node !== 'function') || depth > 3) {
      return false;
    }
    if (seen.indexOf(node) !== -1) {
      return false;
    }
    seen.push(node);

    if (captureByCandidate(node, path || 'object')) {
      return true;
    }

    var keys = safeGetKeys(node);
    var forInKeys = safeForInValues(node);
    for (var k = 0; k < forInKeys.length; k += 1) {
      var forInKey = forInKeys[k];
      if (keys.indexOf(forInKey) === -1) {
        keys.push(forInKey);
      }
    }
    for (var i = 0; i < keys.length; i += 1) {
      var key = keys[i];
      var candidate = safeGetValue(node, key);
      if (!candidate || (typeof candidate !== 'object' && typeof candidate !== 'function')) {
        continue;
      }
      if (captureByCandidate(candidate, path + '.' + key)) {
        return true;
      }
      if (scanForPlayerCandidates(candidate, path + '.' + key, depth + 1)) {
        return true;
      }
    }
    return false;
  };

  var wrapSdkFactories = function wrapSdkFactories(sdk) {
    if (!sdk || (typeof sdk !== 'object' && typeof sdk !== 'function') || sdk.__ymSyncNativePlayerWrapped) {
      return;
    }
    var keys = safeGetKeys(sdk);
    for (var i = 0; i < keys.length; i += 1) {
      var key = keys[i];
      var value = safeGetValue(sdk, key);
      if (typeof value !== 'function' || value.__ymSyncNativePlayerWrapped) {
        continue;
      }
      (function bindWrappedFactory(factoryKey, factoryFn) {
        sdk[factoryKey] = function onWrappedFactory() {
          var args = [];
          for (var j = 0; j < arguments.length; j += 1) {
            args.push(arguments[j]);
          }
          var result = factoryFn.apply(this, args);
          captureByCandidate(result, 'Ya.playerSdk.' + factoryKey + '()');
          return result;
        };
        sdk[factoryKey].__ymSyncNativePlayerWrapped = true;
      })(key, value);
    }
    sdk.__ymSyncNativePlayerWrapped = true;
  };

  var wrapFactoryObject = function wrapFactoryObject(container, containerName) {
    if (!container || (typeof container !== 'object' && typeof container !== 'function')) {
      return;
    }
    var keys = safeGetKeys(container);
    for (var i = 0; i < keys.length; i += 1) {
      var key = keys[i];
      var value = safeGetValue(container, key);
      if (typeof value !== 'function' || value.__ymSyncNativePlayerWrapped) {
        continue;
      }
      (function bindFactoryObjectMethod(factoryKey, factoryFn) {
        container[factoryKey] = function onFactoryObjectMethod() {
          var args = [];
          for (var j = 0; j < arguments.length; j += 1) {
            args.push(arguments[j]);
          }
          var result = factoryFn.apply(container, args);
          captureByCandidate(result, containerName + '.' + factoryKey + '()');
          return result;
        };
        container[factoryKey].__ymSyncNativePlayerWrapped = true;
      })(key, value);
    }
    container.__ymSyncNativePlayerWrappedFactories = true;
  };

  var detectPlayerFromKnownContainers = function detectPlayerFromKnownContainers() {
    var yaNamespace = safeGetValue(window, 'Ya');
    if (!yaNamespace) {
      return;
    }
    var yaPlayerSdk = safeGetValue(yaNamespace, 'playerSdk');
    if (!yaPlayerSdk) {
      return;
    }

    if (yaNamespace) {
      if (captureByCandidate(safeGetValue(yaNamespace, 'playerApi'), 'Heuristic.Ya.playerApi')) {
        return;
      }
      if (!yaNamespace.__ymSyncNativePlayerWrapPlayerApi) {
        wrapFactoryObject(safeGetValue(yaNamespace, 'playerApi'), 'Ya.playerApi');
        yaNamespace.__ymSyncNativePlayerWrapPlayerApi = true;
      }
      if (scanForPlayerCandidates(yaNamespace, 'Ya', 0)) {
        return;
      }
    }

    if (captureByCandidate(yaPlayerSdk, 'Heuristic.Ya.playerSdk')) {
      return;
    }
    wrapSdkFactories(yaPlayerSdk);
    if (!yaPlayerSdk.__ymSyncNativePlayerWrapFactories) {
      wrapFactoryObject(yaPlayerSdk, 'Ya.playerSdk');
      yaPlayerSdk.__ymSyncNativePlayerWrapFactories = true;
    }
    if (captureByCandidate(yaPlayerSdk.player, 'Ya.playerSdk.player')) {
      return;
    }
  };

  var captureMediaFallback = function captureMediaFallback() {
    var media = document.querySelector('audio,video');
    if (!media || media.__ymSyncNativePlayerCaptured) {
      return;
    }
    media.__ymSyncNativePlayerCaptured = true;
    emitReady(media, 'fallback.mediaElement');
  };

  var tryHookPlayerSdk = function tryHookPlayerSdk() {
    var yaNamespace = safeGetValue(window, 'Ya');
    if (!yaNamespace) {
      return;
    }
    var sdk = safeGetValue(yaNamespace, 'playerSdk');
    if (!sdk || sdk.__ymSyncNativePlayerHook || !safeIsFunction(sdk, 'init')) {
      return;
    }

    var originalInit = safeGetValue(sdk, 'init');
    sdk.init = function onNativeInit() {
      var player = originalInit.apply(sdk, arguments);
      emitReady(player, 'Ya.playerSdk.init');
      return player;
    };
    sdk.__ymSyncNativePlayerHook = true;
  };

  var detectExisting = function detectExisting() {
    diagnostics.checks += 1;
    var player = window.__ymSyncNativePlayer;
    if (player) {
      emitReady(player, 'preinitialized.windowProperty');
      return;
    }

    detectPlayerFromKnownContainers();
    tryHookPlayerSdk();
    captureMediaFallback();
  };

  detectExisting();

  var elapsed = 0;
  var interval = window.setInterval(function check() {
    elapsed += FALLBACK_CHECK_MS;
    detectExisting();

    if (window.__ymSyncNativePlayer || elapsed >= FALLBACK_TIMEOUT_MS) {
      window.clearInterval(interval);
    }
  }, FALLBACK_CHECK_MS);
})();
