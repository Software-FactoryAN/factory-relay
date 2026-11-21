import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Broker, nativeAdapter } from '../../src/qa-broker.js';
import { RunStore } from '../../src/qa-store.js';
import { parseOperation } from '../../src/schema.js';
import { sampleBundle } from '../../src/window-target.js';
import { acquire, release, readState } from '../supervisor/lease.js';

const W1 = { windowId: 1, pid: 10, bundleId: sampleBundle };
const W2 = { windowId: 2, pid: 10, bundleId: sampleBundle };
const mac = { id: 'relaymac', name: 'RelayMac', platform: 'macos', bundleId: sampleBundle };
const request = (owner, args) => ({ owner, workspace: '/w', timeout: 5, args });

test('schema: target is optional, validated, and absent keys stay absent', () => {
  const proof = { token: 'a'.repeat(64), generation: 1 };
  const window = { windowId: 1, pid: 2, bundleId: 'com.example.App' };
  assert.deepEqual(parseOperation('acquire', { ttlSeconds: 10 }), { ttlSeconds: 10, takeover: false });
  assert.deepEqual(parseOperation('release', { lease: proof }), { lease: proof });
  assert.deepEqual(parseOperation('acquire', { ttlSeconds: 10, target: window }).target, window);
  assert.deepEqual(parseOperation('release', { lease: proof, target: window }).target, window);
  for (const target of [null, {}, { ...window, extra: 1 }, { ...window, windowId: 0 }, { kind: 'desktop', displayId: 1, displayUUID: 'ABCDEF12-1234-4234-8234-123456789012' }]) {
    assert.throws(() => parseOperation('acquire', { ttlSeconds: 10, target }), /invalid_arguments/);
    assert.throws(() => parseOperation('release', { lease: proof, target }), /invalid_arguments/);
  }
});

// A stub droid that records the request JSON it receives; transport.js spawns it by name.
function stubDroid(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-droid-'));
  const log = path.join(dir, 'requests.log');
  const response = JSON.stringify({ ok: true, result: { owner: 'o', token: 'a'.repeat(64), expiresAt: 1, generation: 1, released: true } });
  fs.writeFileSync(path.join(dir, 'droid'), '#!' + process.execPath + '\n' +
    'let s = ""; process.stdin.on("data", d => { s += d; }); process.stdin.on("end", () => {\n' +
    '  require("node:fs").appendFileSync(' + JSON.stringify(log) + ', s + "\\n"); console.log(' + JSON.stringify(response) + '); });\n', { mode: 0o755 });
  const saved = process.env.PATH;
  process.env.PATH = dir + path.delimiter + saved;
  t.after(() => { process.env.PATH = saved; fs.rmSync(dir, { recursive: true, force: true }); });
  return () => fs.readFileSync(log, 'utf8').trim().split('\n').map(line => line.replace(/"owner":"qa:[^"]+"/, '"owner":"qa:X"'));
}

test('B-01 the Mac adapter sends byte-identical acquire and release requests even when a target is passed', { skip: process.platform === 'win32' }, async t => {
  const requests = stubDroid(t);
  const proof = { token: 'b'.repeat(64), generation: 4 };
  const base = { transport: 'factory', computer: 'c', workspace: '/w', owner: 'x', timeoutSeconds: 5 };
  for (const platform of [undefined, 'mac']) {
    const adapter = nativeAdapter({ ...base, ...(platform ? { platform } : {}) });
    assert.equal(adapter.perTarget, false);
    await adapter.acquire(false);
    await adapter.acquire(true, 30, W1);
    await adapter.release(proof);
    await adapter.release(proof, W1);
  }
  const lines = requests();
  const expected = [
    '{"operation":"acquire","args":{"ttlSeconds":3600,"takeover":false},"owner":"qa:X","workspace":"/w","timeout":5}',
    '{"operation":"acquire","args":{"ttlSeconds":30,"takeover":true},"owner":"qa:X","workspace":"/w","timeout":5}',
    '{"operation":"release","args":{"lease":{"token":"' + proof.token + '","generation":4}},"owner":"qa:X","workspace":"/w","timeout":5}',
    '{"operation":"release","args":{"lease":{"token":"' + proof.token + '","generation":4}},"owner":"qa:X","workspace":"/w","timeout":5}',
  ];
  assert.deepEqual(lines, [...expected, ...expected]);
  const windows = nativeAdapter({ ...base, platform: 'windows', supervisor: 'C:/relay/s.js' });
  assert.equal(windows.perTarget, true);
  await windows.acquire(false, undefined, W1);
  await windows.release(proof, W1);
  await windows.acquire(false);
  const sent = requests().slice(8).map(line => JSON.parse(line).args);
  assert.deepEqual(sent, [{ ttlSeconds: 3600, takeover: false, target: W1 }, { lease: proof, target: W1 }, { ttlSeconds: 3600, takeover: false }]);
});

function windowsBroker(t, root, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-broker-'));
  const calls = [];
  const native = {
    perTarget: true,
    applications: [mac],
    acquire: async (takeover, ttlSeconds = 3600, target) => {
      calls.push(['acquire', target ?? null]);
      return acquire(root, request(name, { ttlSeconds, takeover, ...(target ? { target } : {}) }));
    },
    release: async (proof, target) => {
      calls.push(['release', target ?? null]);
      assert.deepEqual(Object.keys(proof).sort(), ['generation', 'token']);
      return release(root, request(name, { lease: proof, ...(target ? { target } : {}) }));
    },
    windows: async () => ({ windows: [W1, W2], displays: [] }),
    stream: async (_proof, _target, signal) => { await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); },
  };
  const broker = new Broker(new RunStore(path.join(dir, 'runs')), native, { frameWaitMs: 20 });
  t.after(async () => { await broker.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { broker, calls };
}
const liveOwners = (root, now = Date.now() / 1000) => Object.entries(readState(root).leases)
  .filter(([, entry]) => entry.lease && entry.lease.expiresAt > now).map(([key, entry]) => key.split(':').slice(0, 2).join(':') + '=' + entry.lease.owner).sort();

test('B-02 Windows brokers hold per-window leases in parallel and the discovery lease is replaced on select', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-state-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const one = windowsBroker(t, root, 'qa:one'), two = windowsBroker(t, root, 'qa:two');
  await one.broker.execute('human', { op: 'connect' });
  assert.deepEqual(liveOwners(root), ['discovery=qa:one'], 'connect holds the discovery lease');
  await two.broker.execute('human', { op: 'connect' }).then(() => assert.fail('two discovery leases'), e => assert.equal(e.message, 'lease_held'));
  await one.broker.execute('human', { op: 'select', target: W1 });
  assert.deepEqual(one.calls.slice(0, 3), [['acquire', null], ['release', null], ['acquire', W1]]);
  assert.deepEqual(liveOwners(root), ['w:1=qa:one']);
  await two.broker.execute('human', { op: 'connect' });
  await two.broker.execute('human', { op: 'select', target: W2 });
  assert.deepEqual(liveOwners(root), ['w:1=qa:one', 'w:2=qa:two']);
  const third = windowsBroker(t, root, 'qa:three');
  await third.broker.execute('human', { op: 'connect' });
  await assert.rejects(third.broker.execute('human', { op: 'select', target: W1 }), /lease_held/);
  assert.deepEqual(liveOwners(root), ['w:1=qa:one', 'w:2=qa:two'], 'the refused select leaves no lease behind');
  const taken = await one.broker.execute('human', { op: 'take', takeover: false });
  assert.ok(taken.grant);
  assert.deepEqual(one.calls.at(-2), ['release', W1]);
  assert.deepEqual(one.calls.at(-1), ['acquire', W1]);
  await one.broker.execute('human', { op: 'release', grant: taken.grant });
  assert.deepEqual(liveOwners(root), ['w:1=qa:one', 'w:2=qa:two'], 'release re-leases the same window observer-only');
  await one.broker.close();
  await two.broker.close();
  assert.deepEqual(liveOwners(root), [], 'close releases the target leases');
});

test('B-03 a takeover for another target frees the old lease instead of leaking it', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-state-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { broker, calls } = windowsBroker(t, root, 'qa:one');
  await broker.execute('human', { op: 'connect' });
  broker.target = W1;
  await broker.execute('human', { op: 'take', takeover: true });
  assert.deepEqual(calls, [['acquire', null], ['release', null], ['acquire', W1]]);
  assert.deepEqual(liveOwners(root), ['w:1=qa:one']);
});
