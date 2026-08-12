// Regression test for four bugs in the receive/send transfer pipeline:
//
//  1. "Downloads get stuck after a few seconds": RTCDataChannel.send() can
//     throw synchronously (OperationError, "send queue is full") once
//     bufferedAmount hits the browser's internal hard cap. The old
//     pumpChunks() had no try/catch around the send, so this became an
//     unhandled rejection that silently killed the send loop mid-transfer.
//
//  2. ".exe causes a console error": Transfers.handleBinary() chained every
//     chunk write through a promise queue with no .catch(). Any failure in
//     write()/close()/createWritable() -- which is exactly what Chrome's
//     Safe Browsing check can throw when closing a writable stream for a
//     blocked extension -- permanently poisoned that queue: every later
//     chunk silently no-op'd, so the transfer looked frozen forever.
//
//  3. "Transfers slow down and leave a second full-size copy of the file on
//     disk": createWritable({keepExistingData: true}) copies the *entire*
//     existing file into a fresh swap file every time it's called. Closing
//     and reopening the writable on a periodic checkpoint (every N chunks /
//     M seconds) turned that into O(bytes^2) of copying and left a second
//     full-size copy of the file on disk for the duration of every
//     checkpoint. The writable is now opened once and closed exactly once,
//     when the transfer actually finishes.
//
//  4. "Resuming after a reload doesn't work": a receiver's own page reload
//     never runs its own disconnect handler, so a record left at status
//     'in-progress' from before the reload stayed there forever -- none of
//     the UI's button conditions match that status, so no Resume button
//     ever appears. Status is now normalized to 'interrupted' on load.
//
//  5. "A second tab breaks things": two tabs sharing the same identity would
//     both register with the signaling server and both hold their own copy
//     of local state, fighting over the same peer connection and transfer
//     records. App.init() now acquires an exclusive Web Locks API mutex
//     keyed by peerId before touching any shared state; a second tab that
//     can't acquire it shows a blocking message instead of initializing.
//
// All four are reproduced here without touching any real OS file picker:
// the File System Access API is mocked with handles backed by a real
// IndexedDB store via context.addInitScript(), so the app's actual pairing
// -> connect -> accept -> share -> download flow runs against a real local
// signaling server and a real (loopback) WebRTC DataChannel, headless and
// fully automated -- including surviving a real page reload, the way a
// genuine FileSystemFileHandle (natively structured-clone-safe) would.
//
// Usage: npm test   (from this directory)

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, '..', 'server', 'server.js');
const TEST_PORT = 8098; // dedicated to this test, distinct from the dev server's default
const BASE_URL = `http://localhost:${TEST_PORT}/`;
const FILE_SIZE = 40 * 1024 * 1024;

let failures = 0;
function assert(cond, message) {
  if (!cond) {
    failures++;
    console.error(`FAIL: ${message}`);
  } else {
    console.log(`ok: ${message}`);
  }
}

function startServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [SERVER_PATH], {
      env: { ...process.env, PORT: String(TEST_PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let settled = false;
    proc.stdout.on('data', (chunk) => {
      if (!settled && chunk.toString().includes('Server listening')) {
        settled = true;
        resolve(proc);
      }
    });
    proc.stderr.on('data', (chunk) => process.stderr.write(chunk));
    proc.on('exit', (code) => {
      if (!settled) reject(new Error(`server exited early with code ${code}`));
    });
    setTimeout(() => { if (!settled) reject(new Error('server did not start in time')); }, 5000);
  });
}

// Injected into each browser context before any page script runs, so the
// app's calls to showOpenFilePicker/showSaveFilePicker never hit a real OS
// dialog -- they resolve immediately with fake handles.
//
// Bytes live in a real IndexedDB store (survives a page reload, unlike a
// plain in-memory buffer), and the handle's own methods are rehydrated via
// an IDBObjectStore.getAll patch after they come back out of the *app's*
// IndexedDB (where fileHandle gets persisted for resumability) -- a real
// FileSystemFileHandle is natively structured-clone-safe there, which is
// the browser feature this whole resumable-download design leans on; a
// plain mock object always loses its (necessarily non-enumerable) methods
// to structured clone, so this patch is what lets the mock exercise that
// same round trip headlessly.
function initFakePickers(fileSize) {
  window.__injectCloseFailure = false;
  window.__closeCallCount = 0;
  window.__createWritableLog = [];

  const DB_NAME = 'mock-fsa-backing-store';
  function openBackingDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('files');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function getRecord(id) {
    const db = await openBackingDB();
    return new Promise((resolve, reject) => {
      const req = db.transaction('files', 'readonly').objectStore('files').get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }
  async function putRecord(id, record) {
    const db = await openBackingDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('files', 'readwrite');
      tx.objectStore('files').put(record, id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  function attachMethods(obj) {
    if (!obj || typeof obj !== 'object' || typeof obj.queryPermission === 'function') return obj;
    const def = (key, value) => Object.defineProperty(obj, key, { value, enumerable: false, configurable: true });
    if (obj.__mockRole === 'source') {
      def('getFile', async () => new File([(await getRecord(obj.__mockId)).bytes], obj.name, { type: 'application/octet-stream' }));
      def('queryPermission', async () => 'granted');
      def('requestPermission', async () => 'granted');
    } else if (obj.__mockRole === 'dest') {
      def('queryPermission', async () => 'granted');
      def('requestPermission', async () => 'granted');
      def('createWritable', async ({ keepExistingData } = {}) => {
        // committedLength tracks how much of the destination is real,
        // previously-closed data -- separate from the working buffer's
        // (always fileSize) length, so this mirrors the real cost: a fresh
        // destination has nothing to copy, a resumed one copies only what
        // was actually committed by an earlier close().
        const existing = await getRecord(obj.__mockId);
        const committedLength = existing ? existing.committedLength : 0;
        window.__createWritableLog.push({ t: Date.now(), copiedBytes: keepExistingData ? committedLength : 0 });
        const working = existing ? existing.bytes.slice() : new Uint8Array(fileSize);
        let pendingLength = committedLength;
        return {
          write: async ({ position, data }) => {
            working.set(data, position);
            pendingLength = Math.max(pendingLength, position + data.byteLength);
          },
          close: async () => {
            window.__closeCallCount++;
            if (window.__closeCallCount === 1 && window.__injectCloseFailure) {
              throw new DOMException(
                'Write access failed. File may be blocked for security reasons.',
                'NotAllowedError'
              );
            }
            await putRecord(obj.__mockId, { bytes: working, committedLength: pendingLength });
          },
        };
      });
    }
    return obj;
  }

  // Rehydrate any embedded mock handle the instant a getAll() result comes
  // back, before the app's own onsuccess (which it assigns *after* calling
  // getAll()) gets to read req.result -- see IDB.getAll()/Transfers.loadFromIDB().
  const origGetAll = IDBObjectStore.prototype.getAll;
  IDBObjectStore.prototype.getAll = function (...args) {
    const req = origGetAll.apply(this, args);
    req.addEventListener('success', () => {
      const rows = req.result;
      if (Array.isArray(rows)) for (const row of rows) if (row && row.fileHandle) attachMethods(row.fileHandle);
    });
    return req;
  };

  window.showOpenFilePicker = async () => {
    const id = 'source-bigfile.bin';
    let record = await getRecord(id);
    if (!record) {
      const bytes = new Uint8Array(fileSize);
      for (let i = 0; i < fileSize; i++) bytes[i] = i & 0xff;
      record = { bytes, committedLength: fileSize };
      await putRecord(id, record);
    }
    return [attachMethods({ kind: 'file', name: 'bigfile.bin', __mockRole: 'source', __mockId: id })];
  };

  // Deliberately does NOT pre-populate a record for the destination -- a
  // freshly picked save target has nothing committed yet (committedLength
  // 0), matching a real never-before-written file.
  window.showSaveFilePicker = async (opts) => {
    return attachMethods({ kind: 'file', name: opts.suggestedName, __mockRole: 'dest', __mockId: `dest-${opts.suggestedName}` });
  };

  window.__verifyReceived = async () => {
    const record = await getRecord('dest-bigfile.bin');
    if (!record) return { ok: false, reason: 'no dest bytes' };
    const bytes = record.bytes;
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] !== (i & 0xff)) return { ok: false, reason: `mismatch at byte ${i}` };
    }
    return { ok: true };
  };
}

async function waitForText(page, selector, predicate, timeout = 20000) {
  await page.waitForFunction(
    ({ sel, src }) => {
      const el = document.querySelector(sel);
      return el && new Function('text', `return (${src})(text)`)(el.textContent);
    },
    { sel: selector, src: predicate.toString() },
    { timeout }
  );
}

async function pollProgress(page, { timeoutMs, stallMs }) {
  const start = Date.now();
  let lastValue = -1;
  let lastChangeAt = start;
  while (Date.now() - start < timeoutMs) {
    const progress = await page.evaluate(() => {
      const p = document.querySelector('progress');
      return p ? { value: p.value, max: p.max } : null;
    });
    if (progress) {
      if (progress.value !== lastValue) { lastValue = progress.value; lastChangeAt = Date.now(); }
      if (progress.max > 0 && progress.value >= progress.max) return { done: true, stalled: false, value: lastValue };
      if (Date.now() - lastChangeAt > stallMs) return { done: false, stalled: true, value: lastValue };
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { done: false, stalled: false, value: lastValue };
}

async function pairAndConnect(browser) {
  const ctxSender = await browser.newContext();
  const ctxReceiver = await browser.newContext();
  await ctxSender.addInitScript(initFakePickers, FILE_SIZE);
  await ctxReceiver.addInitScript(initFakePickers, FILE_SIZE);

  const sender = await ctxSender.newPage();
  const receiver = await ctxReceiver.newPage();
  const rejections = { sender: [], receiver: [] };
  for (const [label, page] of [['sender', sender], ['receiver', receiver]]) {
    page.on('pageerror', (err) => rejections[label].push(err.message));
  }

  await sender.goto(BASE_URL);
  await receiver.goto(BASE_URL);

  await waitForText(sender, '#own-code', (t) => t && t !== '------');
  const code = await sender.textContent('#own-code');

  await receiver.fill('#connect-code-input', code);
  await receiver.click('#connect-submit-btn');
  await sender.waitForSelector('#incoming-request-overlay:not([hidden])', { timeout: 15000 });
  await sender.click('#accept-btn');
  await waitForText(sender, '#connection-status', (t) => t.includes('Connected'));
  await waitForText(receiver, '#connection-status', (t) => t.includes('Connected'));

  return { ctxSender, ctxReceiver, sender, receiver, rejections };
}

async function testNormalTransferCompletes(browser) {
  console.log('\n--- scenario: plain 40MB transfer should not stall on send-queue-full ---');
  const { ctxSender, ctxReceiver, sender, receiver, rejections } = await pairAndConnect(browser);

  await sender.click('#pick-file-btn');
  await receiver.waitForSelector('li.transfer-row button', { timeout: 15000 });
  await receiver.click('li.transfer-row button');

  const result = await pollProgress(receiver, { timeoutMs: 30000, stallMs: 6000 });
  assert(result.done, `transfer completes without stalling (value=${result.value})`);

  if (result.done) {
    const verify = await receiver.evaluate(() => window.__verifyReceived());
    assert(verify.ok, `received bytes are byte-for-byte correct (${JSON.stringify(verify)})`);
  }
  assert(rejections.sender.length === 0, `sender has no unhandled errors (got: ${JSON.stringify(rejections.sender)})`);
  assert(rejections.receiver.length === 0, `receiver has no unhandled errors (got: ${JSON.stringify(rejections.receiver)})`);

  const createWritableLog = await receiver.evaluate(() => window.__createWritableLog);
  assert(createWritableLog.length === 1, `createWritable() is called exactly once for a completed transfer (got ${createWritableLog.length} calls)`);
  const totalCopied = createWritableLog.reduce((s, e) => s + e.copiedBytes, 0);
  assert(totalCopied === 0, `no bytes are ever re-copied into a fresh swap file mid-transfer (got ${totalCopied})`);

  await ctxSender.close();
  await ctxReceiver.close();
}

async function testWriteFailureRecoversViaResume(browser) {
  console.log('\n--- scenario: injected close() failure should recover via Resume, not hang forever ---');
  const { ctxSender, ctxReceiver, sender, receiver, rejections } = await pairAndConnect(browser);

  await receiver.evaluate(() => { window.__injectCloseFailure = true; });

  await sender.click('#pick-file-btn');
  await receiver.waitForSelector('li.transfer-row button', { timeout: 15000 });
  await receiver.click('li.transfer-row button');

  // The writable is only closed once, when every chunk has actually
  // arrived (see finalizeIfComplete) -- so the injected failure bites on
  // that single final close(), after the progress bar has already reached
  // 100%. Wait for the record to flip to 'interrupted' instead of polling
  // the progress bar, which reaches 100% before that close() is even
  // attempted and would otherwise read as a stall-free success.
  await receiver.waitForFunction(() => {
    const row = document.querySelector('li.transfer-row');
    return !!row && row.textContent.includes('interrupted');
  }, { timeout: 20000 });
  assert(true, 'transfer is marked interrupted by the injected close() failure');
  assert(
    rejections.receiver.length === 0,
    `write failure is caught, not an unhandled rejection (got: ${JSON.stringify(rejections.receiver)})`
  );

  const resumeClicked = await receiver.evaluate(() => {
    const btn = [...document.querySelectorAll('li.transfer-row button')]
      .find((b) => b.textContent.includes('Resume'));
    if (!btn) return false;
    btn.click();
    return true;
  });
  assert(resumeClicked, 'a Resume button is offered after the interruption');

  const second = await pollProgress(receiver, { timeoutMs: 20000, stallMs: 6000 });
  assert(second.done, `transfer completes after clicking Resume (value=${second.value})`);

  if (second.done) {
    const verify = await receiver.evaluate(() => window.__verifyReceived());
    assert(verify.ok, `resumed transfer is byte-for-byte correct (${JSON.stringify(verify)})`);
  }

  await ctxSender.close();
  await ctxReceiver.close();
}

async function testReloadMidTransferResumes(browser) {
  console.log('\n--- scenario: both peers reload mid-transfer, reconnect, and Resume completes it ---');
  const ctxSender = await browser.newContext();
  const ctxReceiver = await browser.newContext();
  await ctxSender.addInitScript(initFakePickers, FILE_SIZE);
  await ctxReceiver.addInitScript(initFakePickers, FILE_SIZE);
  const sender = await ctxSender.newPage();
  const receiver = await ctxReceiver.newPage();
  const rejections = { sender: [], receiver: [] };
  for (const [label, page] of [['sender', sender], ['receiver', receiver]]) {
    page.on('pageerror', (err) => rejections[label].push(err.message));
  }

  await sender.goto(BASE_URL);
  await receiver.goto(BASE_URL);
  await waitForText(sender, '#own-code', (t) => t && t !== '------');
  const code = await sender.textContent('#own-code');
  await receiver.fill('#connect-code-input', code);
  await receiver.click('#connect-submit-btn');
  await sender.waitForSelector('#incoming-request-overlay:not([hidden])', { timeout: 15000 });
  await sender.click('#accept-btn');
  await waitForText(sender, '#connection-status', (t) => t.includes('Connected'));
  await waitForText(receiver, '#connection-status', (t) => t.includes('Connected'));

  await sender.click('#pick-file-btn');
  await receiver.waitForSelector('li.transfer-row button', { timeout: 15000 });
  await receiver.click('li.transfer-row button');

  // let some real progress land before tearing both pages down
  await receiver.waitForFunction(() => (document.querySelector('progress')?.value ?? 0) > 0, { timeout: 15000 });

  const oldCode = await sender.textContent('#own-code');
  await receiver.reload();
  await sender.reload();

  // sender re-registers for a fresh code once it notices the drop; wait for
  // a code DIFFERENT from the old one -- the DOM still shows the old code
  // (non-empty, non-placeholder) until the new 'registered' message lands
  await sender.waitForFunction(
    (old) => document.querySelector('#own-code')?.textContent && document.querySelector('#own-code').textContent !== old,
    oldCode,
    { timeout: 20000 }
  );
  const code2 = await sender.textContent('#own-code');
  await receiver.fill('#connect-code-input', code2);
  await receiver.click('#connect-submit-btn');
  await sender.waitForSelector('#incoming-request-overlay:not([hidden])', { timeout: 15000 });
  await sender.click('#accept-btn');
  await waitForText(sender, '#connection-status', (t) => t.includes('Connected'));
  await waitForText(receiver, '#connection-status', (t) => t.includes('Connected'));

  const receiverBtn = await receiver.waitForSelector('li.transfer-row button:not([disabled])', { timeout: 15000 });
  const receiverBtnText = await receiverBtn.textContent();
  assert(receiverBtnText.includes('Resume'), `receiver shows a Resume button after reload (got "${receiverBtnText}")`);
  await receiverBtn.click();

  const senderBtn = await sender.waitForSelector('li.transfer-row button:not([disabled])', { timeout: 15000 });
  const senderBtnText = await senderBtn.textContent();
  assert(senderBtnText.includes('Resume'), `sender shows a Resume Sharing button after reload (got "${senderBtnText}")`);
  await senderBtn.click();

  const result = await pollProgress(receiver, { timeoutMs: 30000, stallMs: 8000 });
  assert(result.done, `transfer completes after both sides reload and click Resume (value=${result.value})`);
  if (result.done) {
    const verify = await receiver.evaluate(() => window.__verifyReceived());
    assert(verify.ok, `post-reload transfer is byte-for-byte correct (${JSON.stringify(verify)})`);
  }
  assert(rejections.sender.length === 0, `sender has no unhandled errors (got: ${JSON.stringify(rejections.sender)})`);
  assert(rejections.receiver.length === 0, `receiver has no unhandled errors (got: ${JSON.stringify(rejections.receiver)})`);

  await ctxSender.close();
  await ctxReceiver.close();
}

async function testSecondTabIsBlocked(browser) {
  console.log('\n--- scenario: a second tab with the same local state is blocked by the tab lock ---');
  const ctx = await browser.newContext();
  const tab1 = await ctx.newPage();
  await tab1.goto(BASE_URL);
  await tab1.waitForSelector('#own-code', { timeout: 10000 });
  assert(
    await tab1.evaluate(() => !document.querySelector('#app').hidden),
    'first tab initializes normally'
  );

  const tab2 = await ctx.newPage();
  await tab2.goto(BASE_URL);
  await tab2.waitForSelector('#tab-lock-blocked-overlay:not([hidden])', { timeout: 10000 });
  assert(
    await tab2.evaluate(() => document.querySelector('#app').hidden),
    'second tab does not initialize the app while blocked'
  );
  assert(
    await tab1.evaluate(() => !document.querySelector('#app').hidden && document.querySelector('#tab-lock-blocked-overlay').hidden),
    'first tab is unaffected by the second tab opening'
  );

  await tab1.close();
  await tab2.click('#tab-lock-retry-btn');
  await tab2.waitForSelector('#own-code', { timeout: 10000 });
  assert(
    await tab2.evaluate(() => !document.querySelector('#app').hidden),
    'second tab recovers via Try Again once the first tab closes'
  );

  await ctx.close();
}

async function main() {
  console.log(`Starting signaling server on port ${TEST_PORT}...`);
  const server = await startServer();
  const browser = await chromium.launch({ headless: true });
  try {
    await testNormalTransferCompletes(browser);
    await testWriteFailureRecoversViaResume(browser);
    await testReloadMidTransferResumes(browser);
    await testSecondTabIsBlocked(browser);
  } finally {
    await browser.close();
    server.kill();
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('TEST HARNESS ERROR', err);
  process.exit(1);
});
