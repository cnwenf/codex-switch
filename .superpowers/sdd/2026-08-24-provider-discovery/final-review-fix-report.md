# Provider Discovery Final Review Fix Report

Date: 2026-08-25
Base: `f197e1a9f525b2536998b6e37bbe0a927d89b5cf`
Commit: the single scoped `HEAD` commit named `fix(provider-discovery): close final security review`; its immutable hash is returned to the coordinator after commit creation.

## Outcome

The complete final-review fix wave is implemented. The final successful full suite is `226/226`; JS/JSON, POSIX shell, Swift, YAML, diff, focused secret scans, and production dependency audit all pass. No real API/OAuth key was read or used, no application was installed, and no push, release, or `/Applications` mutation was performed.

## Finding map

| Finding | Resolution | Behavioral evidence |
|---|---|---|
| Critical 1 — secrets must never leave the backend or return to config | Provider export/list/raw config and clipboard payloads are metadata-only; raw config is a structurally redacted JSON projection, including whole sensitive subtrees. Client `token` is rejected, serializers never emit it, and imports drop top-level/nested credential material and require local key re-entry. Server-owned legacy inline tokens remain load-only and migrate transactionally to a canonical env entry with mode `0600`; the migration skips a plaintext history snapshot. | `test/admin-api.test.js`, `test/admin-page.test.js`, `test/provider-config.test.js`: response/config/clipboard non-leakage, nested credential redaction, client-token rejection, quote round-trip, migration, rollback, and no new secret-bearing history. Final output contains no fixture key plaintext. |
| Critical 2 — bind auth and credentials to trusted provider/origin | Registry auth and fixed/derived URLs are authoritative for modern saves. Dedicated `chatgpt-sub` is the only subscription/OAuth provider and always resolves to the exact ChatGPT Codex base. Custom/NIM are bearer-only. Runtime route construction uses the load-normalized provider. Legacy passthrough is server-canonicalized and limited to loopback or an exact registry fixed/derived endpoint; unknown arbitrary HTTPS is rejected. Legacy bearer URLs remain compatible under the safe Custom URL policy. | Table-driven `test/provider-config.test.js`; runtime fetch capture in `test/admin-api.test.js` proves preset bearer goes only to `api.x.ai`, inbound Authorization goes only to exact ChatGPT, and a submitted attacker URL never survives. `test/proxy-lifecycle.test.js` uses policy-allowed loopback passthrough. |
| Important 1 — separate legacy load from new save | Added a distinct `normalizeProviderForLoad()`. Providers without `provider_type`, including Kimi/GLM/DeepSeek bearer configs, keep their safe URL/auth and start normally. Modern Custom saves reject known unsupported official endpoints disguised as Custom. | `test/provider-config.test.js` load-vs-save matrix and `test/admin-api.test.js` startup/save coverage. |
| Important 2 — cancel discovery bodies on every early exit | Added non-blocking unread-body cancellation before redirect processing, non-2xx errors, and declared oversize rejection; streamed oversize cancellation remains immediate and non-blocking. | `test/provider-discovery.test.js`: redirect-before-follow, HTTP 401, declared >4 MiB, streamed >4 MiB, and non-resolving cancellation. |
| Important 3 — correct Node system-CA support | Source installer now probes the actual runtime with `node --use-system-ca -e ''`. Package/lock engines and docs use `>=22.15.0 <23 || >=23.8.0`. | `test/launcher-ca.test.js`: 22.14 reject, 22.15 admit, 23.7 reject, 23.8 admit, and both engine declarations. |
| Important 4 — harden the management updater | Admin metadata accepts one exact uploaded versioned DMG/checksum pair with exact GitHub download URLs (including encoded build metadata), but still exposes an update while release assets are asynchronously building. Admin freezes the exact tag and delegates to `scripts/install-app.sh`; the former recursive-delete/copy installer is removed. The one shared `install-app-bundle.cjs` implements copy-to-staging, destination identity validation, backup/rename, rollback, and backup preservation. Provider credential env names are scrubbed from the installer subprocess. Packaging includes both installer files. Existing exact-tag polling, SHA256, no-clobber release workflow, and UI action/status contract remain intact. | `test/app-update.test.js`, `test/install-app.test.js`, `test/admin-page.test.js`: wrong/missing/duplicate assets, checksum mismatch/format, exact tag, staging success, copy failure, final-rename rollback, symlink race defense, build packaging, single-boundary architecture, and secret-free child env. |
| Minor 1 — Custom/NIM warning | Both presets are explicitly `unverified`, remain deliberately routable, and display “未验证 Responses 兼容性” rather than the limited-support claim. | `test/provider-registry.test.js`, `test/admin-page.test.js`. |
| Minor 2 — env control bytes and quote round-trip | Key persistence rejects CR, LF, and NUL before any write or reflection. Generated POSIX single-quote encoding has a canonical inverse, including embedded single quotes, and remains mode `0600`. | `test/admin-api.test.js` plus real `/bin/sh` sourcing of the generated fixture env file. |

## TDD record

All commands used the bundled Node path because the default shell did not expose Node:

`PATH=/Applications/ChatGPT.app/Contents/Resources/cua_node/bin:/usr/bin:/bin:/usr/sbin:/sbin`

### Secrets, auth, legacy, env, and UI

- RED: `node --test test/provider-config.test.js test/provider-registry.test.js test/default-config.test.js test/admin-api.test.js test/admin-page.test.js`
  - `88 pass / 11 fail` for the intended reasons: key-bearing export/raw config, accepted client inline token, missing migration/control-byte protection/quote inverse, missing dedicated ChatGPT preset/default type, unbound auth/origin/runtime routing, unsupported legacy startup/save split, and missing clipboard sanitizers.
- Focused GREEN: same command, `99/99`.
- Additional security RED/GREEN discovered during self-review:
  - legacy migration history assertion: RED because the pre-migration snapshot duplicated the inline secret; GREEN after suppressing only that unsafe disk snapshot while retaining in-memory transactional rollback.
  - nested raw credential table assertion: RED because a sensitive parent object was traversed; GREEN after redacting the full sensitive subtree.
  - nested clipboard/import credential assertion: RED because provider options were copied wholesale; GREEN after scalar metadata allowlisting and credential-key removal.

### Discovery cancellation

- RED: `node --test test/provider-discovery.test.js` — `49/52`; redirect, HTTP error, and declared-oversize bodies were not cancelled.
- Focused GREEN: same command — `52/52`.

### Node CA gate

- RED: `node --test test/launcher-ca.test.js` — `3 pass / 5 fail`; no behavior probe, Node 23.7 passed the monotonic version test, and package/lock engines were inaccurate.
- Focused GREEN: same command — `8/8`.

### Custom/NIM warning

- RED: `node --test test/provider-registry.test.js test/admin-page.test.js` — `44/46`; presets still said `limited` and no explicit compatibility-copy helper existed.
- Focused GREEN: same command — `46/46`.

### Updater and shared installer

- RED: `node --test test/app-update.test.js` — updater module absent (`0/2` initially).
- RED: `node --test --test-name-pattern='shared app-bundle' test/install-app.test.js` — shared helper absent (`0/3`).
- RED: `node --test --test-name-pattern='macOS build stages' test/install-app.test.js` — packaged helper copy absent.
- Subsequent intentional REDs covered conflicting duplicate asset metadata, encoded `+build` asset URLs, provider-secret child-env collisions, and the still-present second `installDmg()` implementation.
- Focused GREEN:
  - `node --test test/app-update.test.js` — `3/3`.
  - `node --test test/install-app.test.js` — `56/56`.
  - `node --test test/app-update.test.js test/admin-page.test.js` — `36/36` at that checkpoint.

### Cross-cutting focused regression

- `node --test test/provider-config.test.js test/provider-registry.test.js test/default-config.test.js test/admin-page.test.js test/provider-discovery.test.js test/launcher-ca.test.js test/app-update.test.js test/admin-api.test.js` — `163/163`.
- The first attempted full run exposed five correct auth-policy REDs in `test/proxy-lifecycle.test.js`: its old fixture sent `chatgpt_subscription` to loopback, which the new policy rejects. The failed fixture registered cleanup too late and left the runner pending, so the run was interrupted after recording `221 pass / 5 fail / 1 cancelled`. Product auth was not weakened; the lifecycle fixture was changed to policy-allowed loopback legacy passthrough and cleanup registration was moved before health probing.
- Focused GREEN: `node --test test/proxy-lifecycle.test.js` — `5/5`, including 300 cancelled SSE requests and byte-for-byte normal SSE.

## Final verification

- Full suite: `npm test` — `226/226`, `0 fail`, `0 cancelled`, duration `52.158s`.
- JavaScript syntax: all `21` tracked/worktree `.js`/`.cjs` files pass `node --check`.
- JSON: `package.json` and `package-lock.json` parse successfully.
- POSIX shell syntax: `install.sh` plus `scripts/*.sh`, `5/5`, pass `/bin/sh -n`.
- Swift: launcher and menubar sources, `2/2`, pass `xcrun swiftc -typecheck`.
- YAML: `.github/workflows/release-dmg.yml` parses with Ruby Psych.
- Diff: `git diff --check` clean.
- Focused secret scan: no high-confidence OpenAI/GitHub/AWS/Google/private-key literals in tracked production changes or new updater/helper files; no production `token =` assignment. No real credential file or local override was inspected.
- Dependency audit: `npm audit --omit=dev` — `found 0 vulnerabilities`.
- One initial JS-static command reported `files=0` because its deliberately narrow PATH omitted `rg`; it was invalid evidence and was replaced by the absolute-path run above (`21` files). No success claim relies on the invalid command.

## Security review notes

- Validation and canonicalization happen server-side before routing or secret binding. Modern client auth/base fields are not trusted.
- Provider mutation persistence remains one transaction: config, env file, process env, cache identity/generation/lease/epoch, and routing state roll back together on failure.
- No secret value is included in connection/cache identities, admin projections, clipboard payloads, updater status, child-process diagnostics, or logs.
- Responses request/response/SSE payload bytes are untouched; no retry was added. The full lifecycle suite verifies byte passthrough, upstream abort on downstream cancellation, bounded FD behavior, and sanitized 502 codes.
- Release installation keeps exact-tag polling, exact asset identity, SHA256 verification, destination confinement, atomic rename/backup, rollback, and workflow no-clobber behavior.

## Changed files

- Runtime/security: `src/provider-config.js`, `src/provider-registry.js`, `src/provider-discovery.js`, `src/server.js`, `src/app-update.js`, `src/admin-page.js`, `config.toml`.
- Install/release/runtime gates: `scripts/install-app.sh`, `scripts/install-app-bundle.cjs`, `scripts/build-macos-app.sh`, `install.sh`, `package.json`, `package-lock.json`.
- Documentation: `README.md`, `DESIGN.md`, `docs/superpowers/plans/2026-08-24-provider-discovery.md`.
- Tests: `test/admin-api.test.js`, `test/admin-page.test.js`, `test/app-update.test.js`, `test/default-config.test.js`, `test/install-app.test.js`, `test/launcher-ca.test.js`, `test/provider-config.test.js`, `test/provider-discovery.test.js`, `test/provider-registry.test.js`, `test/proxy-lifecycle.test.js`.
- Review artifact: this report.

## Concerns / deliberately unverified

- No live provider/API/OAuth key verification was performed. Custom/NIM remain explicitly unverified in product copy.
- No real GitHub Actions run, release publication, release-asset readback, DMG mount on a real release, GUI updater run, or `/Applications` installation was performed.
- Pre-existing user config/history files from older versions may already contain inline tokens. This wave never inspects or rewrites those files automatically; it prevents new copies and migrates a token transactionally when the corresponding provider/snapshot is explicitly touched.
- The raw config GET contract is intentionally now a redacted JSON projection rather than verbatim TOML; mutation POST remains text/plain and identity-gated.

## Scoped re-review follow-up — legacy credential precedence

Date: 2026-08-25

Scope ruling: the user explicitly accepts the local plaintext export/history boundary. This follow-up does not change export, history snapshot, or restore policy; it fixes only stale inline-token precedence and generated env-name collisions.

### Finding and resolution

`prepareLegacyInlineTokenMigrations()` previously coupled removal of every legacy inline `token` to an unconditional `saveEnvKey()`. A stale inline value could therefore overwrite a current credential already configured under that provider's `token_env`. Generated names also considered only provider references, so they could collide with unrelated names already present in the env file or process.

The migration now separates config cleanup from env persistence:

- When the provider's existing canonical `token_env` has a non-empty value in the env file or process, the inline token is removed while the existing env reference and value are left unchanged.
- Only an inline token with no configured env value is persisted through the existing transactional `afterWrite` path.
- Auto-generated names avoid the union of provider references, env-file names, and process-environment names.
- Authorization of the inline-token cleanup, snapshot behavior, and the config/env/process/cache/generation/lease rollback wrapper remain unchanged.

### Focused TDD and verification

- RED: `node --test --test-name-pattern='stale legacy inline|no configured env|generated token_env' test/admin-api.test.js` — `1/4` passed and `3/4` failed for the intended reasons: the env-file value was overwritten, a process-only value caused an env file containing the stale value to be created, and the generated name selected an occupied base name. The no-env migration control passed.
- Focused GREEN: the same command — `4/4`, `0 fail`.
- Covering suite: `node --test test/admin-api.test.js` — `40/40`, including the existing config/env/process/cache/generation/lease rollback cases.
- Final full suite: `npm test` — `229/229`, `0 fail`, `0 cancelled`, duration `26.028s`.
- Static: `node --check src/server.js` and `node --check test/admin-api.test.js` both exit `0`.
- Diff: `git diff --check` exits `0`.

### Follow-up changed files and concerns

- Runtime: `src/server.js`.
- Behavioral tests: `test/admin-api.test.js`.
- Review artifact: this appended report section.
- No real API/OAuth key was read or used. No `/Applications` mutation, GitHub operation, release, or live-provider validation was performed. No additional concern was introduced beyond the deliberately unverified items already listed above.
