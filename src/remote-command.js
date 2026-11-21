import { readFile } from 'node:fs/promises';

export const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";

const read = async name => readFile(new URL('./' + name, import.meta.url), 'utf8');
const dropMain = source => source.replace(/if __name__ == "__main__":\n    \w+\(\)\s*$/, '');
const pythonSources = {
  helper: (await read('remote.py')).replace(
    'if __name__ == "__main__":',
    (await read('bridge.py')) + '\n' + (await read('visual.py')) + '\nif __name__ == "__main__":'),
  stream: (await read('remote.py')).replace('if __name__ == "__main__":\n    main()', '') + '\n' +
    await read('stream-supervisor.py'),
  control: dropMain(await read('remote.py')) + '\n' + dropMain(await read('stream-supervisor.py')) + '\n' +
    await read('control-supervisor.py'),
};

/** The command a transport runs on the remote computer for one role: helper, stream or control. */
export function remoteCommand(config, role) {
  if (!Object.hasOwn(pythonSources, role)) throw new Error('invalid_remote_role');
  if (config.platform === 'windows') {
    if (typeof config.supervisor !== 'string') throw new Error('invalid_config');
    // The schema admits only characters that cmd.exe leaves alone inside double quotes.
    return `node "${config.supervisor}" ${role}`;
  }
  if (config.platform !== undefined && config.platform !== 'mac') throw new Error('invalid_config');
  return `/usr/bin/python3 -c ${quote(pythonSources[role])}`;
}
