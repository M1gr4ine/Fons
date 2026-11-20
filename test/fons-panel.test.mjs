import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../sidecars/fons-pool/index.html', import.meta.url), 'utf8');
const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];

class Element {
  constructor() { this.hidden = false; this.disabled = false; this.textContent = ''; this.value = ''; this.style = {}; this.children = []; this.dataset = {}; this.listeners = {}; this.scrollHeight = 20; this.parentElement = null; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  replaceChildren(...children) { for (const c of this.children) c.parentElement = null; this.children = children; for (const c of children) c.parentElement = this; }
  append(...children) { for (const c of children) { c.parentElement = this; this.children.push(c); } }
  insertBefore(child, anchor) { const old = this.children.indexOf(child); if (old >= 0) this.children.splice(old, 1); const i = this.children.indexOf(anchor); child.parentElement = this; this.children.splice(i < 0 ? this.children.length : i, 0, child); }
  remove() { if (!this.parentElement) return; const i = this.parentElement.children.indexOf(this); if (i >= 0) this.parentElement.children.splice(i, 1); this.parentElement = null; this.isConnected = false; }
  closest(selector) { const cls = selector.startsWith('.') ? selector.slice(1) : null; for (let cur = this; cur; cur = cur.parentElement) { if (cls && String(cur.className || '').split(/\s+/).includes(cls)) return cur; } return null; }
  cloneNode(deep) { const copy = new Element(); copy.tag = this.tag; copy.className = this.className; copy.dataset = { ...this.dataset }; copy.textContent = this.textContent; if (deep) copy.append(...this.children.map((c) => c.cloneNode(true))); return copy; }
  setAttribute() {}
  querySelector(selector) { return this.children.find((child) => child.tag === selector || `.${child.className}` === selector); }
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function harness({ host = true, secureFetch = true } = {}) {
  const elements = new Map();
  for (const selector of ['.rows', '.empty', '[data-testid="fons-quick-add"]', '[data-testid="fons-flow-mode"]', '[data-testid="fons-archive"]', '.warning', '.notice', '.pool']) elements.set(selector, new Element());
  const requests = [];
  let workspaceChange;
  let tick;
  const storage = new Map();
  const localStorage = {
    getItem(key) { return storage.has(key) ? storage.get(key) : null; },
    setItem(key, value) { storage.set(key, String(value)); },
  };
  const sidecar = { conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', fetch(url, options) { const response = deferred(); requests.push({ url, options, ...response }); return response.promise; } };
  if (host) sidecar.onWorkspaceChange = (callback) => { workspaceChange = callback; return () => {}; };
  if (!secureFetch) delete sidecar.fetch;
  const document = { hidden: false, activeElement: null, querySelector: (selector) => elements.get(selector), querySelectorAll: () => [], createElement(tag) { const el = new Element(); el.tag = tag; return el; }, addEventListener() {} };
  vm.runInNewContext(script, { window: { sidecar, localStorage }, document, location: { search: '' }, URLSearchParams, Promise, Date, setTimeout: () => 0, clearTimeout() {}, setInterval: (callback) => { tick = callback; }, queueMicrotask, fetch: sidecar.fetch });
  return { elements, requests, sidecar, storage, document, workspace: (value) => workspaceChange(value), tick };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });

test('waits for the host workspace, then polls no-workspace sessions with empty workspaceUris', async () => {
  const panel = harness();
  assert.equal(panel.requests.length, 0);
  panel.workspace([]);
  await settle();
  assert.equal(panel.requests.length, 1);
  assert.deepEqual(JSON.parse(panel.requests[0].options.body).workspaceUris, []);
  panel.requests[0].resolve(response({ registered: false }));
  await settle();
  assert.match(panel.elements.get('.empty').textContent, /无工作区/);
  assert.equal(panel.elements.get('[data-testid="fons-quick-add"]').disabled, true);
  panel.tick();
  await settle();
  assert.equal(panel.requests.length, 2);
  panel.requests[1].resolve(response({ ...snapshot('无工作区灵感'), scope: 'no-workspace' }));
  await settle();
  assert.equal(panel.elements.get('[data-testid="fons-quick-add"]').disabled, false);
  assert.equal(panel.elements.get('.rows').children.length, 1);
  submit(panel, '补充一条');
  await settle();
  assert.equal(panel.requests[2].url, '/api/pool/add');
  assert.deepEqual(JSON.parse(panel.requests[2].options.body).workspaceUris, []);
});

test('a request error replaces loading and later recovery requests a fresh snapshot', async () => {
  const panel = harness();
  panel.workspace(['file:///project']);
  await settle();
  panel.requests[0].resolve(response({ error: '后端不可用' }, 503));
  await settle();
  assert.match(panel.elements.get('.empty').textContent, /后端不可用/);
  assert.doesNotMatch(panel.elements.get('.empty').textContent, /第一条/);
  panel.tick();
  await settle();
  assert.equal(panel.requests[1].url, '/api/pool');
  assert.equal(panel.requests[1].options.method, 'POST');
  assert.equal(JSON.parse(panel.requests[1].options.body).etag, undefined);
  panel.requests[1].resolve(response({ registered: false }));
  await settle();
  assert.match(panel.elements.get('.empty').textContent, /未登记/);
});

test('a response from a workspace that has closed cannot restore its contents and blocks stale session', async () => {
  const panel = harness();
  await openRegistered(panel);
  panel.tick();
  await settle();
  panel.workspace([]);
  panel.requests[1].resolve(response(snapshot('不应回填')));
  await settle();
  assert.equal(panel.requests.length, 2);
  assert.equal(panel.elements.get('.rows').children.length, 0);
  assert.match(panel.elements.get('.empty').textContent, /工作区|切换/);
  assert.equal(panel.elements.get('[data-testid="fons-quick-add"]').disabled, true);
});

test('scopeMismatch blocks stale workspace or cross-project session without poisoning its binding', async () => {
  const panel = harness();
  panel.workspace(['file:///project-b']);
  await settle();
  assert.equal(panel.requests.length, 1);
  assert.deepEqual(JSON.parse(panel.requests[0].options.body).workspaceUris, ['file:///project-b']);
  panel.requests[0].resolve(response({ registered: true, scopeMismatch: true, scope: 'workspace' }));
  await settle();
  assert.equal(panel.elements.get('[data-testid="fons-quick-add"]').disabled, true);
  assert.match(panel.elements.get('.empty').textContent, /不匹配/);
  panel.workspace(['file:///project-a']);
  await settle();
  assert.equal(panel.requests.length, 2);
  assert.deepEqual(JSON.parse(panel.requests[1].options.body).workspaceUris, ['file:///project-a']);
  panel.requests[1].resolve(response({ ...snapshot('恢复项目 A'), scope: 'workspace' }));
  await settle();
  assert.equal(panel.elements.get('[data-testid="fons-quick-add"]').disabled, false);
  assert.equal(panel.elements.get('.rows').children.length, 1);
});

test('missing host bridge is reported without calling the API', async () => {
  const panel = harness({ host: false });
  panel.tick();
  await settle();
  assert.equal(panel.requests.length, 0);
  assert.match(panel.elements.get('.empty').textContent, /宿主/);
});

const snapshot = (text = '原会话内容') => ({
  registered: true,
  items: [{ id: '111111111111', token: 'token', status: 'buffering', text, raw: text, rowIndex: 0, remainingMs: 30000, editingHold: false }],
  etag: 'etag-1', debounceMs: 45000, canArchive: false,
});

test('authorization failure clears previous content and the next poll reloads a full snapshot', async () => {
  const panel = harness();
  panel.workspace(['file:///project']);
  panel.requests[0].resolve(response(snapshot()));
  await settle();
  assert.equal(panel.elements.get('.rows').children.length, 1);
  panel.elements.get('[data-testid="fons-quick-add"]').value = '未提交内容';
  panel.tick();
  assert.equal(JSON.parse(panel.requests[1].options.body).etag, 'etag-1');
  panel.requests[1].resolve(response({ error: '会话授权失效' }, 403));
  await settle();
  assert.equal(panel.elements.get('.rows').children.length, 0);
  assert.equal(panel.elements.get('[data-testid="fons-quick-add"]').value, '');
  assert.match(panel.elements.get('.empty').textContent, /会话授权失效/);
  panel.tick();
  assert.equal(JSON.parse(panel.requests[2].options.body).etag, undefined);
  panel.requests[2].resolve(response(snapshot('恢复后内容')));
  await settle();
  assert.equal(panel.elements.get('.rows').children.length, 1);
  assert.equal(panel.elements.get('.empty').hidden, true);
});

test('host session switching discards the old response before it is shown', async () => {
  const panel = harness();
  panel.workspace(['file:///project']);
  const nextId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  panel.sidecar.conversationId = nextId;
  panel.requests[0].resolve(response(snapshot()));
  await settle();
  assert.equal(panel.elements.get('.rows').children.length, 0);
  assert.match(panel.elements.get('.empty').textContent, /正在读取/);
  panel.tick();
  assert.equal(JSON.parse(panel.requests[1].options.body).conversationId, nextId);
  panel.requests[1].resolve(response({ registered: false }));
  await settle();
  assert.match(panel.elements.get('.empty').textContent, /未登记/);
});

test('repeated identical workspace notifications do not restart the pending request', async () => {
  const panel = harness();
  panel.workspace(['file:///project']);
  panel.workspace(['file:///project']);
  panel.tick();
  assert.equal(panel.requests.length, 1);
  panel.requests[0].resolve(response({ registered: false }));
  await settle();
  assert.match(panel.elements.get('.empty').textContent, /未登记/);
});

test('missing secure fetch disables the panel', async () => {
  const panel = harness({ secureFetch: false });
  panel.tick();
  await settle();
  assert.equal(panel.requests.length, 0);
  assert.match(panel.elements.get('.empty').textContent, /宿主/);
});

function submit(panel, value) {
  const input = panel.elements.get('[data-testid="fons-quick-add"]');
  input.value = value;
  input.listeners.keydown({ key: 'Enter', isComposing: false, preventDefault() {} });
}

async function openRegistered(panel) {
  panel.workspace(['file:///project-a']);
  panel.requests.at(-1).resolve(response(snapshot()));
  await settle();
}

test('workspace changes keep the old host ID blocked until it changes or the original workspace returns', async () => {
  const panel = harness();
  await openRegistered(panel);
  panel.elements.get('[data-testid="fons-quick-add"]').value = '旧草稿';
  panel.workspace(['file:///project-b']);
  panel.tick();
  assert.equal(panel.requests.length, 1);
  assert.equal(panel.elements.get('.rows').children.length, 0);
  assert.equal(panel.elements.get('[data-testid="fons-quick-add"]').value, '');
  assert.equal(panel.elements.get('[data-testid="fons-quick-add"]').disabled, true);
  assert.match(panel.elements.get('.empty').textContent, /切换|重新打开/);
  panel.workspace([]);
  assert.match(panel.elements.get('.empty').textContent, /工作区|项目/);
  panel.workspace(['file:///project-b']);
  panel.tick();
  assert.equal(panel.requests.length, 1);
  panel.workspace(['file:///project-a']);
  assert.equal(panel.requests.length, 2);
  panel.requests[1].resolve(response(snapshot()));
  await settle();
  panel.workspace(['file:///project-b']);
  assert.equal(panel.requests.length, 2);
  panel.sidecar.conversationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  panel.tick();
  assert.equal(panel.requests.length, 3);
  assert.equal(JSON.parse(panel.requests[2].options.body).conversationId, panel.sidecar.conversationId);
});

test('reordering a multi-root workspace does not reset or reload the panel', async () => {
  const panel = harness();
  panel.workspace(['file:///project-a', 'file:///project-b']);
  panel.requests[0].resolve(response(snapshot()));
  await settle();
  panel.workspace(['file:///project-b', 'file:///project-a']);
  assert.equal(panel.requests.length, 1);
  assert.equal(panel.elements.get('.rows').children.length, 1);
  assert.equal(panel.elements.get('[data-testid="fons-quick-add"]').disabled, false);
});

test('queued old-session writes are not sent and their drafts do not return to a new session', async () => {
  const panel = harness();
  await openRegistered(panel);
  submit(panel, '第一条');
  await settle();
  assert.equal(panel.requests[1].url, '/api/pool/add');
  submit(panel, '第二条');
  await settle();
  assert.equal(panel.requests.length, 2);
  panel.sidecar.conversationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  panel.tick();
  assert.equal(panel.requests.length, 3);
  panel.requests[1].resolve(response({ error: '写入失败' }, 500));
  await settle();
  assert.equal(panel.requests.length, 3);
  assert.equal(panel.elements.get('[data-testid="fons-quick-add"]').value, '');
  panel.requests[2].resolve(response({ registered: false }));
  await settle();
  assert.equal(panel.elements.get('[data-testid="fons-quick-add"]').value, '');
});

test('a failed write in the same session restores its input', async () => {
  const panel = harness();
  await openRegistered(panel);
  submit(panel, '待恢复的草稿');
  await settle();
  panel.requests[1].resolve(response({ error: '写入失败' }, 500));
  await settle();
  panel.requests[2].resolve(response(snapshot()));
  await settle();
  assert.equal(panel.elements.get('[data-testid="fons-quick-add"]').value, '待恢复的草稿');
});

test('a previously seen session keeps its original workspace when revisited', async () => {
  const panel = harness();
  await openRegistered(panel);
  const idA = panel.sidecar.conversationId;
  const idB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  panel.workspace(['file:///project-b']);
  panel.sidecar.conversationId = idB;
  panel.tick();
  assert.equal(panel.requests.length, 2);
  panel.requests[1].resolve(response(snapshot('会话 B')));
  await settle();
  panel.sidecar.conversationId = idA;
  panel.tick();
  assert.equal(panel.requests.length, 2);
  assert.equal(panel.elements.get('.rows').children.length, 0);
  assert.equal(panel.elements.get('[data-testid="fons-quick-add"]').disabled, true);
  assert.match(panel.elements.get('.empty').textContent, /切换|重新打开/);
  panel.workspace(['file:///project-a']);
  assert.equal(panel.requests.length, 3);
  assert.equal(JSON.parse(panel.requests[2].options.body).conversationId, idA);
});

test('archive notice does not leak across a session switch during refresh', async () => {
  const panel = harness();
  await openRegistered(panel);
  panel.elements.get('[data-testid="fons-archive"]').listeners.click();
  await settle();
  assert.equal(panel.requests[1].url, '/api/pool/archive');
  panel.requests[1].resolve(response({ count: 2 }));
  await settle();
  assert.equal(panel.requests[2].url, '/api/pool');
  panel.sidecar.conversationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  panel.tick();
  assert.equal(panel.requests.length, 4);
  panel.requests[2].resolve(response(snapshot()));
  await settle();
  assert.doesNotMatch(panel.elements.get('.notice').textContent, /已归档/);
  panel.requests[3].resolve(response({ registered: false }));
  await settle();
});

test('waterline flow toggle switches between upward and rightward water transforms and persists choice', async () => {
  const panel = harness();
  await openRegistered(panel);
  const [row] = panel.elements.get('.rows').children;
  const water = row.querySelector('.row-water');
  assert.equal(panel.elements.get('.pool').dataset.flow, 'up');
  assert.match(water.style.transform, /^scaleY\(/);
  panel.elements.get('[data-testid="fons-flow-mode"]').listeners.click();
  assert.equal(panel.elements.get('.pool').dataset.flow, 'right');
  assert.equal(panel.storage.get('fons.waterFlow'), 'right');
  assert.match(water.style.transform, /^scaleX\(/);
});

test('an in-flight old edit conflict cannot notify the newly active conversation', async () => {
  const panel = harness();
  await openRegistered(panel);
  const [row] = panel.elements.get('.rows').children;
  row.isConnected = true;
  const input = row.querySelector('textarea');
  input.value = 'edited in A';
  input.listeners.blur();
  await settle();
  assert.equal(panel.requests[1].url, '/api/pool/update');
  panel.sidecar.conversationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  panel.tick();
  row.isConnected = false;
  panel.requests[2].resolve(response(snapshot('B row')));
  await settle();
  panel.requests[1].resolve(response({ conflict: true }));
  await settle();
  assert.doesNotMatch(panel.elements.get('.notice').textContent, /内容已被修改/);
  assert.equal(panel.elements.get('.rows').children[0].item.text, 'B row');
});

test('per-row hold pauses only the focused buffering row while delivered and done rows stay read-only', async () => {
  const panel = harness();
  panel.workspace(['file:///project-a']);
  panel.requests[0].resolve(response({
    registered: true,
    items: [
      { id: 'aaaaaaaaaaaa', token: 't1', status: 'buffering', text: '草稿一', raw: '- [ ] 草稿一\n', rowIndex: 0, remainingMs: 30000, editingHold: false },
      { id: 'bbbbbbbbbbbb', token: 't2', status: 'buffering', text: '草稿二', raw: '- [ ] 草稿二\n', rowIndex: 1, remainingMs: 15000, editingHold: false },
      { id: 'cccccccccccc', token: 't3', status: 'delivered', text: '已投递项', raw: '- [ ] 已投递项\n', rowIndex: 2, remainingMs: 0, editingHold: false },
      { id: 'dddddddddddd', token: 't4', status: 'done', text: '已完成项', raw: '【√】 已完成项\n', rowIndex: 3, remainingMs: 0, editingHold: false },
    ],
    etag: 'etag-multi-1', debounceMs: 45000, canArchive: true,
  }));
  await settle();
  const [row1, row2, deliveredRow, doneRow] = panel.elements.get('.rows').children;
  for (const r of [row1, row2, deliveredRow, doneRow]) r.isConnected = true;

  assert.equal(row1.querySelector('textarea').readOnly, false);
  assert.equal(deliveredRow.querySelector('textarea').readOnly, true);
  assert.equal(doneRow.querySelector('textarea').readOnly, true);

  deliveredRow.querySelector('textarea').listeners.focus();
  await settle();
  assert.equal(panel.requests.length, 1);

  const input1 = row1.querySelector('textarea');
  input1.listeners.focus();
  await settle();
  assert.equal(row1.dataset.holding, 'true');
  assert.equal(row2.dataset.holding, undefined);
  assert.equal(row1.querySelector('.row-timer').textContent, '暂缓');
  assert.equal(row2.querySelector('.row-timer').textContent, '15s');
  assert.equal(panel.requests[1].url, '/api/pool/hold');
  assert.equal(JSON.parse(panel.requests[1].options.body).id, 'aaaaaaaaaaaa');
  panel.requests[1].resolve(response({ editingHold: true, id: 'aaaaaaaaaaaa' }));
  await settle();
  panel.requests[2].resolve(response({ unchanged: true, etag: 'etag-multi-1' }));
  await settle();

  input1.listeners.blur();
  await settle();
  const releaseReq = panel.requests.find((req) => req.url === '/api/pool/release');
  assert.ok(releaseReq, 'blur without changes sends release for that item');
  assert.equal(JSON.parse(releaseReq.options.body).id, 'aaaaaaaaaaaa');
});

test('active typing skips background polling until quiet', async () => {
  const panel = harness();
  await openRegistered(panel);
  const quick = panel.elements.get('[data-testid="fons-quick-add"]');
  quick.value = '正在输入';
  quick.listeners.input();
  panel.tick();
  await settle();
  assert.equal(panel.requests.length, 1);
});

test('a conflicted blur edit still releases its active hold immediately', async () => {
  const panel = harness();
  await openRegistered(panel);
  const [row] = panel.elements.get('.rows').children;
  row.isConnected = true;
  const input = row.querySelector('textarea');
  input.listeners.focus();
  await settle();
  assert.equal(panel.requests[1].url, '/api/pool/hold');
  panel.requests[1].resolve(response({ editingHold: true, id: '111111111111' }));
  await settle();
  panel.requests[2].resolve(response({ unchanged: true, etag: 'etag-1' }));
  await settle();

  input.value = 'conflicted edit';
  input.listeners.input();
  input.listeners.blur();
  await settle();
  assert.equal(panel.requests[3].url, '/api/pool/update');
  panel.requests[3].resolve(response({ conflict: true }));
  await settle();
  panel.requests[4].resolve(response(snapshot('外部修改后内容')));
  await settle();
  const releaseReq = panel.requests.find((req) => req.url === '/api/pool/release');
  assert.ok(releaseReq, 'conflicted blur still sends release');
  assert.equal(JSON.parse(releaseReq.options.body).id, '111111111111');
});

function attachMotion(panel, rowHeight = 36) {
  const animations = [];
  const pool = panel.elements.get('.pool');
  const rows = panel.elements.get('.rows');
  const empty = panel.elements.get('.empty');
  pool.getBoundingClientRect = () => ({ top: 0, left: 0, width: 320, height: 480 });
  const equip = (node) => {
    node.getBoundingClientRect = () => {
      if (!empty.hidden) return { top: 0, left: 0, width: 0, height: 0 };
      const idx = rows.children.indexOf(node);
      if (idx < 0) return { top: 0, left: 0, width: 0, height: 0 };
      return { top: 44 + idx * rowHeight, left: 8, width: 304, height: rowHeight };
    };
    node.animate = (keyframes, options) => {
      const anim = { node, keyframes, options, onfinish: null, oncancel: null, cancelled: false, cancel() { this.cancelled = true; this.oncancel?.(); } };
      animations.push(anim);
      return anim;
    };
    const origClone = node.cloneNode.bind(node);
    node.cloneNode = (deep) => {
      const clone = origClone(deep);
      clone.animate = (keyframes, options) => {
        const anim = { node: clone, keyframes, options, onfinish: null, oncancel: null, cancelled: false, cancel() { this.cancelled = true; this.oncancel?.(); } };
        animations.push(anim);
        return anim;
      };
      return clone;
    };
  };
  for (const row of rows.children) equip(row);
  return animations;
}

test('deleting a buffering row while its remove button is focused removes it immediately with exit animation', async () => {
  const panel = harness();
  await openRegistered(panel);
  const [row] = panel.elements.get('.rows').children;
  row.isConnected = true;
  const animations = attachMotion(panel);
  const removeBtn = row.querySelector('.remove');
  panel.document.activeElement = removeBtn;

  removeBtn.listeners.click();
  await settle();
  // Rapid second click while removal is in flight must be ignored
  removeBtn.listeners.click();
  await settle();
  assert.equal(panel.requests.length, 2);
  assert.equal(panel.requests[1].url, '/api/pool/remove');

  panel.requests[1].resolve(response({ conflict: false }));
  await settle();
  assert.equal(panel.requests[2].url, '/api/pool');
  panel.requests[2].resolve(response({ registered: true, items: [], etag: 'etag-empty', debounceMs: 45000, canArchive: false }));
  await settle();

  assert.equal(panel.elements.get('.rows').children.length, 0);
  assert.equal(panel.elements.get('.pool').dataset.phase, 'idle');
  assert.equal(panel.elements.get('.empty').hidden, false);
  assert.equal(panel.elements.get('.notice').textContent, '');
  const ghostAnim = animations.find((a) => a.node.className === 'row ghost');
  assert.ok(ghostAnim, 'exit animation plays even when deleting the last item');
  assert.equal(ghostAnim.node.querySelector('textarea').value, '原会话内容');
  assert.equal(ghostAnim.node.style.top, '44px');
  assert.equal(ghostAnim.node.style.height, '36px');
  assert.equal(panel.elements.get('.pool').children.includes(ghostAnim.node), true);
  ghostAnim.onfinish();
  assert.equal(panel.elements.get('.pool').children.includes(ghostAnim.node), false);
});

test('deleting the first of two buffering rows removes it at its original slot and glides the remaining row up', async () => {
  const panel = harness();
  panel.workspace(['file:///project-a']);
  const first = { id: 'aaaaaaaaaaaa', token: 't1', status: 'buffering', text: '第一条', raw: '- [ ] 第一条\n', rowIndex: 0, remainingMs: 30000, editingHold: false };
  const second = { id: 'bbbbbbbbbbbb', token: 't2', status: 'buffering', text: '第二条', raw: '- [ ] 第二条\n', rowIndex: 1, remainingMs: 20000, editingHold: false };
  panel.requests[0].resolve(response({ registered: true, items: [first, second], etag: 'etag-2', debounceMs: 45000, canArchive: false }));
  await settle();

  const [row1, row2] = panel.elements.get('.rows').children;
  row1.isConnected = true;
  row2.isConnected = true;
  const animations = attachMotion(panel, 36);
  const removeBtn = row1.querySelector('.remove');
  panel.document.activeElement = removeBtn;

  removeBtn.listeners.click();
  await settle();
  assert.equal(panel.requests[1].url, '/api/pool/remove');
  panel.requests[1].resolve(response({ conflict: false }));
  await settle();
  panel.requests[2].resolve(response({
    registered: true,
    items: [{ ...second, rowIndex: 0 }],
    etag: 'etag-1-left', debounceMs: 45000, canArchive: false,
  }));
  await settle();

  assert.equal(panel.elements.get('.rows').children.length, 1);
  assert.equal(panel.elements.get('.rows').children[0], row2);
  assert.equal(row2.item.text, '第二条');
  assert.equal(row2.item.rowIndex, 0);
  const ghostAnim = animations.find((a) => a.node.className === 'row ghost');
  assert.ok(ghostAnim);
  assert.equal(ghostAnim.node.style.top, '44px');
  const shiftAnim = animations.find((a) => a.node === row2);
  assert.ok(shiftAnim, 'remaining sibling plays FLIP shift animation');
  assert.equal(shiftAnim.keyframes[0].transform, 'translateY(36px)');
});

test('deleting a row whose textarea was cleared or conflicted externally still detaches the stale row', async () => {
  const panel = harness();
  await openRegistered(panel);
  const [row] = panel.elements.get('.rows').children;
  row.isConnected = true;
  row.dirty = true;
  row.querySelector('textarea').value = '';
  const removeBtn = row.querySelector('.remove');
  panel.document.activeElement = removeBtn;

  removeBtn.listeners.click();
  await settle();
  assert.equal(panel.requests[1].url, '/api/pool/remove');
  panel.requests[1].resolve(response({ conflict: true }));
  await settle();
  panel.requests[2].resolve(response({ registered: true, items: [], etag: 'etag-gone', debounceMs: 45000, canArchive: false }));
  await settle();

  assert.equal(panel.elements.get('.notice').textContent, '内容已被修改');
  assert.equal(panel.elements.get('.rows').children.length, 0);
  assert.equal(panel.elements.get('.pool').dataset.phase, 'idle');
});
