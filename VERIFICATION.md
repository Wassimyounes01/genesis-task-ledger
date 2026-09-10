# Verification

The release was exercised on Windows using v24.14.0. The offline test run passed 9 tests (0 skipped); the offline example exited successfully. Tests took 135 ms and the example 48 ms in this observation. These timings are not a benchmark or performance guarantee.

Commands: `npm test` and `npm run demo`. GitHub Actions is configured to repeat them on Windows and Linux with Node.js 20 and 22. CI results are available in the repository Actions tab.

Tests use explicit temporary state and injected fixtures. Live provider behavior, model quality, real account billing, arbitrary third-party CLIs and hosted integrations are not certified by this run. Reviewer identity and external evidence provenance remain caller-attested.

Recorded: 2026-09-10T19:43:32.795Z.
