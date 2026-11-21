import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { configSchema } from '../src/schema.js';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const usage = 'Usage: npm run setup -- --computer REGISTERED_NAME --workspace /Users/USER/Projects/factory-relay [--owner human:NAME] [--platform mac|windows --supervisor C:\\path\\to\\supervisor.js]';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function existing(file) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024)
    throw new Error(`Refusing unsafe configuration: ${path.basename(file)}`);
  return fs.readFileSync(file, 'utf8');
}

export function setup(args, root = projectRoot) {
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!['--computer', '--workspace', '--owner', '--platform', '--supervisor'].includes(key) || values[key] !== undefined || !args[i + 1])
      throw new Error(usage);
    values[key] = args[i + 1];
  }
  const parsed = configSchema.safeParse({
    transport: 'factory', computer: values['--computer'], workspace: values['--workspace'],
    owner: values['--owner'] ?? 'human:factory-relay', timeoutSeconds: 300,
    ...(values['--platform'] === undefined ? {} : { platform: values['--platform'] }),
    ...(values['--supervisor'] === undefined ? {} : { supervisor: values['--supervisor'] }),
  });
  if (!parsed.success) throw new Error(usage + '\nUse a registered computer name and normalized absolute remote path.');
  root = fs.realpathSync(root);
  const configFile = path.join(root, 'config.local.json');
  const factory = path.join(root, '.factory');
  if (fs.existsSync(factory) && (!fs.lstatSync(factory).isDirectory() || fs.lstatSync(factory).isSymbolicLink()))
    throw new Error('Refusing unsafe .factory directory');
  const mcpFile = path.join(factory, 'mcp.json');
  const configText = existing(configFile);
  if (configText !== null && !isDeepStrictEqual(JSON.parse(configText), parsed.data))
    throw new Error('Refusing to overwrite differing config.local.json. Keep it, or review and move it aside before setup.');
  const mcpText = existing(mcpFile);
  const mcp = mcpText === null ? { mcpServers: {} } : JSON.parse(mcpText);
  if (!object(mcp) || (mcp.mcpServers !== undefined && !object(mcp.mcpServers)))
    throw new Error('Invalid project MCP configuration');
  mcp.mcpServers ??= {};
  const server = {
    type: 'stdio', command: 'node', args: [path.join(root, 'src/qa-mcp.js')],
    timeout: 100000, disabled: false,
  };
  if (Object.hasOwn(mcp.mcpServers, 'factory-relay') && !isDeepStrictEqual(mcp.mcpServers['factory-relay'], server))
    throw new Error('Refusing to overwrite differing factory-relay MCP server.');
  if (isDeepStrictEqual(mcp.mcpServers['applets-qa'], server)) delete mcp.mcpServers['applets-qa'];
  mcp.mcpServers['factory-relay'] = server;
  const nextMcp = JSON.stringify(mcp, null, 2) + '\n';
  fs.mkdirSync(factory, { recursive: true });
  if (configText === null) fs.writeFileSync(configFile, JSON.stringify(parsed.data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  if (mcpText === null) fs.writeFileSync(mcpFile, nextMcp, { flag: 'wx', mode: 0o600 });
  else if (!isDeepStrictEqual(JSON.parse(mcpText), mcp)) {
    const temporary = path.join(factory, `.mcp-setup-${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, nextMcp, { flag: 'wx', mode: 0o600 });
      if (existing(mcpFile) !== mcpText) throw new Error('MCP configuration changed during setup; retry after reviewing it.');
      fs.renameSync(temporary, mcpFile);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  return 'factory-relay configured. Start the broker with npm run qa -- config.local.json before checking droid mcp list.';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.slice(2).join(' ') === '--help') console.log(usage);
    else console.log(setup(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof SyntaxError ? 'Invalid JSON in existing project configuration; nothing was overwritten.' : error.message);
    process.exitCode = 1;
  }
}
