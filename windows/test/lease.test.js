import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, linkSync, chmodSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { acquire, release, verify, verifyAny, authorize, readState, setInflight, clearInflight, targetKey, Failure } from '../supervisor/lease.js';

const leaseModule = fileURLToPath(new URL('../supervisor/lease.js', import.meta.url));
const posix = process.platform !== 'win32';
const UUID = 'abcdef12-1234-4234-8234-123456789012';
const W1 = { windowId: 1, pid: 10, bundleId: 'com.example.One' };
const W2 = { windowId: 2, pid: 10, bundleId: 'com.example.One' };
const D1 = { kind: 'desktop', displayId: 7, displayUUID: UUID };
const D2 = { kind: 'desktop', displayId: 8, displayUUID: UUID.replace(/9$/, '8') };
let clock = 1000;
const now = () => clock;
const o = { now, lockTimeoutMs: 300, pollMs: 5, staleLockMs: 10000 };

function root(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'lease-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  clock = 1000;
  return dir;
}
const acq = (dir, owner, target, extra = {}, options = o) => acquire(dir,
  { operation: 'acquire', owner, workspace: '/w', timeout: 5, args: { ttlSeconds: 60, takeover: false, ...(target === undefined ? {} : { target }), ...extra } }, options);
const rel = (dir, owner, held, target, options = o) => release(dir,
  { operation: 'release', owner, workspace: '/w', timeout: 5, args: { lease: { token: held.token, generation: held.generation }, ...(target === undefined ? {} : { target }) } }, options);
const check = (dir, owner, held, target) => verify(readState(dir), { owner, lease: { token: held.token, generation: held.generation }, target }, clock);
const proof = held => ({ token: held.token, generation: held.generation });
const fails = (promise, code) => assert.rejects(Promise.resolve(promise), error => error instanceof Failure && error.message === code, code);
const failsSync = (fn, code) => assert.throws(fn, error => error instanceof Failure && error.message === code, code);

test('L-01 acquire and release without a target use the discovery key and the Mac result shapes', async t => {
  const dir = root(t);
  const held = await acq(dir, 'a');
  assert.deepEqual(Object.keys(held).sort(), ['expiresAt', 'generation', 'owner', 'token']);
  assert.equal(held.generation, 1);
  assert.equal(held.expiresAt, 1060);
  assert.match(held.token, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(readState(dir).leases), ['discovery']);
  assert.deepEqual(await rel(dir, 'a', held), { released: true, generation: 2 });
  await fails(rel(dir, 'a', held), 'stale_lease');
});

test('L-02 window target: acquire echoes the target, release bumps the generation, re-acquire continues it', async t => {
  const dir = root(t);
  const held = await acq(dir, 'a', W1);
  assert.deepEqual(held.target, W1);
  assert.equal(held.generation, 1);
  assert.ok(check(dir, 'a', held, W1));
  assert.deepEqual(await rel(dir, 'a', held, W1), { released: true, generation: 2, target: W1 });
  failsSync(() => check(dir, 'a', held, W1), 'stale_lease');
  assert.equal((await acq(dir, 'a', W1)).generation, 3);
});

test('L-03 desktop target moves desktopGeneration on acquire and release', async t => {
  const dir = root(t);
  const held = await acq(dir, 'a', D1);
  assert.equal(readState(dir).desktopGeneration, 1);
  assert.equal(held.generation, 1);
  assert.deepEqual(await rel(dir, 'a', held, D1), { released: true, generation: 2, target: D1 });
  assert.equal(readState(dir).desktopGeneration, 2);
  assert.ok(await acq(dir, 'b', W1));
});

test('L-04 a second lease on the same window is refused and changes nothing', async t => {
  const dir = root(t);
  const held = await acq(dir, 'a', W1);
  const before = readFileSync(path.join(dir, 'leases.json'), 'utf8');
  await fails(acq(dir, 'b', W1), 'lease_held');
  assert.equal(readFileSync(path.join(dir, 'leases.json'), 'utf8'), before);
  assert.ok(check(dir, 'a', held, W1));
});

test('L-05 different windows are leased, verified and released independently', async t => {
  const dir = root(t);
  const one = await acq(dir, 'a', W1), two = await acq(dir, 'b', W2);
  assert.ok(check(dir, 'a', one, W1));
  assert.ok(check(dir, 'b', two, W2));
  await rel(dir, 'a', one, W1);
  assert.ok(check(dir, 'b', two, W2));
  failsSync(() => check(dir, 'a', two, W2), 'stale_lease');
});

test('L-06 a live window blocks a desktop lease, with and without takeover', async t => {
  const dir = root(t);
  const held = await acq(dir, 'a', W1);
  for (const takeover of [false, true]) await fails(acq(dir, 'b', D1, { takeover }), 'lease_held');
  assert.ok(check(dir, 'a', held, W1));
  assert.equal(readState(dir).desktopGeneration, 0);
});

test('L-07 a live desktop blocks window leases, with and without takeover', async t => {
  const dir = root(t);
  const held = await acq(dir, 'a', D1);
  for (const takeover of [false, true]) await fails(acq(dir, 'b', W1, { takeover }), 'lease_held');
  assert.ok(check(dir, 'a', held, D1));
});

test('L-08 desktop takeover works on the same display only', async t => {
  const dir = root(t);
  const old = await acq(dir, 'a', D1);
  for (const takeover of [false, true]) await fails(acq(dir, 'b', D2, { takeover }), 'lease_held');
  await fails(acq(dir, 'b', D1), 'lease_held');
  const taken = await acq(dir, 'b', D1, { takeover: true });
  assert.equal(taken.generation, 2);
  failsSync(() => check(dir, 'a', old, D1), 'stale_lease');
  assert.ok(check(dir, 'b', taken, D1));
});

test('L-09 the discovery lease neither blocks nor is blocked by target leases', async t => {
  const dir = root(t);
  const desktop = await acq(dir, 'a', D1);
  const list = await acq(dir, 'b');
  await rel(dir, 'b', list);
  await rel(dir, 'a', desktop, D1);
  const again = await acq(dir, 'b');
  assert.ok(await acq(dir, 'c', W1));
  await rel(dir, 'c', await acq(dir, 'c', W2), W2);
  await fails(acq(dir, 'c'), 'lease_held');
  assert.equal((await acq(dir, 'c', undefined, { takeover: true })).generation, again.generation + 1);
});

test('L-10 window takeover fences the former holder and leaves other windows alone', async t => {
  const dir = root(t);
  const old = await acq(dir, 'a', W1), other = await acq(dir, 'c', W2);
  const taken = await acq(dir, 'b', W1, { takeover: true });
  assert.equal(taken.generation, 2);
  failsSync(() => check(dir, 'a', old, W1), 'stale_lease');
  await fails(rel(dir, 'a', old, W1), 'stale_lease');
  assert.ok(check(dir, 'b', taken, W1));
  assert.ok(check(dir, 'c', other, W2));
});

test('L-11 stale, wrong owner, wrong token and wrong generation all fail stale_lease', async t => {
  const dir = root(t);
  const held = await acq(dir, 'a', W1);
  for (const [owner, proof] of [['b', held], ['a', { ...held, token: (held.token[0] === 'a' ? 'b' : 'a') + held.token.slice(1) }],
    ['a', { ...held, generation: held.generation - 1 }], ['a', { ...held, generation: held.generation + 1 }], ['a', { ...held, generation: 0 }]]) {
    failsSync(() => check(dir, owner, proof, W1), 'stale_lease');
    await fails(rel(dir, owner, proof, W1), 'stale_lease');
  }
  assert.ok(check(dir, 'a', held, W1));
});

test('L-12 an expired lease fails lease_expired and never excludes a new acquire', async t => {
  const dir = root(t);
  const window = await acq(dir, 'a', W1);
  clock = window.expiresAt - 1;
  assert.ok(check(dir, 'a', window, W1));
  clock = window.expiresAt;
  failsSync(() => check(dir, 'a', window, W1), 'lease_expired');
  await fails(rel(dir, 'a', window, W1), 'lease_expired');
  const desktop = await acq(dir, 'b', D1);
  clock = desktop.expiresAt;
  assert.ok(await acq(dir, 'c', W1));
  assert.ok(await acq(dir, 'd', W2));
  failsSync(() => check(dir, 'b', desktop, D1), 'lease_expired');
});

test('L-13 releasing an unknown or omitted target fails stale_lease and touches nothing else', async t => {
  const dir = root(t);
  const held = await acq(dir, 'a', W1);
  await fails(rel(dir, 'a', held, { ...W1, windowId: 9 }), 'stale_lease');
  await fails(rel(dir, 'a', held), 'stale_lease');
  assert.ok(check(dir, 'a', held, W1));
});

test('L-14 malformed leases.json always fails closed with unsafe_state', async t => {
  const good = { desktopGeneration: 0, leases: {} };
  const entry = { generation: 1, lease: { owner: 'a', token: 'a'.repeat(64), expiresAt: 5 } };
  const cases = {
    'not json': '{', 'array': '[]', 'extra top key': { ...good, extra: 1 }, 'missing leases': { desktopGeneration: 0 },
    'bad key': { ...good, leases: { nonsense: entry } }, 'proto key': JSON.parse('{"desktopGeneration":0,"leases":{"__proto__":{"generation":1,"lease":null}}}'),
    'entry extra key': { ...good, leases: { discovery: { ...entry, extra: 1 } } },
    'negative generation': { ...good, leases: { discovery: { ...entry, generation: -1 } } },
    'float generation': { ...good, leases: { discovery: { ...entry, generation: 1.5 } } },
    'short token': { ...good, leases: { discovery: { generation: 1, lease: { ...entry.lease, token: 'ab' } } } },
    'string expiry': { ...good, leases: { discovery: { generation: 1, lease: { ...entry.lease, expiresAt: 'soon' } } } },
    'desktop generation ahead': { ...good, leases: { ['d:7:' + UUID]: { generation: 3, lease: null } } },
    'too large': JSON.stringify({ ...good, pad: 'x'.repeat(70000) }),
  };
  for (const [name, content] of Object.entries(cases)) {
    const dir = root(t);
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    writeFileSync(path.join(dir, 'leases.json'), text, { mode: 0o600 });
    failsSync(() => readState(dir), 'unsafe_state');
    await fails(acq(dir, 'a', W1), 'unsafe_state');
    await fails(rel(dir, 'a', { token: 'a'.repeat(64), generation: 1 }, W1), 'unsafe_state');
    assert.equal(readFileSync(path.join(dir, 'leases.json'), 'utf8'), text, name + ' is not repaired');
  }
  const empty = root(t);
  writeFileSync(path.join(empty, 'leases.json'), '', { mode: 0o600 });
  assert.deepEqual(readState(empty), good);
});

test('L-15 symlink, hardlink, directory and loose-permission state files fail unsafe_state', async t => {
  const dir = root(t), file = path.join(dir, 'leases.json');
  mkdirSync(file);
  failsSync(() => readState(dir), 'unsafe_state');
  rmSync(file, { recursive: true });
  if (!posix) return;
  writeFileSync(path.join(dir, 'real'), '', { mode: 0o600 });
  symlinkSync(path.join(dir, 'real'), file);
  failsSync(() => readState(dir), 'unsafe_state');
  rmSync(file);
  linkSync(path.join(dir, 'real'), file);
  failsSync(() => readState(dir), 'unsafe_state');
  rmSync(file);
  writeFileSync(file, '', { mode: 0o600 });
  chmodSync(file, 0o644);
  failsSync(() => readState(dir), 'unsafe_state');
});

test('L-16 the legacy inflight marker and bridge-session.json make every target busy', async t => {
  for (const name of ['inflight', 'bridge-session.json']) {
    const dir = root(t);
    const held = await acq(dir, 'a', W1);
    writeFileSync(path.join(dir, name), '');
    for (const target of [undefined, W1, W2, D1]) {
      await fails(acq(dir, 'b', target), 'busy');
      failsSync(() => authorize(dir, { owner: 'a', lease: proof(held), target: W1 }, clock), 'busy');
    }
    await fails(rel(dir, 'a', held, W1), 'busy');
  }
  if (posix) {
    const dir = root(t);
    symlinkSync(path.join(dir, 'nowhere'), path.join(dir, 'inflight'));
    await fails(acq(dir, 'a', W1), 'busy');
  }
});

test('L-17 per-target inflight markers scope busy and a corrupt marker directory fails closed', async t => {
  const dir = root(t);
  setInflight(dir, W1);
  await fails(acq(dir, 'a', W1), 'busy');
  await fails(acq(dir, 'a', D1), 'busy');
  assert.ok(await acq(dir, 'a', W2));
  assert.ok(await acq(dir, 'a'));
  assert.throws(() => setInflight(dir, W1), error => error.message === 'busy');
  clearInflight(dir, W1);
  clearInflight(dir, W1);
  const desktops = root(t);
  setInflight(desktops, D1);
  for (const target of [W1, D1, D2]) await fails(acq(desktops, 'a', target), 'busy');
  assert.ok(await acq(desktops, 'a'));
  const discovery = root(t);
  setInflight(discovery, undefined);
  await fails(acq(discovery, 'a'), 'busy');
  assert.ok(await acq(discovery, 'a', W1));
  const corrupt = root(t);
  mkdirSync(path.join(corrupt, 'inflight.d'));
  writeFileSync(path.join(corrupt, 'inflight.d', 'stray'), '');
  await fails(acq(corrupt, 'a', W1), 'unsafe_state');
  const plainFile = root(t);
  writeFileSync(path.join(plainFile, 'inflight.d'), '');
  await fails(acq(plainFile, 'a', W1), 'unsafe_state');
});

test('L-18 lock contention times out busy, waits for a release, reclaims stale locks and rejects a symlink', async t => {
  const dir = root(t), lock = path.join(dir, 'leases.lock');
  writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce: 'x' }));
  await fails(acq(dir, 'a', W1), 'busy');
  setTimeout(() => rmSync(lock), 40);
  assert.ok(await acq(dir, 'a', W1, {}, { ...o, lockTimeoutMs: 2000 }));
  assert.equal(existsSync(lock), false, 'the lock is released after the operation');
  writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce: 'old' }));
  const old = new Date(Date.now() - 60000);
  utimesSync(lock, old, old);
  assert.ok(await acq(dir, 'a', W2));
  const dead = spawn(process.execPath, ['-e', '']);
  await new Promise(resolve => dead.on('close', resolve));
  writeFileSync(lock, JSON.stringify({ pid: dead.pid, nonce: 'dead' }));
  assert.ok(await acq(dir, 'b', { ...W2, windowId: 3 }));
  if (posix) {
    symlinkSync(path.join(dir, 'real-lock'), lock);
    await fails(acq(dir, 'a', { ...W2, windowId: 4 }), 'unsafe_state');
  }
});

const raceScript = `
import { acquire } from ${JSON.stringify(pathToFileURL(leaseModule).href)};
const [root, owner, target] = process.argv.slice(1);
try {
  await acquire(root, { operation: 'acquire', owner, workspace: '/w', timeout: 5, args: { ttlSeconds: 60, takeover: false, ...(target === 'none' ? {} : { target: JSON.parse(target) }) } }, { lockTimeoutMs: 5000 });
  console.log('ok');
} catch (error) { console.log(error.message); }
`;
const race = (dir, owner, target) => new Promise(resolve => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', raceScript, dir, owner, target === undefined ? 'none' : JSON.stringify(target)]);
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.on('close', () => resolve(out.trim()));
});

test('L-19 concurrent acquires serialize the same window, allow distinct windows and exclude the desktop', async t => {
  const same = root(t);
  const sameResults = await Promise.all(Array.from({ length: 6 }, (_, i) => race(same, 'p' + i, W1)));
  assert.equal(sameResults.filter(r => r === 'ok').length, 1, sameResults.join());
  assert.equal(sameResults.filter(r => r === 'lease_held').length, 5, sameResults.join());
  const many = root(t);
  const manyResults = await Promise.all([1, 2, 3, 4].map(i => race(many, 'p' + i, { ...W1, windowId: i })));
  assert.deepEqual(manyResults, ['ok', 'ok', 'ok', 'ok']);
  assert.equal(Object.keys(readState(many).leases).length, 4);
  const mixed = root(t);
  const mixedResults = await Promise.all([race(mixed, 'w', W1), race(mixed, 'd', D1)]);
  assert.deepEqual(mixedResults.sort(), ['lease_held', 'ok']);
  const inProcess = root(t);
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => acq(inProcess, 'q' + i, W1, {}, { ...o, lockTimeoutMs: 3000 })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
});

test('L-20 invalid targets fail invalid_request before any disk access', async t => {
  const dir = path.join(root(t), 'never-created');
  const bad = [null, {}, [], 'x', { ...W1, extra: 1 }, { windowId: 1, bundleId: 'a' }, { ...W1, windowId: 0 }, { ...W1, pid: 0 },
    { ...W1, bundleId: 'bad/id' }, { ...W1, bundleId: 'com.factory.applets.host' }, { ...D1, displayUUID: UUID.toUpperCase() },
    { ...D1, displayId: 0 }, { kind: 'window', windowId: 1, pid: 1, bundleId: 'a' }];
  for (const target of bad) {
    await fails(acq(dir, 'a', target), 'invalid_request');
    await fails(rel(dir, 'a', { token: 'a'.repeat(64), generation: 1 }, target), 'invalid_request');
    assert.throws(() => targetKey(target), error => error.message === 'invalid_request');
  }
  for (const args of [{ ttlSeconds: 0 }, { ttlSeconds: 3601 }, { ttlSeconds: 1.5 }, { ttlSeconds: 5, takeover: 'yes' }, { ttlSeconds: 5, other: 1 }]) {
    await fails(acquire(dir, { operation: 'acquire', owner: 'a', workspace: '/w', timeout: 5, args }, o), 'invalid_request');
  }
  assert.equal(existsSync(dir), false);
});

test('L-21 the module never reads or writes the Mac-shaped state.json', async t => {
  const dir = root(t);
  writeFileSync(path.join(dir, 'state.json'), 'garbage that would be unsafe_state', { mode: 0o600 });
  const held = await acq(dir, 'a', W1);
  assert.ok(check(dir, 'a', held, W1));
  assert.equal(readFileSync(path.join(dir, 'state.json'), 'utf8'), 'garbage that would be unsafe_state');
});

test('verifyAny accepts any live lease of the owner and authorize picks the right check', async t => {
  const dir = root(t);
  const held = await acq(dir, 'a', W1);
  const lease = proof(held);
  assert.ok(verifyAny(readState(dir), { owner: 'a', lease }, clock));
  failsSync(() => verifyAny(readState(dir), { owner: 'b', lease }, clock), 'stale_lease');
  assert.ok(authorize(dir, { owner: 'a', lease }, clock));
  assert.ok(authorize(dir, { owner: 'a', lease, target: W1 }, clock));
  failsSync(() => authorize(dir, { owner: 'a', lease, target: W2 }, clock), 'stale_lease');
  failsSync(() => authorize(dir, { owner: 'a', lease, target: W1 }, held.expiresAt), 'lease_expired');
});

test('the state is capped at 256 entries: spare released entries are pruned, otherwise busy', async t => {
  const dir = root(t);
  for (let i = 1; i <= 256; i++) await acq(dir, 'a', { ...W1, windowId: i }, { ttlSeconds: 3600 });
  await fails(acq(dir, 'a', { ...W1, windowId: 999 }), 'busy');
  clock += 4000;
  assert.ok(await acq(dir, 'a', { ...W1, windowId: 999 }));
  assert.equal(Object.keys(readState(dir).leases).length, 256);
});
