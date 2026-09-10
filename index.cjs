'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const MAX_BYTES = 4 * 1024 * 1024;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
  }
  return value;
}

function digest(value) { return sha256(JSON.stringify(stable(value))); }
// Digest the complete bounded check receipts. No projection is used: command, counts,
// exit status, artifact binding, revision, and any future bounded fields all matter.
function checksDigest(checks) { return digest(checks || []); }
function artifactsDigest(artifacts) { return digest((artifacts || []).map(a => ({ path: a.path, sha256: a.sha256 })).sort((a, b) => `${a.path}:${a.sha256}`.localeCompare(`${b.path}:${b.sha256}`))); }

function ensureId(value, label) {
  if (typeof value !== 'string' || !ID.test(value) || ['__proto__', 'prototype', 'constructor'].includes(value)) throw new Error(`${label} must be a simple identifier`);
  return value;
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function nowMs(clock) {
  const value = typeof clock === 'function' ? clock() : Date.now();
  if (!Number.isFinite(value)) throw new Error('clock must return a finite timestamp');
  return value;
}

class TaskLedger {
  constructor(options = {}) {
    if (typeof options.stateDir !== 'string' || !options.stateDir.trim()) throw new Error('stateDir is required and must be caller-supplied');
    if (typeof options.artifactRoot !== 'string' || !options.artifactRoot.trim()) throw new Error('artifactRoot is required and must be caller-supplied');
    this.stateDir = path.resolve(options.stateDir);
    this.artifactRoot = path.resolve(options.artifactRoot);
    this.file = path.join(this.stateDir, 'ledger.json');
    this.clock = options.clock || (() => Date.now());
    this.freshnessMs = Number.isFinite(options.freshnessMs) ? Math.max(1, options.freshnessMs) : 24 * 60 * 60 * 1000;
    this.maxTasks = Number.isInteger(options.maxTasks) ? Math.max(1, Math.min(10000, options.maxTasks)) : 1000;
    this.maxOutcomesPerTask = Number.isInteger(options.maxOutcomesPerTask) ? Math.max(1, Math.min(100, options.maxOutcomesPerTask)) : 20;
    this._state = this._load();
  }

  _load() {
    fs.mkdirSync(this.stateDir, { recursive: true });
    if (!fs.existsSync(this.file)) return { version: 1, tasks: Object.create(null), outcomes: Object.create(null), credits: Object.create(null) };
    if (fs.statSync(this.file).size > 2 * 1024 * 1024) throw new Error('ledger state exceeds size bound');
    const value = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (!value || value.version !== 1 || !value.tasks || !value.outcomes || !value.credits) throw new Error('invalid ledger state');
    return value;
  }

  _save() {
    const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    const serialized = JSON.stringify(this._state, null, 2) + '\n';
    if (Buffer.byteLength(serialized) > 2 * 1024 * 1024) throw new Error('ledger state exceeds size bound');
    try { fs.writeFileSync(temporary, serialized, { mode: 0o600 }); fs.renameSync(temporary, this.file); }
    catch (error) { try { fs.rmSync(temporary, { force: true }); } catch {} throw error; }
  }

  _appendOutcome(taskId, outcome) {
    const outcomes = this._state.outcomes[taskId] || [];
    const before = clone(this._state);
    try { if (outcomes.length >= this.maxOutcomesPerTask) outcomes.shift(); outcomes.push(outcome); this._state.outcomes[taskId] = outcomes; this._save(); }
    catch (error) { this._state = before; throw error; }
  }

  _artifactPath(input) {
    if (typeof input !== 'string' || !input.trim()) throw new Error('artifact path required');
    const absolute = path.resolve(this.artifactRoot, input);
    const relative = path.relative(this.artifactRoot, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('artifact outside artifactRoot');
    const realRoot = fs.realpathSync(this.artifactRoot);
    const realFile = fs.realpathSync(absolute);
    const realRelative = path.relative(realRoot, realFile);
    if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) throw new Error('artifact symlink outside artifactRoot');
    return realFile;
  }

  verifyArtifact(proof) {
    try {
      if (!proof || typeof proof.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(proof.sha256)) return { ok: false, reason: 'sha256 required' };
      const file = this._artifactPath(proof.path);
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size < 1 || stat.size > MAX_BYTES) return { ok: false, reason: 'artifact must be a nonempty bounded file' };
      const actual = sha256(fs.readFileSync(file));
      return actual.toLowerCase() === proof.sha256.toLowerCase() ? { ok: true, sha256: actual, size: stat.size } : { ok: false, reason: 'artifact sha256 mismatch', actual };
    } catch (error) { return { ok: false, reason: error.message }; }
  }

  preregister(task) {
    if (!task || typeof task !== 'object') throw new Error('task object required');
    const id = ensureId(task.id, 'task id');
    if (typeof task.objective !== 'string' || !task.objective.trim() || task.objective.length > 10000) throw new Error('objective required and bounded to 10000 characters');
    if (!Array.isArray(task.criteria) || task.criteria.length === 0 || task.criteria.length > 50) throw new Error('1..50 acceptance criteria required');
    const criteria = task.criteria.map(c => {
      if (typeof c === 'string') {
        if (!ID.test(c)) throw new Error('criteria need unique ids and descriptions');
        return { id: c, description: c };
      }
      if (!c || typeof c !== 'object' || !ID.test(c.id || '') || typeof c.description !== 'string' || !c.description.trim() || c.description.length > 2000) throw new Error('criteria need unique ids and bounded descriptions');
      return { id: c.id, description: c.description.trim() };
    });
    if (new Set(criteria.map(c => c.id)).size !== criteria.length) throw new Error('criterion ids must be unique');
    if (this._state.tasks[id]) {
      if (this._state.tasks[id].acceptanceDigest !== digest({ id, objective: task.objective.trim(), criteria })) throw new Error('task preregistration is immutable');
      return { task: clone(this._state.tasks[id]), duplicate: true };
    }
    if (Object.keys(this._state.tasks).length >= this.maxTasks) throw new Error('task ledger capacity reached');
    const record = { id, objective: task.objective.trim(), criteria, preregisteredAt: new Date(nowMs(this.clock)).toISOString(), acceptanceDigest: digest({ id, objective: task.objective.trim(), criteria }) };
    const before = clone(this._state);
    try { this._state.tasks[id] = record; this._state.outcomes[id] = []; this._save(); }
    catch (error) { this._state = before; throw error; }
    return { task: clone(record), duplicate: false };
  }

  getTask(id) { ensureId(id, 'task id'); return this._state.tasks[id] ? clone(this._state.tasks[id]) : null; }

  recordOutcome(input) {
    if (!input || typeof input !== 'object') throw new Error('outcome object required');
    const id = ensureId(input.taskId, 'task id');
    const task = this._state.tasks[id];
    if (!task) throw new Error('task must be preregistered');
    if (input.authorityViolation === true || input.regression === true) {
      const failure = { id: `failure-${digest({ id, authorityViolation: input.authorityViolation === true, regression: input.regression === true, note: input.reason || '' }).slice(0, 20)}`, taskId: id, verified: false, reason: input.authorityViolation === true ? 'authority violation' : 'regression detected', recordedAt: new Date(nowMs(this.clock)).toISOString() };
      this._appendOutcome(id, failure);
      return { accepted: false, credited: false, duplicate: false, outcome: clone(failure), reason: failure.reason };
    }
    const checks = Array.isArray(input.checks) ? input.checks : [];
    if (!checks.length) throw new Error('criterion-bound checks required');
    const criterionIds = new Set(task.criteria.map(c => c.id));
    const seen = new Set();
    for (const check of checks) {
      if (!check || JSON.stringify(check).length > 10000 || check.taskId !== id || check.acceptanceDigest !== task.acceptanceDigest || !ID.test(check.checkId || '') || !criterionIds.has(check.criterionId) || typeof check.passed !== 'boolean' || typeof check.command !== 'string' || !check.command.trim() || check.command.length > 500 || check.exitCode !== 0 || !Number.isSafeInteger(check.checkedCount) || check.checkedCount < 1 || !Number.isSafeInteger(check.expectedCount) || check.expectedCount < 1 || check.checkedCount !== check.expectedCount || !Array.isArray(check.artifacts) || check.artifacts.length > 20 || (check.revisionId != null && !ID.test(check.revisionId))) throw new Error('each check needs taskId, acceptanceDigest, command, exitCode 0, positive matching counts, exact artifacts and a known criterion');
      if (seen.has(check.criterionId)) throw new Error('one check per criterion is required');
      seen.add(check.criterionId);
    }
    if (seen.size !== criterionIds.size || checks.some(c => !c.passed)) throw new Error('all preregistered criteria need passing bound checks');
    const reviewer = input.reviewer;
    if (typeof input.workerId !== 'string' || !input.workerId.trim()) throw new Error('workerId is required for reviewer independence');
    if (!reviewer || reviewer.configured !== true || reviewer.independent !== true || typeof reviewer.id !== 'string' || !reviewer.id.trim() || reviewer.id.trim() === input.workerId.trim() || reviewer.taskId !== id || reviewer.acceptanceDigest !== task.acceptanceDigest) throw new Error('an independent configured reviewer bound to this task contract with a distinct identity is required');
    const artifacts = Array.isArray(input.artifacts) ? input.artifacts : [];
    if (!artifacts.length || artifacts.length > 20) throw new Error('1..20 artifact proofs required');
    const verified = artifacts.map(proof => ({ proof: clone(proof), verification: this.verifyArtifact(proof) }));
    if (verified.some(x => !x.verification.ok)) throw new Error(`artifact verification failed: ${verified.find(x => !x.verification.ok).verification.reason}`);
    const checksHash = checksDigest(checks);
    const artifactsHash = artifactsDigest(artifacts);
    if (checks.some(check => artifactsDigest(check.artifacts) !== artifactsHash)) throw new Error('check artifact binding must match exact task artifacts');
    if (reviewer.verdict !== 'accept' || reviewer.checksDigest !== checksHash || reviewer.artifactsDigest !== artifactsHash) throw new Error('review verdict must bind exact checks and artifact proofs');
    const completedAt = input.completedAt == null ? nowMs(this.clock) : new Date(input.completedAt).getTime();
    const current = nowMs(this.clock);
    if (!Number.isFinite(completedAt) || completedAt > current + 1000 || current - completedAt > this.freshnessMs) throw new Error('outcome is outside the freshness window');
    const fingerprint = digest({ taskId: id, checks, artifacts: artifacts.map(a => ({ path: a.path, sha256: a.sha256 })).sort((a, b) => `${a.path}:${a.sha256}`.localeCompare(`${b.path}:${b.sha256}`)) });
    const outcomes = this._state.outcomes[id] || [];
    const duplicate = outcomes.find(o => o.fingerprint === fingerprint);
    if (duplicate) {
      const currentOutcome = outcomes[outcomes.length - 1] === duplicate;
      const currentFresh = currentOutcome && duplicate.verified === true && duplicate.artifacts.every(proof => this.verifyArtifact(proof).ok) && nowMs(this.clock) - new Date(duplicate.completedAt).getTime() <= this.freshnessMs;
      return currentFresh ? { accepted: true, credited: false, duplicate: true, outcome: clone(duplicate) } : { accepted: false, credited: false, duplicate: true, reason: 'duplicate receipt is stale or is not the current outcome' };
    }
    const outcome = { id: `outcome-${fingerprint.slice(0, 20)}`, taskId: id, fingerprint, checks: clone(checks), artifacts: clone(artifacts), reviewer: { id: reviewer.id.trim(), taskId: id, acceptanceDigest: task.acceptanceDigest, configured: true, independent: true, verdict: 'accept', checksDigest: checksHash, artifactsDigest: artifactsHash }, completedAt: new Date(completedAt).toISOString(), recordedAt: new Date(current).toISOString(), verified: true };
    const before = clone(this._state);
    const credited = !this._state.credits[id];
    try {
      this._state.outcomes[id] = outcomes;
      if (credited) this._state.credits[id] = { taskId: id, fingerprint, creditedAt: outcome.recordedAt, amount: 1 };
      this._appendOutcome(id, outcome);
    } catch (error) { this._state = before; throw error; }
    return { accepted: true, credited, duplicate: false, outcome: clone(outcome) };
  }

  evaluate(taskId) {
    const id = ensureId(taskId, 'task id');
    const task = this._state.tasks[id];
    if (!task) return { accepted: false, reason: 'task not found' };
    const allRecords = this._state.outcomes[id] || [];
    const latest = allRecords[allRecords.length - 1];
    if (latest && latest.verified === false) return { accepted: false, fresh: false, reason: latest.reason || 'latest outcome is not accepted' };
    const current = nowMs(this.clock);
    const latestValid = latest && latest.verified === true && Array.isArray(latest.artifacts) && latest.artifacts.every(proof => this.verifyArtifact(proof).ok);
    const fresh = latestValid && current - new Date(latest.completedAt).getTime() <= this.freshnessMs ? latest : null;
    return fresh ? { accepted: true, fresh: true, outcome: clone(fresh), credited: !!this._state.credits[id] } : { accepted: false, fresh: false, reason: latest ? (latestValid ? 'latest outcome is stale' : 'latest artifact evidence changed or is unavailable') : 'no verified outcome' };
  }

  snapshot() { return clone(this._state); }
}

function createLedger(options) { return new TaskLedger(options); }

module.exports = { TaskLedger, createLedger, sha256, digest, checksDigest, artifactsDigest };
