import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeStream } from '../../src/stream.js';
import { frameGeometry } from '../../src/qa-geometry.js';
import { startFakeHost } from './fake-host.js';

// Desk PC only: the real Windows.exe runs behind a pipe bridge, through windows/supervisor/stream.js, into the upstream decoder.
//   RELAY_DESK_HOST=<Windows.exe>  RELAY_DESK_WINDOW=<process name of an own test window that repaints>  [RELAY_DESK_STATIC=<process name of an own window that never repaints>]
const exe = process.env.RELAY_DESK_HOST;
const skip = process.platform !== 'win32' || !exe || !process.env.RELAY_DESK_WINDOW ? 'needs a desk PC: RELAY_DESK_HOST and RELAY_DESK_WINDOW' : false;
const supervisor = fileURLToPath(new URL('../supervisor/stream.js', import.meta.url));
const token = 'b'.repeat(64), owner = 'desk-owner';

const rowFor = name => {
  const list = JSON.parse(execFileSync(exe, ['windows']).toString());
  const row = list.windows.find(w => w.displayName === name);
  assert.ok(row, 'no window of process ' + name);
  return row;
};

// Packets are decoded until stop(packets) says so; the host sees the supervisor's argv and one 0x06 per packet.
async function run(row, stop) {
  const dir = mkdtempSync(path.join(tmpdir(), 'rs-desk-'));
  const endpoint = '\\\\.\\pipe\\relay-desk-' + path.basename(dir);
  writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ generation: 1, lease: { owner, token, expiresAt: Date.now() / 1000 + 600 } }), { mode: 0o600 });
  let hostExit;
  const fake = await startFakeHost(endpoint, ({ args, socket, seen }) => {
    const host = spawn(exe, args, { stdio: ['pipe', 'pipe', 'inherit'] });
    host.stdin.on('error', () => {});
    let acked = 0;
    host.stdout.pipe(socket);
    host.on('exit', code => { hostExit = code; socket.end(); });
    socket.on('close', () => host.kill());
    socket.on('acks', () => { host.stdin.write(Buffer.alloc(seen.acks - acked, 6)); acked = seen.acks; });
  });
  const target = { windowId: row.windowId, pid: row.pid, bundleId: row.bundleId };
  const child = spawn(process.execPath, [supervisor, 'stream'], { env: { ...process.env, RELAY_STATE_DIR: dir, RELAY_HOST_ENDPOINT: endpoint }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.on('error', () => {});
  child.stdin.write(JSON.stringify({ owner, workspace: '/w', args: { lease: { token, generation: 1 } }, mode: 'stream', target, timeout: 60 }) + '\n');
  const packets = [];
  try {
    for await (const packet of decodeStream(child.stdout)) {
      packet.receivedMono = performance.now();
      packets.push(packet);
      child.stdin.write(Buffer.from([6]));
      if (stop(packets)) { child.stdin.end(); break; }
    }
  } finally { child.kill(); await fake.close(); rmSync(dir, { recursive: true, force: true }); }
  return { packets, stderr, target, hostExit };
}

const snapshot = (row, target) => ({ target, windowRectPoints: row.windowRectPoints, processStartedAt: row.processStartedAt });

test('desk: own window frames pass decodeStream and frameGeometry with the exact start and rect', { skip, timeout: 60000 }, async () => {
  const row = rowFor(process.env.RELAY_DESK_WINDOW);
  const { packets, target } = await run(row, p => p.length >= 12);
  const frames = packets.filter(p => p.header.type === 'frame');
  assert.ok(frames.length >= 10, 'frames: ' + frames.length);
  frames.forEach((frame, i) => {
    assert.equal(frame.header.sequence, frames[0].header.sequence + i);
    frameGeometry(frame, snapshot(row, target), row.processStartedAt);
  });
});

test('desk: a window that never repaints gets heartbeats about every 2 s', { skip: skip || !process.env.RELAY_DESK_STATIC && 'RELAY_DESK_STATIC not set', timeout: 60000 }, async () => {
  const row = rowFor(process.env.RELAY_DESK_STATIC);
  const started = performance.now();
  const { packets } = await run(row, p => p.filter(x => x.header.type === 'heartbeat').length >= 2);
  assert.equal(packets[0].header.type, 'frame');
  const beats = packets.filter(p => p.header.type === 'heartbeat');
  assert.ok(beats[1].receivedMono - beats[0].receivedMono > 1500 && beats[1].receivedMono - beats[0].receivedMono < 3000);
  assert.ok(performance.now() - started < 15000);
});

test('desk: a window that does not exist gets one diagnostic and exit 0', { skip, timeout: 30000 }, async () => {
  const row = { ...rowFor(process.env.RELAY_DESK_WINDOW), windowId: 1 };
  const { packets, stderr, hostExit } = await run(row, p => p.length >= 1);
  assert.deepEqual(packets.map(p => [p.header.type, p.header.code]), [['diagnostic', 'capture_unavailable']]);
  assert.ok(hostExit === 0 || hostExit === undefined);
});
