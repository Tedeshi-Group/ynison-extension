chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(["syncApiBase"], (data) => {
    if (!data.syncApiBase) {
      chrome.storage.local.set({ syncApiBase: "https://ynison.tedeshi.ru/api" });
    }
  });
});
