// Regression test for two bugs in the receive/send transfer pipeline:
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
// Both are reproduced here without touching any real OS file picker: the
// File System Access API is mocked with in-memory handles via
// context.addInitScript(), so the app's actual pairing -> connect ->
// accept -> share -> download flow runs against a real local signaling
// server and a real (loopback) WebRTC DataChannel, headless and fully
// automated.
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
const FILE_SIZE = 40 * 1024 * 1024; // > 128 chunks, so a mid-transfer checkpoint fires

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
// dialog -- they resolve immediately with in-memory fake handles.
function initFakePickers(fileSize) {
  window.__injectCloseFailure = false;
  window.__closeCallCount = 0;

  function withHiddenMethods(base, methods) {
    // Real FileSystemFileHandle objects are structured-clone-safe (the app
    // stores them in IndexedDB for resumability). Fake handles are plain
    // objects, so their methods must be non-enumerable or IndexedDB's
    // structured-clone step throws trying to clone a function.
    for (const [key, fn] of Object.entries(methods)) {
      Object.defineProperty(base, key, { value: fn, enumerable: false, configurable: true });
    }
    return base;
  }

  window.showOpenFilePicker = async () => {
    const bytes = new Uint8Array(fileSize);
    for (let i = 0; i < fileSize; i++) bytes[i] = i & 0xff;
    const file = new File([bytes], 'bigfile.bin', { type: 'application/octet-stream' });
    return [withHiddenMethods({ kind: 'file', name: 'bigfile.bin' }, {
      getFile: async () => file,
      queryPermission: async () => 'granted',
      requestPermission: async () => 'granted',
    })];
  };

  window.showSaveFilePicker = async (opts) => {
    window.__receiveBuffer = new Uint8Array(fileSize);
    return withHiddenMethods({ kind: 'file', name: opts.suggestedName }, {
      queryPermission: async () => 'granted',
      requestPermission: async () => 'granted',
      createWritable: async () => ({
        write: async ({ position, data }) => window.__receiveBuffer.set(data, position),
        close: async () => {
          window.__closeCallCount++;
          if (window.__closeCallCount === 1 && window.__injectCloseFailure) {
            throw new DOMException(
              'Write access failed. File may be blocked for security reasons.',
              'NotAllowedError'
            );
          }
        },
      }),
    });
  };

  window.__verifyReceived = () => {
    const buf = window.__receiveBuffer;
    if (!buf) return { ok: false, reason: 'no buffer' };
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] !== (i & 0xff)) return { ok: false, reason: `mismatch at byte ${i}` };
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

  const first = await pollProgress(receiver, { timeoutMs: 20000, stallMs: 4000 });
  assert(first.stalled && !first.done, `transfer pauses at the injected failure point (value=${first.value})`);
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

async function main() {
  console.log(`Starting signaling server on port ${TEST_PORT}...`);
  const server = await startServer();
  const browser = await chromium.launch({ headless: true });
  try {
    await testNormalTransferCompletes(browser);
    await testWriteFailureRecoversViaResume(browser);
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
