const form = document.querySelector('#open-form');
const urlInput = document.querySelector('#url');
const reuseButton = document.querySelector('#reuse-button');
const newButton = document.querySelector('#new-button');
const enabledInput = document.querySelector('#enabled');
const status = document.querySelector('#status');

let windowId;
let savedEnabled = true;
let ready = false;
let busy = false;

function setStatus(message, kind = 'info') {
  status.textContent = message;
  status.dataset.kind = kind;
}

function setBusy(value) {
  busy = value;
  for (const control of [urlInput, reuseButton, newButton, enabledInput]) {
    control.disabled = value || !ready;
  }
  form.setAttribute('aria-busy', String(value));
}

async function sendMessage(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) {
    throw new Error(response?.error || '操作未完成，请稍后重试。');
  }
  return response;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : '操作未完成，请稍后重试。';
}

async function openUrl(mode) {
  if (busy || !ready) return;
  const url = urlInput.value.trim();
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
  } catch {
    setStatus('请输入以 http:// 或 https:// 开头的完整链接。', 'error');
    urlInput.focus();
    return;
  }

  setBusy(true);
  setStatus(mode === 'reuse' ? '正在查找已打开的标签页…' : '正在打开独立标签页…');
  try {
    const result = await sendMessage({ type: 'open-url', url, mode, windowId });
    setStatus(result.reused ? '已切换到已有标签页。' : '已打开新的标签页。', 'success');
  } catch (error) {
    setStatus(errorMessage(error), 'error');
  } finally {
    setBusy(false);
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  void openUrl('reuse');
});

newButton.addEventListener('click', () => void openUrl('new'));

enabledInput.addEventListener('change', async () => {
  if (busy || !ready) return;
  const enabled = enabledInput.checked;
  setBusy(true);
  try {
    const response = await sendMessage({ type: 'set-settings', enabled });
    savedEnabled = response.settings.enabled;
    enabledInput.checked = savedEnabled;
    setStatus(savedEnabled ? '已开启自动复用。' : '已关闭自动复用，仍可使用上方按钮。', 'success');
  } catch (error) {
    enabledInput.checked = savedEnabled;
    setStatus(errorMessage(error), 'error');
  } finally {
    setBusy(false);
  }
});

async function initialize() {
  setBusy(true);
  try {
    const [tabs, response] = await Promise.all([
      chrome.tabs.query({ active: true, currentWindow: true }),
      sendMessage({ type: 'get-settings' }),
    ]);
    const currentTab = tabs[0];
    if (!Number.isInteger(currentTab?.windowId)) {
      throw new Error('未找到当前浏览器窗口，请重新打开插件。');
    }
    windowId = currentTab.windowId;
    if (/^https?:\/\//i.test(currentTab.url || '')) urlInput.value = currentTab.url;
    savedEnabled = response.settings.enabled;
    enabledInput.checked = savedEnabled;
    ready = true;
    setStatus('已有相同链接时，直接切换到对应标签页。');
  } catch (error) {
    setStatus(errorMessage(error), 'error');
  } finally {
    setBusy(false);
  }
}

void initialize();
