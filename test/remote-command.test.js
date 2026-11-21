import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { remoteCommand, quote } from '../src/remote-command.js';
import { configSchema } from '../src/schema.js';

const source = name => readFileSync(new URL('../src/' + name, import.meta.url), 'utf8');
const dropMain = text => text.replace(/if __name__ == "__main__":\n    \w+\(\)\s*$/, '');
// The commands the three launch sites built before the seam existed.
const legacy = {
  helper: source('remote.py').replace('if __name__ == "__main__":',
    source('bridge.py') + '\n' + source('visual.py') + '\nif __name__ == "__main__":'),
  stream: source('remote.py').replace('if __name__ == "__main__":\n    main()', '') + '\n' + source('stream-supervisor.py'),
  control: [dropMain(source('remote.py')), dropMain(source('stream-supervisor.py')), source('control-supervisor.py')].join('\n'),
};
const base = { transport: 'factory', computer: 'test-computer', workspace: '/Users/test/work', owner: 'human:test' };
const windows = { ...base, platform: 'windows', supervisor: 'C:\\relay\\windows\\supervisor.js' };

test('Mac commands are byte-identical to the pre-seam launch commands', () => {
  for (const role of Object.keys(legacy)) {
    const expected = `/usr/bin/python3 -c ${quote(legacy[role])}`;
    assert.equal(remoteCommand(configSchema.parse(base), role), expected, role);
    assert.equal(remoteCommand(configSchema.parse({ ...base, platform: 'mac' }), role), expected, role);
  }
});

test('Windows commands are short and name the supervisor and the role', () => {
  for (const role of Object.keys(legacy)) {
    const command = remoteCommand(configSchema.parse(windows), role);
    assert.equal(command, `node "C:\\relay\\windows\\supervisor.js" ${role}`);
    assert.ok(command.length < 32767 / 100);
  }
});

test('remoteCommand refuses an unknown role, an unknown platform and a Windows config without supervisor', () => {
  assert.throws(() => remoteCommand(base, 'shell'), /invalid_remote_role/);
  assert.throws(() => remoteCommand(base, '__proto__'), /invalid_remote_role/);
  assert.throws(() => remoteCommand({ ...base, platform: 'linux' }, 'stream'), /invalid_config/);
  assert.throws(() => remoteCommand({ ...base, platform: 'windows' }, 'stream'), /invalid_config/);
});

test('config schema ties the supervisor path to the windows platform and limits its characters', () => {
  assert.deepEqual(configSchema.parse(base).platform, undefined);
  assert.equal(configSchema.safeParse({ ...base, platform: 'windows' }).success, false);
  assert.equal(configSchema.safeParse({ ...base, supervisor: windows.supervisor }).success, false);
  assert.equal(configSchema.safeParse({ ...base, platform: 'mac', supervisor: windows.supervisor }).success, false);
  assert.equal(configSchema.safeParse({ ...base, platform: 'linux' }).success, false);
  assert.equal(configSchema.safeParse(windows).success, true);
  for (const bad of ['relay\\supervisor.js', '/usr/supervisor.js', 'C:\\a"b.js', 'C:\\%PATH%.js', 'C:\\a&b.js',
    'C:\\a^b.js', 'C:\\a|b.js', 'C:\\a\nb.js', 'C:\\' + 'a'.repeat(300)])
    assert.equal(configSchema.safeParse({ ...windows, supervisor: bad }).success, false, JSON.stringify(bad));
  assert.equal(configSchema.safeParse({ ...windows, transport: 'ssh', host: 'h', user: 'u' }).success, false);
});
