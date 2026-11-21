import { openSync, closeSync, writeSync, fsyncSync, readFileSync, renameSync, unlinkSync, lstatSync, readdirSync, mkdirSync, writeFileSync, constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const STATE_FILE = 'leases.json';
export const LOCK_FILE = 'leases.lock';
export const INFLIGHT_DIR = 'inflight.d';
const STATE_LIMIT_BYTES = 65536;
const MAX_ENTRIES = 256;
const RELAY_HOST_BUNDLE = 'com.factory.applets.host';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^(discovery|w:\d+:\d+:[A-Za-z0-9._-]{0,255}|d:\d+:[0-9a-f-]{36})$/;
const MARKER = /^(discovery|[wd]-[0-9a-f]{64})$/;
const DEFAULTS = { now: () => Date.now() / 1000, lockTimeoutMs: 2000, pollMs: 25, staleLockMs: 10000 };

export class Failure extends Error {}

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sameKeys = (value, keys) => plain(value) && Object.keys(value).sort().join() === [...keys].sort().join();
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const lstat = file => lstatSync(file, { throwIfNoEntry: false });
const emptyState = () => ({ desktopGeneration: 0, leases: {} });

export function validTarget(target) {
  if (!plain(target)) return false;
  if (target.kind === 'desktop') {
    return sameKeys(target, ['kind', 'displayId', 'displayUUID']) && integer(target.displayId, 1, 0xffffffff) &&
      typeof target.displayUUID === 'string' && UUID.test(target.displayUUID);
  }
  return sameKeys(target, ['windowId', 'pid', 'bundleId']) && integer(target.windowId, 1, 0xffffffff) &&
    integer(target.pid, 1, 0x7fffffff) && typeof target.bundleId === 'string' && /^[A-Za-z0-9._-]{0,255}$/.test(target.bundleId) &&
    target.bundleId !== RELAY_HOST_BUNDLE;
}

/** No target is the discovery lease; null or a malformed target is a request error, never discovery. */
export function targetKey(target) {
  if (target === undefined) return 'discovery';
  if (!validTarget(target)) throw new Failure('invalid_request');
  return target.kind === 'desktop' ? 'd:' + target.displayId + ':' + target.displayUUID
    : 'w:' + target.windowId + ':' + target.pid + ':' + target.bundleId;
}

const validProof = proof => sameKeys(proof, ['token', 'generation']) && /^[a-f0-9]{64}$/.test(proof.token) &&
  integer(proof.generation, 0, 2 ** 53 - 2);
const validLease = lease => lease === null || (sameKeys(lease, ['owner', 'token', 'expiresAt']) &&
  typeof lease.owner === 'string' && /^[a-f0-9]{64}$/.test(lease.token) && Number.isFinite(lease.expiresAt));
const live = (entry, now) => Boolean(entry?.lease) && entry.lease.expiresAt > now;
const holds = (entry, owner, proof) => Boolean(entry?.lease) && proof.generation === entry.generation &&
  owner === entry.lease.owner && timingSafeEqual(Buffer.from(proof.token), Buffer.from(entry.lease.token));

/** Reads leases.json; read-only, and anything unreadable or malformed is unsafe_state. */
export function readState(root) {
  const file = path.join(root, STATE_FILE);
  let raw;
  try {
    const info = lstat(file);
    if (!info) return emptyState();
    if (!info.isFile() || info.nlink !== 1 || info.size > STATE_LIMIT_BYTES ||
        (process.getuid && (info.uid !== process.getuid() || (info.mode & 0o077)))) throw new Failure('unsafe_state');
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    throw error instanceof Failure ? error : new Failure('unsafe_state');
  }
  if (!raw) return emptyState();
  let state;
  try { state = JSON.parse(raw); } catch { throw new Failure('unsafe_state'); }
  if (!sameKeys(state, ['desktopGeneration', 'leases']) || !integer(state.desktopGeneration, 0, 2 ** 53 - 2) ||
      !plain(state.leases) || Object.keys(state.leases).length > MAX_ENTRIES) throw new Failure('unsafe_state');
  for (const [key, entry] of Object.entries(state.leases)) {
    if (!KEY.test(key) || !sameKeys(entry, ['generation', 'lease']) || !integer(entry.generation, 0, 2 ** 53 - 2) ||
        !validLease(entry.lease) || (key.startsWith('d:') && entry.generation > state.desktopGeneration)) throw new Failure('unsafe_state');
  }
  return state;
}

function writeState(root, state, retries = process.platform === 'win32' ? 5 : 0) {
  const body = JSON.stringify(state);
  if (body.length > STATE_LIMIT_BYTES) throw new Failure('busy');
  const temp = path.join(root, 'leases-' + randomBytes(16).toString('hex') + '.tmp');
  try {
    const fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), 0o600);
    try { writeSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
    for (let attempt = 0; ; attempt++) {
      try { renameSync(temp, path.join(root, STATE_FILE)); break; } catch (error) {
        if (attempt >= retries || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    if (process.platform !== 'win32') {
      const dir = openSync(root, constants.O_RDONLY);
      try { fsyncSync(dir); } finally { closeSync(dir); }
    }
  } catch (error) {
    throw error instanceof Failure ? error : new Failure('unsafe_state');
  } finally {
    try { unlinkSync(temp); } catch {}
  }
}

const markerName = key => key === 'discovery' ? key : key[0] + '-' + createHash('sha256').update(key).digest('hex');

/** The global markers stop everything; a per-target marker stops its target, and desktop markers stop windows too. */
function checkBusy(root, key) {
  if (lstat(path.join(root, 'inflight')) || lstat(path.join(root, 'bridge-session.json'))) throw new Failure('busy');
  const dir = path.join(root, INFLIGHT_DIR);
  const info = lstat(dir);
  if (!info) return;
  if (!info.isDirectory()) throw new Failure('unsafe_state');
  const names = readdirSync(dir);
  if (names.some(name => !MARKER.test(name) || !lstat(path.join(dir, name))?.isFile())) throw new Failure('unsafe_state');
  const own = markerName(key);
  const desktop = desktopKey(key);
  if (names.some(name => name === own || (key !== 'discovery' && name.startsWith('d-')) || (desktop && name.startsWith('w-')))) {
    throw new Failure('busy');
  }
}

export function setInflight(root, target, pid = process.pid) {
  const key = targetKey(target);
  checkBusy(root, key);
  mkdirSync(path.join(root, INFLIGHT_DIR), { recursive: true, mode: 0o700 });
  try { writeFileSync(path.join(root, INFLIGHT_DIR, markerName(key)), String(pid), { flag: 'wx', mode: 0o600 }); }
  catch { throw new Failure('busy'); }
}

export function clearInflight(root, target) {
  try { unlinkSync(path.join(root, INFLIGHT_DIR, markerName(targetKey(target)))); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

/** Pure check for one target: stale_lease unless generation, owner and token match, then lease_expired. */
export function verify(state, { owner, lease: proof, target }, nowSeconds = Date.now() / 1000) {
  const entry = state.leases[targetKey(target)];
  if (!validProof(proof) || !Object.hasOwn(state.leases, targetKey(target)) || !holds(entry, owner, proof)) throw new Failure('stale_lease');
  if (entry.lease.expiresAt <= nowSeconds) throw new Failure('lease_expired');
  return entry.lease;
}

/** For read-only modes: any lease of this owner proves the caller, discovery or target. */
export function verifyAny(state, { owner, lease: proof }, nowSeconds = Date.now() / 1000) {
  const entry = validProof(proof) && Object.values(state.leases).find(e => holds(e, owner, proof));
  if (!entry) throw new Failure('stale_lease');
  if (entry.lease.expiresAt <= nowSeconds) throw new Failure('lease_expired');
  return entry.lease;
}

export function authorize(root, request, nowSeconds = Date.now() / 1000) {
  checkBusy(root, targetKey(request.target));
  const state = readState(root);
  return request.target === undefined ? verifyAny(state, request, nowSeconds) : verify(state, request, nowSeconds);
}

/** A lock whose owner is alive is never taken over, however old; age only decides for a lock file with no readable owner. */
function reclaimable(file, options) {
  const info = lstat(file);
  if (!info) return true;
  if (!info.isFile()) throw new Failure('unsafe_state');
  let verdict = false;
  try {
    const { pid } = JSON.parse(readFileSync(file, 'utf8'));
    if (!integer(pid, 1, 2 ** 31 - 1)) throw new Error();
    try { process.kill(pid, 0); } catch (error) { verdict = error.code === 'ESRCH'; }
  } catch { verdict = Date.now() - info.mtimeMs > options.staleLockMs; }
  const again = lstat(file);
  if (verdict && again?.ino === info.ino && again.mtimeMs === info.mtimeMs) {
    try { unlinkSync(file); } catch {}
  }
  return verdict || !again;
}

async function withLock(root, options, task) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, LOCK_FILE);
  const nonce = randomBytes(8).toString('hex');
  const until = Date.now() + options.lockTimeoutMs;
  for (;;) {
    try {
      const fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), 0o600);
      try { writeSync(fd, JSON.stringify({ pid: process.pid, nonce })); fsyncSync(fd); } finally { closeSync(fd); }
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw new Failure('unsafe_state');
      if (reclaimable(file, options)) continue;
      if (Date.now() >= until) throw new Failure('busy');
      await sleep(options.pollMs);
    }
  }
  try { return await task(); } finally {
    try { if (JSON.parse(readFileSync(file, 'utf8')).nonce === nonce) unlinkSync(file); } catch {}
  }
}

/** Two keys exclude each other when equal, or when either is a desktop; discovery and window pairs never conflict. */
const desktopKey = key => key.startsWith('d:');
const conflicts = (a, b) => a === b || (a !== 'discovery' && b !== 'discovery' && (desktopKey(a) || desktopKey(b)));

function parse(request, argKeys) {
  const args = request?.args;
  if (!plain(request) || typeof request.owner !== 'string' || !plain(args) ||
      !Object.keys(args).every(key => [...argKeys, 'target'].includes(key))) throw new Failure('invalid_request');
  return { args, key: targetKey(args.target), owner: request.owner, ...(args.target ? { target: args.target } : {}) };
}

export async function acquire(root, request, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const { args, key, owner, target } = parse(request, ['ttlSeconds', 'takeover']);
  const takeover = args.takeover ?? false;
  if (!integer(args.ttlSeconds, 1, 3600) || typeof takeover !== 'boolean') throw new Failure('invalid_request');
  return withLock(root, o, () => {
    checkBusy(root, key);
    const state = readState(root), now = o.now();
    const held = Object.entries(state.leases).filter(([other, entry]) => live(entry, now) && conflicts(key, other));
    if (held.some(([other]) => other !== key) || (held.length && !takeover)) throw new Failure('lease_held');
    if (!state.leases[key] && Object.keys(state.leases).length >= MAX_ENTRIES) {
      const spare = Object.entries(state.leases).find(([other, entry]) => !desktopKey(other) && !live(entry, now));
      if (!spare) throw new Failure('busy');
      delete state.leases[spare[0]];
    }
    let generation;
    if (desktopKey(key)) generation = ++state.desktopGeneration;
    else generation = (state.leases[key]?.generation ?? 0) + 1;
    const lease = { owner, token: randomBytes(32).toString('hex'), expiresAt: now + args.ttlSeconds };
    state.leases[key] = { generation, lease };
    writeState(root, state);
    return { ...lease, generation, ...(target ? { target } : {}) };
  });
}

export async function release(root, request, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const { args, key, owner, target } = parse(request, ['lease']);
  return withLock(root, o, () => {
    checkBusy(root, key);
    const state = readState(root);
    verify(state, { owner, lease: args.lease, target: args.target }, o.now());
    const generation = desktopKey(key) ? ++state.desktopGeneration : state.leases[key].generation + 1;
    state.leases[key] = { generation, lease: null };
    writeState(root, state);
    return { released: true, generation, ...(target ? { target } : {}) };
  });
}
