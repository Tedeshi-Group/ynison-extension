function isAllowedSyncUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch (_error) {
    return false;
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    return false;
  }
  if (url.port !== "10001" || !url.pathname.startsWith("/api/ws")) {
    return false;
  }
  const host = url.hostname;
  if (host === "localhost" || host === "127.0.0.1") {
    return true;
  }
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) {
    return true;
  }
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) {
    return true;
  }
  return /^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(host);
}

const extensionApi = globalThis.chrome || globalThis.browser;

extensionApi.runtime.onConnect.addListener((port) => {
  if (port.name !== "ym-sync-ws") {
    return;
  }

  try {
    port.postMessage({ type: "bg-ready" });
  } catch (_error) {
    // Вкладка уже закрыта.
  }

  let link = null;

  const closeLink = () => {
    if (!link) {
      return;
    }
    const current = link;
    link = null;
    current.stopped = true;
    if (current.abort) {
      current.abort.abort();
    }
  };

  port.onDisconnect.addListener(() => {
    closeLink();
  });

  port.onMessage.addListener((message) => {
    if (!message || typeof message !== "object") {
      return;
    }

    if (message.type === "connect") {
      closeLink();
      if (!isAllowedSyncUrl(message.url)) {
        port.postMessage({ type: "error", message: "адрес сервера не разрешён" });
        port.postMessage({ type: "close" });
        return;
      }

      const wsUrl = new URL(message.url);
      const httpBase = `http://${wsUrl.hostname}:${wsUrl.port || "10001"}`;
      link = {
        stopped: false,
        abort: null,
        pending: [],
        session: {
          roomId: wsUrl.searchParams.get("roomId") || "",
          clientId: wsUrl.searchParams.get("clientId") || "",
          roleHint: wsUrl.searchParams.get("roleHint") || "listener",
          nickname: wsUrl.searchParams.get("nickname") || "",
          avatarUrl: wsUrl.searchParams.get("avatarUrl") || "",
        },
      };

      const runPoll = () => {
        const current = link;
        if (!current || current.stopped) {
          return;
        }
        const controller = new AbortController();
        current.abort = controller;
        const messages = current.pending.splice(0, current.pending.length);
        fetch(`${httpBase}/api/poll`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...current.session, messages }),
          signal: controller.signal,
        })
          .then((response) => response.json())
          .then((data) => {
            if (!link || link !== current || current.stopped) {
              return;
            }
            const events = Array.isArray(data.events) ? data.events : [];
            for (const event of events) {
              port.postMessage({ type: "message", data: JSON.stringify(event) });
            }
            runPoll();
          })
          .catch((error) => {
            if (current.stopped || !link || link !== current) {
              return;
            }
            if (error.name === "AbortError") {
              current.pending.unshift(...messages);
              runPoll();
              return;
            }
            port.postMessage({
              type: "error",
              message: "запрос к серверу не прошёл: " + String(error),
            });
            port.postMessage({ type: "close" });
          });
      };

      port.postMessage({ type: "open" });
      port.postMessage({ type: "log", message: "канал открыт обычными запросами, не через WebSocket" });
      runPoll();
      return;
    }

    if (message.type === "send" && link && !link.stopped) {
      link.pending.push(String(message.data ?? ""));
      if (link.abort) {
        link.abort.abort();
      }
      return;
    }

    if (message.type === "close") {
      closeLink();
    }
  });
});

const YM_URL = "https://music.yandex.ru/";
const YM_MATCH_PATTERNS = ["*://music.yandex.ru/*", "*://music.yandex.com/*"];
const toolbarAction = extensionApi.action || extensionApi.browserAction;

if (!toolbarAction || !toolbarAction.onClicked) {
  // No toolbar action API in this browser environment; nothing to listen to.
  // Service worker stays alive for other entrypoints if needed.
} else {
  toolbarAction.onClicked.addListener(() => {
  extensionApi.tabs.query({ url: YM_MATCH_PATTERNS }, (tabs) => {
    const existingTab = tabs?.[0];

    if (existingTab?.id != null && existingTab.windowId != null) {
      extensionApi.windows.update(existingTab.windowId, { focused: true }, () => {
        extensionApi.tabs.update(existingTab.id, { active: true });
      });
      return;
    }

    extensionApi.tabs.create({ url: YM_URL });
  });
});
}