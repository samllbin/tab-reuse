import test from 'node:test';
import assert from 'node:assert/strict';
import { candidates, createController, isBlank, tabUrl, urlKey } from '../extension/core.js';

const URL_A = 'https://example.com/path?item=1#details';
const URL_B = 'https://example.com/other';
const copy = value => structuredClone(value);

// Model Chrome's async, copy-on-read APIs. Event callbacks enqueue controller
// work without awaiting it, just as background.js does in a real service worker.
function browser(initialTabs = [], options = {}) {
  const tabs = new Map();
  const local = { enabled: true, ...options.local };
  const session = copy(options.session || {});
  const calls = [];
  const events = [];
  let clock = options.now ?? 100_000;
  let nextId = 1;
  let controller;
  const storage = data => ({
    async get(defaults) { return copy({ ...defaults, ...data }); },
    async set(value) { Object.assign(data, copy(value)); }
  });
  const add = props => {
    const id = props.id ?? nextId++;
    nextId = Math.max(nextId, id + 1);
    const tab = { id, windowId: 1, active: false, incognito: false,
      pinned: false, discarded: false, status: 'complete', url: URL_A, ...props };
    tabs.set(id, tab);
    return tab;
  };
  for (const tab of initialTabs) add(tab);
  const api = {
    storage: { local: storage(local), session: storage(session) },
    tabs: {
      async query() { return copy([...tabs.values()]); },
      async get(id) {
        if (!tabs.has(id)) throw new Error('No tab with id');
        return copy(tabs.get(id));
      },
      async create(props) {
        calls.push({ action: 'create', props: copy(props) });
        const tab = add({ ...props, status: 'loading' });
        if (options.events) events.push(controller.onCreated(copy(tab)));
        return copy(tab);
      },
      async update(id, props) {
        calls.push({ action: 'update', id, props: copy(props) });
        if (!tabs.has(id)) throw new Error('No tab with id');
        const tab = tabs.get(id);
        if (props.active) {
          for (const other of tabs.values()) {
            if (other.windowId === tab.windowId) other.active = false;
          }
        }
        Object.assign(tab, props);
        if (props.url) {
          tab.status = 'loading';
          delete tab.pendingUrl;
          if (options.events) events.push(controller.onUpdated(id, { url: props.url, status: 'loading' }));
        }
        return copy(tab);
      },
      async remove(id) {
        calls.push({ action: 'remove', id });
        if (!tabs.delete(id)) throw new Error('No tab with id');
        if (options.events) events.push(controller.onRemoved(id));
      }
    },
    windows: {
      async get(id) {
        return { id, incognito: id === 99,
          focused: options.focusedWindowId === undefined || options.focusedWindowId === id };
      },
      async update(id, props) {
        calls.push({ action: 'window-update', id, props: copy(props) });
        return { id, ...props };
      }
    }
  };
  const restart = () => (controller = createController(api, { now: () => clock }));
  restart();
  return {
    api, tabs, calls, local, session, add, restart,
    get controller() { return controller; },
    advance(ms) { clock += ms; },
    async created(props) {
      const tab = add(props);
      await controller.onCreated(copy(tab));
      return tab.id;
    },
    async updated(id, props, change = props) {
      Object.assign(tabs.get(id), props);
      await controller.onUpdated(id, copy(change));
    },
    async drain() {
      let done = 0;
      while (done < events.length) {
        const pending = events.slice(done);
        done = events.length;
        await Promise.all(pending);
      }
      await controller.idle();
    }
  };
}

test('URL identity preserves query, query order, fragment, path case and protocol', () => {
  const original = 'https://example.com/Path?a=1&b=2#section';
  for (const different of [
    'https://example.com/Path?a=2&b=2#section',
    'https://example.com/Path?b=2&a=1#section',
    'https://example.com/Path?a=1&b=2#other',
    'https://example.com/path?a=1&b=2#section',
    'http://example.com/Path?a=1&b=2#section',
    'https://example.com/Path/?a=1&b=2#section'
  ]) assert.notEqual(urlKey(original), urlKey(different));
  assert.equal(urlKey('  HTTPS://EXAMPLE.COM:443  '), 'https://example.com/');
});

test('invalid, privileged and credential-bearing URLs are rejected', () => {
  for (const value of [null, undefined, 42, '', ' ', 'example.com', 'not a url',
    'javascript:alert(1)', 'file:///tmp/a', 'chrome://settings', 'about:blank',
    'https://user:pass@example.com/', 'https://user@example.com/']) {
    assert.equal(urlKey(value), null, String(value));
  }
});

test('pending URLs take precedence, and recognized empty browser pages are blank', () => {
  assert.equal(tabUrl({ url: URL_B, pendingUrl: URL_A }), URL_A);
  assert.equal(tabUrl({}), '');
  for (const value of ['', undefined, 'about:blank', 'chrome://newtab/', 'chrome://new-tab-page']) {
    assert.equal(isBlank(value), true);
  }
  assert.equal(isBlank(URL_A), false);
});

test('browser settings, history and extension pages never remain eligible as blank tabs', async () => {
  for (const url of [
    'chrome://settings/', 'edge://settings/', 'brave://settings/',
    'opera://history/', 'vivaldi://history/',
    'chrome-extension://abcdefghijklmnopabcdefghijklmnop/newtab.html',
    'edge://newtab/extra', 'brave://newtab.example/', 'https://example.com/newtab'
  ]) {
    assert.equal(isBlank(url), false, url);
    const b = browser([{ id: 1, url: URL_A }]);
    await b.created({ id: 2, url, status: 'loading' });
    await b.updated(2, { status: 'complete' });
    await b.updated(2, { url: URL_A, status: 'loading' });
    assert.equal(b.tabs.has(2), true, url);
    assert.deepEqual(b.calls, [], url);
  }
});

test('candidate order prefers same window, then active and recently accessed tabs', () => {
  const all = [
    { id: 1, windowId: 2, active: true, lastAccessed: 900, url: URL_A },
    { id: 2, windowId: 1, active: false, lastAccessed: 200, url: URL_A },
    { id: 3, windowId: 1, active: true, lastAccessed: 100, url: URL_A },
    { id: 4, windowId: 1, active: false, lastAccessed: 300, url: URL_A },
    { id: 5, windowId: 1, active: true, incognito: true, url: URL_A },
    { id: 6, windowId: 1, url: URL_B },
    { id: 7, windowId: 1, url: URL_A }
  ];
  assert.deepEqual(candidates(all, urlKey(URL_A), { id: 7, windowId: 1 }).map(t => t.id), [3, 4, 2, 1]);
});

test('missing lastAccessed still gives stable candidate ordering on older Chromium versions', () => {
  const all = [
    { id: 8, windowId: 2, active: true, url: URL_A },
    { id: 6, windowId: 1, active: false, url: URL_A },
    { id: 4, windowId: 1, active: true, url: URL_A },
    { id: 2, windowId: 1, active: false, url: URL_A }
  ];
  const expected = [4, 2, 6, 8];
  assert.deepEqual(candidates(all, urlKey(URL_A), { windowId: 1 }).map(t => t.id), expected);
  assert.deepEqual(candidates([...all].reverse(), urlKey(URL_A), { windowId: 1 }).map(t => t.id), expected);
  assert.deepEqual(all.map(t => t.id), [8, 6, 4, 2]);
});

test('explicit reuse focuses an existing tab without navigating or refreshing it', async () => {
  const b = browser([{ id: 1, windowId: 2, url: URL_A }]);
  assert.deepEqual(await b.controller.open(URL_A, { windowId: 1 }), { reused: true, tabId: 1 });
  assert.deepEqual(b.calls, [
    { action: 'update', id: 1, props: { active: true } },
    { action: 'window-update', id: 2, props: { focused: true } }
  ]);
});

test('a URL with different query, hash or protocol opens a separate tab', async () => {
  for (const url of ['https://example.com/path?item=2#details',
    'https://example.com/path?item=1#other', 'http://example.com/path?item=1#details']) {
    const b = browser([{ id: 1, url: URL_A }]);
    assert.equal((await b.controller.open(url)).reused, false);
    assert.equal(b.tabs.size, 2);
  }
});

test('force-new survives onCreated/onUpdated events and service-worker reconstruction', async () => {
  const b = browser([{ id: 1, url: URL_A }], { events: true });
  const result = await b.controller.open(URL_A, { mode: 'new', windowId: 1 });
  await b.drain();
  b.restart();
  await b.updated(result.tabId, { status: 'complete' }, { status: 'complete' });
  assert.equal(result.reused, false);
  assert.equal(b.tabs.size, 2);
  assert.deepEqual(b.session.tracking[result.tabId], { kind: 'exempt' });
  assert.equal(b.calls.some(c => c.action === 'remove'), false);
});

test('simultaneous reuse requests create only one page', async () => {
  const b = browser([], { events: true });
  const results = await Promise.all(Array.from({ length: 8 }, () => b.controller.open(URL_A)));
  await b.drain();
  assert.equal(b.tabs.size, 1);
  assert.equal(results.filter(r => !r.reused).length, 1);
  assert.equal(new Set(results.map(r => r.tabId)).size, 1);
  assert.equal(b.calls.filter(c => c.action === 'create').length, 1);
});

test('simultaneous force-new requests keep every explicitly requested tab', async () => {
  const b = browser([{ id: 1, url: URL_A }], { events: true });
  const results = await Promise.all(Array.from({ length: 3 }, () => b.controller.open(URL_A, { mode: 'new' })));
  await b.drain();
  assert.equal(b.tabs.size, 4);
  assert.equal(new Set(results.map(r => r.tabId)).size, 3);
});

test('new foreground duplicate is removed only after the target is focused', async () => {
  const b = browser([{ id: 1, windowId: 2, url: URL_A }]);
  await b.created({ id: 2, url: URL_A, status: 'loading', active: true });
  assert.equal(b.tabs.has(2), false);
  assert.deepEqual(b.calls.map(c => c.action), ['update', 'window-update', 'remove']);
  assert.equal(b.tabs.get(1).active, true);
  assert.equal(b.session.tracking[2], undefined);
});

test('new background duplicate is removed without changing focus', async () => {
  const b = browser([{ id: 1, windowId: 2, url: URL_A }]);
  await b.created({ id: 2, url: URL_A, status: 'loading', active: false });
  assert.deepEqual(b.calls, [{ action: 'remove', id: 2 }]);
});

test('an active tab in an unfocused background window must not steal focus', async () => {
  const b = browser([{ id: 1, windowId: 2, url: URL_A }], { focusedWindowId: 3 });
  await b.created({ id: 2, windowId: 1, url: URL_A, status: 'loading', active: true });
  assert.deepEqual(b.calls, [{ action: 'remove', id: 2 }]);
});

test('navigation of an existing untracked tab is never merged', async () => {
  const b = browser([{ id: 1, url: URL_A }, { id: 2, url: URL_B }]);
  await b.updated(2, { url: URL_A, status: 'loading' });
  await b.updated(2, { status: 'complete' });
  assert.equal(b.tabs.size, 2);
  assert.deepEqual(b.calls, []);
});

test('already complete nonblank created tabs are preserved as restored/explicit duplicates', async () => {
  const b = browser([{ id: 1, url: URL_A }]);
  await b.created({ id: 2, url: URL_A, status: 'complete' });
  await b.updated(2, { status: 'complete' });
  assert.equal(b.tabs.size, 2);
  assert.equal(b.session.tracking?.[2], undefined);
});

test('blank created tab remains eligible through blank completion and first navigation', async () => {
  const b = browser([{ id: 1, url: URL_A }]);
  await b.created({ id: 2, url: 'about:blank', status: 'loading' });
  await b.updated(2, { status: 'complete' });
  assert.equal(b.session.tracking[2].phase, 'blank');
  await b.updated(2, { pendingUrl: URL_A, status: 'loading' });
  assert.equal(b.tabs.has(2), false);
});

test('Chromium browser new-tab aliases survive completion until the first HTTPS navigation', async () => {
  const aliases = [
    'chrome://newtab', 'chrome://new-tab-page',
    'edge://newtab', 'edge://new-tab-page',
    'brave://newtab', 'brave://new-tab-page',
    'chrome://startpage', 'opera://startpage', 'vivaldi://startpage'
  ];
  for (const alias of aliases) {
    for (const suffix of ['', '/']) {
      const url = alias + suffix;
      assert.equal(isBlank(url), true, url);
      // Browsers may report an already-rendered built-in page on creation.
      for (const status of ['loading', 'complete']) {
        const b = browser([{ id: 1, url: URL_A }]);
        await b.created({ id: 2, url, status });
        await b.updated(2, { status: 'complete' });
        assert.equal(b.session.tracking[2]?.phase, 'blank', `${url} (${status})`);
        await b.updated(2, { url: URL_A, status: 'loading' });
        assert.equal(b.tabs.has(2), false, `${url} (${status})`);
        assert.equal(b.tabs.has(1), true, `${url} (${status})`);
      }
    }
  }
});

test('new tab uses its pending URL when initial URL is still blank', async () => {
  const b = browser([{ id: 1, url: URL_A }]);
  await b.created({ id: 2, url: 'about:blank', pendingUrl: URL_A, status: 'loading' });
  assert.equal(b.tabs.has(2), false);
});

test('initial navigation can redirect to an existing page and then merge', async () => {
  const b = browser([{ id: 1, url: URL_A }]);
  await b.created({ id: 2, url: URL_B, status: 'loading' });
  assert.equal(b.tabs.has(2), true);
  await b.updated(2, { url: URL_A, status: 'loading' });
  assert.equal(b.tabs.has(2), false);
});

test('after first unique page completes, later navigation does not close that tab', async () => {
  const b = browser([{ id: 1, url: URL_A }]);
  await b.created({ id: 2, url: URL_B, status: 'loading' });
  await b.updated(2, { status: 'complete' });
  assert.equal(b.session.tracking[2], undefined);
  await b.updated(2, { url: URL_A, status: 'loading' });
  assert.equal(b.tabs.has(2), true);
});

test('a custom HTTPS new-tab homepage stops being eligible once it has completed', async () => {
  const homepage = 'https://home.example.com/dashboard';
  for (const status of ['loading', 'complete']) {
    const b = browser([{ id: 1, url: URL_A }]);
    await b.created({ id: 2, url: homepage, status, active: true });
    await b.updated(2, { status: 'complete' });
    assert.equal(b.session.tracking?.[2], undefined);
    await b.updated(2, { url: URL_A, status: 'loading' });
    assert.equal(b.tabs.has(2), true, status);
    assert.equal(b.tabs.get(2).active, true, status);
    assert.deepEqual(b.calls, [], status);
  }
});

test('long-running first navigation stops being eligible for automatic closing', async () => {
  for (const now of [0, 100_000]) {
    const b = browser([{ id: 1, url: URL_A }], { now });
    await b.created({ id: 2, url: URL_B, status: 'loading' });
    b.advance(15_001);
    await b.updated(2, { url: URL_A, status: 'loading' });
    assert.equal(b.tabs.has(2), true);
    assert.equal(b.session.tracking[2], undefined);
  }
});

test('pinned, discarded and incognito source tabs are never automatically removed', async () => {
  for (const property of ['pinned', 'discarded', 'incognito']) {
    const b = browser([{ id: 1, url: URL_A }]);
    await b.created({ id: 2, url: URL_A, status: 'loading', [property]: true });
    assert.equal(b.tabs.has(2), true, property);
  }
});

test('incognito targets do not match explicit or automatic reuse', async () => {
  const b = browser([{ id: 1, url: URL_A, incognito: true }]);
  await b.created({ id: 2, url: URL_A, status: 'loading' });
  assert.equal(b.tabs.has(2), true);
  const c = browser([{ id: 1, url: URL_A, incognito: true }]);
  assert.equal((await c.controller.open(URL_A)).reused, false);
});

test('pause prevents new automatic merges and resume does not retroactively merge', async () => {
  const b = browser([{ id: 1, url: URL_A }]);
  await b.controller.setSettings(false);
  await b.created({ id: 2, url: URL_A, status: 'loading' });
  await b.controller.setSettings(true);
  await b.updated(2, { status: 'complete' });
  assert.equal(b.tabs.size, 2);
  assert.equal(b.session.tracking[2], undefined);
});

test('pausing clears in-flight automatic eligibility while preserving force-new exemptions', async () => {
  const b = browser([{ id: 1, url: URL_A }]);
  await b.created({ id: 2, url: URL_B, status: 'loading' });
  const { tabId } = await b.controller.open(URL_A, { mode: 'new' });
  await b.controller.setSettings(false);
  await b.controller.setSettings(true);
  await b.updated(2, { url: URL_A, status: 'loading' });
  assert.equal(b.tabs.has(2), true);
  assert.equal(b.session.tracking[2], undefined);
  assert.equal(b.session.tracking[tabId].kind, 'exempt');
});

test('explicit reuse still works while automatic reuse is paused', async () => {
  const b = browser([{ id: 1, url: URL_A }], { local: { enabled: false } });
  assert.deepEqual(await b.controller.open(URL_A), { reused: true, tabId: 1 });
});

test('service-worker reconstruction retains first-navigation tracking from session storage', async () => {
  const b = browser([{ id: 1, url: URL_A }]);
  await b.created({ id: 2, url: 'chrome://newtab/', status: 'complete' });
  b.restart();
  await b.updated(2, { url: URL_A, status: 'loading' });
  assert.equal(b.tabs.has(2), false);
});

test('browser startup clears stale tracking and ignores tabs created during restoration', async () => {
  const b = browser([{ id: 1, url: URL_A }], { session: { tracking: { 50: { kind: 'fresh' } } } });
  await b.controller.onStartup();
  assert.deepEqual(b.session.tracking, {});
  await b.created({ id: 2, url: URL_A, status: 'loading' });
  b.advance(10_001);
  await b.updated(2, { status: 'complete' });
  assert.equal(b.tabs.has(2), true);
  await b.created({ id: 3, url: URL_A, status: 'loading' });
  assert.equal(b.tabs.has(3), false);
});

test('removed tabs are forgotten in persisted tracking', async () => {
  const b = browser();
  await b.created({ id: 1, url: 'about:blank', status: 'loading' });
  b.tabs.delete(1);
  await b.controller.onRemoved(1);
  assert.equal(b.session.tracking[1], undefined);
});

test('target disappearing after candidate query does not delete the new source', async () => {
  const b = browser([{ id: 1, url: URL_A }]);
  const query = b.api.tabs.query;
  b.api.tabs.query = async () => {
    const snapshot = await query();
    b.tabs.delete(1);
    return snapshot;
  };
  await b.created({ id: 2, url: URL_A, status: 'loading' });
  assert.equal(b.tabs.has(2), true);
  assert.equal(b.calls.some(c => c.action === 'remove'), false);
});

test('target navigating after candidate query does not delete the new source', async () => {
  const b = browser([{ id: 1, url: URL_A }]);
  const query = b.api.tabs.query;
  b.api.tabs.query = async () => {
    const snapshot = await query();
    b.tabs.get(1).pendingUrl = URL_B;
    return snapshot;
  };
  await b.created({ id: 2, url: URL_A, status: 'loading' });
  assert.equal(b.tabs.has(2), true);
  assert.deepEqual(b.calls, []);
});

test('source navigation during candidate lookup is never closed or focused away', async () => {
  const b = browser([{ id: 1, url: URL_A }]);
  const query = b.api.tabs.query;
  b.api.tabs.query = async () => {
    const snapshot = await query();
    b.tabs.get(2).pendingUrl = URL_B;
    return snapshot;
  };
  await b.created({ id: 2, url: URL_A, status: 'loading', active: true });
  assert.equal(b.tabs.has(2), true);
  assert.deepEqual(b.calls, []);
  assert.equal(b.session.tracking[2], undefined);
});

test('target disappearing or navigating during focus never causes source deletion', async () => {
  for (const change of ['disappear', 'navigate']) {
    const b = browser([{ id: 1, url: URL_A }]);
    const focus = b.api.windows.update;
    b.api.windows.update = async (...args) => {
      const result = await focus(...args);
      if (change === 'disappear') b.tabs.delete(1);
      else b.tabs.get(1).pendingUrl = URL_B;
      return result;
    };
    await b.created({ id: 2, url: URL_A, status: 'loading', active: true });
    assert.equal(b.tabs.has(2), true, change);
    assert.equal(b.calls.some(c => c.action === 'remove'), false, change);
  }
});

test('source being pinned or navigating during focus never causes its deletion', async () => {
  for (const change of ['pin', 'navigate']) {
    const b = browser([{ id: 1, url: URL_A }]);
    const focus = b.api.windows.update;
    b.api.windows.update = async (...args) => {
      const result = await focus(...args);
      if (change === 'pin') b.tabs.get(2).pinned = true;
      else b.tabs.get(2).pendingUrl = URL_B;
      return result;
    };
    await b.created({ id: 2, url: URL_A, status: 'loading', active: true });
    assert.equal(b.tabs.has(2), true, change);
    assert.equal(b.calls.some(c => c.action === 'remove'), false, change);
  }
});

test('focus failure leaves source open and does not poison subsequent queued work', async () => {
  const b = browser([{ id: 1, url: URL_A }]);
  const focus = b.api.windows.update;
  b.api.windows.update = async () => { throw new Error('Cannot focus window'); };
  await assert.rejects(b.created({ id: 2, url: URL_A, status: 'loading', active: true }), /Cannot focus/);
  assert.equal(b.tabs.has(2), true);
  b.api.windows.update = focus;
  assert.equal((await b.controller.open(URL_A)).reused, true);
});

test('explicit reuse skips stale candidates and creates a new tab when none remain', async () => {
  const b = browser([{ id: 1, url: URL_A }]);
  const query = b.api.tabs.query;
  b.api.tabs.query = async () => {
    const snapshot = await query();
    b.tabs.get(1).pendingUrl = URL_B;
    return snapshot;
  };
  assert.equal((await b.controller.open(URL_A)).reused, false);
  assert.equal(b.tabs.size, 2);
  assert.equal(b.calls.some(c => c.action === 'update' && c.id === 1), false);
});

test('invalid open/settings requests fail before browser mutations', async () => {
  const b = browser();
  for (const args of [
    ['javascript:alert(1)'], [URL_A, { mode: 'surprise' }],
    [URL_A, { windowId: -1 }], [URL_A, { windowId: '1' }],
    [URL_A, { windowId: 99 }]
  ]) await assert.rejects(b.controller.open(...args));
  await assert.rejects(b.controller.setSettings('false'));
  assert.deepEqual(b.calls, []);
  assert.deepEqual(await b.controller.getSettings(), { enabled: true });
});
