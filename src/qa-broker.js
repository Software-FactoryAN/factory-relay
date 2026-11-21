import { z } from 'zod';
import { control, controlTargetSchema } from './control.js';
import { consumeHost } from './stream.js';
import { run } from './transport.js';
import { opaque } from './qa-store.js';
import { Exporter } from './qa-export.js';
import { tasks } from './qa-contract.js';
import { executeTask, readTask } from './qa-tasks.js';
import { applicationProfiles, capabilities, nativeAuthorized, requireNativeAuthorization, selectApplication } from './qa-applications.js';
import { mouseSchema } from './mouse.js';
import { sampleBundle, isDesktop, sameTarget, targetIdentity } from './window-target.js';
import { frameGeometry } from './qa-geometry.js';

const id = z.string().regex(/^[a-f0-9]{32}$/);
const grant = { grant: id };
export const qaCommand = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('connect') }),
  z.strictObject({ op: z.literal('select'), target: controlTargetSchema }),
  z.strictObject({ op: z.literal('take'), takeover: z.boolean().default(false) }),
  z.strictObject({ op: z.literal('release'), ...grant }),
  z.strictObject({ op: z.literal('start'), ...grant,
    labels: z.record(z.string().max(40), z.string().max(200)).refine(v => Object.keys(v).length <= 8).default({}) }),
  z.strictObject({ op: z.literal('stop'), ...grant }),
  z.strictObject({ op: z.literal('observe'), ...grant, mode: z.enum(['pixels', 'count']).optional() }),
  z.strictObject({ op: z.literal('press'), ...grant, observationId: id }),
  z.strictObject({ op: z.literal('mouse'), ...grant, observationId: id, mouse: mouseSchema }),
  z.strictObject({ op: z.literal('assert-visual'), ...grant, observationId: id,
    expected: z.string().trim().min(1).max(600), actual: z.string().trim().min(1).max(600),
    outcome: z.enum(['pass', 'fail']), title: z.string().trim().min(1).max(160), context: z.string().max(600).optional() }),
  z.strictObject({ op: z.literal('assert-count'), ...grant, expected: z.number().int().min(0).max(1e9),
    title: z.string().min(1).max(160).optional(), context: z.string().max(600).optional() }),
]);

export function nativeAdapter(config) {
  if (config.transport !== 'factory') throw new Error('factory_transport_required');
  const applications = applicationProfiles(config.applications);
  const owner = { ...config, owner: 'qa:' + opaque() };
  const perTarget = config.platform === 'windows';
  return {
    applications,
    perTarget,
    acquire: (takeover, ttlSeconds = 3600, target) => run(owner, 'acquire', { ttlSeconds, takeover, ...(perTarget && target ? { target } : {}) }),
    release: (lease, target) => run(owner, 'release', { lease, ...(perTarget && target ? { target } : {}) }),
    windows: async lease => {
      if (!nativeAuthorized(applications)) return { windows: [], displays: [] };
      let windows = [], displays = [];
      await consumeHost(owner, { lease, mode: 'windows' }, ({ header }) => {
        if (header.type === 'windows') { windows = header.windows; displays = header.displays; }
      });
      return { windows: windows.filter(w => nativeAuthorized(applications, w)),
        displays: displays.filter(d => nativeAuthorized(applications, d)) };
    },
    stream: async (lease, target, signal, consume) => {
      requireNativeAuthorization(applications, target);
      return consumeHost(owner, { lease, target, signal }, consume);
    },
    observe: async (lease, target, mode) => {
      requireNativeAuthorization(applications, target);
      return control(owner, { operation: 'observe', lease, target, ...(mode ? { mode } : {}) });
    },
    press: async (lease, target, observationId) => {
      requireNativeAuthorization(applications, target);
      return control(owner, { operation: 'press', lease, target, observationId, elementId: 'relay-increment' });
    },
    mouse: async (lease, target, observationId, mouse) => {
      requireNativeAuthorization(applications, target);
      return control(owner, { operation: 'mouse', lease, target, observationId, mouse });
    },
  };
}

const safeError = e => /^[a-z_]{1,64}$/.test(e.message) ? e.message : 'qa_operation_failed';
export class Broker {
  constructor(store, native, { frameWaitMs = 1500, applications = native.applications } = {}) {
    this.store = store;
    this.native = native;
    this.applications = applicationProfiles(applications);
    this.queue = Promise.resolve();
    this.pending = 0;
    this.connection = 'disconnected';
    this.leaseTarget = null;
    this.owner = null;
    this.windows = [];
    this.displays = [];
    this.target = null;
    this.latest = null;
    this.active = null;
    this.observation = null;
    this.frameVersion = 0;
    this.frameWaitMs = frameWaitMs;
    this.frameWaiters = new Set();
    this.exports = new Exporter(store);
  }
  status() {
    const runId = this.current()?.id ?? null;
    return { connection: this.connection, error: this.error ?? null, owner: this.owner?.actor ?? 'observer-only',
      target: this.target, windows: this.windows, displays: this.displays, runId,
      desktopAllowed: nativeAuthorized(this.applications, { kind: 'desktop' }),
      desktopCapabilities: nativeAuthorized(this.applications, { kind: 'desktop' })
        ? capabilities({ platform: 'macos', kind: 'desktop' })
        : { sharedQA: false, reason: 'application_not_authorized', observe: [], act: [], check: [], recording: false },
      targetCapabilities: this.target ? capabilities({ platform: 'macos', ...this.target }) : null,
      applications: this.applications.map(app => ({ ...app, capabilities: capabilities(app) })),
      frameVersion: this.latest?.version ?? null, frameReceivedAt: this.latest?.receivedAt ?? null,
      frameAgeMs: this.latest ? Math.round(performance.now() - this.latest.receivedMono) : null,
      currentCheck: this.active?.events.findLast(e => e.kind === 'assertion' || e.kind === 'step-start' && ['assert-count', 'assert-visual'].includes(e.operation)) ?? null,
      recording: '5 Hz background sampling + action evidence · 10 minute maximum · elapsed-time MP4 with marked gaps' };
  }
  current() {
    if (this.store.fault) { this.active = null; this.error = 'recording_error'; }
    if (this.active?.events.at(-1)?.kind === 'run-end') this.active = null;
    return this.active;
  }
  event(fields) { if (this.current()) return this.store.append(this.active, fields); }
  recordFrame(force = false) {
    if (!this.current() || !this.latest) return null;
    return this.store.frame(this.active, this.latest, force)?.frameId ?? null;
  }
  waitFrame(afterVersion, timeoutMs, acceptCurrent = false) {
    const usable = () => this.latest && this.latest.version > afterVersion &&
      (!acceptCurrent || performance.now() - this.latest.receivedMono < 2000);
    if (usable()) return Promise.resolve(this.latest);
    return new Promise(resolve => {
      const finish = value => { clearTimeout(timer); this.frameWaiters.delete(check); resolve(value); };
      const check = () => { if (usable()) finish(this.latest); };
      const timer = setTimeout(() => finish(null), timeoutMs);
      this.frameWaiters.add(check);
    });
  }
  async halt() {
    if (this.stream) {
      this.stream.abort.abort();
      await this.stream.done;
      this.stream = null;
    }
    this.latest = null;
  }
  launch() {
    if (!this.target || !this.lease) return;
    requireNativeAuthorization(this.applications, this.target);
    const abort = new AbortController();
    this.connection = 'connecting';
    const done = Promise.resolve().then(() => this.native.stream(this.lease, this.target, abort.signal, packet => {
      if (abort.signal.aborted || packet.header.type !== 'frame') return;
      this.latest = { ...packet, version: ++this.frameVersion, receivedAt: Date.now(), receivedMono: performance.now() };
      this.connection = 'live';
      try { this.recordFrame(); }
      catch (e) { this.error = safeError(e); if (this.current()) this.store.finish(this.active, 'blocked', this.error); }
      for (const ready of this.frameWaiters) ready();
    })).then(() => {
      if (!abort.signal.aborted) this.disconnected('stream_ended');
    }, e => {
      if (!abort.signal.aborted) this.disconnected(safeError(e));
    });
    this.stream = { abort, done };
  }
  disconnected(reason) {
    this.connection = 'disconnected';
    this.error = reason;
    this.latest = null;
    this.observation = null;
    this.owner = null;
    try {
      this.event({ kind: 'gap', actor: 'broker', status: 'blocked', reason });
      if (this.current()) {
        if (this.active.inflight) this.active.pendingEnd = { status: 'interrupted', reason };
        else this.store.finish(this.active, 'interrupted', reason);
      }
    } catch { this.error = 'recording_error'; }
  }
  requireOwner(actor, args) {
    if (!this.owner || this.owner.actor !== actor || this.owner.grant !== args.grant)
      throw new Error('stale_control');
  }
  command(actor, raw) {
    if (!['human', 'agent'].includes(actor)) return Promise.reject(new Error('invalid_actor'));
    const parsed = qaCommand.safeParse(raw);
    if (!parsed.success) return Promise.reject(new Error('invalid_command'));
    return this.enqueue(() => this.execute(actor, parsed.data));
  }
  deletionInfo(id) {
    const pending = this.store.deletions.get(id);
    if (pending) return { title: pending.title, pending: true, reason: null };
    const run = this.store.get(id);
    let reason = run.inflight || run.events.at(-1)?.kind !== 'run-end' ? 'run_active' : null;
    try { this.exports.requireIdle(id); } catch (e) { reason ??= e.message; }
    return { title: String(run.events[0]?.labels?.title ?? 'QA run'), pending: false, reason };
  }
  recordings() {
    return this.enqueue(async () => {
      const result = await readTask(this, 'qa_runs', { offset: 0, limit: this.store.policy.maxRuns });
      const runs = result.runs.map(r => ({ ...r, sourceBytes: this.store.get(r.runId).bytes,
        exportBytes: this.exports.usageBytes(r.runId), deletion: this.deletionInfo(r.runId) }));
      for (const d of this.store.deletions.values()) runs.push({ runId: d.id, title: d.title, started: d.started,
        status: 'deletion pending', counts: { pass: 0, fail: 0, blocked: 0, uncertain: 0 },
        export: { status: 'unavailable' }, sourceBytes: this.store.runs.get(d.id)?.bytes ?? 0,
        exportBytes: this.exports.usageBytes(d.id), deletion: this.deletionInfo(d.id) });
      const exportBytes = runs.reduce((sum, r) => sum + r.exportBytes, 0);
      return { total: runs.length, runs, storage: { sourceBytes: this.store.totalBytes, exportBytes,
        totalBytes: this.store.totalBytes + exportBytes, sourceLimitBytes: this.store.policy.maxTotalBytes,
        exportLimitBytes: this.exports.policy.totalBytes, maxRuns: this.store.policy.maxRuns,
        measuringExports: !!this.exports.active } };
    });
  }
  deleteRecording(actor, id) {
    if (actor !== 'human') return Promise.reject(new Error('human_confirmation_required'));
    return this.enqueue(() => {
      if (this.current()?.id === id) throw new Error('run_active');
      return this.store.deleteRun(id, this.exports);
    });
  }
  task(actor, name, raw) {
    if (!['human', 'agent'].includes(actor) || !Object.hasOwn(tasks, name)) return Promise.reject(new Error('invalid_operation'));
    const parsed = tasks[name].safeParse(raw);
    if (!parsed.success) return Promise.reject(new Error('invalid_arguments'));
    if (['qa_status', 'qa_runs', 'qa_replay', 'qa_report'].includes(name)) return readTask(this, name, parsed.data);
    return this.enqueue(() => executeTask(this, actor, name, parsed.data));
  }
  enqueue(work) {
    if (this.pending >= 16 || this.closing) return Promise.reject(new Error('broker_busy'));
    this.pending++;
    const task = this.queue.then(work);
    this.queue = task.catch(() => {}).finally(() => { this.pending--; });
    return task;
  }
  async rotate(takeover, target = this.target) {
    await this.halt();
    this.owner = null;
    this.observation = null;
    const leaseTarget = this.native.perTarget && target ? targetIdentity(target) : null;
    try {
      if (this.lease && this.leaseTarget !== leaseTarget && !sameTarget(this.leaseTarget, leaseTarget)) {
        const old = this.lease;
        this.lease = null;
        try { await this.native.release(old, this.leaseTarget); } catch {}
      }
      const value = leaseTarget ? await this.native.acquire(takeover, undefined, leaseTarget) : await this.native.acquire(takeover);
      this.lease = { token: value.token, generation: value.generation };
      this.leaseTarget = leaseTarget;
      this.connection = 'connected';
      this.error = null;
    } catch (e) { this.lease = null; this.leaseTarget = null; this.disconnected(safeError(e)); throw e; }
  }
  /** Per-target hosts verify a lease for the selected target, so a lease taken for another key is replaced. */
  async leaseFor(target) {
    if (!this.native.perTarget || !this.lease) return;
    const wanted = targetIdentity(target), owner = this.owner;
    if (this.leaseTarget === null || !sameTarget(this.leaseTarget, wanted)) { await this.rotate(false, wanted); this.owner = owner; }
  }
  async refreshTargets(lease) {
    const found = await this.native.windows(lease);
    this.windows = (Array.isArray(found) ? found : found.windows).filter(w => nativeAuthorized(this.applications, w));
    this.displays = (Array.isArray(found) ? [] : found.displays).filter(d => nativeAuthorized(this.applications, d));
    this.discoveredAt = Date.now();
  }
  targets() { return [...this.displays, ...this.windows]; }
  async freshGeometry(snapshot, afterVersion = -1) {
    let frame = this.latest;
    if (frame && frame.version > afterVersion) {
      try { return frameGeometry(frame, snapshot, this.targetProcessStartedAt); } catch {}
    }
    const version = this.frameVersion;
    this.event({ kind: 'gap', actor: 'broker', reason: 'capture_refresh', status: 'interrupted' });
    await this.halt();
    this.launch();
    frame = await this.waitFrame(version, 15000);
    if (!frame) throw new Error('live_frame_required');
    return frameGeometry(frame, snapshot, this.targetProcessStartedAt);
  }
  async discover() {
    if (!nativeAuthorized(this.applications)) { this.windows = []; this.displays = []; return []; }
    let temporary;
    try {
      if (!this.lease) {
        const { token, generation } = await this.native.acquire(false, 30);
        temporary = { token, generation };
      }
      const lease = this.lease ?? temporary;
      await this.refreshTargets(lease);
      return this.targets().map(w => ({ ...w, target: targetIdentity(w),
        capabilities: capabilities({ platform: 'macos', ...w }) }));
    } finally {
      if (temporary) await this.native.release({ token: temporary.token, generation: temporary.generation });
    }
  }
  async execute(actor, args) {
    if (args.op === 'connect') {
      if (this.current()) throw new Error('run_active');
      if (this.owner) throw new Error('release_control_before_connect');
      requireNativeAuthorization(this.applications);
      if (!this.lease) await this.rotate(false);
      await this.halt();
      try {
        await this.refreshTargets(this.lease);
      }
      catch (e) { this.disconnected(safeError(e)); throw e; }
      this.connection = 'connected';
      this.launch();
      return this.status();
    }
    if (args.op === 'take') {
      if (actor === 'agent' && (args.takeover || this.owner)) throw new Error('human_takeover_required');
      if (this.owner && !args.takeover) throw new Error('control_held');
      requireNativeAuthorization(this.applications, this.target);
      this.event({ kind: 'gap', actor, reason: 'ownership_change', status: 'interrupted' });
      if (this.lease && !args.takeover) {
        await this.halt();
        this.owner = null;
        this.observation = null;
        const lease = this.lease;
        this.lease = null;
        try { await this.native.release(lease, this.leaseTarget); }
        catch (e) { this.disconnected(safeError(e)); throw e; }
      }
      await this.rotate(args.takeover);
      this.owner = { actor, grant: opaque() };
      this.event({ kind: 'ownership', actor, status: 'pass', owner: actor });
      this.launch();
      return { grant: this.owner.grant, ...this.status() };
    }
    if (args.op === 'select') {
      if (this.current() || this.owner) throw new Error('release_control_before_select');
      requireNativeAuthorization(this.applications, args.target);
      if (!this.targets().some(w => sameTarget(w, args.target))) throw new Error('target_unavailable');
      await this.halt();
      const started = this.windows.find(w => sameTarget(w, args.target))?.processStartedAt;
      if (!isDesktop(args.target) && args.target.bundleId !== sampleBundle && !Number.isFinite(started)) throw new Error('target_identity_required');
      this.target = args.target;
      this.targetProcessStartedAt = started;
      this.observation = null;
      try { await this.leaseFor(args.target); } catch (e) { this.disconnected(safeError(e)); throw e; }
      this.launch();
      return this.status();
    }
    this.requireOwner(actor, args);
    if (args.op === 'release') {
      this.event({ kind: 'gap', actor, reason: 'control_released', status: 'interrupted' });
      this.event({ kind: 'ownership', actor, status: 'pass', owner: 'observer-only' });
      await this.halt();
      this.owner = null;
      this.observation = null;
      const lease = this.lease;
      this.lease = null;
      try {
        await this.native.release(lease, this.leaseTarget);
        await this.rotate(false);
        this.launch();
      } catch (e) { this.disconnected(safeError(e)); throw e; }
      return this.status();
    }
    if (!this.target) throw new Error('select_target_first');
    if (args.op === 'start') {
      if (this.current()) throw new Error('run_active');
      if (this.connection !== 'live') throw new Error('live_frame_required');
      const application = selectApplication(this.applications, { applicationId: args.labels.applicationId, target: this.target });
      if (this.target.bundleId !== sampleBundle) {
        const fresh = await this.native.observe(this.lease, this.target, 'pixels');
        await this.freshGeometry(fresh.snapshot);
      } else if (Number.isFinite(this.targetProcessStartedAt) && this.latest?.header.processStartedAt !== this.targetProcessStartedAt)
        throw new Error('target_mismatch');
      this.active = this.store.start(this.target, { ...args.labels, applicationId: application.id,
        ...(Number.isFinite(this.targetProcessStartedAt) ? { processStartedAt: String(this.targetProcessStartedAt) } : {}) }, actor);
      this.observation = null;
      this.recordFrame(true);
      clearTimeout(this.runTimer);
      const captured = this.active;
      this.runTimer = setTimeout(() => {
        if (this.current() !== captured) return;
        if (captured.inflight) captured.limitReached = true;
        else this.store.finish(captured, 'blocked', 'recording_full');
      }, this.store.policy.maxDurationMs);
      this.runTimer.unref();
      return { runId: this.active.id };
    }
    if (args.op === 'stop') {
      if (!this.current()) throw new Error('no_active_run');
      this.observation = null;
      clearTimeout(this.runTimer);
      const lastAction = this.active.events.findLast(e => ['action', 'action-attempt'].includes(e.kind))?.seq ?? 0;
      const lastAssertion = this.active.events.findLast(e => e.kind === 'assertion')?.seq ?? 0;
      const status = this.active.events.some(e => e.status === 'fail') ? 'fail'
        : this.active.events.some(e => ['uncertain', 'blocked'].includes(e.status)) ? 'uncertain'
          : lastAssertion > lastAction ? 'pass' : 'uncertain';
      return this.store.finish(this.active, status, 'caller_stopped');
    }
    if (!this.current()) throw new Error('start_run_first');
    requireNativeAuthorization(this.applications, this.target);
    const generic = this.target.bundleId !== sampleBundle;
    const pixels = generic || args.op === 'mouse' || args.mode === 'pixels';
    const input = ['press', 'mouse'].includes(args.op);
    if (generic && (['press', 'assert-count'].includes(args.op) || args.mode === 'count')) throw new Error('application_not_supported');
    const recordedRun = this.active;
    this.store.reserveStep(recordedRun);
    const stepId = opaque(), actionId = input ? opaque() : undefined;
    let beforeFrameId, dispatched = false, acknowledgedVersion;
    try {
      beforeFrameId = this.recordFrame(true);
      if (recordedRun.limitReached) throw new Error('recording_full');
      this.event({ kind: 'step-start', actor, stepId, actionId, operation: args.op, beforeFrameId,
        title: args.title, context: args.context, ...(args.mouse ? { mouse: args.mouse } : {}) });
      if (args.op === 'assert-visual') {
        const observed = this.observation;
        this.observation = null;
        if (!observed || observed.id !== args.observationId || observed.grant !== args.grant ||
            Date.now() > observed.expires || !observed.frame || !observed.afterFrameId) throw new Error('observation_stale');
        if (recordedRun.events.some(e => e.kind === 'assertion' && e.afterFrameId === observed.afterFrameId))
          throw new Error('observation_stale');
        frameGeometry(observed.frame, observed.snapshot, observed.snapshot.processStartedAt, 30000);
        const current = await this.native.observe(this.lease, this.target, observed.mode);
        if (Date.now() > observed.expires || JSON.stringify(current.snapshot) !== JSON.stringify(observed.snapshot))
          throw new Error('observation_stale');
        const observation = this.event({ kind: 'observation', actor, stepId, observationId: observed.id,
          snapshot: observed.snapshot, actual: args.actual, beforeFrameId, afterFrameId: observed.afterFrameId,
          frameEvidence: observed.frameEvidence });
        return this.event({ kind: 'assertion', actor, stepId, observationId: observed.id,
          observationSeq: observation.seq, title: args.title, context: args.context ?? '',
          checkKind: 'visual', assessment: { source: 'caller', actor, serverVerified: false },
          expected: args.expected, actual: args.actual, status: args.outcome, afterFrameId: observed.afterFrameId });
      }
      if (input) {
        const observed = this.observation;
        this.observation = null;
        if (!observed || observed.id !== args.observationId || observed.grant !== args.grant ||
            Date.now() > observed.expires) throw new Error('observation_stale');
        if (args.op === 'press' && observed.mode === 'pixels') throw new Error('observation_stale');
        if (args.op === 'mouse')
          frameGeometry(observed.frame, observed.snapshot, observed.snapshot.processStartedAt, 30000);
        this.event({ kind: 'action-attempt', actor, stepId, actionId, status: 'running', observationId: observed.id });
        dispatched = true;
        if (args.op === 'mouse') {
          await this.native.mouse(this.lease, this.target, observed.nativeId, args.mouse);
        } else await this.native.press(this.lease, this.target, observed.nativeId);
        acknowledgedVersion = this.latest?.version ?? this.frameVersion;
        this.event({ kind: 'action', actor, stepId, actionId, status: 'pass',
          reason: 'input_acknowledged_requires_assertion', observationId: observed.id, beforeFrameId });
      }
      const result = await this.native.observe(this.lease, this.target, pixels ? 'pixels' : undefined);
      const value = result.snapshot.elements.find(e => e.id === 'relay-count')?.value;
      if (!pixels && !/^Count: \d+$/.test(value)) throw new Error('invalid_count');
      const actual = pixels ? null : Number(value.slice(7)), observationId = opaque();
      let newer = input ? await this.waitFrame(acknowledgedVersion, this.frameWaitMs) : this.latest;
      let geometry;
      if (pixels) {
        geometry = await this.freshGeometry(result.snapshot, input ? acknowledgedVersion : -1);
        newer = this.latest;
      }
      const afterFrameId = newer ? this.recordFrame(true) : null;
      const frameEvidence = { beforeFrameId, afterFrameId, status: afterFrameId ? 'available' : 'missing',
        correlation: generic || args.op === 'mouse' ? 'fresh selected-target pixels; outcome requires caller assessment'
          : args.op === 'press' ? 'newer frame received after input acknowledgement; AX is assertion authority' : 'nearest received sample',
        frameVersion: newer?.version ?? null, ageMs: newer ? Math.round(performance.now() - newer.receivedMono) : null };
      const observation = this.event({ kind: 'observation', actor, stepId, actionId, observationId,
        actual, snapshot: result.snapshot, beforeFrameId, afterFrameId, frameEvidence });
      this.observation = { id: observationId, nativeId: result.observationId, grant: args.grant,
        expires: Math.min(Date.now() + 30000, result.expiresAt * 1000),
        snapshot: result.snapshot, frame: newer, afterFrameId, frameEvidence, mode: pixels ? 'pixels' : undefined };
      if (this.store.fault) throw new Error('recording_error');
      if (args.op === 'assert-count') {
        return this.event({ kind: 'assertion', actor, stepId, observationId,
          title: args.title ?? 'Count assertion', context: args.context ?? '',
          observationSeq: observation.seq, expected: args.expected, actual,
          status: actual === args.expected ? 'pass' : 'fail' });
      }
      this.event({ kind: 'step-end', actor, stepId, actionId, status: 'pass' });
      return { observationId, actual, stepId, actionId, frameEvidence, ...(geometry ?? {}),
        ...(input ? { acknowledged: true, assertion: false } : {}),
        status: recordedRun.limitReached ? 'blocked' : 'pass', retrySafe: !input };
    } catch (e) {
      if (args.op === 'assert-count') this.event({ kind: 'assertion', actor, stepId, title: args.title ?? 'Count assertion',
        context: args.context ?? '', expected: args.expected, actual: null, status: 'blocked', reason: safeError(e) });
      if (args.op === 'assert-visual') this.event({ kind: 'assertion', actor, stepId, title: args.title,
        context: args.context ?? '', expected: args.expected, actual: args.actual, checkKind: 'visual',
        assessment: { source: 'caller', actor, serverVerified: false }, status: 'blocked', reason: safeError(e) });
      this.event({ kind: 'step-end', actor, stepId, actionId,
        status: dispatched ? 'uncertain' : 'blocked', reason: safeError(e) });
      throw new Error(safeError(e));
    } finally {
      if (!this.store.fault) this.store.endStep(recordedRun);
    }
  }
  async close() {
    this.closing = true;
    await this.queue;
    await this.halt();
    clearTimeout(this.runTimer);
    await this.exports.close();
    try {
      if (this.current()) this.store.finish(this.active, 'interrupted', 'broker_shutdown');
    } finally {
      if (this.lease) { try { await this.native.release(this.lease, this.leaseTarget); } catch {} }
      this.store.close();
    }
  }
}
