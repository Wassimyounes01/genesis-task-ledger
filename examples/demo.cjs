'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLedger, sha256, checksDigest, artifactsDigest } = require('../index.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-ledger-demo-'));
try {
  const artifact = path.join(root, 'result.json');
  fs.writeFileSync(artifact, JSON.stringify({ ok: true }));
  const ledger = createLedger({ stateDir: root, artifactRoot: root });
  ledger.preregister({ id: 'offline-demo', objective: 'verify a bounded result', criteria: [{ id: 'json-valid', description: 'the result is valid JSON' }] });
  const task = ledger.getTask('offline-demo');
  const proof = { path: 'result.json', sha256: sha256(fs.readFileSync(artifact)) };
  const checks = [{ taskId: 'offline-demo', acceptanceDigest: task.acceptanceDigest, criterionId: 'json-valid', checkId: 'parse-json', passed: true, command: 'node parse.cjs', exitCode: 0, checkedCount: 1, expectedCount: 1, artifacts: [proof] }];
  console.log(ledger.recordOutcome({ taskId: 'offline-demo', workerId: 'demo-worker', checks, artifacts: [proof], reviewer: { id: 'configured-reviewer', taskId: 'offline-demo', acceptanceDigest: task.acceptanceDigest, configured: true, independent: true, verdict: 'accept', checksDigest: checksDigest(checks), artifactsDigest: artifactsDigest([proof]) } }));
} finally { fs.rmSync(root, { recursive: true, force: true }); }
