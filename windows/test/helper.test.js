import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const supervisor = fileURLToPath(new URL('../supervisor/stream.js', import.meta.url));
const window = id => ({ windowId: id, pid: 100, bundleId: 'com.example.app' });
const request = (operation, args, over = {}) => ({ operation, args, owner: 'owner-1', workspace: '/w', timeout: 30, ...over });

async function helper(input, setup) {
  const dir = mkdtempSync(path.join(tmpdir(), 'rh-'));
  setup?.(dir);
  const calls = [];
  const call = body => new Promise(resolve => {
    const child = spawn(process.execPath, [supervisor, 'helper'], { env: { ...process.env, RELAY_STATE_DIR: dir } });
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stdin.on('error', () => {});
    child.on('close', code => resolve({ code, stdout }));
    child.stdin.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  try { return await input(call, dir); } finally { rmSync(dir, { recursive: true, force: true }); calls.length = 0; }
}
const parse = ({ code, stdout }) => {
  assert.equal(code, 0);
  assert.match(stdout, /^[^\n]+\n$/);
  return JSON.parse(stdout);
};

test('helper: acquire and release for a window, then a second release is stale_lease', () => helper(async call => {
  const target = window(5);
  const got = parse(await call(request('acquire', { ttlSeconds: 60, takeover: false, target })));
  assert.equal(got.ok, true);
  assert.deepEqual(Object.keys(got.result).sort(), ['expiresAt', 'generation', 'owner', 'target', 'token']);
  const lease = { token: got.result.token, generation: got.result.generation };
  assert.deepEqual(parse(await call(request('release', { lease, target }))), { ok: true, result: { released: true, generation: 2, target } });
  assert.deepEqual(parse(await call(request('release', { lease, target }))), { ok: false, error: 'stale_lease' });
}));

test('helper: acquire without a target is the discovery lease, with the Mac result shape', () => helper(async call => {
  const got = parse(await call(request('acquire', { ttlSeconds: 60, takeover: false })));
  assert.deepEqual(Object.keys(got.result).sort(), ['expiresAt', 'generation', 'owner', 'token']);
  assert.deepEqual(parse(await call(request('acquire', { ttlSeconds: 60, takeover: false }))), { ok: false, error: 'lease_held' });
}));

test('helper: a window held by one owner is lease_held for another, a different window is free', () => helper(async call => {
  assert.equal(parse(await call(request('acquire', { ttlSeconds: 60, takeover: false, target: window(5) }))).ok, true);
  assert.deepEqual(parse(await call(request('acquire', { ttlSeconds: 60, takeover: false, target: window(5) }, { owner: 'owner-2' }))), { ok: false, error: 'lease_held' });
  assert.equal(parse(await call(request('acquire', { ttlSeconds: 60, takeover: false, target: window(6) }, { owner: 'owner-2' }))).ok, true);
}));

const bad = {
  'not json': () => '{nope',
  'empty input': () => '',
  'unknown operation': () => request('preflight', {}),
  'prototype operation': () => request('toString', {}),
  'extra key': () => request('acquire', { ttlSeconds: 60 }, { extra: 1 }),
  'missing key': () => { const { workspace, ...rest } = request('acquire', { ttlSeconds: 60 }); return rest; },
  'timeout zero': () => request('acquire', { ttlSeconds: 60 }, { timeout: 0 }),
  'timeout too long': () => request('acquire', { ttlSeconds: 60 }, { timeout: 1801 }),
  'null target': () => request('acquire', { ttlSeconds: 60, target: null }),
  'ttl zero': () => request('acquire', { ttlSeconds: 0 }),
  'an array': () => '[]',
};
for (const [name, build] of Object.entries(bad)) {
  test('helper: invalid_request for ' + name, () => helper(async call => {
    assert.deepEqual(parse(await call(build())), { ok: false, error: 'invalid_request' });
  }));
}

test('helper: input of 16384 bytes is read, one byte more is invalid_request without reading on', () => helper(async call => {
  const base = JSON.stringify(request('acquire', { ttlSeconds: 60 }, { workspace: '' }));
  const fit = base.slice(0, -1) + ' '.repeat(16384 - base.length) + '}';
  assert.equal(fit.length, 16384);
  assert.equal(parse(await call(fit)).ok, true);
  assert.deepEqual(parse(await call(fit + ' ')), { ok: false, error: 'invalid_request' });
}));

test('helper: a lease.js failure keeps its code, a legacy inflight marker is busy', () => helper(async call => {
  assert.deepEqual(parse(await call(request('acquire', { ttlSeconds: 60 }))), { ok: false, error: 'busy' });
}, dir => writeFileSync(path.join(dir, 'inflight'), '')));

test('helper: damaged state is unsafe_state and an unexpected exception is internal_error', () => helper(async call => {
  assert.deepEqual(parse(await call(request('acquire', { ttlSeconds: 60 }))), { ok: false, error: 'unsafe_state' });
}, dir => writeFileSync(path.join(dir, 'leases.json'), '{', { mode: 0o600 })));

test('helper: a state directory that cannot be created is a plain failure code, never a crash', () => helper(async (call, dir) => {
  const got = parse(await call(request('acquire', { ttlSeconds: 60 })));
  assert.equal(got.ok, false);
  assert.ok(['internal_error', 'unsafe_state'].includes(got.error));
}, dir => { rmSync(dir, { recursive: true }); writeFileSync(dir, 'file'); }));
