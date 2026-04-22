const YM_URL = "https://music.yandex.ru/";
const YM_MATCH_PATTERNS = ["*://music.yandex.ru/*", "*://music.yandex.com/*"];

chrome.action.onClicked.addListener(() => {
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