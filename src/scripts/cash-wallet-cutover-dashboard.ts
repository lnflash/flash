#!/usr/bin/env node

import fs from "fs"
import http from "http"

import express from "express"
import yargs from "yargs"
import { hideBin } from "yargs/helpers"

import { discoverCashWalletCutoverAccounts } from "@app/cash-wallet-cutover/discovery"
import {
  buildCashWalletCutoverOperatorSnapshot,
  CashWalletCutoverMilestone,
  CASH_WALLET_CUTOVER_STAGE_STATUSES,
  CashWalletCutoverOperatorManifestAccount,
  CashWalletCutoverOperatorSnapshot,
  CashWalletCutoverStageSummary,
  deriveCashWalletCutoverMilestones,
  formatCashWalletCutoverOperatorSnapshotCsv,
  formatOperatorBalance,
  OperatorBalance,
  parseCashWalletCutoverOperatorManifest,
  refreshOperatorAccountCutoverBalanceAudit,
  summarizeCashWalletCutoverStages,
} from "@app/cash-wallet-cutover/operator-dashboard"
import { buildCashWalletCutoverPreflightReport } from "@app/cash-wallet-cutover/preflight"
import { getBalanceForWallet } from "@app/wallets"
import { WalletCurrency } from "@domain/shared"
import { getFunderWalletId } from "@services/ledger/caching"
import { baseLogger } from "@services/logger"
import { setupMongoConnection } from "@services/mongodb"
import {
  AccountsRepository,
  CashWalletCutoverRepository,
  WalletsRepository,
} from "@services/mongoose"

const BALANCE_TIMEOUT_MS = 7_500
const BALANCE_READ_ATTEMPTS = 3
const BALANCE_READ_SPACING_MS = 1_000

const args = yargs(hideBin(process.argv))
  .option("port", { type: "number", default: 3450 })
  .option("manifest", { type: "array", string: true, demandOption: true })
  .option("expected-accounts", { type: "number", default: 60 })
  .option("snapshot-ttl-ms", { type: "number", default: 5_000 })
  .option("run-id", { type: "string" })
  .option("cutover-version", { type: "number" })
  .option("configPath", { type: "string", demandOption: true })
  .parseSync()

const readManifestAccounts = (): CashWalletCutoverOperatorManifestAccount[] => {
  const accounts = args.manifest.flatMap((manifestPath) =>
    parseCashWalletCutoverOperatorManifest(
      JSON.parse(fs.readFileSync(manifestPath, "utf8")),
    ),
  )

  const seen = new Set<AccountId>()
  for (const account of accounts) {
    if (seen.has(account.accountId)) {
      throw new Error(`Duplicate operator dashboard accountId: ${account.accountId}`)
    }
    seen.add(account.accountId)
  }

  if (args["expected-accounts"] && accounts.length !== args["expected-accounts"]) {
    throw new Error(
      `Expected ${args["expected-accounts"]} operator accounts, loaded ${accounts.length}`,
    )
  }

  return accounts
}

const withBalanceTimeout = (balance: ReturnType<typeof getBalanceForWallet>) =>
  Promise.race([
    balance,
    new Promise<ApplicationError>((resolve) => {
      setTimeout(
        () => resolve(new Error("Balance read timed out") as ApplicationError),
        BALANCE_TIMEOUT_MS,
      )
    }),
  ])

let nextBalanceReadAt = 0

const readBalanceThrottled = async (
  request: Parameters<typeof getBalanceForWallet>[0],
) => {
  const now = Date.now()
  const scheduledAt = Math.max(now, nextBalanceReadAt)
  nextBalanceReadAt = scheduledAt + BALANCE_READ_SPACING_MS

  const waitMs = scheduledAt - now
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs))
  }

  return withBalanceTimeout(getBalanceForWallet(request))
}

type CachedBalance = OperatorBalance & {
  walletId: WalletId
  updatedAt?: string
}

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Cash Wallet Cutover Dashboard</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8fb;
      --panel: #ffffff;
      --line: #d8dde8;
      --text: #172033;
      --muted: #667085;
      --green: #16794c;
      --green-bg: #e7f6ee;
      --yellow: #946200;
      --yellow-bg: #fff4cf;
      --red: #b42318;
      --red-bg: #fee4e2;
      --blue: #1f5eff;
      --blue-bg: #eaf0ff;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 14px;
    }

    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 16px 20px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
      position: sticky;
      top: 0;
      z-index: 5;
    }

    h1 {
      font-size: 18px;
      margin: 0;
      font-weight: 650;
    }

    main { padding: 16px 20px 28px; }

    button, select, label.filter {
      border: 1px solid var(--line);
      background: var(--panel);
      color: var(--text);
      border-radius: 6px;
      height: 34px;
      padding: 0 10px;
      font: inherit;
    }

    button { cursor: pointer; }
    button:hover { border-color: var(--blue); }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--muted);
      font-size: 12px;
    }

    .readiness {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      min-height: 34px;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 0 11px;
      background: var(--panel);
      color: var(--muted);
      font-weight: 650;
    }

    .readiness::before {
      content: "";
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--yellow);
      box-shadow: 0 0 0 3px var(--yellow-bg);
    }

    .readiness.ok {
      color: var(--green);
      border-color: #addfc6;
      background: var(--green-bg);
    }

    .readiness.ok::before {
      background: var(--green);
      box-shadow: 0 0 0 3px #bfe8d3;
    }

    .readiness.bad {
      color: var(--red);
      border-color: #f4b6b1;
      background: var(--red-bg);
    }

    .readiness.bad::before {
      background: var(--red);
      box-shadow: 0 0 0 3px #f8c7c3;
    }

    .summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
      gap: 8px;
      margin-bottom: 14px;
    }

    .metric {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px;
      min-height: 70px;
    }

    .metric span {
      display: block;
      color: var(--muted);
      font-size: 11px;
      margin-bottom: 6px;
      text-transform: uppercase;
    }

    .metric strong {
      display: block;
      font-size: 20px;
      line-height: 1.1;
      overflow-wrap: anywhere;
    }

    .controls {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      margin-bottom: 12px;
    }

    label.filter {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
    }

    input[type="checkbox"] {
      margin: 0;
      width: 15px;
      height: 15px;
    }

    .table-wrap {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: auto;
      max-height: calc(100vh - 215px);
    }

    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 1180px;
    }

    th, td {
      border-bottom: 1px solid var(--line);
      padding: 8px 10px;
      text-align: left;
      vertical-align: top;
      white-space: nowrap;
    }

    th {
      position: sticky;
      top: 0;
      background: #f0f3f9;
      color: #344054;
      font-size: 12px;
      z-index: 2;
    }

    tbody tr:hover { background: #fafcff; }
    tbody tr.watchlisted {
      background: #fbfcff;
      box-shadow: inset 3px 0 0 var(--blue);
    }
    tbody tr.watchlisted:hover { background: #f4f7ff; }
    .muted { color: var(--muted); font-size: 12px; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }

    .badge {
      display: inline-flex;
      align-items: center;
      min-height: 22px;
      padding: 2px 7px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      margin: 0 4px 4px 0;
    }

    .ok { color: var(--green); background: var(--green-bg); }
    .warn { color: var(--yellow); background: var(--yellow-bg); }
    .bad { color: var(--red); background: var(--red-bg); }
    .info { color: var(--blue); background: var(--blue-bg); }
    .right { text-align: right; }

    .stagegrid { display: grid; grid-template-columns: 1.6fr 1fr; gap: 10px; margin-bottom: 14px; }
    .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px; }
    .panel-title { font-weight: 650; margin-bottom: 10px; display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }
    .bar { display: flex; height: 22px; border-radius: 6px; overflow: hidden; border: 1px solid var(--line); background: #eef1f6; }
    .bar div { height: 100%; transition: width .4s ease; min-width: 0; }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
    .chip { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line); border-radius: 999px; padding: 3px 10px; cursor: pointer; font-size: 12px; font-weight: 600; background: #fff; }
    .chip .dot { width: 9px; height: 9px; border-radius: 50%; }
    .chip.active { border-color: var(--blue); box-shadow: 0 0 0 2px var(--blue-bg); }
    .chip .n { color: var(--muted); font-weight: 700; }
    .chip.zero { opacity: .45; }
    .feed { list-style: none; margin: 0; padding: 0; max-height: 200px; overflow: auto; font-size: 13px; }
    .feed li { display: flex; gap: 8px; align-items: baseline; padding: 4px 0; border-bottom: 1px dashed var(--line); }
    .feed .t { color: var(--muted); font-size: 11px; white-space: nowrap; font-family: ui-monospace, Menlo, monospace; }
    .feed .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; align-self: center; }
    .feed .dot.ok { background: var(--green); } .feed .dot.info { background: var(--blue); }
    .feed .dot.warn { background: var(--yellow); } .feed .dot.bad { background: var(--red); }

    @media (max-width: 1100px) {
      .stagegrid { grid-template-columns: 1fr; }
      .summary { grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); }
      header { align-items: flex-start; flex-direction: column; }
      .table-wrap { max-height: none; }
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Cash Wallet Cutover Dashboard</h1>
      <div class="muted">Raw Mongo wallets plus lazy IBEX balances. Presentation filtering is bypassed.</div>
    </div>
    <div class="header-actions">
      <span id="can-start" class="readiness">canStart: -</span>
      <span id="status">Loading...</span>
      <button id="export-csv" type="button">Export CSV</button>
      <button id="refresh" type="button">Refresh</button>
    </div>
  </header>
  <main>
    <section class="stagegrid">
      <div class="panel">
        <div class="panel-title">Pipeline <span class="muted" id="pipeline-note"></span></div>
        <div class="bar" id="stage-bar"></div>
        <div class="chips" id="stage-chips"></div>
      </div>
      <div class="panel">
        <div class="panel-title">Highlights <span class="muted" id="highlights-note"></span></div>
        <ol class="feed" id="highlights"></ol>
      </div>
    </section>
    <section class="summary" id="summary"></section>
    <section class="controls">
      <label class="filter"><input type="checkbox" id="filter-anomalies">Anomalies</label>
      <label class="filter"><input type="checkbox" id="filter-funded">Funded only</label>
      <label class="filter"><input type="checkbox" id="filter-missing-usdt">Missing USDT</label>
      <label class="filter"><input type="checkbox" id="filter-nonzero-usd">Nonzero USD</label>
      <label class="filter"><input type="checkbox" id="filter-nonzero-usdt">Nonzero USDT</label>
      <select id="filter-migration">
        <option value="">All migration statuses</option>
      </select>
    </section>
    <section class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Phone</th>
            <th>Account</th>
            <th>Default</th>
            <th>USD</th>
            <th class="right">USD Balance</th>
            <th>USDT</th>
            <th class="right">USDT Balance</th>
            <th>Audit</th>
            <th>Migration</th>
            <th>Anomalies</th>
          </tr>
        </thead>
        <tbody id="rows"></tbody>
      </table>
    </section>
  </main>
  <script>
    let snapshot = null
    let stageFilter = ""

    // Status lists interpolated from CASH_WALLET_CUTOVER_STAGE_STATUSES so a
    // new state-machine status can't silently diverge between server counts
    // and this client-side chip filter.
    const STAGE_STATUSES = ${JSON.stringify(CASH_WALLET_CUTOVER_STAGE_STATUSES)}
    const STAGES = [
      ["pending", "Pending", "#98a2b3"],
      ["provisioning", "Provisioning", "#7a5af8"],
      ["moving", "Moving funds", "#1f5eff"],
      ["fees", "Fees", "#0ba5ec"],
      ["finalizing", "Finalizing", "#12b76a"],
      ["complete", "Complete", "#16794c"],
      ["skipped", "Skipped (USDT)", "#66c61c"],
      ["attention", "Attention", "#b42318"],
      ["rollingBack", "Rolling back", "#946200"],
      ["rolledBack", "Rolled back", "#667085"],
    ].map(([key, label, color]) => [key, label, color, STAGE_STATUSES[key] || []])
    const stageStatuses = (key) => STAGE_STATUSES[key] || []

    const $ = (id) => document.getElementById(id)
    const money = (cents) => "$" + (cents / 100).toFixed(2)
    const usdt = (micros) => (micros / 1000000).toFixed(2) + " USDT"
    const combinedCents = (usdCents, usdtMicros) => usdCents + (usdtMicros / 10000)
    const shortId = (value) => value ? value.slice(0, 8) : "-"
    const walletText = (wallets) => wallets.length ? wallets.map((w) => shortId(w.id)).join(", ") : "-"
    const balanceText = (wallets) => wallets.length ? wallets.map((w) => {
      const text = w.balance.display
      return w.balance.status === "loading" ? '<span class="muted">' + text + '</span>' : text
    }).join(", ") : "-"
    const auditText = (audit) => {
      if (!audit) return "-"
      const cls = audit.status === "verified" ? "ok" : audit.status === "shortfall" ? "bad" : "warn"
      if (audit.status === "loading") {
        return '<span class="badge ' + cls + '">loading</span>' +
          '<div class="muted">waiting for balance</div>'
      }
      return '<span class="badge ' + cls + '">' + audit.status + '</span>' +
        '<div class="muted">delta ' + usdt(audit.finalDeltaUsdtMicros) + '</div>' +
        '<div class="muted">subsidy ' + usdt(audit.roundingSubsidyUsdtMicros) + '</div>' +
        (audit.shortfallUsdtMicros > 0 ? '<div class="bad">short ' + usdt(audit.shortfallUsdtMicros) + '</div>' : '')
    }
    const refreshAudit = (account) => {
      const audit = account.cutoverBalanceAudit
      if (!audit) return
      const wallet = account.usdtWallets.find((w) => w.id === account.expectedUsdtWalletId) ||
        account.usdtWallets.find((w) => w.expected) ||
        account.usdtWallets[0]
      if (!wallet) return
      if (wallet.balance.status === "loading") {
        account.cutoverBalanceAudit = Object.assign({}, audit, {
          status: "loading",
          currentDestinationBalanceUsdtMicros: 0,
          finalDeltaUsdtMicros: 0,
          roundingSubsidyUsdtMicros: 0,
          shortfallUsdtMicros: 0,
        })
        return
      }
      const current = wallet.balance.minorUnitsNumber
      const finalDelta = Math.max(0, current - audit.destinationStartingBalanceUsdtMicros)
      const shortfall = Math.max(0, audit.expectedMinimumUsdtMicros - finalDelta)
      const subsidy = Math.max(0, finalDelta - audit.expectedMinimumUsdtMicros)
      account.cutoverBalanceAudit = Object.assign({}, audit, {
        status: shortfall > 0 ? "shortfall" : "verified",
        currentDestinationBalanceUsdtMicros: current,
        finalDeltaUsdtMicros: finalDelta,
        roundingSubsidyUsdtMicros: subsidy,
        shortfallUsdtMicros: shortfall,
      })
    }
    const badgeClass = (name) => {
      if (name === "none" || name === "complete" || name === "skipped_already_migrated") return "ok"
      if (name.includes("failed") || name.includes("missing_usd") || name.includes("requires")) return "bad"
      if (name.includes("missing") || name.includes("not_started") || name.includes("locked")) return "warn"
      return "info"
    }
    const badge = (name) => '<span class="badge ' + badgeClass(name) + '">' + name + '</span>'

    function metric(label, value, kind) {
      return '<div class="metric ' + (kind || "") + '"><span>' + label + '</span><strong>' + value + '</strong></div>'
    }

    function renderReadiness() {
      const el = $("can-start")
      const readiness = snapshot.preflight || snapshot.summary
      const canStart = readiness.canStart === true
      el.className = "readiness " + (canStart ? "ok" : "bad")
      el.textContent = "canStart: " + (canStart ? "true" : "false") + " (" + readiness.blockers + " blockers)"
    }

    function renderSummary() {
      const s = currentSummary()
      const p = snapshot.preflight
      $("summary").innerHTML = [
        metric("Cutover", snapshot.cutover.state),
        metric("Run", snapshot.cutover.runId || "-"),
        metric("Accounts", p ? p.totalAccounts : s.accounts),
        metric("Candidates", p ? p.migrationCandidates : "-"),
        metric("Already USDT", p ? p.alreadyUsdt : "-"),
        metric("Blockers", p ? p.blockers : s.blockers, (p ? p.blockers : s.blockers) ? "bad" : "ok"),
        metric("Watchlist", s.watchlistAccounts),
        metric("Wallets", s.wallets.current + " / " + s.wallets.target, s.wallets.current === s.wallets.target ? "ok" : "warn"),
        metric("Missing USDT", s.wallets.missingUsdt, s.wallets.missingUsdt ? "warn" : "ok"),
        metric("Funded USD-only", s.fundedUsdOnlyAccounts),
        metric("USD Total", money(s.usdTotalCents)),
        metric("USDT Total", usdt(s.usdtTotalMicros)),
        metric("Treasury USD", money(s.treasury.usdTotalCents)),
        metric("Treasury USDT", usdt(s.treasury.usdtTotalMicros)),
        metric("Customer Total", money(s.reconciliation.customerTotalCents)),
        metric("System Total", money(s.reconciliation.systemTotalCents)),
        metric("Run anomalies", s.watchlistAnomalies || 0, s.watchlistAnomalies ? "bad" : "ok"),
        metric("Global anomalies", s.anomalies, s.anomalies ? "bad" : "ok"),
      ].join("")
    }

    function currentSummary() {
      const s = Object.assign({}, snapshot.summary, {
        wallets: Object.assign({}, snapshot.summary.wallets),
      })
      s.usdTotalCents = snapshot.accounts.reduce((sum, account) =>
        sum + account.usdWallets.reduce((walletSum, wallet) =>
          walletSum + wallet.balance.minorUnitsNumber, 0), 0)
      s.usdtTotalMicros = snapshot.accounts.reduce((sum, account) =>
        sum + account.usdtWallets.reduce((walletSum, wallet) =>
          walletSum + wallet.balance.minorUnitsNumber, 0), 0)
      s.fundedUsdOnlyAccounts = snapshot.accounts.filter((account) =>
        account.usdtWallets.length === 0 &&
        account.usdWallets.some((wallet) => wallet.balance.minorUnitsNumber > 0)
      ).length
      const treasuryAccounts = snapshot.treasury ? snapshot.treasury.accounts : []
      const treasuryUsdTotalCents = treasuryAccounts.reduce((sum, account) =>
        sum + account.usdWallets.reduce((walletSum, wallet) =>
          walletSum + wallet.balance.minorUnitsNumber, 0), 0)
      const treasuryUsdtTotalMicros = treasuryAccounts.reduce((sum, account) =>
        sum + account.usdtWallets.reduce((walletSum, wallet) =>
          walletSum + wallet.balance.minorUnitsNumber, 0), 0)
      s.treasury = {
        accounts: treasuryAccounts.length,
        wallets: treasuryAccounts.reduce((sum, account) => sum + account.walletCount, 0),
        usdTotalCents: treasuryUsdTotalCents,
        usdtTotalMicros: treasuryUsdtTotalMicros,
      }
      const customerTotalCents = combinedCents(s.usdTotalCents, s.usdtTotalMicros)
      const treasuryTotalCents = combinedCents(treasuryUsdTotalCents, treasuryUsdtTotalMicros)
      s.reconciliation = {
        customerTotalCents,
        treasuryTotalCents,
        systemTotalCents: customerTotalCents + treasuryTotalCents,
      }
      return s
    }

    function filters() {
      return {
        anomalies: $("filter-anomalies").checked,
        funded: $("filter-funded").checked,
        missingUsdt: $("filter-missing-usdt").checked,
        nonzeroUsd: $("filter-nonzero-usd").checked,
        nonzeroUsdt: $("filter-nonzero-usdt").checked,
        migration: $("filter-migration").value,
      }
    }

    function includeRow(account, f) {
      const usd = account.usdWallets.some((w) => w.balance.minorUnitsNumber > 0)
      const usdt = account.usdtWallets.some((w) => w.balance.minorUnitsNumber > 0)
      if (f.anomalies && account.anomalies.length === 0) return false
      if (f.funded && !usd && !usdt) return false
      if (f.missingUsdt && account.usdtWallets.length > 0) return false
      if (f.nonzeroUsd && !usd) return false
      if (f.nonzeroUsdt && !usdt) return false
      // An explicit status pick overrides a stale stage chip (chip clicks
      // clear the dropdown, but not vice versa — ANDing them can render an
      // empty table while the chip still shows a nonzero count).
      if (f.migration) return account.migrationStatus === f.migration
      if (stageFilter && stageStatuses(stageFilter).indexOf(account.migrationStatus) === -1) return false
      return true
    }

    function renderMigrationFilter() {
      const select = $("filter-migration")
      const current = select.value
      const values = Array.from(new Set(snapshot.accounts.map((a) => a.migrationStatus))).sort()
      select.innerHTML = '<option value="">All migration statuses</option>' + values.map((value) => '<option value="' + value + '">' + value + '</option>').join("")
      select.value = values.includes(current) ? current : ""
    }

    function renderRows() {
      const f = filters()
      snapshot.accounts.forEach(refreshAudit)
      const rows = snapshot.accounts.filter((account) => includeRow(account, f))
      $("rows").innerHTML = rows.map((account) => {
        const anomalies = account.anomalies.length ? account.anomalies.map(badge).join("") : badge("none")
        return '<tr class="' + (account.watchlisted ? "watchlisted" : "") + '">' +
          '<td>' + (account.index || "") + (account.watchlisted ? '<div>' + badge("watchlist") + '</div>' : '') + '</td>' +
          '<td>' + (account.phone || "-") + '<div class="muted">' + (account.username || account.batchRunId || "") + '</div></td>' +
          '<td class="mono">' + shortId(account.accountId) + '<div class="muted">' + shortId(account.accountUuid) + '</div></td>' +
          '<td>' + shortId(account.defaultWalletId) + '<div class="muted">' + (account.defaultWalletCurrency || "-") + '</div></td>' +
          '<td class="mono">' + walletText(account.usdWallets) + '</td>' +
          '<td class="right">' + balanceText(account.usdWallets) + '</td>' +
          '<td class="mono">' + walletText(account.usdtWallets) + '</td>' +
          '<td class="right">' + balanceText(account.usdtWallets) + '</td>' +
          '<td>' + auditText(account.cutoverBalanceAudit) + '</td>' +
          '<td>' + badge(account.migrationStatus) + '<div class="muted">' + (account.migrationUpdatedAt || "") + '</div></td>' +
          '<td>' + anomalies + '</td>' +
          '</tr>'
      }).join("")
    }

    function elapsedText(startedAt) {
      if (!startedAt) return ""
      const ms = Date.now() - new Date(startedAt).getTime()
      if (ms < 0) return ""
      const m = Math.floor(ms / 60000), sec = Math.floor((ms % 60000) / 1000)
      return (m >= 60 ? Math.floor(m / 60) + "h " + (m % 60) + "m" : m + "m " + sec + "s")
    }

    function renderPipeline() {
      const st = snapshot.stages
      const bar = $("stage-bar"), chips = $("stage-chips"), note = $("pipeline-note")
      if (!st) { bar.innerHTML = ""; chips.innerHTML = '<span class="muted">waiting for first snapshot…</span>'; return }
      note.textContent = st.cutoverState + (st.runId ? " · " + st.runId : "") +
        (snapshot.cutover && snapshot.cutover.state === "in_progress" && snapshot.cutover.startedAt
          ? " · elapsed " + elapsedText(snapshot.cutover.startedAt) : "") +
        " · " + st.percentComplete + "% done"
      bar.innerHTML = STAGES.map(([key, label, color]) => {
        const n = st.counts[key] || 0
        if (!n) return ""
        const pct = (n / st.total) * 100
        return '<div title="' + label + ': ' + n + '" style="width:' + pct + '%;background:' + color + '"></div>'
      }).join("")
      chips.innerHTML = STAGES.map(([key, label, color]) => {
        const n = st.counts[key] || 0
        return '<span class="chip' + (stageFilter === key ? " active" : "") + (n ? "" : " zero") + '" data-stage="' + key + '">' +
          '<span class="dot" style="background:' + color + '"></span>' + label + ' <span class="n">' + n + '</span></span>'
      }).join("")
      chips.querySelectorAll(".chip").forEach((chip) => {
        chip.addEventListener("click", () => {
          stageFilter = stageFilter === chip.dataset.stage ? "" : chip.dataset.stage
          $("filter-migration").value = ""
          renderPipeline()
          renderRows()
        })
      })
    }

    function renderHighlights() {
      const feed = $("highlights")
      const items = (snapshot.milestones || []).slice().reverse()
      $("highlights-note").textContent = items.length + " event(s)"
      // Milestone text embeds the free-form --run-id; escape it — this is the
      // one innerHTML sink fed by operator input.
      const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))
      feed.innerHTML = items.map((m) =>
        '<li><span class="dot ' + esc(m.kind) + '"></span><span class="t">' +
        new Date(m.at).toLocaleTimeString() + '</span><span>' + esc(m.text) + '</span></li>'
      ).join("") || '<li><span class="muted">no events yet</span></li>'
    }

    function render() {
      renderReadiness()
      renderSummary()
      renderPipeline()
      renderHighlights()
      renderMigrationFilter()
      renderRows()
    }

    // USD wallets first (the funded legacy balances operators care about
    // most), then USDT, then treasury — so the meaningful numbers fill in
    // before the long tail.
    function allWalletIds() {
      const usd = snapshot.accounts.flatMap((a) => a.usdWallets.map((w) => w.id))
      const usdt = snapshot.accounts.flatMap((a) => a.usdtWallets.map((w) => w.id))
      const treasury = (snapshot.treasury ? snapshot.treasury.accounts : []).flatMap(
        (a) => a.usdWallets.concat(a.usdtWallets).map((w) => w.id),
      )
      return usd.concat(usdt).concat(treasury)
    }

    function mergeBalances(balances) {
      snapshot.accounts.forEach((account) => {
        account.usdWallets.concat(account.usdtWallets).forEach((wallet) => {
          if (balances[wallet.id]) wallet.balance = balances[wallet.id]
        })
      })
      if (snapshot.treasury) {
        snapshot.treasury.accounts.forEach((account) => {
          account.usdWallets.concat(account.usdtWallets).forEach((wallet) => {
            if (balances[wallet.id]) wallet.balance = balances[wallet.id]
          })
        })
      }
    }

    // Wallet IDs are batched into small GETs: one URL with the whole fleet
    // (600+ UUIDs ≈ 22KB) exceeds Node's 16KB header limit and 431s, which
    // stalled every balance at zero. 60 ids/request keeps URLs ~2KB.
    const BALANCE_BATCH = 60
    let balancePollTimer = null
    let hydrateGeneration = 0
    function loadingWalletIds() {
      const ids = []
      const collect = (account) => account.usdWallets.concat(account.usdtWallets)
        .forEach((w) => { if (!w.balance.status || w.balance.status === "loading") ids.push(w.id) })
      snapshot.accounts.forEach(collect)
      if (snapshot.treasury) snapshot.treasury.accounts.forEach(collect)
      return ids
    }
    async function hydrateBalances(force, onlyLoading) {
      if (!snapshot) return
      // Generation guard: the 15s active-run reload starts a new pass while a
      // previous multi-batch pass (and its 2s poll chain) may still be
      // running — without this they stack and interleave renders.
      const generation = ++hydrateGeneration
      const walletIds = onlyLoading ? loadingWalletIds() : allWalletIds()
      if (walletIds.length === 0) return

      let fresh = 0, errors = 0, loading = 0, pending = 0, active = false

      for (let i = 0; i < walletIds.length; i += BALANCE_BATCH) {
        if (generation !== hydrateGeneration) return // superseded by a newer pass
        const batch = walletIds.slice(i, i + BALANCE_BATCH)
        const url = "/api/balances?walletIds=" + encodeURIComponent(batch.join(",")) +
          (force ? "&refresh=1" : "")
        const response = await fetch(url)
        if (!response.ok) {
          throw new Error("Balance refresh failed (" + response.status + ")")
        }
        const result = await response.json()

        mergeBalances(result.balances)
        for (const balance of Object.values(result.balances)) {
          if (balance.status === "fresh") fresh++
          else if (balance.status === "error") errors++
          else if (balance.status === "loading") loading++
        }
        pending = result.queue.pending
        active = !!result.queue.active

        // Paint incrementally so funded USD balances appear as batches land.
        renderSummary()
        renderRows()
        $("status").textContent = "Loading balances " + Math.min(i + BALANCE_BATCH, walletIds.length) +
          "/" + walletIds.length + "…"
      }

      $("status").textContent = "Updated " + new Date(snapshot.generatedAt).toLocaleTimeString() +
        " | balances " + (fresh + errors) + "/" + walletIds.length +
        (pending || active ? " (" + pending + " queued)" : "")

      if ((loading > 0 || pending > 0 || active) && !balancePollTimer) {
        balancePollTimer = setTimeout(() => {
          balancePollTimer = null
          // Poll passes only re-request wallets still loading — not the full
          // 600-wallet list every 2s while the server queue drains.
          hydrateBalances(false, true).catch((error) => {
            $("status").textContent = error.message
          })
        }, 2000)
      }
    }

    async function load(force) {
      $("status").textContent = force ? "Refreshing..." : "Loading..."
      const response = await fetch("/api/snapshot" + (force ? "?refresh=1" : ""))
      // Parse before assigning: a transient 500 must not replace the live
      // snapshot with {error} and break every subsequent render.
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || "Snapshot failed")
      snapshot = body
      $("status").textContent = "Updated " + new Date(snapshot.generatedAt).toLocaleTimeString()
      render()
      hydrateBalances(force, false).catch((error) => {
        $("status").textContent = error.message
      })
    }

    document.querySelectorAll("input, select").forEach((element) => {
      element.addEventListener("change", () => snapshot && renderRows())
    })
    $("refresh").addEventListener("click", () => load(true).catch((error) => {
      $("status").textContent = error.message
    }))
    $("export-csv").addEventListener("click", () => {
      window.location.href = "/api/export.csv"
    })

    // Adaptive refresh: tight loop while a run (or rollback) is active,
    // relaxed when idle.
    function isActiveRun() {
      if (!snapshot) return false
      if (snapshot.cutover && snapshot.cutover.state === "in_progress") return true
      const st = snapshot.stages
      return !!st && (st.inFlight > 0 || (st.counts && st.counts.rollingBack > 0))
    }
    let reloadTimer = null
    function scheduleReload() {
      if (reloadTimer) clearTimeout(reloadTimer)
      reloadTimer = setTimeout(() => {
        // Watchdog: re-arm even if load() never settles — the server can hang
        // behind a stuck snapshot build with no timeout, and a dead chain
        // otherwise never recovers (the old setInterval did by construction).
        const watchdog = setTimeout(scheduleReload, 60000)
        load(false)
          .catch((error) => { $("status").textContent = error.message })
          .finally(() => { clearTimeout(watchdog); scheduleReload() })
      }, isActiveRun() ? 15000 : 120000)
    }

    load(false).catch((error) => {
      $("status").textContent = error.message
    }).finally(scheduleReload)
  </script>
</body>
</html>`

const start = async () => {
  const manifestAccounts = readManifestAccounts()
  const accountsRepo = AccountsRepository()
  const walletsRepo = WalletsRepository()
  const migrationsRepo = CashWalletCutoverRepository()
  const migrationLookup =
    args["run-id"] && args["cutover-version"]
      ? { runId: args["run-id"], cutoverVersion: args["cutover-version"] }
      : undefined

  await setupMongoConnection()

  const loadTreasuryAccountIds = async (): Promise<AccountId[]> => {
    const funderWalletId = await getFunderWalletId()

    const funderWallet = await walletsRepo.findById(funderWalletId)
    if (funderWallet instanceof Error) throw funderWallet

    return [funderWallet.accountId]
  }

  const treasuryAccountIds = await loadTreasuryAccountIds()

  let cache:
    | {
        snapshot: CashWalletCutoverOperatorSnapshot
        cachedAt: number
      }
    | undefined
  let pending: Promise<CashWalletCutoverOperatorSnapshot> | undefined

  // Stage pipeline + milestone highlights: diff consecutive snapshots and
  // keep a bounded feed. Also logged, so `kubectl logs` retains the history
  // across browser sessions.
  let lastStageSummary: CashWalletCutoverStageSummary | undefined
  const MILESTONE_LIMIT = 300
  const milestones: CashWalletCutoverMilestone[] = [
    {
      at: new Date().toISOString(),
      kind: "info",
      text: `Dashboard online — watching ${manifestAccounts.length} accounts`,
    },
  ]

  const observeStageProgress = (result: CashWalletCutoverOperatorSnapshot) => {
    const current = summarizeCashWalletCutoverStages({
      migrationStatuses: result.accounts.map((account) => account.migrationStatus),
      cutoverState: result.cutover.state,
      runId: result.cutover.runId,
      missingUsdtWallets: result.summary.wallets.missingUsdt,
    })
    const fresh = deriveCashWalletCutoverMilestones({
      previous: lastStageSummary,
      current,
      at: new Date().toISOString(),
    })
    for (const milestone of fresh) {
      milestones.push(milestone)
      baseLogger.info({ milestone }, "cutover milestone")
    }
    if (milestones.length > MILESTONE_LIMIT) {
      milestones.splice(0, milestones.length - MILESTONE_LIMIT)
    }
    lastStageSummary = current
  }
  const walletCurrencies = new Map<WalletId, WalletCurrency>()
  const balanceCache = new Map<WalletId, CachedBalance>()
  const balanceQueue: Array<{ walletId: WalletId; currency: WalletCurrency }> = []
  const queuedBalanceIds = new Set<WalletId>()
  let activeBalanceId: WalletId | undefined
  let balanceWorker: Promise<void> | undefined

  const registerSnapshotWallets = (snapshot: CashWalletCutoverOperatorSnapshot) => {
    for (const account of [...snapshot.accounts, ...snapshot.treasury.accounts]) {
      for (const wallet of [...account.usdWallets, ...account.usdtWallets]) {
        walletCurrencies.set(wallet.id, wallet.currency)
        if (!balanceCache.has(wallet.id)) {
          balanceCache.set(wallet.id, {
            walletId: wallet.id,
            currency: wallet.currency,
            display: "loading",
            minorUnits: "0",
            minorUnitsNumber: 0,
            status: "loading",
          })
        }
      }
    }
  }

  const runBalanceWorker = () => {
    if (balanceWorker) return balanceWorker

    balanceWorker = (async () => {
      while (balanceQueue.length > 0) {
        const request = balanceQueue.shift()
        if (!request) continue

        queuedBalanceIds.delete(request.walletId)
        activeBalanceId = request.walletId
        balanceCache.set(request.walletId, {
          walletId: request.walletId,
          currency: request.currency,
          display: "loading",
          minorUnits: "0",
          minorUnitsNumber: 0,
          status: "loading",
        })

        const balance = await readBalanceThrottled({
          walletId: request.walletId,
          currency: request.currency,
        })
        balanceCache.set(request.walletId, {
          walletId: request.walletId,
          ...formatOperatorBalance(
            { id: request.walletId, currency: request.currency } as Wallet,
            balance,
          ),
          updatedAt: new Date().toISOString(),
        })
      }
    })().finally(() => {
      activeBalanceId = undefined
      balanceWorker = undefined
      if (balanceQueue.length > 0) runBalanceWorker()
    })

    return balanceWorker
  }

  const enqueueBalance = ({
    walletId,
    currency,
    force,
  }: {
    walletId: WalletId
    currency: WalletCurrency
    force: boolean
  }) => {
    const cached = balanceCache.get(walletId)
    if (!force && cached && cached.status !== "loading") return
    if (queuedBalanceIds.has(walletId) || activeBalanceId === walletId) return

    queuedBalanceIds.add(walletId)
    balanceQueue.push({ walletId, currency })
    runBalanceWorker()
  }

  const snapshotWithCachedBalances = (
    currentSnapshot: CashWalletCutoverOperatorSnapshot,
  ): CashWalletCutoverOperatorSnapshot => ({
    ...currentSnapshot,
    accounts: currentSnapshot.accounts.map((account) =>
      refreshOperatorAccountCutoverBalanceAudit({
        ...account,
        usdWallets: account.usdWallets.map((wallet) => ({
          ...wallet,
          balance: balanceCache.get(wallet.id) ?? wallet.balance,
        })),
        usdtWallets: account.usdtWallets.map((wallet) => ({
          ...wallet,
          balance: balanceCache.get(wallet.id) ?? wallet.balance,
        })),
      }),
    ),
    treasury: {
      ...currentSnapshot.treasury,
      accounts: currentSnapshot.treasury.accounts.map((account) => ({
        ...account,
        usdWallets: account.usdWallets.map((wallet) => ({
          ...wallet,
          balance: balanceCache.get(wallet.id) ?? wallet.balance,
        })),
        usdtWallets: account.usdtWallets.map((wallet) => ({
          ...wallet,
          balance: balanceCache.get(wallet.id) ?? wallet.balance,
        })),
      })),
    },
  })

  const buildSnapshot = async () => {
    const config = await migrationsRepo.getConfig()
    if (config instanceof Error) throw config
    const lookup =
      migrationLookup ??
      (config.runId
        ? {
            cutoverVersion: config.cutoverVersion,
            runId: config.runId,
          }
        : undefined)
    const discoveries = lookup
      ? await discoverCashWalletCutoverAccounts({
          accountsRepo,
          walletsRepo,
        })
      : undefined
    if (discoveries instanceof Error) throw discoveries
    const preflightReport =
      lookup && discoveries
        ? buildCashWalletCutoverPreflightReport({
            cutoverVersion: lookup.cutoverVersion,
            runId: lookup.runId,
            discoveries,
          })
        : undefined

    const result = await buildCashWalletCutoverOperatorSnapshot({
      manifestAccounts,
      accountsRepo,
      walletsRepo,
      migrationsRepo,
      migrationLookup: lookup,
      preflightReport,
      discoveredAccounts: discoveries,
      treasuryAccountIds,
      balanceReadAttempts: BALANCE_READ_ATTEMPTS,
      balanceMode: "structural",
      getBalanceForWallet: (request) =>
        readBalanceThrottled({
          walletId: request.walletId,
          currency: request.currency ?? WalletCurrency.Usd,
        }),
    })
    registerSnapshotWallets(result)
    observeStageProgress(result)
    return result
  }

  const snapshot = async (force: boolean) => {
    const now = Date.now()
    if (!force && cache && now - cache.cachedAt < args["snapshot-ttl-ms"]) {
      return cache.snapshot
    }
    if (pending) return pending

    pending = buildSnapshot()
      .then((result) => {
        cache = { snapshot: result, cachedAt: Date.now() }
        return result
      })
      .finally(() => {
        pending = undefined
      })
    return pending
  }

  // Keep stage/milestone tracking alive even with no browser tab open.
  // Tight cadence only while a run/rollback is live; idle polls back off —
  // each rebuild is a discovery scan over every unlocked account plus
  // several mongo queries per dashboard account, and pre-PR it only ran
  // while a browser was actually polling.
  const BACKGROUND_POLL_ACTIVE_MS = 30_000
  const BACKGROUND_POLL_IDLE_MS = 5 * 60_000
  const backgroundPoll = () => {
    snapshot(false)
      .catch((error) =>
        baseLogger.warn({ error }, "cutover dashboard background poll failed"),
      )
      .finally(() => {
        const active =
          lastStageSummary !== undefined &&
          (lastStageSummary.cutoverState === "in_progress" ||
            lastStageSummary.inFlight > 0 ||
            lastStageSummary.counts.rollingBack > 0)
        setTimeout(
          backgroundPoll,
          active ? BACKGROUND_POLL_ACTIVE_MS : BACKGROUND_POLL_IDLE_MS,
        )
      })
  }
  setTimeout(backgroundPoll, BACKGROUND_POLL_ACTIVE_MS)

  const app = express()
  app.get("/", (_req, res) => res.type("html").send(html))
  app.get("/api/snapshot", async (req, res) => {
    try {
      const result = await snapshot(req.query.refresh === "1")
      res.json({ ...result, stages: lastStageSummary, milestones })
    } catch (error) {
      baseLogger.error({ error }, "Cash wallet cutover dashboard snapshot failed")
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })
  app.get("/api/balances", async (req, res) => {
    try {
      await snapshot(false)
      const rawWalletIds =
        typeof req.query.walletIds === "string" ? req.query.walletIds : ""
      const requestedWalletIds = rawWalletIds
        ? rawWalletIds
            .split(",")
            .map((walletId) => walletId.trim())
            .filter(Boolean)
        : Array.from(walletCurrencies.keys())
      const force = req.query.refresh === "1"

      for (const rawWalletId of requestedWalletIds) {
        const walletId = rawWalletId as WalletId
        const currency = walletCurrencies.get(walletId)
        if (!currency) continue
        enqueueBalance({ walletId, currency, force })
      }

      const balances: Record<string, CachedBalance> = {}
      for (const rawWalletId of requestedWalletIds) {
        const walletId = rawWalletId as WalletId
        const cached = balanceCache.get(walletId)
        if (cached) balances[walletId] = cached
      }

      res.json({
        balances,
        queue: {
          pending: balanceQueue.length,
          active: activeBalanceId,
        },
      })
    } catch (error) {
      baseLogger.error({ error }, "Cash wallet cutover dashboard balance refresh failed")
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })
  app.get("/api/balance-status", async (_req, res) => {
    const balances = Array.from(balanceCache.values())
    res.json({
      known: walletCurrencies.size,
      cached: balances.length,
      fresh: balances.filter((balance) => balance.status === "fresh").length,
      errors: balances.filter((balance) => balance.status === "error").length,
      loading: balances.filter((balance) => balance.status === "loading").length,
      queue: {
        pending: balanceQueue.length,
        active: activeBalanceId,
      },
    })
  })
  app.get("/api/milestones", (_req, res) => {
    res.json({ stages: lastStageSummary, milestones })
  })
  app.get("/api/export.csv", async (_req, res) => {
    try {
      const currentSnapshot = await snapshot(false)
      const csv = formatCashWalletCutoverOperatorSnapshotCsv(
        snapshotWithCachedBalances(currentSnapshot),
      )
      const runId = currentSnapshot.cutover.runId ?? "unknown-run"
      res
        .type("text/csv")
        .attachment(`cash-wallet-cutover-${runId}-${Date.now()}.csv`)
        .send(csv)
    } catch (error) {
      baseLogger.error({ error }, "Cash wallet cutover dashboard CSV export failed")
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })

  const server = http.createServer(app)
  server.listen(args.port, "127.0.0.1", () => {
    baseLogger.info(
      { port: args.port, accounts: manifestAccounts.length },
      "Cash wallet cutover dashboard listening",
    )
    console.log(`Cash wallet cutover dashboard: http://localhost:${args.port}`)
  })
}

start().catch((error) => {
  baseLogger.error({ error }, "Cash wallet cutover dashboard failed")
  process.exit(1)
})
