import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Failure, validTarget, authorize as authorizeLease } from './lease.js';
import { runHelper } from './helper.js';

export const STREAM_HEADER_LIMIT = 8192;
export const STREAM_IMAGE_LIMIT = 4 * 1024 * 1024;
const REQUEST_LIMIT_BYTES = 16384;
const BUFFER_PAUSE_BYTES = STREAM_IMAGE_LIMIT * 2;
const STEP_TIMEOUT_MS = 10000;
const ACK_WRITE_TIMEOUT_MS = 1000;
const ACK = 6;
const MODES = ['diagnose', 'windows', 'stream'];
const ERRORS = new Set(['busy', 'stale_lease', 'lease_expired', 'unsafe_state', 'unsafe_peer',
  'unsupported_host', 'ipc_path_limit', 'invalid_request', 'invalid_stream',
  'stream_timeout', 'stream_closed', 'stream_interrupted', 'host_unavailable']);

export { Failure, validTarget };

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sameKeys = (value, keys) => plain(value) && Object.keys(value).sort().join() === [...keys].sort().join();
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;

/** Same request contract as the Mac stream supervisor: one line, exact keys, bounded values. */
export function parseRequest(line) {
  let request;
  try { request = JSON.parse(line); } catch { throw new Failure('invalid_request'); }
  if (!sameKeys(request, ['owner', 'workspace', 'args', 'mode', 'target', 'timeout']) ||
      !MODES.includes(request.mode) || !integer(request.timeout, 1, 1800) ||
      typeof request.owner !== 'string' || typeof request.workspace !== 'string' ||
      !sameKeys(request.args, ['lease']) || !sameKeys(request.args.lease, ['token', 'generation']) ||
      !/^[a-f0-9]{64}$/.test(request.args.lease.token) || !integer(request.args.lease.generation, 0, 2 ** 53 - 2)) {
    throw new Failure('invalid_request');
  }
  if (request.mode === 'stream' ? !validTarget(request.target) : request.target !== null) throw new Failure('invalid_request');
  return request;
}

/** Windows and diagnose are read-only and accept any lease of the owner; a stream must hold the lease of its own target. */
export function authorize(root, request, nowSeconds = Date.now() / 1000) {
  const { owner, args: { lease }, mode, target } = request;
  return authorizeLease(root, { owner, lease, ...(mode === 'stream' ? { target } : {}) }, nowSeconds);
}

/** Byte queue over a stream with deadlines; pauses the source while a consumer is behind. */
class Reader {
  buffer = Buffer.alloc(0);
  ended = false;
  #wake = null;
  constructor(source) {
    this.source = source;
    source.on('data', chunk => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (this.buffer.length > BUFFER_PAUSE_BYTES) source.pause();
      this.#notify();
    });
    for (const event of ['end', 'close', 'error']) source.on(event, () => { this.ended = true; this.#notify(); });
  }
  #notify() { this.#wake?.(); }
  async fill(enough, deadline) {
    while (!enough()) {
      if (this.ended) throw new Failure('stream_closed');
      const left = deadline - Date.now();
      if (left <= 0) throw new Failure('stream_timeout');
      await new Promise(resolve => {
        const timer = setTimeout(resolve, left);
        this.#wake = () => { clearTimeout(timer); resolve(); };
      });
      this.#wake = null;
    }
  }
  async take(size, deadline) {
    await this.fill(() => this.buffer.length >= size, deadline);
    const out = this.buffer.subarray(0, size);
    this.buffer = this.buffer.subarray(size);
    this.source.resume();
    return out;
  }
  async line(limit, deadline) {
    await this.fill(() => this.buffer.indexOf(10) >= 0 || this.buffer.length > limit, deadline);
    const end = this.buffer.indexOf(10);
    if (end < 0 || end > limit) throw new Failure('invalid_stream');
    const out = this.buffer.subarray(0, end);
    this.buffer = this.buffer.subarray(end + 1);
    return out;
  }
}

// A write may not outlive the request: the step limit is cut to the time left before the request's own end.
export const within = (end, limitMs) => Math.max(1, Math.min(end - Date.now(), limitMs));

function write(sink, data, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Failure('stream_timeout')), timeoutMs);
    sink.write(data, error => { clearTimeout(timer); if (error) reject(new Failure('stream_closed')); else resolve(); });
  });
}

export function defaultEndpoint() {
  return process.platform === 'win32' ? '\\\\.\\pipe\\relay-win-' + os.userInfo().username : null;
}

function connect(endpoint, deadline) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(endpoint);
    const timer = setTimeout(() => { socket.destroy(); reject(new Failure('host_unavailable')); }, Math.max(1, deadline - Date.now()));
    socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
    socket.once('error', () => { clearTimeout(timer); reject(new Failure('host_unavailable')); });
  });
}

function checkHello(line) {
  let hello;
  try { hello = JSON.parse(line); } catch { throw new Failure('invalid_stream'); }
  if (!sameKeys(hello, ['protocol', 'type', 'pid']) || hello.protocol !== 1 || hello.type !== 'hello' || !integer(hello.pid, 1, Number.MAX_SAFE_INTEGER)) {
    throw new Failure('invalid_stream');
  }
}

const argumentsFor = request => request.mode !== 'stream' ? [request.mode] :
  request.target.kind === 'desktop' ? ['stream', 'desktop', String(request.target.displayId), request.target.displayUUID] :
    ['stream', String(request.target.windowId), String(request.target.pid), request.target.bundleId];

async function readPacket(host, deadline, mode) {
  const prefix = await host.take(4, deadline);
  let raw, header, image = Buffer.alloc(0);
  if (prefix[0] === 0x7b) {
    const rest = await host.line(STREAM_HEADER_LIMIT, deadline);
    try { header = JSON.parse(Buffer.concat([prefix, rest]).toString('utf8')); } catch { throw new Failure('invalid_stream'); }
    if (!plain(header) || !['diagnostic', 'windows'].includes(header.type)) throw new Failure('invalid_stream');
    header.bytes = 0;
    raw = Buffer.from(JSON.stringify(header));
  } else {
    const length = prefix.readUInt32BE();
    if (!(length > 0 && length <= STREAM_HEADER_LIMIT)) throw new Failure('invalid_stream');
    raw = await host.take(length, deadline);
    try { header = JSON.parse(raw.toString('utf8')); } catch { throw new Failure('invalid_stream'); }
    const size = header?.bytes;
    if (!plain(header) || !Number.isSafeInteger(size) ||
        !((header.type === 'frame' && size > 0 && size <= STREAM_IMAGE_LIMIT) || (header.type === 'heartbeat' && size === 0))) {
      throw new Failure('invalid_stream');
    }
    image = await host.take(size, deadline);
  }
  const allowed = mode === 'stream' ? ['frame', 'heartbeat', 'diagnostic'] : [mode === 'windows' ? 'windows' : 'diagnostic', 'diagnostic'];
  if (raw.length > STREAM_HEADER_LIMIT || !allowed.includes(header.type)) throw new Failure('invalid_stream');
  const size = Buffer.alloc(4);
  size.writeUInt32BE(raw.length);
  return { header, packet: Buffer.concat([size, raw, image]) };
}

export async function runStream({ stdin = process.stdin, stdout = process.stdout, env = process.env } = {}) {
  const input = new Reader(stdin);
  const request = parseRequest(await input.line(REQUEST_LIMIT_BYTES, Date.now() + STEP_TIMEOUT_MS).catch(error => {
    throw error.message === 'invalid_stream' ? new Failure('invalid_request') : error;
  }));
  const root = env.RELAY_STATE_DIR || path.join(os.homedir(), '.applets-control');
  const endpoint = env.RELAY_HOST_ENDPOINT || defaultEndpoint();
  if (!endpoint) throw new Failure('unsupported_host');
  authorize(root, request);
  const end = Date.now() + request.timeout * 1000;
  const socket = await connect(endpoint, Math.min(end, Date.now() + STEP_TIMEOUT_MS));
  const host = new Reader(socket);
  const closeHost = () => socket.destroy();
  // Only a stream needs the client; windows and diagnose answer once even if the client already closed stdin.
  if (request.mode === 'stream') stdin.once('close', closeHost);
  try {
    checkHello(await host.line(1024, Math.min(end, Date.now() + STEP_TIMEOUT_MS)));
    authorize(root, request);
    await write(socket, JSON.stringify(argumentsFor(request)) + '\n', within(end, STEP_TIMEOUT_MS));
    while (true) {
      const { header, packet } = await readPacket(host, Math.min(end, Date.now() + STEP_TIMEOUT_MS), request.mode);
      authorize(root, request);
      await write(stdout, packet, within(end, STEP_TIMEOUT_MS));
      if (!['frame', 'heartbeat'].includes(header.type)) return;
      const ack = await input.take(1, Math.min(end, Date.now() + STEP_TIMEOUT_MS));
      if (ack[0] !== ACK) throw new Failure('invalid_stream');
      authorize(root, request);
      await write(socket, ack, within(end, ACK_WRITE_TIMEOUT_MS));
    }
  } finally {
    stdin.removeListener('close', closeHost);
    socket.destroy();
  }
}

export function failureCode(error) {
  return error instanceof Failure && ERRORS.has(error.message) ? error.message : 'invalid_stream';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fail = error => {
    process.stderr.write('APPLETS_STREAM_ERROR:' + failureCode(error) + '\n', () => process.exit(1));
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => fail(new Failure('stream_interrupted')));
  if (process.argv[2] === 'helper') runHelper().then(() => process.exit(0), () => process.exit(1));
  else if (process.argv[2] !== 'stream') fail(new Failure('invalid_request'));
  else runStream().then(() => process.stdout.write('', () => process.exit(0)), fail);
}
