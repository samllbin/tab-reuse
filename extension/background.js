import { createController } from './core.js';

const controller = createController(chrome);
const report = error => console.warn('Tab Reuse:', error.message);
chrome.tabs.onCreated.addListener(tab => { controller.onCreated(tab).catch(report); });
chrome.tabs.onUpdated.addListener((id, change) => { controller.onUpdated(id, change).catch(report); });
chrome.tabs.onRemoved.addListener(id => { controller.onRemoved(id).catch(report); });
chrome.runtime.onStartup.addListener(() => { controller.onStartup().catch(report); });

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    for (const [id, title] of [['reuse-link', 'Tab Reuse：优先复用已有标签页'], ['new-link', 'Tab Reuse：强制新开标签页']]) {
      chrome.contextMenus.create({ id, title, contexts: ['link'], targetUrlPatterns: ['http://*/*', 'https://*/*'] });
    }
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!['reuse-link', 'new-link'].includes(info.menuItemId)) return;
  controller.open(info.linkUrl, { mode: info.menuItemId === 'new-link' ? 'new' : 'reuse', windowId: tab?.windowId }).catch(report);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  let operation;
  if (message?.type === 'get-settings') operation = controller.getSettings().then(settings => ({ settings }));
  else if (message?.type === 'set-settings') operation = controller.setSettings(message.enabled).then(settings => ({ settings }));
  else if (message?.type === 'open-url') operation = controller.open(message.url, { mode: message.mode, windowId: message.windowId });
  else return false;
  operation.then(result => sendResponse({ ok: true, ...result }), error => sendResponse({ ok: false, error: error.message }));
  return true;
});
