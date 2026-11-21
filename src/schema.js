import { z } from 'zod';
import path from 'node:path';
import { applicationsSchema } from './qa-applications.js';
import { targetSchema as leaseTarget } from './window-target.js';

const text = z.string().min(1).max(256).regex(/^[^\x00-\x1f\x7f]+$/);
const absolute = text.refine(s => s.startsWith('/') && path.posix.normalize(s) === s && s !== '/', 'Use a normalized absolute path');
const relative = text.refine(s => !s.startsWith('/') && !s.startsWith('-') && path.posix.normalize(s) === s && !s.split('/').includes('..') && s !== '.', 'Use a relative workspace path');
const uuid = z.string().uuid();
const proof = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/), generation: z.number().int().positive().safe() }).strict();
const target = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('workspace'), path: relative.refine(s => s.endsWith('.xcworkspace')) }).strict(),
  z.object({ kind: z.literal('project'), path: relative.refine(s => s.endsWith('.xcodeproj')) }).strict(),
]);
const xcode = {
  lease: proof, target, scheme: text.refine(s => !s.startsWith('-')),
  destination: z.discriminatedUnion('platform', [
    z.object({ platform: z.literal('iOS Simulator'), id: uuid }).strict(),
    z.object({ platform: z.literal('macOS') }).strict(),
  ]),
};
const observationId = z.string().regex(/^[a-f0-9]{32}$/);
const visual = { lease: proof, target, udid: uuid,
  bundleId: z.string().min(3).max(255).regex(/^[A-Za-z0-9][A-Za-z0-9.-]*$/) };
export const operations = {
  preflight: z.object({}).strict(),
  simulators: z.object({}).strict(),
  acquire: z.object({ ttlSeconds: z.number().int().min(1).max(3600), takeover: z.boolean().default(false), target: leaseTarget.optional() }).strict(),
  release: z.object({ lease: proof, target: leaseTarget.optional() }).strict(),
  boot: z.object({ lease: proof, udid: uuid }).strict(),
  install: z.object({ lease: proof, udid: uuid, app: relative.refine(s => s.endsWith('.app')) }).strict(),
  launch: z.object({ lease: proof, udid: uuid, bundleId: z.string().min(3).max(255).regex(/^[A-Za-z0-9][A-Za-z0-9.-]*$/) }).strict(),
  screenshot: z.object({ lease: proof, udid: uuid }).strict(),
  build: z.object(xcode).strict(),
  test: z.object(xcode).strict(),
  observe: z.object(visual).strict(),
  tap: z.object({ ...visual, observationId, elementId: text.max(128) }).strict(),
  frame: z.object({ lease: proof, observationId }).strict(),
};
const windowsSupervisor = z.string().max(260).regex(/^[A-Za-z]:[\\/][A-Za-z0-9_. ()\\/:-]+$/);
const commonConfig = {
  workspace: absolute,
  owner: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:@/-]*$/),
  timeoutSeconds: z.number().int().min(1).max(1800).default(300),
  localWorkspace: absolute.optional(),
  applications: applicationsSchema.optional(),
};
export const configSchema = z.preprocess(value => value && typeof value === 'object'
  ? { transport: 'factory', ...value } : value, z.discriminatedUnion('transport', [
  z.object({
    ...commonConfig, transport: z.literal('factory'),
    computer: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
    platform: z.enum(['mac', 'windows']).optional(),
    supervisor: windowsSupervisor.optional(),
  }).strict().refine(c => (c.platform === 'windows') === (c.supervisor !== undefined),
    'A supervisor path is required for windows and not allowed otherwise'),
  z.object({
    ...commonConfig, transport: z.literal('ssh'),
    host: z.string().max(253).regex(/^[A-Za-z0-9][A-Za-z0-9.-]*$/),
    user: z.string().max(64).regex(/^[A-Za-z_][A-Za-z0-9_-]*$/),
    port: z.number().int().min(1).max(65535).default(22),
    identityFile: absolute.optional(),
  }).strict(),
]));

export function parseOperation(name, input) {
  if (!Object.hasOwn(operations, name)) throw new Error('invalid_operation');
  const result = operations[name].safeParse(input);
  if (!result.success) throw new Error('invalid_arguments');
  return result.data;
}
