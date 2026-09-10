'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLedger, sha256, checksDigest, artifactsDigest } = require('../index.cjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-ledger-'));
  fs.writeFileSync(path.join(root, 'artifact.txt'), 'verified artifact');
  return { root, file: path.join(root, 'artifact.txt'), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('accepts a fresh artifact-bound outcome and deduplicates credit after reload', () => {
  const f = fixture();
  try {
    const ledger = createLedger({ stateDir: f.root, artifactRoot: f.root });
    ledger.preregister({ id: 'task-1', objective: 'demo', criteria: [{ id: 'criterion-a', description: 'works' }] });
    const proof = { path: 'artifact.txt', sha256: sha256(fs.readFileSync(f.file)) };
    const task = ledger.getTask('task-1');
    const checks = [{ taskId: 'task-1', acceptanceDigest: task.acceptanceDigest, criterionId: 'criterion-a', checkId: 'check-a', passed: true, command: 'node verify.cjs', exitCode: 0, checkedCount: 1, expectedCount: 1, artifacts: [proof], revisionId: 'revision-a' }];
    const reviewer = { id: 'reviewer-a', taskId: 'task-1', acceptanceDigest: task.acceptanceDigest, configured: true, independent: true, verdict: 'accept', checksDigest: checksDigest(checks), artifactsDigest: artifactsDigest([proof]) };
    const input = { taskId: 'task-1', workerId: 'worker-a', checks, artifacts: [proof], reviewer };
    assert.equal(ledger.recordOutcome(input).credited, true);
    assert.equal(ledger.recordOutcome(input).duplicate, true);
    const reloaded = createLedger({ stateDir: f.root, artifactRoot: f.root });
    assert.equal(reloaded.evaluate('task-1').accepted, true);
    assert.equal(reloaded.evaluate('task-1').credited, true);
  } finally { f.cleanup(); }
});

test('rejects changed artifacts, missing independent review and stale results', () => {
  const f = fixture();
  try {
    let clock = Date.now();
    const ledger = createLedger({ stateDir: f.root, artifactRoot: f.root, clock: () => clock, freshnessMs: 1000 });
    ledger.preregister({ id: 'task-2', objective: 'demo', criteria: ['criterion-a'] });
    const proof = { path: 'artifact.txt', sha256: sha256(fs.readFileSync(f.file)) };
    const task = ledger.getTask('task-2');
    const checks = [{ taskId: 'task-2', acceptanceDigest: task.acceptanceDigest, criterionId: 'criterion-a', checkId: 'check-a', passed: true, command: 'node verify.cjs', exitCode: 0, checkedCount: 1, expectedCount: 1, artifacts: [proof] }];
    const review = { id: 'same-worker', taskId: 'task-2', acceptanceDigest: task.acceptanceDigest, configured: true, independent: false, verdict: 'accept', checksDigest: checksDigest(checks), artifactsDigest: artifactsDigest([proof]) };
    assert.throws(() => ledger.recordOutcome({ taskId: 'task-2', workerId: 'same-worker', checks, artifacts: [proof], reviewer: review }), /independent configured reviewer/);
    fs.writeFileSync(f.file, 'tampered');
    const validReview = { id: 'reviewer', taskId: 'task-2', acceptanceDigest: task.acceptanceDigest, configured: true, independent: true, verdict: 'accept', checksDigest: checksDigest(checks), artifactsDigest: artifactsDigest([proof]) };
    assert.throws(() => ledger.recordOutcome({ taskId: 'task-2', workerId: 'worker', checks, artifacts: [proof], reviewer: validReview }), /artifact verification failed/);
    fs.writeFileSync(f.file, 'verified artifact');
    clock += 2001;
    const freshProof = { path: 'artifact.txt', sha256: sha256(fs.readFileSync(f.file)) };
    const freshChecks = [{ ...checks[0], artifacts: [freshProof] }];
    const freshReview = { id: 'reviewer', taskId: 'task-2', acceptanceDigest: task.acceptanceDigest, configured: true, independent: true, verdict: 'accept', checksDigest: checksDigest(freshChecks), artifactsDigest: artifactsDigest([freshProof]) };
    assert.throws(() => ledger.recordOutcome({ taskId: 'task-2', workerId: 'worker', completedAt: clock - 2001, checks: freshChecks, artifacts: [freshProof], reviewer: freshReview }), /freshness window/);
  } finally { f.cleanup(); }
});

test('keeps acceptance criteria immutable', () => {
  const f = fixture();
  try {
    const ledger = createLedger({ stateDir: f.root, artifactRoot: f.root });
    ledger.preregister({ id: 'task-3', objective: 'same', criteria: ['a'] });
    assert.equal(ledger.preregister({ id: 'task-3', objective: 'same', criteria: ['a'] }).duplicate, true);
    assert.throws(() => ledger.preregister({ id: 'task-3', objective: 'changed', criteria: ['a'] }), /immutable/);
  } finally { f.cleanup(); }
});

test('a persisted authority failure blocks an older accepted result and symlink escapes are rejected', () => {
  const f = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-ledger-outside-'));
  try {
    const ledger = createLedger({ stateDir: f.root, artifactRoot: f.root });
    ledger.preregister({ id: 'task-4', objective: 'guard', criteria: ['a'] });
    const proof = { path: 'artifact.txt', sha256: sha256(fs.readFileSync(f.file)) }; const task = ledger.getTask('task-4'); const checks = [{ taskId: 'task-4', acceptanceDigest: task.acceptanceDigest, criterionId: 'a', checkId: 'a-check', passed: true, command: 'node verify.cjs', exitCode: 0, checkedCount: 1, expectedCount: 1, artifacts: [proof] }];
    const reviewer = { id: 'reviewer', taskId: 'task-4', acceptanceDigest: task.acceptanceDigest, configured: true, independent: true, verdict: 'accept', checksDigest: checksDigest(checks), artifactsDigest: artifactsDigest([proof]) };
    ledger.recordOutcome({ taskId: 'task-4', workerId: 'worker', checks, artifacts: [proof], reviewer });
    ledger.recordOutcome({ taskId: 'task-4', authorityViolation: true });
    assert.equal(ledger.evaluate('task-4').accepted, false);
    assert.equal(ledger.recordOutcome({ taskId: 'task-4', workerId: 'worker', checks, artifacts: [proof], reviewer }).accepted, false);
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside');
    try { fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(f.root, 'escape.txt')); } catch { return; }
    assert.equal(ledger.verifyArtifact({ path: 'escape.txt', sha256: sha256(fs.readFileSync(path.join(outside, 'secret.txt'))) }).ok, false);
  } finally { f.cleanup(); fs.rmSync(outside, { recursive: true, force: true }); }
});

test('does not replay an exact receipt across task contracts', () => {
  const f = fixture();
  try {
    const ledger = createLedger({ stateDir: f.root, artifactRoot: f.root });
    ledger.preregister({ id: 'task-a', objective: 'same criterion', criteria: ['criterion'] });
    ledger.preregister({ id: 'task-b', objective: 'same criterion', criteria: ['criterion'] });
    const proof = { path: 'artifact.txt', sha256: sha256(fs.readFileSync(f.file)) }; const a = ledger.getTask('task-a');
    const checks = [{ taskId: 'task-a', acceptanceDigest: a.acceptanceDigest, criterionId: 'criterion', checkId: 'check', passed: true, command: 'node verify.cjs', exitCode: 0, checkedCount: 1, expectedCount: 1, artifacts: [proof] }];
    const reviewer = { id: 'reviewer', taskId: 'task-a', acceptanceDigest: a.acceptanceDigest, configured: true, independent: true, verdict: 'accept', checksDigest: checksDigest(checks), artifactsDigest: artifactsDigest([proof]) };
    assert.throws(() => ledger.recordOutcome({ taskId: 'task-b', workerId: 'worker', checks, artifacts: [proof], reviewer }), /taskId|contract/);
    const b = ledger.getTask('task-b'); const rebound = [{ ...checks[0], taskId: 'task-b' }];
    assert.throws(() => ledger.recordOutcome({ taskId: 'task-b', workerId: 'worker', checks: rebound, artifacts: [proof], reviewer: { ...reviewer, taskId: 'task-b', acceptanceDigest: a.acceptanceDigest, checksDigest: checksDigest(rebound) } }), /taskId|acceptanceDigest|contract/);
    assert.equal(ledger.evaluate('task-b').accepted, false);
    assert.notEqual(a.acceptanceDigest, b.acceptanceDigest);
  } finally { f.cleanup(); }
});

test('rejects oversized preregistration without leaving an unpersisted task', () => {
  const f = fixture();
  try {
    const ledger = createLedger({ stateDir: f.root, artifactRoot: f.root });
    assert.throws(() => ledger.preregister({ id: 'oversized', objective: 'x'.repeat(10001), criteria: ['criterion'] }), /bounded/);
    assert.equal(ledger.getTask('oversized'), null);
    assert.equal(ledger.evaluate('oversized').accepted, false);
  } finally { f.cleanup(); }
});

test('rolls back in-memory registration when atomic persistence fails', () => {
  const f = fixture();
  const originalRename = fs.renameSync;
  try {
    const ledger = createLedger({ stateDir: f.root, artifactRoot: f.root });
    fs.renameSync = () => { throw new Error('injected rename failure'); };
    assert.throws(() => ledger.preregister({ id: 'rename-failure', objective: 'bounded', criteria: ['criterion'] }), /injected rename failure/);
    assert.equal(ledger.getTask('rename-failure'), null);
    assert.equal(ledger.evaluate('rename-failure').accepted, false);
  } finally { fs.renameSync = originalRename; f.cleanup(); }
});

test('binds full check receipts and never falls back to an older artifact version', () => {
  const f = fixture();
  try {
    const ledger = createLedger({ stateDir: f.root, artifactRoot: f.root });
    ledger.preregister({ id: 'task-5', objective: 'versioned', criteria: ['a'] });
    const task = ledger.getTask('task-5');
    const make = (revisionId, label) => {
      const proof = { path: 'artifact.txt', sha256: sha256(fs.readFileSync(f.file)) };
      const checks = [{ taskId: 'task-5', acceptanceDigest: task.acceptanceDigest, criterionId: 'a', checkId: 'a-check', passed: true, command: `node verify-${label}.cjs`, exitCode: 0, checkedCount: 1, expectedCount: 1, artifacts: [proof], revisionId }];
      const reviewer = { id: `reviewer-${label}`, taskId: 'task-5', acceptanceDigest: task.acceptanceDigest, configured: true, independent: true, verdict: 'accept', checksDigest: checksDigest(checks), artifactsDigest: artifactsDigest([proof]) };
      return { taskId: 'task-5', workerId: `worker-${label}`, checks, artifacts: [proof], reviewer };
    };
    const first = make('revision-1', 'one'); ledger.recordOutcome(first);
    fs.writeFileSync(f.file, 'version two'); const second = make('revision-2', 'two'); ledger.recordOutcome(second);
    const tamperedChecks = { ...second.checks[0], command: 'node altered.cjs' };
    assert.throws(() => ledger.recordOutcome({ ...second, checks: [tamperedChecks] }), /bind exact checks/);
    fs.writeFileSync(f.file, 'verified artifact');
    assert.equal(ledger.evaluate('task-5').accepted, false);
    const recovery = make('revision-3', 'recovery');
    assert.equal(ledger.recordOutcome(recovery).accepted, true);
    const reloaded = createLedger({ stateDir: f.root, artifactRoot: f.root });
    assert.equal(reloaded.evaluate('task-5').accepted, true);
    assert.equal(reloaded.evaluate('task-5').outcome.checks[0].revisionId, 'revision-3');
  } finally { f.cleanup(); }
});

test('failed outcome persistence restores both acceptance and credit before a successful retry', () => {
  const f=fixture(), originalRename=fs.renameSync;
  try {
    const ledger=createLedger({stateDir:f.root,artifactRoot:f.root});
    const task=ledger.preregister({id:'durable-credit',objective:'Preserve durable credit',criteria:['works']}).task;
    const proof={path:'artifact.txt',sha256:sha256(fs.readFileSync(f.file))};
    const checks=[{taskId:task.id,acceptanceDigest:task.acceptanceDigest,criterionId:'works',checkId:'checked',passed:true,command:'inspect fixture',exitCode:0,checkedCount:1,expectedCount:1,artifacts:[proof]}];
    const input={taskId:task.id,workerId:'worker',checks,artifacts:[proof],reviewer:{id:'reviewer',taskId:task.id,acceptanceDigest:task.acceptanceDigest,configured:true,independent:true,verdict:'accept',checksDigest:checksDigest(checks),artifactsDigest:artifactsDigest([proof])}};
    fs.renameSync=()=>{throw new Error('injected outcome rename failure');};
    assert.throws(()=>ledger.recordOutcome(input),/injected outcome rename failure/);
    assert.equal(ledger.evaluate(task.id).accepted,false);
    assert.equal(Object.hasOwn(ledger.snapshot().credits,task.id),false);
    fs.renameSync=originalRename;
    const retry=ledger.recordOutcome(input);
    assert.equal(retry.accepted,true);assert.equal(retry.credited,true);
    assert.equal(createLedger({stateDir:f.root,artifactRoot:f.root}).evaluate(task.id).accepted,true);
  } finally {fs.renameSync=originalRename;f.cleanup();}
});
