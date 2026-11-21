import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { configSchema, parseOperation } from './schema.js';
import { saveFrame } from './frames.js';

import { quote, remoteCommand } from './remote-command.js';

export { quote };
export const MAX_OUTPUT = 1024 * 1024;

export async function loadConfig(file) {
  try {
    const body = await readFile(file, 'utf8');
    if (body.length > 16384) throw new Error();
    return configSchema.parse(JSON.parse(body));
  } catch {
    throw new Error('invalid_config');
  }
}

export function run(config, name, input) {
  const args = parseOperation(name, input);
  if (['acquire', 'release'].includes(name) && args.target && config.platform !== 'windows') throw new Error('invalid_arguments');
  const request = JSON.stringify({ operation: name, args, owner: config.owner, workspace: config.workspace, timeout: config.timeoutSeconds });
  const command = remoteCommand(config, 'helper');
  const transportArgs = config.transport === 'factory'
    ? ['computer', 'ssh', config.computer, '--', command] : [
    '-F', '/dev/null', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=10', '-o', 'ConnectionAttempts=1', '-o', 'ServerAliveInterval=5',
    '-o', 'ServerAliveCountMax=2', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes',
    '-o', 'RequestTTY=no', '-o', 'LogLevel=ERROR',
    '-p', String(config.port), '-l', config.user,
    ...(config.identityFile ? ['-o', 'IdentitiesOnly=yes', '-i', config.identityFile] : []),
    '--', config.host, command,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(config.transport === 'factory' ? 'droid' : 'ssh', transportArgs,
      { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let size = 0, output = [], failure;
    const killGroup = () => {
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    };
    const stop = code => { failure ??= code; killGroup(); };
    const onSignal = () => stop('transport_interrupted');
    process.once('SIGTERM', onSignal);
    process.once('SIGINT', onSignal);
    const timer = setTimeout(() => stop('transport_timeout'), (config.timeoutSeconds + 15) * 1000);
    for (const [stream, capture] of [[child.stdout, true], [child.stderr, false]]) {
      stream.on('data', data => {
        size += data.length;
        if (size > MAX_OUTPUT) stop('transport_output_limit');
        else if (capture) output.push(data);
      });
    }
    child.stdin.on('error', () => {});
    child.on('error', () => { failure = 'transport_unavailable'; });
    child.on('close', code => {
      clearTimeout(timer);
      process.removeListener('SIGTERM', onSignal);
      process.removeListener('SIGINT', onSignal);
      killGroup();
      if (failure || code !== 0) return reject(new Error(failure ?? 'transport_failed'));
      try {
        const response = JSON.parse(Buffer.concat(output).toString('utf8'));
        if (response.ok === true && response.result && typeof response.result === 'object') {
          resolve(name === 'frame' ? saveFrame(config, args.observationId, response.result) : response.result);
        }
        else if (response.ok === false && ERROR_CODES.has(response.error)) {
          const error = new Error(response.error);
          if (Array.isArray(response.warnings)) error.warnings = response.warnings.filter(w => WARNING_CODES.has(w));
          reject(error);
        }
        else reject(new Error('invalid_remote_response'));
      } catch { reject(new Error('invalid_remote_response')); }
    });
    child.stdin.end(request);
  });
}

const WARNING_CODES = new Set(['apple_package_authorization_required', 'remote_stderr_present',
  'apple_simulator_framework_incompatible', 'apple_coredevice_framework_incompatible']);

const ERROR_CODES = new Set([
  'busy', 'lease_held', 'stale_lease', 'lease_expired', 'command_failed', 'command_timeout',
  'command_output_limit', 'invalid_remote_output', 'unsafe_state', 'invalid_request',
  'workspace_unavailable', 'internal_error',
  'command_interrupted',
  'observation_stale', 'target_mismatch', 'target_not_booted', 'target_unavailable',
  'application_mismatch', 'element_unavailable', 'invalid_visual_artifact', 'artifact_limit',
  'bridge_protocol_error', 'bridge_closed', 'bridge_tool_error', 'bridge_approval_required',
  'session_identifier_conflict',
]);
