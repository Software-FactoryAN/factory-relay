import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { configSchema } from '../src/schema.js';

const project = fileURLToPath(new URL('..', import.meta.url));
function checkout(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory relay setup '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['scripts/setup.js', 'src/schema.js', 'src/qa-applications.js', 'src/window-target.js', 'web/target-identity.js', 'package.json']) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.copyFileSync(path.join(project, name), path.join(root, name));
  }
  fs.symlinkSync(path.join(project, 'node_modules'), path.join(root, 'node_modules'));
  return root;
}
const args = ['--computer', 'test-mac', '--workspace', "/Users/test/Projects/QA's sample"];
function run(root, extra = args) {
  return spawnSync(process.execPath, [path.join(root, 'scripts/setup.js'), ...extra],
    { cwd: root, encoding: 'utf8', timeout: 10000 });
}
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const put = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const server = root => ({ type: 'stdio', command: 'node', args: [path.join(root, 'src/qa-mcp.js')], timeout: 100000, disabled: false });

test('setup CLI creates private valid config and absolute project MCP paths in a checkout with spaces', t => {
  const root = checkout(t), result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /factory-relay configured/);
  const config = path.join(root, 'config.local.json'), mcp = path.join(root, '.factory/mcp.json');
  assert.deepEqual(configSchema.parse(json(config)), {
    transport: 'factory', computer: 'test-mac', workspace: "/Users/test/Projects/QA's sample",
    owner: 'human:factory-relay', timeoutSeconds: 300,
  });
  assert.deepEqual(json(mcp), { mcpServers: { 'factory-relay': server(root) } });
  assert.equal(fs.statSync(config).mode & 0o777, 0o600);
  assert.equal(fs.statSync(mcp).mode & 0o777, 0o600);
  const before = [config, mcp].map(f => ({ text: fs.readFileSync(f, 'utf8'), mtime: fs.statSync(f).mtimeMs }));
  assert.equal(run(root).status, 0);
  assert.deepEqual([config, mcp].map(f => ({ text: fs.readFileSync(f, 'utf8'), mtime: fs.statSync(f).mtimeMs })), before);
});

test('setup preserves unrelated metadata and migrates only the recognized legacy server', t => {
  const root = checkout(t), file = path.join(root, '.factory/mcp.json');
  fs.mkdirSync(path.dirname(file));
  const other = { type: 'http', url: 'https://example.invalid/mcp', disabled: true };
  put(file, { otherSetting: ['keep'], mcpServers: { other, 'applets-qa': server(root) } });
  assert.equal(run(root).status, 0);
  assert.deepEqual(json(file), { otherSetting: ['keep'], mcpServers: { other, 'factory-relay': server(root) } });
  put(file, { mcpServers: { 'applets-qa': { ...server(root), disabled: true } } });
  assert.equal(run(root).status, 0);
  assert.equal(json(file).mcpServers['applets-qa'].disabled, true, 'Unrecognized legacy settings must remain untouched');
  assert.deepEqual(json(file).mcpServers['factory-relay'], server(root));
});

test('setup refuses mismatched existing config or server before changing either file', t => {
  const root = checkout(t);
  assert.equal(run(root).status, 0);
  const config = path.join(root, 'config.local.json'), mcp = path.join(root, '.factory/mcp.json');
  const originalConfig = fs.readFileSync(config, 'utf8'), originalMcp = fs.readFileSync(mcp, 'utf8');
  const mismatch = run(root, ['--computer', 'other-mac', '--workspace', '/Users/test/Projects/sample']);
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, /Refusing to overwrite differing config/);
  assert.equal(fs.readFileSync(config, 'utf8'), originalConfig);
  assert.equal(fs.readFileSync(mcp, 'utf8'), originalMcp);
  put(mcp, { mcpServers: { 'factory-relay': { command: 'custom' } } });
  const changedMcp = fs.readFileSync(mcp, 'utf8');
  fs.unlinkSync(config);
  assert.equal(run(root).status, 1);
  assert.equal(fs.existsSync(config), false, 'MCP conflict must be detected before creating config');
  assert.equal(fs.readFileSync(mcp, 'utf8'), changedMcp);
});

test('setup validates arguments and JSON and refuses symlink destinations', t => {
  const root = checkout(t);
  for (const invalid of [[], ['--computer', '-bad', '--workspace', '/tmp/work'],
    ['--computer', 'mac', '--workspace', '/tmp/../work'], ['--computer', 'mac', '--workspace', '/'],
    [...args, '--owner', 'contains spaces'], [...args, '--unknown', 'value'], [...args, '--computer', 'again']]) {
    assert.equal(run(root, invalid).status, 1, JSON.stringify(invalid));
    assert.equal(fs.existsSync(path.join(root, 'config.local.json')), false);
  }
  const mcp = path.join(root, '.factory/mcp.json');
  fs.mkdirSync(path.dirname(mcp));
  fs.writeFileSync(mcp, '{broken');
  assert.equal(run(root).status, 1);
  assert.equal(fs.readFileSync(mcp, 'utf8'), '{broken');
  fs.unlinkSync(mcp);
  fs.symlinkSync(path.join(root, 'package.json'), mcp);
  assert.equal(run(root).status, 1);
  assert.equal(json(path.join(root, 'package.json')).name, 'factory-relay');
});

test('setup writes platform and supervisor only when given and refuses an inconsistent pair', t => {
  const root = checkout(t), config = path.join(root, 'config.local.json');
  const windowsArgs = [...args, '--platform', 'windows', '--supervisor', 'C:\\relay\\supervisor.js'];
  for (const invalid of [[...args, '--platform', 'windows'], [...args, '--supervisor', 'C:\\relay\\supervisor.js'],
    [...args, '--platform', 'linux'], [...windowsArgs, '--platform', 'mac'], [...args, '--platform', 'mac', '--supervisor', 'C:\\x.js']]) {
    assert.equal(run(root, invalid).status, 1, JSON.stringify(invalid));
    assert.equal(fs.existsSync(config), false);
  }
  assert.equal(run(root, windowsArgs).status, 0);
  assert.deepEqual(configSchema.parse(json(config)), {
    transport: 'factory', computer: 'test-mac', workspace: "/Users/test/Projects/QA's sample",
    owner: 'human:factory-relay', timeoutSeconds: 300, platform: 'windows', supervisor: 'C:\\relay\\supervisor.js',
  });
  assert.equal(run(root).status, 1, 'a Mac setup must not overwrite a Windows config');
});
