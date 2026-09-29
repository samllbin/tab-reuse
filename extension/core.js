// Keep query strings, fragments and path case: they may identify different app state.
export function urlKey(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function tabUrl(tab) {
  return tab.pendingUrl || tab.url || '';
}

export function isBlank(value) {
  return !value || value === 'about:blank' ||
    /^(?:chrome|edge|brave):\/\/(?:newtab|new-tab-page)\/?$/.test(value) ||
    /^(?:chrome|opera|vivaldi):\/\/startpage\/?$/.test(value);
}

export function candidates(tabs, key, source = {}) {
  return tabs.filter(tab => tab.id !== source.id && !tab.incognito &&
    urlKey(tabUrl(tab)) === key).sort((a, b) =>
    Number(b.windowId === source.windowId) - Number(a.windowId === source.windowId) ||
    Number(b.active) - Number(a.active) || (b.lastAccessed || 0) - (a.lastAccessed || 0) || a.id - b.id);
}

export function createController(api, { now = Date.now } = {}) {
  let tail = Promise.resolve();
  const serial = job => {
    const next = tail.then(job);
    tail = next.catch(() => {});
    return next;
  };
  const getTab = id => api.tabs.get(id).catch(() => null);
  const read = async () => {
    const data = await api.storage.session.get({ tracking: {}, quietUntil: 0 });
    return data;
  };
  const save = state => api.storage.session.set(state);
  const settings = async () => api.storage.local.get({ enabled: true });
  const forget = async (state, id) => { delete state.tracking[id]; await save(state); };

  async function focus(tab) {
    await api.tabs.update(tab.id, { active: true });
    await api.windows.update(tab.windowId, { focused: true });
  }

  async function inspect(id, complete = false) {
    const state = await read();
    const record = state.tracking[id];
    if (!record || record.kind !== 'fresh') return;
    const source = await getTab(id);
    if (!source) return forget(state, id);
    const url = tabUrl(source);
    if (isBlank(url) && record.phase === 'blank') return;
    if (!(await settings()).enabled || source.incognito || source.pinned || source.discarded ||
        state.quietUntil > now()) return forget(state, id);
    const key = urlKey(url);
    if (!key) return forget(state, id);
    // A long-running navigation should not later close a page the user has started using.
    if (record.startedAt !== undefined && now() - record.startedAt > 15000) return forget(state, id);
    if (record.startedAt === undefined) record.startedAt = now();
    record.phase = 'loading';
    await save(state);
    const matches = candidates(await api.tabs.query({}), key, source);
    for (const match of matches) {
      const target = await getTab(match.id);
      const current = await getTab(id);
      if (!current || urlKey(tabUrl(current)) !== key) return forget(state, id);
      if (!target || target.incognito || urlKey(tabUrl(target)) !== key) continue;
      // Focus must succeed before the newly created duplicate can be removed.
      if (current.active && (await api.windows.get(current.windowId)).focused) await focus(target);
      const finalSource = await getTab(id);
      const finalTarget = await getTab(target.id);
      if (!finalSource || finalSource.pinned || !finalTarget ||
          urlKey(tabUrl(finalSource)) !== key || urlKey(tabUrl(finalTarget)) !== key) {
        return forget(state, id);
      }
      await api.tabs.remove(id);
      return forget(state, id);
    }
    if (complete || (source.status === 'complete' && !source.pendingUrl)) await forget(state, id);
  }

  return {
    getSettings: () => serial(settings),
    setSettings: enabled => serial(async () => {
      if (typeof enabled !== 'boolean') throw new Error('开关必须是布尔值');
      await api.storage.local.set({ enabled });
      // Re-enabling must not retroactively merge tabs opened while paused.
      const state = await read();
      state.tracking = Object.fromEntries(Object.entries(state.tracking).filter(([, r]) => r.kind === 'exempt'));
      await save(state);
      return { enabled };
    }),
    open: (value, { mode = 'reuse', windowId } = {}) => serial(async () => {
      const key = urlKey(value);
      if (!key) throw new Error('请输入完整的 http:// 或 https:// 链接');
      if (!['reuse', 'new'].includes(mode)) throw new Error('未知的打开方式');
      if (windowId !== undefined && (!Number.isInteger(windowId) || windowId < 0)) throw new Error('窗口无效');
      if (windowId !== undefined && (await api.windows.get(windowId)).incognito) throw new Error('暂不支持无痕窗口');
      if (mode === 'reuse') {
        for (const match of candidates(await api.tabs.query({}), key, { windowId })) {
          const target = await getTab(match.id);
          if (!target || target.incognito || urlKey(tabUrl(target)) !== key) continue;
          await focus(target);
          return { reused: true, tabId: target.id };
        }
      }
      // Register an exemption before navigation; queued onCreated/onUpdated cannot race it.
      const tab = await api.tabs.create({ url: 'about:blank', active: true, ...(windowId === undefined ? {} : { windowId }) });
      const state = await read();
      state.tracking[tab.id] = { kind: 'exempt' };
      await save(state);
      await api.tabs.update(tab.id, { url: key });
      return { reused: false, tabId: tab.id };
    }),
    onCreated: tab => serial(async () => {
      if (!Number.isInteger(tab.id) || tab.incognito || tab.pinned || tab.discarded) return;
      const state = await read();
      if (state.tracking[tab.id]?.kind === 'exempt') return;
      if (!(await settings()).enabled || state.quietUntil > now()) return;
      // Complete nonblank tabs may be restored pages or explicit browser duplicates.
      if (!isBlank(tabUrl(tab)) && tab.status === 'complete' && !tab.pendingUrl) return;
      state.tracking[tab.id] = { kind: 'fresh', phase: 'blank' };
      await save(state);
      await inspect(tab.id);
    }),
    onUpdated: (id, change) => serial(async () => {
      if (change.url !== undefined || change.status !== undefined) await inspect(id, change.status === 'complete');
    }),
    onRemoved: id => serial(async () => { const state = await read(); await forget(state, id); }),
    onStartup: () => serial(async () => save({ tracking: {}, quietUntil: now() + 10000 })),
    idle: () => tail
  };
}
