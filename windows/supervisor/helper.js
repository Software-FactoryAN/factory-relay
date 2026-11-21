import os from 'node:os';
import path from 'node:path';
import { acquire, release, Failure } from './lease.js';

const REQUEST_LIMIT_BYTES = 16384;
const OPERATIONS = { acquire, release };
const KEYS = ['operation', 'args', 'owner', 'workspace', 'timeout'];

async function readRequest(stdin) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stdin) {
    chunks.push(chunk);
    size += chunk.length;
    if (size > REQUEST_LIMIT_BYTES) throw new Failure('invalid_request');
  }
  let request;
  try { request = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Failure('invalid_request'); }
  if (request === null || typeof request !== 'object' || Array.isArray(request) ||
      Object.keys(request).sort().join() !== [...KEYS].sort().join() || !Object.hasOwn(OPERATIONS, request.operation) ||
      !Number.isSafeInteger(request.timeout) || request.timeout < 1 || request.timeout > 1800) throw new Failure('invalid_request');
  return request;
}

/** Same one-line answer as src/remote.py: the request src/transport.js sends in, {ok, result} or {ok, error} out, always exit 0. */
export async function runHelper({ stdin = process.stdin, stdout = process.stdout, env = process.env } = {}) {
  let response;
  try {
    const request = await readRequest(stdin);
    const root = env.RELAY_STATE_DIR || path.join(os.homedir(), '.applets-control');
    response = { ok: true, result: await OPERATIONS[request.operation](root, request) };
  } catch (error) {
    response = { ok: false, error: error instanceof Failure ? error.message : 'internal_error' };
  }
  await new Promise(resolve => stdout.write(JSON.stringify(response) + '\n', resolve));
}
