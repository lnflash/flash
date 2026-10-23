# Isolated native-parity backend unit checks

Use Node 24 and dependencies installed from this checkout's frozen Yarn lockfile. The runner intentionally rejects other Node major versions. It does not install dependencies, source `.env`/`.env.local`, invoke a shell, or run the integration/sandbox suites.

```sh
node scripts/native-parity-unit.cjs
node --test scripts/native-parity-unit.test.cjs
```

The first command runs the fixed, reviewed selection of 75 Bridge, Earn, identity-storage, telemetry, device-bootstrap and wallet-ownership unit suites. Optional group arguments are `bridge`, `earn`, `storage`, `telemetry`, `device`, and `ownership`, for example `node scripts/native-parity-unit.cjs device`. No other Jest flags, file paths, environment overrides or configuration arguments are accepted. The checked-in selection must be updated deliberately when another relevant unit suite is added. It includes owned KYC provider/link boundaries, atomic account/customer binding, Earn's atomic reward deduplication, private-log regressions, durable device provisioning, and raw owned-wallet snapshot checks. It does not claim to run the full backend test tree; offers' Redis storage tests are outside this identity-storage slice.

The child receives only inherited `PATH` and `TMPDIR`, plus the explicit fixture values in `scripts/native-parity-unit.cjs`. Required secrets are unmistakable dummy strings. Network is `regtest`; configured service hosts point at numeric loopback port 9. `HOME`, cloud credentials/profiles, proxy variables, Node preloads, and inherited service/provider credentials are omitted. Jest's setup selects only committed `dev/config/base-config.yaml`; no private configuration file is loaded by the runner. Its required dummy environment exists only in the child process and must never be used for a deployment.

The runner uses the same Node executable that launched it, local Jest, `--runInBand`, an explicit `--runTestsByPath` list, and `--watchman=false`. Disabling Watchman avoids contacting a developer's existing Watchman daemon. There is no `--forceExit`, forced success, automatic test retry, or hidden connection cleanup. An open application/service handle therefore remains visible rather than being masked by forced termination.

`test/flash/unit/native-parity-network.cjs` preloads a network interlock before Jest or application modules. It permits only numeric loopback TCP fixture servers created in that same process on an ephemeral port, and connections to those registered fixture ports. Other TCP/Unix-socket connections, wildcard/fixed-port listeners, DNS resolution, and UDP sends fail. A caught network error still makes the overall run fail, so a best-effort provider wrapper cannot hide a missing mock. Diagnostics print a static error and code frames without destination URLs, headers or payloads. This protects these trusted tests against accidental unmocked I/O; it is not a security sandbox for hostile JavaScript or arbitrary subprocesses.

Three narrow test boundaries now avoid real service initialization:

- KYC webhook tests mock `awardReferralRewardOnKycApproval` from `@app/invite`. The approval case asserts the owned referral delegation, while duplicate-event and lost-CAS cases assert no reward delegation. This keeps invite's notification/queue clients out of a handler unit test.
- Withdrawal return-shape tests mock `@services/cache`, whose Plaid token-store import otherwise initializes Redis despite no Plaid call in that suite. Plaid cache ownership and consumption behavior is tested separately in the selected exchange suite with explicit cache mocks.
- WhatsApp bridge tests explicitly mock unconfigured Twilio/SendGrid configuration, matching their documented fallback precondition and keeping it independent of the backend bootstrap's dummy Twilio variables.

The identity presigned-PUT test still uses the real pinned AWS SDK and sends the untouched signed URL with a nonempty PNG to its local HTTP fixture. The interlock permits that fixture. It emulates checksum/body acceptance, not production signature verification, and uses dummy credentials only. All Bridge, IBEX, notification, database and cache interactions elsewhere are mocked.

Validated 2026-10-23 on Node `24.22.1` against integrated backend source through `ba04cb045` plus the reviewed runner changes: all **75 suites / 1180 tests** pass with natural status-zero termination, no blocked network attempts and no Jest open-handle warning. The separate Node runner checks pass **5 tests**, covering hostile inherited configuration, fixed suite selection, real local HTTP fixture acceptance, blocked TCP/DNS/UDP/listeners, and caught unmocked `fetch` failures. Installed lockfile versions were Jest `29.7.0`, `@swc/jest` `0.2.39`, and both S3 SDK packages `3.968.0`. Logs from this run are `/tmp/flash-native-backend-post-auth-provider-runner.log` and `/tmp/flash-native-backend-final-runner-selftest.log`; they are local artifacts, not checked-in fixtures.

These are offline unit checks. They do not establish provider access, sandbox interoperability, production configuration, bank-account provisioning, image storage acceptance by DigitalOcean, or deployment readiness.
