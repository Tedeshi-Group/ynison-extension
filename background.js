const YM_URL = "https://music.yandex.ru/";
const YM_MATCH_PATTERNS = ["*://music.yandex.ru/*", "*://music.yandex.com/*"];
const toolbarAction = chrome.action || chrome.browserAction;

if (!toolbarAction || !toolbarAction.onClicked) {
  // No toolbar action API in this browser environment; nothing to listen to.
  // Service worker stays alive for other entrypoints if needed.
} else {
  toolbarAction.onClicked.addListener(() => {
  chrome.tabs.query({ url: YM_MATCH_PATTERNS }, (tabs) => {
    const existingTab = tabs?.[0];

    if (existingTab?.id != null && existingTab.windowId != null) {
      chrome.windows.update(existingTab.windowId, { focused: true }, () => {
        chrome.tabs.update(existingTab.id, { active: true });
      });
      return;
    }

    chrome.tabs.create({ url: YM_URL });
  });
});
}