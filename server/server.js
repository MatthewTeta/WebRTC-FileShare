import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_HTML_PATH = path.join(__dirname, '..', 'client', 'index.html');

function loadEnvFile(filePath) {
  let contents;
  try {
    contents = fs.readFileSync(filePath, 'utf8');
  } catch {
    return;
  }
  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile(path.join(__dirname, '.env'));

const PORT = process.env.PORT || 8087;

// When started under systemd socket activation, the listening socket is
// already open and inherited as fd 3 (SD_LISTEN_FDS_START) — bind to that
// instead of asking the OS for a fresh port.
const usingSocketActivation =
  Number(process.env.LISTEN_FDS) > 0 &&
  process.env.LISTEN_PID === String(process.pid);

const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 6;
const CODE_TTL_MS = 10 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 30 * 1000;

// code -> { ws, createdAt }
const codes = new Map();
// requestId -> { ownerWs, requesterWs, code }
const pendingRequests = new Map();
// sessionId -> { offerer: ws, answerer: ws }
const sessions = new Map();

function generateCode() {
  let code;
  do {
    code = Array.from({ length: CODE_LENGTH }, () =>
      CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]
    ).join('');
  } while (codes.has(code));
  return code;
}

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function freeCodeFor(ws) {
  if (ws.ownedCode && codes.get(ws.ownedCode)?.ws === ws) {
    codes.delete(ws.ownedCode);
  }
  ws.ownedCode = null;
}

function clearPendingRequestFor(ws) {
  if (ws.pendingRequestId && pendingRequests.has(ws.pendingRequestId)) {
    pendingRequests.delete(ws.pendingRequestId);
  }
  ws.pendingRequestId = null;
}

function endSessionFor(ws) {
  if (!ws.sessionId) return;
  const session = sessions.get(ws.sessionId);
  if (session) {
    const other = session.offerer === ws ? session.answerer : session.offerer;
    send(other, { type: 'peer-disconnected', sessionId: ws.sessionId });
    if (other) other.sessionId = null;
    sessions.delete(ws.sessionId);
  }
  ws.sessionId = null;
}

function handleRegister(ws) {
  freeCodeFor(ws);
  const code = generateCode();
  codes.set(code, { ws, createdAt: Date.now() });
  ws.ownedCode = code;
  send(ws, { type: 'registered', code });
}

function handleConnectRequest(ws, msg) {
  const entry = codes.get(msg.code);
  if (!entry || Date.now() - entry.createdAt > CODE_TTL_MS) {
    if (entry) codes.delete(msg.code);
    send(ws, { type: 'connect-error', reason: 'invalid-code' });
    return;
  }
  if (entry.ws === ws) {
    send(ws, { type: 'connect-error', reason: 'invalid-code' });
    return;
  }
  if (entry.ws.pendingRequestId || entry.ws.sessionId) {
    send(ws, { type: 'connect-error', reason: 'busy' });
    return;
  }
  const requestId = crypto.randomUUID();
  pendingRequests.set(requestId, { ownerWs: entry.ws, requesterWs: ws, code: msg.code });
  entry.ws.pendingRequestId = requestId;
  ws.pendingRequestId = requestId;
  send(entry.ws, { type: 'incoming-connect-request', requestId });
}

function handleConnectResponse(ws, msg) {
  const pending = pendingRequests.get(msg.requestId);
  if (!pending || pending.ownerWs !== ws) return;
  pendingRequests.delete(msg.requestId);
  pending.ownerWs.pendingRequestId = null;
  pending.requesterWs.pendingRequestId = null;
  freeCodeFor(pending.ownerWs);

  if (!msg.accept) {
    send(pending.requesterWs, { type: 'connect-denied' });
    handleRegister(pending.ownerWs);
    return;
  }

  const sessionId = crypto.randomUUID();
  sessions.set(sessionId, { offerer: pending.requesterWs, answerer: pending.ownerWs });
  pending.requesterWs.sessionId = sessionId;
  pending.ownerWs.sessionId = sessionId;
  send(pending.requesterWs, { type: 'session-start', sessionId, role: 'offerer' });
  send(pending.ownerWs, { type: 'session-start', sessionId, role: 'answerer' });
}

function handleSignal(ws, msg) {
  const session = sessions.get(msg.sessionId);
  if (!session) return;
  const other = session.offerer === ws ? session.answerer : session.offerer;
  send(other, { type: 'signal', sessionId: msg.sessionId, payload: msg.payload });
}

function handleMessage(ws, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  switch (msg.type) {
    case 'register':
      handleRegister(ws);
      break;
    case 'connect-request':
      handleConnectRequest(ws, msg);
      break;
    case 'connect-response':
      handleConnectResponse(ws, msg);
      break;
    case 'signal':
      handleSignal(ws, msg);
      break;
    default:
      break;
  }
}

const server = http.createServer((req, res) => {
  fs.readFile(CLIENT_HTML_PATH, (err, data) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Failed to load client');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.ownedCode = null;
  ws.pendingRequestId = null;
  ws.sessionId = null;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => handleMessage(ws, raw));

  ws.on('close', () => {
    freeCodeFor(ws);
    if (ws.pendingRequestId) {
      const pending = pendingRequests.get(ws.pendingRequestId);
      if (pending) {
        pendingRequests.delete(ws.pendingRequestId);
        const other = pending.ownerWs === ws ? pending.requesterWs : pending.ownerWs;
        if (other) {
          other.pendingRequestId = null;
          send(other, { type: 'connect-denied' });
        }
      }
    }
    endSessionFor(ws);
  });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_INTERVAL_MS);

wss.on('close', () => clearInterval(heartbeat));

if (usingSocketActivation) {
  server.listen({ fd: 3 }, () => {
    console.log('Server listening on systemd-provided socket (fd 3)');
  });
} else {
  server.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}
