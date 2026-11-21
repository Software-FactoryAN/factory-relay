import { spawn } from 'node:child_process';
import { z } from 'zod';
import { configSchema } from './schema.js';
import { remoteCommand } from './remote-command.js';
import { windowTargetSchema, desktopTargetSchema, targetSchema, displayConfigurationSchema, sameTarget } from './window-target.js';

export const HEADER_LIMIT = 8192;
export const IMAGE_LIMIT = 4 * 1024 * 1024;
const STREAM_ERRORS = new Set(['busy', 'stale_lease', 'lease_expired', 'unsafe_state', 'unsafe_peer',
  'unsupported_host', 'ipc_path_limit', 'invalid_request', 'invalid_stream',
  'stream_timeout', 'stream_closed', 'stream_interrupted', 'host_unavailable']);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const rect = z.tuple([z.number().finite(), z.number().finite(), z.number().nonnegative().finite(), z.number().nonnegative().finite()]);
export const streamTargetSchema = targetSchema;
const frameFields = {
  protocol: z.literal(1), type: z.literal('frame'), sequence: integer.min(1),
  mediaType: z.literal('image/jpeg'),
  width: integer.min(1).max(2048), height: integer.min(1).max(2048),
  captureTimeSeconds: z.number().nonnegative().finite(), sentUptimeSeconds: z.number().nonnegative().finite(),
  contentRectPixels: rect,
  contentScale: z.number().positive().finite(), scaleFactor: z.number().positive().finite(),
  replacedFrames: integer, bytes: integer.min(1).max(IMAGE_LIMIT),
};
const frameSchema = z.union([
  z.strictObject({ ...frameFields, ...windowTargetSchema.shape, initialWindowRectPoints: rect,
    processStartedAt: z.number().finite().optional() }),
  z.strictObject({ ...frameFields, ...desktopTargetSchema.shape, displayConfiguration: displayConfigurationSchema }),
]);
const diagnosticSchema = z.strictObject({
  protocol: z.literal(1), type: z.literal('diagnostic'), bytes: z.literal(0),
  code: z.enum(['permission_preflight', 'screen_recording_required', 'capture_unavailable']),
  bundleId: z.literal('com.factory.applets.host'), bundlePath: z.string().max(4096),
  executablePath: z.string().max(4096), screenRecording: z.boolean(),
  accessibility: z.boolean(), permissionRequested: z.literal(false),
  launchMode: z.enum(['stdio', 'launchservices-ipc']).optional(),
  processId: integer.min(1).optional(), parentProcessId: integer.min(1).optional(),
  lifecycle: z.strictObject({
    appKitInitialized: z.boolean(), eventLoopRunning: z.boolean(),
    launchFinished: z.boolean(), mainThread: z.boolean(),
  }).optional(),
  stage: z.enum(['app_ready', 'enumerating', 'windows_ready', 'creating_filter',
    'filter_ready', 'starting_capture', 'capturing', 'stopping_capture']).optional(),
});
const windowsSchema = z.strictObject({
  protocol: z.literal(1), type: z.literal('windows'), bytes: z.literal(0),
  displays: z.array(desktopTargetSchema.extend({ main: z.boolean(), displayConfiguration: displayConfigurationSchema })).max(32).default([]),
  windows: z.array(windowTargetSchema.extend({ title: z.string().max(1024), windowRectPoints: rect,
    displayName: z.string().max(120).optional(), processStartedAt: z.number().finite().optional() })).max(100),
});
const heartbeatSchema = z.strictObject({
  protocol: z.literal(1), type: z.literal('heartbeat'), bytes: z.literal(0),
  sentUptimeSeconds: z.number().nonnegative().finite(),
});
const headerSchema = z.union([frameSchema, diagnosticSchema, windowsSchema, heartbeatSchema]);

/** Bounded packet buffering; consumer completion gates transport acknowledgments. */
export async function* decodeStream(readable) {
  let buffer = Buffer.alloc(0), header, headerBytes = 0, sequence = 0;
  for await (const chunk of readable) {
    if (!Buffer.isBuffer(chunk) || buffer.length + chunk.length > IMAGE_LIMIT + HEADER_LIMIT + 65540)
      throw new Error('stream_buffer_limit');
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      if (!header) {
        if (buffer.length < 4) break;
        headerBytes = buffer.readUInt32BE();
        if (headerBytes < 1 || headerBytes > HEADER_LIMIT) throw new Error('invalid_stream_header');
        if (buffer.length < 4 + headerBytes) break;
        header = headerSchema.parse(JSON.parse(buffer.subarray(4, 4 + headerBytes).toString('utf8')));
        buffer = buffer.subarray(4 + headerBytes);
      }
      if (buffer.length < header.bytes) break;
      const image = Buffer.from(buffer.subarray(0, header.bytes));
      buffer = buffer.subarray(header.bytes);
      if (header.type === 'frame') {
        if (header.sequence <= sequence || image.length < 4 ||
            image.readUInt16BE(0) !== 0xffd8 || image.readUInt16BE(image.length - 2) !== 0xffd9)
          throw new Error('invalid_stream_frame');
        sequence = header.sequence;
      }
      yield { header, image };
      header = undefined;
    }
  }
  if (buffer.length || header) throw new Error('truncated_stream');
}

const proofSchema = z.strictObject({ token: z.string().regex(/^[a-f0-9]{64}$/), generation: integer });

/** Transport seam for a future native sidebar; no UI or input API is implied. */
export async function consumeHost(config, { lease, mode = 'stream', target = null, signal }, consume) {
  config = configSchema.parse(config);
  if (config.transport !== 'factory') throw new Error('factory_transport_required');
  lease = proofSchema.parse(lease);
  mode = z.enum(['diagnose', 'windows', 'stream']).parse(mode);
  target = mode === 'stream' ? streamTargetSchema.parse(target) : z.null().parse(target);
  if (signal?.aborted) throw new Error('stream_cancelled');
  const child = spawn('droid', ['computer', 'ssh', config.computer, '--', remoteCommand(config, 'stream')],
    { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  let stderrBytes = 0, stderr = '', failure, frames = 0, packets = 0, terminal = false;
  const stop = () => {
    if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; } }
  };
  const cancel = () => { failure = new Error('stream_cancelled'); stop(); };
  const done = new Promise(resolve => {
    child.on('error', () => { failure = new Error('transport_unavailable'); });
    child.on('close', resolve);
  });
  child.stderr.on('data', chunk => {
    stderrBytes += chunk.length;
    if (stderrBytes > 65536) { failure = new Error('transport_output_limit'); stop(); }
    else {
      stderr += chunk.toString('utf8');
      const code = stderr.match(/^APPLETS_STREAM_ERROR:([a-z_]+)\r?$/m)?.[1];
      if (STREAM_ERRORS.has(code)) failure ??= new Error(code);
    }
  });
  child.stdin.on('error', () => {});
  signal?.addEventListener('abort', cancel, { once: true });
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  const timer = setTimeout(() => { failure = new Error('stream_timeout'); stop(); }, (config.timeoutSeconds + 15) * 1000);
  child.stdin.write(JSON.stringify({ owner: config.owner, workspace: config.workspace, args: { lease },
    mode, target, timeout: config.timeoutSeconds }) + '\n');
  try {
    for await (const packet of decodeStream(child.stdout)) {
      const kind = packet.header.type;
      if (terminal || (kind !== 'diagnostic' && !(
        (mode === 'windows' && kind === 'windows') || (mode === 'stream' && ['frame', 'heartbeat'].includes(kind))
      ))) throw new Error('invalid_stream_response');
      packets++;
      terminal = ['diagnostic', 'windows'].includes(kind);
      if (packet.header.type === 'frame') {
        if (!sameTarget(packet.header, target)) throw new Error('stream_target_mismatch');
        frames++;
      }
      const streaming = ['frame', 'heartbeat'].includes(packet.header.type);
      await new Promise((resolve, reject) => {
        const finish = error => {
          clearTimeout(deadline);
          child.removeListener('close', closed);
          if (error) reject(error); else resolve();
        };
        const closed = code => {
          if (streaming || failure || code !== 0) finish(failure ?? new Error('stream_terminated'));
        };
        const deadline = setTimeout(() => finish(new Error('stream_consumer_timeout')), 10000);
        child.once('close', closed);
        Promise.resolve().then(() => consume(packet)).then(() => finish(), finish);
      });
      if (streaming) child.stdin.write(Buffer.from([6]));
    }
    const code = await done;
    if (failure) throw failure;
    if (code !== 0) throw new Error('stream_terminated');
    if (!packets) throw new Error('empty_stream');
    return { frames };
  } catch (error) {
    throw failure ?? error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    stop();
    await done;
  }
}
