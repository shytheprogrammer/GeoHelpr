const PANEL_PATH = "popup.html?panel=1";

chrome.runtime.onInstalled.addListener(configureSidePanel);
chrome.runtime.onStartup.addListener(configureSidePanel);

async function configureSidePanel() {
  await chrome.action.setPopup({ popup: "" });
  await chrome.sidePanel.setOptions({ path: PANEL_PATH, enabled: true });
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
}
