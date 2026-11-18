import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../sidecars/fons-pool/index.html', import.meta.url), 'utf8');
const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];

class Element {
  constructor() { this.hidden = false; this.disabled = false; this.textContent = ''; this.value = ''; this.style = {}; this.children = []; this.dataset = {}; this.listeners = {}; this.scrollHeight = 20; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  replaceChildren(...children) { this.children = children; }
  append(...children) { this.children.push(...children); }
  insertBefore(child, anchor) { const old = this.children.indexOf(child); if (old >= 0) this.children.splice(old, 1); const i = this.children.indexOf(anchor); this.children.splice(i < 0 ? this.children.length : i, 0, child); }
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
  for (const selector of ['.rows', '.empty', '[data-testid="fons-quick-add"]', '[data-testid="fons-countdown"]', '[data-testid="fons-flush"]', '[data-testid="fons-archive"]', '.warning', '.notice', '.pool']) elements.set(selector, new Element());
  const requests = [];
  let workspaceChange;
  let tick;
  const sidecar = { conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', fetch(url, options) { const response = deferred(); requests.push({ url, options, ...response }); return response.promise; } };
  if (host) sidecar.onWorkspaceChange = (callback) => { workspaceChange = callback; return () => {}; };
  if (!secureFetch) delete sidecar.fetch;
  const document = { hidden: false, activeElement: null, querySelector: (selector) => elements.get(selector), querySelectorAll: () => [], createElement(tag) { const el = new Element(); el.tag = tag; return el; }, addEventListener() {} };
  vm.runInNewContext(script, { window: { sidecar }, document, location: { search: '' }, URLSearchParams, Promise, Date, setTimeout: () => 0, clearTimeout() {}, setInterval: (callback) => { tick = callback; }, queueMicrotask, fetch: sidecar.fetch });
  return { elements, requests, sidecar, workspace: (value) => workspaceChange(value), tick };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });

test('waits for the host workspace, then stops polling when there is no project', async () => {
  const panel = harness();
  assert.equal(panel.requests.length, 0);
  panel.workspace([]);
  panel.tick();
  await settle();
  assert.equal(panel.requests.length, 0);
  assert.match(panel.elements.get('.empty').textContent, /工作区|项目/);
  assert.equal(panel.elements.get('[data-testid="fons-quick-add"]').disabled, true);
  panel.workspace(['file:///project']);
  await settle();
  assert.equal(panel.requests.length, 1);
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

test('a response from a workspace that has closed cannot restore its contents', async () => {
  const panel = harness();
  panel.workspace(['file:///project']);
  await settle();
  panel.workspace([]);
  panel.requests[0].resolve(response({ registered: false }));
  await settle();
  assert.match(panel.elements.get('.empty').textContent, /工作区|项目/);
  assert.equal(panel.elements.get('[data-testid="fons-quick-add"]').disabled, true);
});

test('missing host bridge is reported without calling the API', async () => {
  const panel = harness({ host: false });
  panel.tick();
  await settle();
  assert.equal(panel.requests.length, 0);
  assert.match(panel.elements.get('.empty').textContent, /宿主/);
});

const snapshot = (text = '原会话内容') => ({
  registered: true, items: [{ token: 'token', status: 'buffering', text, raw: text, rowIndex: 0 }],
  etag: 'etag-1', debounceRemainingMs: 0, flushPending: false, canArchive: false,
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

test('a successful flush cannot show its notice after switching during the refresh', async () => {
  const panel = harness();
  await openRegistered(panel);
  panel.elements.get('[data-testid="fons-flush"]').listeners.click();
  await settle();
  assert.equal(panel.requests[1].url, '/api/pool/flush');
  panel.requests[1].resolve(response({ flushRequestedAt: 1 }));
  await settle();
  assert.equal(panel.requests[2].url, '/api/pool');
  panel.sidecar.conversationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  panel.tick();
  assert.equal(panel.requests.length, 4);
  panel.requests[2].resolve(response(snapshot()));
  await settle();
  assert.doesNotMatch(panel.elements.get('.notice').textContent, /将在下次模型调用时投递/);
  panel.requests[3].resolve(response({ registered: false }));
  await settle();
});

test('a successful flush shows its notice when the session remains current', async () => {
  const panel = harness();
  await openRegistered(panel);
  panel.elements.get('[data-testid="fons-flush"]').listeners.click();
  await settle();
  panel.requests[1].resolve(response({ flushRequestedAt: 1 }));
  await settle();
  panel.requests[2].resolve(response(snapshot()));
  await settle();
  assert.match(panel.elements.get('.notice').textContent, /将在下次模型调用时投递/);
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
