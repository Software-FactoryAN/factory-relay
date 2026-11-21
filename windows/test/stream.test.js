import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeStream, HEADER_LIMIT, IMAGE_LIMIT } from '../../src/stream.js';
import { fabricated, windowsPacket, diagnosticPacket, line, frame, startFakeHost } from './fake-host.js';

const supervisor = fileURLToPath(new URL('../supervisor/stream.js', import.meta.url));
const token = 'a'.repeat(64);
const owner = 'owner-1';
const windowTarget = { windowId: 4242, pid: 100, bundleId: fabricated.bundleId };
const desktopTarget = { kind: 'desktop', displayId: 7, displayUUID: fabricated.displayUUID };
const validState = { generation: 3, lease: { owner, token, expiresAt: Date.now() / 1000 + 600 } };
const endpointIn = dir => process.platform === 'win32' ? '\\\\.\\pipe\\relay-test-' + path.basename(dir) : path.join(dir, 'h.sock');
const lengthPrefixed = (header, image = Buffer.alloc(0)) => {
  const json = Buffer.from(JSON.stringify(header)), size = Buffer.alloc(4);
  size.writeUInt32BE(json.length);
  return Buffer.concat([size, json, image]);
};

function requestFor(mode, target, over = {}) {
  return { owner, workspace: '/workspace', args: { lease: { token, generation: 3 } }, mode, target, timeout: 30, ...over };
}

// Runs the supervisor as ssh would: request line on stdin, packets decoded by the upstream decoder, one ack byte per frame.
async function session({ mode = 'windows', target = null, state = validState, request, script = () => {}, hello, ack = 6, serve = true, closeAfterPackets, endStdin = false, onPacket, prepare }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'rs-'));
  const endpoint = endpointIn(dir);
  prepare?.(dir);
  if (state !== null) writeFileSync(path.join(dir, 'state.json'), typeof state === 'string' ? state : JSON.stringify(state), { mode: 0o600 });
  const host = serve ? await startFakeHost(endpoint, script, hello && { hello }) : { seen: { requests: [], acks: 0 }, close: async () => {} };
  const child = spawn(process.execPath, [supervisor, 'stream'], { env: { ...process.env, RELAY_STATE_DIR: dir, RELAY_HOST_ENDPOINT: endpoint }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.on('error', () => {});
  const exited = new Promise(resolve => child.on('close', code => resolve(code)));
  child.stdin.write(typeof request === 'string' ? request : JSON.stringify(request ?? requestFor(mode, target)) + '\n');
  if (endStdin) child.stdin.end();
  const packets = [];
  let decodeError;
  try {
    for await (const packet of decodeStream(child.stdout)) {
      packets.push(packet);
      if (ack !== null && ['frame', 'heartbeat'].includes(packet.header.type)) child.stdin.write(Buffer.from([ack]));
      onPacket?.(child);
      if (packets.length === closeAfterPackets) child.stdin.end();
    }
  } catch (error) { decodeError = error; }
  const code = await exited;
  await host.close();
  rmSync(dir, { recursive: true, force: true });
  return { packets, decodeError, stderr, code, seen: host.seen, errorCode: stderr.match(/^APPLETS_STREAM_ERROR:([a-z_]+)$/m)?.[1] };
}

test('windows mode: host list passes the upstream schema, and the process start is one finite number', async () => {
  const result = await session({ script: ({ socket }) => socket.write(line(windowsPacket)) });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.packets.length, 1);
  const { header } = result.packets[0];
  assert.equal(header.type, 'windows');
  assert.equal(header.bytes, 0);
  assert.deepEqual(result.seen.requests, [['windows']]);
  assert.match(header.windows[0].bundleId, /^[A-Za-z0-9._-]*$/);
  assert.match(header.displays[0].displayUUID, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.ok(Number.isFinite(header.windows[0].processStartedAt) && header.windows[0].processStartedAt > 0);
});

test('diagnose mode passes the upstream diagnostic schema', async () => {
  const result = await session({ mode: 'diagnose', script: ({ socket }) => socket.write(line(diagnosticPacket)) });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.packets[0].header.bundleId, 'com.factory.applets.host');
  assert.deepEqual(result.seen.requests, [['diagnose']]);
});

for (const [name, target, expected] of [
  ['window', windowTarget, ['stream', '4242', '100', fabricated.bundleId]],
  ['desktop', desktopTarget, ['stream', 'desktop', '7', fabricated.displayUUID]],
]) {
  test('stream mode (' + name + '): frames reach the decoder and every frame is acknowledged before the next', async () => {
    const script = ({ socket, seen }) => {
      let sent = 0;
      const next = () => {
        if (sent === 3) { socket.end(); return; }
        const bytes = frame(++sent, target, name === 'desktop' ? { processStartedAt: undefined, initialWindowRectPoints: undefined,
          displayConfiguration: windowsPacket.displays[0].displayConfiguration } : {});
        const half = bytes.length >> 1;
        socket.write(bytes.subarray(0, half));
        setImmediate(() => socket.write(bytes.subarray(half)));
      };
      socket.on('acks', () => { assert.equal(seen.acks, sent); next(); });
      next();
    };
    const result = await session({ mode: 'stream', target, script });
    assert.deepEqual(result.seen.requests, [expected]);
    assert.deepEqual(result.packets.map(p => p.header.sequence), [1, 2, 3]);
    assert.equal(result.seen.acks, 3);
    assert.equal(result.errorCode, 'stream_closed');
    assert.equal(result.decodeError, undefined);
  });
}

test('a client that closes stdin mid-stream ends the host connection', async () => {
  let closed;
  const hostClosed = new Promise(resolve => { closed = resolve; });
  const result = await session({ mode: 'stream', target: windowTarget, closeAfterPackets: 1,
    script: ({ socket }) => { socket.on('close', closed); socket.write(frame(1, windowTarget)); } });
  await hostClosed;
  assert.equal(result.packets.length, 1);
  assert.notEqual(result.code, 0);
  assert.equal(result.errorCode, 'stream_closed');
});

const invalidRequests = {
  'extra key': () => requestFor('windows', null, { extra: 1 }),
  'timeout zero': () => requestFor('windows', null, { timeout: 0 }),
  'timeout too long': () => requestFor('windows', null, { timeout: 1801 }),
  'unknown mode': () => requestFor('input', null),
  'windows with target': () => requestFor('windows', windowTarget),
  'stream without target': () => requestFor('stream', null),
  'stream with the relay host bundle': () => requestFor('stream', { ...windowTarget, bundleId: 'com.factory.applets.host' }),
  'stream with a bundle id outside the charset': () => requestFor('stream', { ...windowTarget, bundleId: 'a b' }),
  'window id zero': () => requestFor('stream', { ...windowTarget, windowId: 0 }),
  'display uuid in capitals': () => requestFor('stream', { ...desktopTarget, displayUUID: desktopTarget.displayUUID.toUpperCase() }),
  'lease token too short': () => requestFor('windows', null, { args: { lease: { token: 'ab', generation: 3 } } }),
  'fractional timeout': () => requestFor('windows', null, { timeout: 1.5 }),
  'not json': () => '{nope\n',
  'line over the limit': () => '{' + ' '.repeat(16400) + '\n',
};
for (const [name, build] of Object.entries(invalidRequests)) {
  test('invalid request refused before the host is contacted: ' + name, async () => {
    const result = await session({ request: build(), serve: true, script: () => assert.fail('host contacted') });
    assert.equal(result.errorCode, 'invalid_request');
    assert.equal(result.packets.length, 0);
    assert.equal(result.seen.requests.length, 0);
  });
}

const refusals = {
  'no state file': [null, 'stale_lease'],
  'no lease': [{ generation: 3, lease: null }, 'stale_lease'],
  'other generation': [{ ...validState, generation: 4 }, 'stale_lease'],
  'other owner': [{ generation: 3, lease: { ...validState.lease, owner: 'someone' } }, 'stale_lease'],
  'other token': [{ generation: 3, lease: { ...validState.lease, token: 'b'.repeat(64) } }, 'stale_lease'],
  'expired lease': [{ generation: 3, lease: { ...validState.lease, expiresAt: 1 } }, 'lease_expired'],
  'state is not json': ['{', 'unsafe_state'],
  'state has an extra key': [{ ...validState, extra: 1 }, 'unsafe_state'],
  'lease expiry is not a number': [{ generation: 3, lease: { ...validState.lease, expiresAt: 'soon' } }, 'unsafe_state'],
  'state over the size limit': [JSON.stringify({ ...validState, pad: 'x'.repeat(17000) }), 'unsafe_state'],
};
for (const [name, [state, expected]] of Object.entries(refusals)) {
  test('lease refused without contacting the host: ' + name, async () => {
    const result = await session({ state, script: () => assert.fail('host contacted') });
    assert.equal(result.errorCode, expected);
    assert.equal(result.code, 1);
    assert.equal(result.seen.requests.length, 0);
  });
}

test('an inflight marker makes the supervisor busy', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rs-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'state.json'), JSON.stringify(validState), { mode: 0o600 });
  writeFileSync(path.join(dir, 'inflight'), '');
  const child = spawn(process.execPath, [supervisor, 'stream'], { env: { ...process.env, RELAY_STATE_DIR: dir, RELAY_HOST_ENDPOINT: path.join(dir, 'none') } });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.write(JSON.stringify(requestFor('windows', null)) + '\n');
  await new Promise(resolve => child.on('close', resolve));
  rmSync(dir, { recursive: true, force: true });
  assert.match(stderr, /^APPLETS_STREAM_ERROR:busy$/m);
});

test('no host listening: host_unavailable', async () => {
  const result = await session({ serve: false });
  assert.equal(result.errorCode, 'host_unavailable');
});

const hostFaults = {
  'hello with another key set': { hello: { protocol: 1, type: 'hello', pid: 1, extra: 1 }, script: ({ socket }) => socket.write(line(windowsPacket)) },
  'hello with pid zero': { hello: { protocol: 1, type: 'hello', pid: 0 }, script: ({ socket }) => socket.write(line(windowsPacket)) },
  'frame for the windows mode': { script: ({ socket }) => socket.write(frame(1, windowTarget)) },
  'windows packet for the diagnose mode': { mode: 'diagnose', script: ({ socket }) => socket.write(line(windowsPacket)) },
  'unknown packet type': { script: ({ socket }) => socket.write(line({ protocol: 1, type: 'input' })) },
  'json line that is not an object': { script: ({ socket }) => socket.write(Buffer.from('{"a"\n')) },
  'length over the header limit': { script: ({ socket }) => socket.write(Buffer.from([0, 0, 0x20, 1, 0])) },
  'frame with zero bytes': { mode: 'stream', target: windowTarget, script: ({ socket }) => socket.write(lengthPrefixed({ type: 'frame', bytes: 0 })) },
  'frame over the image limit': { mode: 'stream', target: windowTarget, script: ({ socket }) => socket.write(lengthPrefixed({ type: 'frame', bytes: IMAGE_LIMIT + 1 })) },
  'heartbeat with a body': { mode: 'stream', target: windowTarget, script: ({ socket }) => socket.write(lengthPrefixed({ type: 'heartbeat', bytes: 1 }, Buffer.from([0]))) },
};
for (const [name, fault] of Object.entries(hostFaults)) {
  test('host fault refused as invalid_stream: ' + name, async () => {
    const result = await session(fault);
    assert.equal(result.errorCode, 'invalid_stream');
    assert.equal(result.packets.length, 0);
  });
}

test('host that goes silent after a frame is cut off, and one that closes early reports stream_closed', async () => {
  const early = await session({ script: ({ socket }) => socket.end() });
  assert.equal(early.errorCode, 'stream_closed');
  const truncated = await session({ mode: 'stream', target: windowTarget, script: ({ socket }) => { socket.write(frame(1, windowTarget).subarray(0, 20)); socket.end(); } });
  assert.equal(truncated.errorCode, 'stream_closed');
  assert.equal(truncated.packets.length, 0);
});

test('an acknowledgment byte other than 0x06 stops the stream before the host sees it', async () => {
  const result = await session({ mode: 'stream', target: windowTarget, ack: 7, script: ({ socket }) => socket.write(frame(1, windowTarget)) });
  assert.equal(result.errorCode, 'invalid_stream');
  assert.equal(result.seen.acks, 0);
});

for (const revokedAt of ['after the decoder got frame 1', 'when the host receives the ack for frame 1']) {
  test('lease revoked ' + revokedAt + ': the next packet is not forwarded', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rs-'));
    const endpoint = endpointIn(dir);
    const revoke = () => writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ ...validState, generation: 4 }), { mode: 0o600 });
    writeFileSync(path.join(dir, 'state.json'), JSON.stringify(validState), { mode: 0o600 });
    const host = await startFakeHost(endpoint, ({ socket }) => {
      socket.write(frame(1, windowTarget));
      socket.once('acks', () => { if (revokedAt.startsWith('when')) revoke(); socket.write(frame(2, windowTarget)); });
    });
    const child = spawn(process.execPath, [supervisor, 'stream'], { env: { ...process.env, RELAY_STATE_DIR: dir, RELAY_HOST_ENDPOINT: endpoint } });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.write(JSON.stringify(requestFor('stream', windowTarget)) + '\n');
    const sequences = [];
    for await (const packet of decodeStream(child.stdout)) {
      sequences.push(packet.header.sequence);
      if (revokedAt.startsWith('after')) revoke();
      child.stdin.write(Buffer.from([6]));
    }
    await host.close();
    rmSync(dir, { recursive: true, force: true });
    assert.match(stderr, /^APPLETS_STREAM_ERROR:stale_lease$/m);
    assert.deepEqual(sequences, [1]);
    assert.equal(host.seen.acks, revokedAt.startsWith('after') ? 0 : 1);
  });
}

const canSymlink = (() => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rs-'));
  try { symlinkSync('x', path.join(dir, 'y')); return true; } catch { return false; } finally { rmSync(dir, { recursive: true, force: true }); }
})();

test('a request cut off before its newline is stream_closed', async () => {
  const result = await session({ request: '{"owner"', endStdin: true });
  assert.equal(result.errorCode, 'stream_closed');
  assert.equal(result.seen.requests.length, 0);
});

test('a role other than stream is invalid_request', async () => {
  const child = spawn(process.execPath, [supervisor, 'input']);
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise(resolve => child.on('close', resolve));
  assert.equal(code, 1);
  assert.match(stderr, /^APPLETS_STREAM_ERROR:invalid_request$/m);
});

for (const [mode, packet] of [['windows', windowsPacket], ['diagnose', diagnosticPacket]]) {
  test(mode + ': stdin closed right after the request does not cut the host answer', async () => {
    const result = await session({ mode, endStdin: true, script: ({ socket }) => setTimeout(() => socket.write(line(packet)), 100) });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.packets.length, 1);
  });
}

test('frame, heartbeat and diagnostic in one stream: two acks, exit 0', async () => {
  const steps = [() => frame(1, windowTarget), () => lengthPrefixed({ protocol: 1, type: 'heartbeat', bytes: 0, sentUptimeSeconds: 11 }), () => line(diagnosticPacket)];
  const result = await session({ mode: 'stream', target: windowTarget, script: ({ socket }) => {
    let next = 0;
    const send = () => socket.write(steps[next++]());
    socket.on('acks', () => { if (next < steps.length) send(); });
    send();
  } });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.packets.map(p => p.header.type), ['frame', 'heartbeat', 'diagnostic']);
  assert.equal(result.seen.acks, 2);
});

test('a silent host ends at the request timeout with stream_timeout', async () => {
  const result = await session({ request: requestFor('windows', null, { timeout: 1 }) });
  assert.equal(result.errorCode, 'stream_timeout');
  assert.equal(result.code, 1);
});

test('a frame that is never acknowledged ends at the request timeout with stream_timeout', async () => {
  const result = await session({ mode: 'stream', target: windowTarget, ack: null, request: requestFor('stream', windowTarget, { timeout: 1 }),
    script: ({ socket }) => socket.write(frame(1, windowTarget)) });
  assert.equal(result.errorCode, 'stream_timeout');
  assert.equal(result.packets.length, 1);
});

test('SIGTERM mid-stream gives stream_interrupted', { skip: process.platform === 'win32' && 'a Windows process cannot handle SIGTERM' }, async () => {
  const result = await session({ mode: 'stream', target: windowTarget, ack: null, onPacket: child => child.kill('SIGTERM'),
    script: ({ socket }) => socket.write(frame(1, windowTarget)) });
  assert.equal(result.errorCode, 'stream_interrupted');
  assert.equal(result.code, 1);
});

test('a state.json that is a symlink is unsafe_state', { skip: !canSymlink && 'symlinks need a privilege here' }, async () => {
  const result = await session({ state: null, script: () => assert.fail('host contacted'), prepare: dir => {
    writeFileSync(path.join(dir, 'real.json'), JSON.stringify(validState), { mode: 0o600 });
    symlinkSync('real.json', path.join(dir, 'state.json'));
  } });
  assert.equal(result.errorCode, 'unsafe_state');
});

test('no host endpoint on a platform without a default is unsupported_host', { skip: process.platform === 'win32' && 'Windows has a default pipe' }, async () => {
  const child = spawn(process.execPath, [supervisor, 'stream'], { env: { ...process.env, RELAY_HOST_ENDPOINT: '' } });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.write(JSON.stringify(requestFor('windows', null)) + '\n');
  await new Promise(resolve => child.on('close', resolve));
  assert.match(stderr, /^APPLETS_STREAM_ERROR:unsupported_host$/m);
});

test('the header limit constant matches the upstream decoder', () => {
  assert.equal(HEADER_LIMIT, 8192);
});
