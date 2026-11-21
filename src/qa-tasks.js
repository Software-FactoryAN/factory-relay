import { summarize, failure } from './qa-contract.js';
import { qaEditPlan } from '../web/qa-edit.js';
import { selectApplication } from './qa-applications.js';
import { sampleBundle, isDesktop, sameTarget, targetIdentity, sameDisplayConfiguration } from './window-target.js';

function owner(broker, actor, runId) {
  if (broker.current()?.id !== runId) throw new Error('run_mismatch');
  if (broker.owner?.actor !== actor) throw new Error('stale_control');
  return broker.owner.grant;
}
function image(broker, frame = broker.latest) {
  if (!frame) return undefined;
  return { mimeType: 'image/jpeg', data: frame.image.toString('base64'),
    version: frame.version, ageMs: Math.round(performance.now() - frame.receivedMono),
    receivedAt: frame.receivedAt };
}
const url = (broker, id, step) => `${broker.origin ?? ''}/#run=${id}${step ? '&step=' + step : ''}`;
const markdownText = value => String(value).replace(/[\\`*_[\]<>#\r\n]/g, ' ').slice(0, 600);
export function report(broker, id) {
  const summary = summarize(broker.store, id), exported = broker.exports.state(id, 'qa');
  const edit = qaEditPlan(broker.store.get(id).events, summary.durationMs);
  const failed = summary.checks.filter(c => c.status !== 'pass'), first = failed[0];
  const checks = [...failed, ...summary.checks.filter(c => c.status === 'pass')].slice(0, 50).map(c => ({
    ...c, replayUrl: url(broker, id, c.stepId), clip: edit.clips.find(clip => clip.stepId === c.stepId) ?? null,
  }));
  const artifacts = exported.status === 'ready' ? Object.fromEntries(
    ['qa-v3-recording.mp4', 'qa-v3-poster.jpg', 'qa-v3-summary.json'].map(name => [name, broker.exports.artifact(id, name).file])) : {};
  const sourceExport = broker.exports.state(id);
  const sourceArtifact = sourceExport.status === 'ready' ? broker.exports.artifact(id, 'recording.mp4').file : null;
  const replayUrl = url(broker, id, first?.stepId);
  const lines = [`### ${markdownText(summary.title)}`, `${summary.status.toUpperCase()} · ${summary.counts.pass} passed · ${summary.counts.fail} failed · ${summary.counts.blocked} blocked · ${summary.counts.uncertain} uncertain`,
    ...checks.slice(0, 20).map(c => `- [${markdownText(c.title)}](${c.replayUrl}): **${c.status}**; expected ${markdownText(c.expected)}, observed ${markdownText(c.actual ?? 'unavailable')}.${c.kind === 'visual' ? ` Visual assessment by ${c.assessment.actor}; not server-verified.` : ''}${c.context ? ' ' + markdownText(c.context) : ''}${c.clip ? ` Source ${(c.clip.sourceStartMs / 1000).toFixed(3)}–${(c.clip.sourceEndMs / 1000).toFixed(3)}s; QA video ${(c.clip.startMs / 1000).toFixed(3)}–${(c.clip.endMs / 1000).toFixed(3)}s.` : ' No QA clip.'}`),
    ...(summary.checks.length > 20 ? [`Showing ${Math.min(20, summary.checks.length)} of ${summary.checks.length} checks, non-passing first. Use paginated qa_replay for all results.`] : []),
    `[Open QA review](${replayUrl})`];
  if (artifacts['qa-v3-recording.mp4']) lines.push(`[![QA recording preview](${artifacts['qa-v3-poster.jpg']})](${replayUrl})`,
    `[Download QA video](${artifacts['qa-v3-recording.mp4']}) · [QA edit provenance](${artifacts['qa-v3-summary.json']})`);
  else lines.push(`QA video export: ${exported.status}. ${edit.available && !edit.clips.length ? 'No completed passing or failing QA checks.' : !edit.available ? edit.reason : 'Prepare with qa_report.'}`);
  if (sourceArtifact) lines.push(`[Full session evidence, separate from QA video](${sourceArtifact})`);
  lines.push(`QA video contains only recorded evidence for passing and failing checks: ${(edit.durationMs / 1000).toFixed(3)}s edited; ${(edit.evidenceMs / 1000).toFixed(3)}s evidence from ${(summary.durationMs / 1000).toFixed(3)}s source. Only conservatively associated preceding input is included as context, not causal proof. Setup, ownership transitions and idle between operations are omitted. Missing footage inside QA is marked.`,
    'All checks and operational errors remain in Results JSON. Labels and intentional-test descriptions are caller supplied. Local replay requires an authenticated browser. No inline chat-player claim.');
  const { checks: _, ...overview } = summary;
  return { ...overview, checks, checksTruncated: summary.checks.length > checks.length, replayUrl, edit,
    export: exported, sourceExport, artifacts, sourceArtifact, reportMarkdown: lines.join('\n\n') };
}
export async function readTask(broker, name, args) {
  if (name === 'qa_status') return broker.status();
  if (name === 'qa_runs') {
    const all = broker.store.history();
    return { total: all.length, offset: args.offset, nextOffset: args.offset + args.limit < all.length ? args.offset + args.limit : null,
      runs: all.slice(args.offset, args.offset + args.limit).map(r => {
        const { checks, ...summary } = summarize(broker.store, r.runId);
        return { ...summary, edit: qaEditPlan(broker.store.get(r.runId).events, summary.durationMs), export: broker.exports.state(r.runId, 'qa'), replayUrl: url(broker, r.runId) };
      }) };
  }
  if (name === 'qa_replay') {
    const run = broker.store.get(args.runId), summary = summarize(broker.store, args.runId);
    if (args.frameId) return { runId: args.runId, frameId: args.frameId,
      image: { mimeType: 'image/jpeg', data: broker.store.image(args.runId, args.frameId).toString('base64') } };
    const selected = args.stepId ? summary.checks.find(c => c.stepId === args.stepId) : null;
    if (args.stepId && !selected) throw new Error('step_not_found');
    if (args.filter === 'results') {
      const errors = run.events.filter(e => e.kind !== 'frame' && e.kind !== 'assertion' &&
        (['blocked', 'uncertain', 'interrupted'].includes(e.status) || e.kind === 'step-end' && e.status === 'fail'))
        .map(e => ({ kind: e.kind, elapsedMs: e.elapsedMs, status: e.status, reason: e.reason ?? null,
          ...(e.stepId ? { stepId: e.stepId } : {}), ...(e.operation ? { operation: e.operation } : {}) }));
      return { runId: summary.runId, title: summary.title, context: summary.context, status: summary.status,
        reason: summary.reason ?? null, counts: summary.counts, sourceDurationMs: summary.durationMs,
        checks: { total: summary.checks.length, offset: args.offset, items: summary.checks.slice(args.offset, args.offset + args.limit)
          .map(({ observationId, ...check }) => check) },
        operationalErrors: { total: errors.length, offset: args.offset, items: errors.slice(args.offset, args.offset + args.limit) },
        nextOffset: args.offset + args.limit < Math.max(summary.checks.length, errors.length) ? args.offset + args.limit : null };
    }
    const edit = qaEditPlan(run.events, summary.durationMs);
    const rows = args.filter === 'checks' ? summary.checks : args.filter === 'failures'
      ? summary.checks.filter(c => c.status !== 'pass') : run.events.filter(e => args.filter !== 'frames' || e.kind === 'frame');
    const { checks, ...overview } = summary;
    return { ...overview, total: rows.length, offset: args.offset,
      nextOffset: args.offset + args.limit < rows.length ? args.offset + args.limit : null,
      items: rows.slice(args.offset, args.offset + args.limit), selected,
      seekMs: selected ? edit.clips.find(c => c.stepId === selected.stepId)?.startMs ?? null : 0,
      export: broker.exports.state(args.runId, 'qa'), sourceExport: broker.exports.state(args.runId), replayUrl: url(broker, args.runId, args.stepId), edit };
  }
  if (name === 'qa_report') {
    if (args.export) broker.exports.request(args.runId, args.retryExport, 'qa');
    if (args.waitMs) await broker.exports.wait(args.runId, args.waitMs, 'qa');
    return report(broker, args.runId);
  }
}
export async function executeTask(broker, actor, name, args) {
  if (name === 'qa_targets') {
    const found = await broker.discover();
    return { displays: found.filter(isDesktop), windows: found.filter(t => !isDesktop(t)), discoveredAt: Date.now(),
      input: 'Desktop mouse covers all visible content on one selected display. Restricted windows must be foreground and unobscured at the input point.' };
  }
  if (name === 'qa_start') {
    const active = broker.current();
    const application = selectApplication(broker.applications, args, active?.events[0]);
    const selectedApplication = { applicationId: application.id, application };
    if (active) {
      if (args.resumeRunId && args.resumeRunId !== active.id) throw new Error('run_mismatch');
      if (args.target && !sameTarget(args.target, active.events[0].target))
        throw new Error('target_mismatch');
      owner(broker, actor, active.id);
      const startedAt = Number(active.events[0].labels?.processStartedAt);
      if (Number.isFinite(startedAt)) {
        broker.observation = null;
        const current = await broker.native.observe(broker.lease, broker.target);
        if (current.snapshot.processStartedAt !== startedAt)
          throw new Error('target_mismatch');
      }
      return { runId: active.id, ...selectedApplication, resumed: true, controller: actor, target: broker.target, replayUrl: url(broker, active.id), nextAction: 'qa_observe' };
    }
    if (args.resumeRunId) throw new Error('run_not_active');
    if (broker.owner && broker.owner.actor !== actor) throw new Error('human_takeover_required');
    const hadOwner = Boolean(broker.owner);
    let discovered;
    if (args.target && args.target.bundleId !== sampleBundle) {
      discovered = broker.targets().find(w => sameTarget(w, args.target));
      if (!discovered || !isDesktop(discovered) && !Number.isFinite(discovered.processStartedAt) || !broker.discoveredAt ||
          Date.now() - broker.discoveredAt > 30000) throw new Error('target_discovery_required');
    }
    try {
      if (!broker.owner) {
        await broker.execute(actor, { op: 'connect' });
        if (discovered && !broker.targets().some(w => sameTarget(w, discovered) && (isDesktop(w)
          ? sameDisplayConfiguration(w.displayConfiguration, discovered.displayConfiguration)
          : w.processStartedAt === discovered.processStartedAt)))
          throw new Error('target_mismatch');
        const candidates = isDesktop(application) ? broker.displays.filter(d => d.main) : broker.windows.filter(w => w.bundleId === application.bundleId);
        const target = args.target ?? (candidates.length === 1 ? candidates[0] : null);
        if (!target) throw new Error(candidates.length ? 'target_ambiguous' : 'target_unavailable');
        await broker.execute(actor, { op: 'select', target: targetIdentity(target) });
        await broker.execute(actor, { op: 'take', takeover: false });
      } else {
        await broker.refreshTargets(broker.lease);
        if (discovered && !broker.targets().some(w => sameTarget(w, discovered) && (isDesktop(w)
          ? sameDisplayConfiguration(w.displayConfiguration, discovered.displayConfiguration)
          : w.processStartedAt === discovered.processStartedAt))) throw new Error('target_mismatch');
        const candidates = isDesktop(application) ? broker.displays.filter(d => d.main) : broker.windows.filter(w => w.bundleId === application.bundleId);
        const selected = args.target ?? (candidates.length === 1 ? candidates[0] : null);
        if (!selected) throw new Error(candidates.length ? 'target_ambiguous' : 'target_unavailable');
        if (!broker.targets().some(w => sameTarget(w, selected)))
          throw new Error('target_unavailable');
        if (args.target && broker.target && !sameTarget(args.target, broker.target)) throw new Error('target_mismatch');
        await broker.halt();
        broker.target = targetIdentity(selected);
        broker.targetProcessStartedAt = broker.windows.find(w => sameTarget(w, selected))?.processStartedAt;
        if (!isDesktop(selected) && selected.bundleId !== sampleBundle && !Number.isFinite(broker.targetProcessStartedAt)) throw new Error('target_identity_required');
        await broker.leaseFor(broker.target);
        broker.launch();
      }
      if (!await broker.waitFrame(0, 15000)) throw new Error('live_frame_required');
      const { runId } = await broker.execute(actor, { op: 'start', grant: broker.owner.grant,
        labels: { title: args.title, applicationId: application.id, ...(args.context ? { context: args.context } : {}) } });
      broker.owner.runId = runId;
      return { runId, ...selectedApplication, resumed: false, controller: actor, target: broker.target, replayUrl: url(broker, runId),
        recording: { cadence: '5 Hz background sampling plus action evidence', maxDurationSeconds: 600, gaps: 'explicitly marked' }, nextAction: 'qa_observe' };
    } catch (error) {
      if (!hadOwner && !broker.current()) {
        await broker.halt();
        const lease = broker.lease, leaseTarget = broker.leaseTarget;
        broker.lease = null; broker.owner = null; broker.observation = null; broker.connection = 'disconnected';
        if (lease) {
          try { await broker.native.release(lease, leaseTarget); }
          catch { broker.error = 'release_unconfirmed'; }
        }
      }
      throw error;
    }
  }
  if (name === 'qa_control') {
    if (actor !== 'human') throw new Error('human_takeover_required');
    if (args.mode === 'take') {
      await broker.execute(actor, { op: 'take', takeover: true });
      broker.owner.runId = broker.current()?.id;
    } else {
      if (broker.owner?.actor !== actor) throw new Error('stale_control');
      await broker.execute(actor, { op: 'release', grant: broker.owner.grant });
    }
    return broker.status();
  }
  if (name === 'qa_finish') {
    const run = broker.store.get(args.runId);
    if (run.events.at(-1)?.kind !== 'run-end') {
      const grant = owner(broker, actor, args.runId);
      await broker.execute(actor, { op: 'stop', grant });
    }
    if (broker.owner?.actor === actor && (!broker.current() || broker.owner.runId === args.runId)) {
      await broker.halt();
      const lease = broker.lease, leaseTarget = broker.leaseTarget; broker.owner = null; broker.observation = null; broker.lease = null;
      broker.connection = 'disconnected';
      if (lease) {
        try { await broker.native.release(lease, leaseTarget); }
        catch { broker.error = 'release_unconfirmed'; }
      }
    }
    try { broker.exports.request(args.runId, false, 'qa'); }
    catch (e) { return { ...report(broker, args.runId), exportError: failure(e, 'qa_report', actor) }; }
    return report(broker, args.runId);
  }
  if (name === 'qa_observe' && broker.owner?.actor !== actor) {
    const run = broker.store.get(args.runId);
    const cached = run.events.findLast(e => e.kind === 'observation');
    return { runId: args.runId, observerOnly: true, canAct: false, actual: cached?.actual ?? null,
      observationId: cached?.observationId ?? null, observedAt: cached?.at ?? null,
      freshness: 'cached; caller does not own native observation',
      ...(args.includeImage && broker.current()?.id === args.runId ? { image: image(broker) } : {}) };
  }
  const grant = owner(broker, actor, args.runId);
  if (name === 'qa_observe') {
    const observed = await broker.execute(actor, { op: 'observe', grant, ...(args.mode ? { mode: args.mode } : {}) });
    owner(broker, actor, args.runId);
    return { runId: args.runId, ...observed, canAct: true, expiresInMs: Math.max(0, broker.observation.expires - Date.now()),
      ...(args.includeImage ? { image: image(broker, broker.observation.frame) } : {}) };
  }
  if (name === 'qa_act') {
    const result = await broker.execute(actor, { op: args.action === 'mouse' ? 'mouse' : 'press', grant,
      observationId: args.observationId, ...(args.action === 'mouse' ? { mouse: args.mouse } : {}) });
    return { runId: args.runId, ...result,
      ...(args.action === 'mouse' ? { image: image(broker, broker.observation.frame) } : {}) };
  }
  if (name === 'qa_check') {
    const check = await broker.execute(actor, { op: args.kind === 'visual' ? 'assert-visual' : 'assert-count',
      grant, expected: args.expected, title: args.title, context: args.context,
      ...(args.kind === 'visual' ? { actual: args.actual, outcome: args.outcome, observationId: args.observationId } : {}) });
    return { runId: args.runId, stepId: check.stepId, title: check.title, status: check.status,
      expected: check.expected, actual: check.actual, context: check.context, observationId: check.observationId,
      ...(check.checkKind ? { kind: check.checkKind, assessment: check.assessment, frameId: check.afterFrameId } : {}),
      replayUrl: url(broker, args.runId, check.stepId), retrySafe: true,
      nextAction: check.status === 'pass' ? 'Continue the run or qa_finish.' : 'Inspect the observed mismatch; do not silently relabel this failure.' };
  }
  throw new Error('invalid_operation');
}
