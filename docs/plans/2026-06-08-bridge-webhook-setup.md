# Bridge Webhook Setup Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a local developer setup path that starts ngrok for the Bridge webhook server, recreates sandbox Bridge webhooks, writes returned public keys into `~/.config/flash/dev-overrides.yaml`, and prints next-step instructions.

**Architecture:** Keep `dev/setup.sh` as the user-facing entrypoint and add a testable Node helper for Bridge/ngrok/YAML orchestration. The helper will call Bridge's Webhook API, manage ngrok through its local API, and merge only local override fields into `dev-overrides.yaml` without touching `dev/config/base-config.yaml`.

**Tech Stack:** Bash, Node.js CommonJS, built-in `fetch`, `js-yaml`, Jest unit tests, Bridge Webhooks API, ngrok CLI/local API.

---

### Task 1: Add test coverage for webhook setup helper

**Files:**
- Create: `test/flash/unit/dev/setup-bridge-webhooks.spec.ts`
- Create: `dev/setup-bridge-webhooks.js`

**Steps:**
1. Write tests for:
   - mapping four route keys to Bridge event categories and URLs
   - deleting existing non-deleted webhooks before recreation
   - creating webhooks and enabling them with `PUT status=active`
   - merging public keys and local Bridge settings into an existing YAML object
   - parsing the HTTPS ngrok public URL from the local API response
2. Run the test and confirm it fails because the helper does not exist.

### Task 2: Implement the Node helper

**Files:**
- Modify: `dev/setup-bridge-webhooks.js`

**Steps:**
1. Implement exported pure helpers for URL/category mapping and YAML merge.
2. Implement Bridge API helpers for list/delete/create/update.
3. Implement ngrok helpers:
   - ensure `ngrok` binary exists
   - start `ngrok http 4009` when no tunnel is already present
   - poll `http://127.0.0.1:4040/api/tunnels` for an HTTPS `public_url`
4. Implement CLI validation and success output.
5. Run focused unit tests.

### Task 3: Wire `dev/setup.sh`

**Files:**
- Modify: `dev/setup.sh`

**Steps:**
1. Add flag parsing for `--dev` and `--webhook`.
2. Make `--webhook` run only Bridge webhook setup.
3. Make `--dev` run existing setup and invoke Bridge webhook setup when Bridge config is available.
4. Keep the existing no-arg behavior compatible.

### Task 4: Verify

**Commands:**
- `TEST='test/flash/unit/dev/setup-bridge-webhooks.spec.ts' yarn test:unit`
- `npx prettier --check dev/setup.sh dev/setup-bridge-webhooks.js test/flash/unit/dev/setup-bridge-webhooks.spec.ts docs/plans/2026-06-08-bridge-webhook-setup.md`
- `npx eslint --resolve-plugins-relative-to "$PWD" --no-ignore test/flash/unit/dev/setup-bridge-webhooks.spec.ts`
- `bash -n dev/setup.sh`
- `node dev/setup-bridge-webhooks.js --help`
