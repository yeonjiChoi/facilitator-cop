#!/usr/bin/env node
// Demo page server for the x402 demo.
//
// Starts Facilitator, Resource Server and Agent Wallet from the sibling repos, serves the demo
// page, and proxies the browser's calls to them (the services don't send CORS headers). Also
// answers the chain questions the page needs: balances and which tx settled a given payment.

import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFormatter, setTokenSymbol, toTerminalLine } from "./log-format.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

// demo-ui/.env holds every key the demo needs (see .env.example). Variables already set in the
// environment win, and are passed on to the services this script starts.
for (const [key, value] of Object.entries(readEnvFile(path.join(HERE, ".env")))) {
  if (process.env[key] === undefined && value !== "") process.env[key] = value;
}
// Keys copied from MetaMask come without the 0x prefix, which viem requires.
for (const key of ["FACILITATOR_PRIVATE_KEY", "TOKEN_OWNER_PRIVATE_KEY"]) {
  const v = process.env[key];
  if (v && /^[0-9a-fA-F]{64}$/.test(v)) process.env[key] = `0x${v}`;
}

const UI_PORT = Number(process.env.PORT ?? 4000);
const PORTS = { facilitator: 4001, resourceServer: 4002, agentWallet: 4003 };
const RPC_URL = process.env.ETHEREUM_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
// Payment token: any EIP-3009 token on Sepolia. Its name/version/symbol/decimals are read from the
// contract at startup (see readToken), so switching tokens only takes this address.
const TOKENS = {
  USDC: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", // Circle's Sepolia USDC (faucet.circle.com)
  DEMO: "0x025311Ca250150E9c3684b614566c9f187a47e16", // DemoCoin, coin-contract/README.md
};
const ASSET = process.env.TOKEN_ADDRESS || TOKENS.USDC;
const EXPLORER = "https://sepolia.etherscan.io";
const AGENT_ID = "demo-agent";
let token = { address: ASSET, name: null, version: null, symbol: "?", decimals: 6, faucet: null };
// keccak256("AuthorizationUsed(address,bytes32)"), emitted by EIP-3009 tokens on every authorized transfer
const AUTHORIZATION_USED_TOPIC = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";

const SERVICE_URL = {
  rs: `http://localhost:${PORTS.resourceServer}`,
  aw: `http://localhost:${PORTS.agentWallet}`,
  fac: `http://localhost:${PORTS.facilitator}`,
};

// ------------------------------------------------------------------ helpers

function readEnvFile(file) {
  const env = {};
  if (!existsSync(file)) return env;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

function loadJson(file, fallback) {
  try {
    return { ...fallback, ...JSON.parse(readFileSync(file, "utf8")) };
  } catch {
    return structuredClone(fallback);
  }
}

async function rpc(method, params) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }).then((r) => r.json());
  if (res.error) throw new Error(`${method}: ${res.error.message}`);
  return res.result;
}

const pad32 = (hex) => "0x" + hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");

async function tokenBalance(address) {
  const data = "0x70a08231" + pad32(address).slice(2);
  return BigInt(await rpc("eth_call", [{ to: ASSET, data }, "latest"])).toString();
}

const ethBalance = async (address) => BigInt(await rpc("eth_getBalance", [address, "latest"])).toString();

function decodeString(hex) {
  const data = hex.slice(2);
  const len = parseInt(data.slice(64, 128), 16);
  return Buffer.from(data.slice(128, 128 + len * 2), "hex").toString("utf8");
}

// The EIP-712 domain (name, version) must match the contract's exactly or every signature is
// rejected on-chain, so it is read from the token rather than configured.
async function readToken(address) {
  const call = (data) => rpc("eth_call", [{ to: address, data }, "latest"]);
  const [name, version, symbol, decimals] = await Promise.all([
    call("0x06fdde03").then(decodeString), // name()
    call("0x54fd4d50").then(decodeString).catch(() => "1"), // version(); tokens without it use "1"
    call("0x95d89b41").then(decodeString), // symbol()
    call("0x313ce567").then((h) => parseInt(h, 16)), // decimals()
  ]);
  const faucet = address.toLowerCase() === TOKENS.USDC.toLowerCase() ? "https://faucet.circle.com" : null;
  return { address, name, version, symbol, decimals, faucet };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ services

const children = [];
let settlerAddress = null;
// Settlement failures reported in the Resource Server log, keyed by payer:nonce, so the page
// can show the reason instead of waiting for a transaction that will never come.
const settlementFailures = new Map();
const paymentKey = (from, nonce) => `${from.toLowerCase()}:${nonce.toLowerCase()}`;

// Formatted demo log events: printed to the terminal and streamed to the page (SSE).
const LOG_BACKLOG = 500;
const logEvents = [];
const logClients = new Set();
let logSeq = 0;

function publishLog(event) {
  event.seq = ++logSeq;
  logEvents.push(event);
  if (logEvents.length > LOG_BACKLOG) logEvents.shift();
  console.log(toTerminalLine(event));
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of logClients) client.write(data);
}

function start(name, repo, env) {
  const logDir = path.join(HERE, "logs");
  mkdirSync(logDir, { recursive: true });
  const out = createWriteStream(path.join(logDir, `${name}.log`));
  // Run tsx's CLI with this Node directly: node_modules/.bin/tsx is a shell script that Windows
  // can't spawn.
  const tsxCli = path.join(ROOT, repo, "node_modules", "tsx", "dist", "cli.mjs");
  const child = spawn(process.execPath, [tsxCli, "--env-file-if-exists=.env", "src/index.ts"], {
    cwd: path.join(ROOT, repo),
    env: { ...process.env, ...env },
    // own process group, so the whole tree can be stopped (Windows uses taskkill /T instead)
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  const format = createFormatter(name);
  let buf = "";
  const onData = (chunk) => {
    out.write(chunk);
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        const entry = JSON.parse(line);
        if (entry.settler) settlerAddress = entry.settler;
        if (name === "resourceServer") recordResourceServerEvent(entry);
        if (entry.event === "payment.settle_failed" && entry.payer && entry.nonce) {
          settlementFailures.set(paymentKey(entry.payer, entry.nonce), entry.reason ?? entry.err?.message ?? "unknown");
        }
        const event = format(entry);
        if (event) publishLog(event);
      } catch {
        // non-JSON output
      }
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("exit", (code) => {
    if (!shuttingDown) console.error(`${name} exited (code ${code}), see demo-ui/logs/${name}.log`);
  });
  children.push(child);
}

let shuttingDown = false;
function stopAll() {
  shuttingDown = true;
  for (const child of children) {
    try {
      if (process.platform === "win32") {
        execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        process.kill(-child.pid, "SIGTERM");
      }
    } catch {
      // already exited
    }
  }
}
process.on("exit", stopAll);
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

async function assertPortsFree() {
  for (const [name, port] of Object.entries({ ...PORTS, ui: UI_PORT })) {
    try {
      await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(500) });
      throw new Error(`port ${port} (${name}) is already in use; stop that process first`);
    } catch (err) {
      if (err.message.startsWith("port")) throw err;
    }
  }
}

async function waitHealthy() {
  const deadline = Date.now() + 30_000;
  for (const url of Object.values(SERVICE_URL)) {
    while (true) {
      try {
        if ((await fetch(`${url}/health`)).ok) break;
      } catch {
        // not up yet
      }
      if (Date.now() > deadline) throw new Error(`${url} did not become healthy (see demo-ui/logs/)`);
      await sleep(300);
    }
  }
}

// ------------------------------------------------------------------ demo state

let agentAddress = null;
let payTo = null;
let delegation = null; // { id, policy }

async function ensureAgent() {
  const res = await fetch(`${SERVICE_URL.aw}/wallets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentId: AGENT_ID, keyStoreProvider: "local" }),
  });
  if (res.ok) return (await res.json()).address;
  if (res.status === 409) {
    return JSON.parse(readFileSync(path.join(HERE, ".keystore", `${AGENT_ID}.json`), "utf8")).address;
  }
  throw new Error(`create wallet failed: ${res.status} ${await res.text()}`);
}

async function revokeDelegation() {
  if (!delegation) return;
  await fetch(`${SERVICE_URL.aw}/delegations/${delegation.id}`, { method: "DELETE" });
  delegation = null;
}

async function createDelegation(policy) {
  const res = await fetch(`${SERVICE_URL.aw}/delegations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(policy),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `delegation failed (${res.status})`);
  return body.id;
}

// The agent has one standing policy, which this replaces (revoking the previous one also resets
// its window usage). One-off approvals are separate, short-lived delegations; see agentPay().
async function setDelegation(input) {
  await revokeDelegation();
  const policy = {
    agentId: AGENT_ID,
    allowedResources: input.allowedResources,
    maxAmountPerTx: String(input.maxAmountPerTx),
    maxAmountPerWindow: String(input.maxAmountPerWindow),
    windowSeconds: Number(input.windowSeconds),
    allowedChains: ["ethereum"],
    expiresAt: Math.floor(Date.now() / 1000) + Number(input.expiresIn ?? 24 * 3600),
    nonce: `demo-${Date.now()}`,
  };
  delegation = { id: await createDelegation(policy), policy };
  return delegation;
}

async function state() {
  const [agentDemo, agentEth, payToDemo, settlerEth, block] = await Promise.all([
    tokenBalance(agentAddress),
    ethBalance(agentAddress),
    tokenBalance(payTo),
    settlerAddress ? ethBalance(settlerAddress) : null,
    rpc("eth_blockNumber", []),
  ]);
  return {
    network: "ethereum (Sepolia)",
    explorer: EXPLORER,
    asset: ASSET,
    token,
    resourceServerUrl: SERVICE_URL.rs,
    agent: { id: AGENT_ID, address: agentAddress, demo: agentDemo, eth: agentEth },
    payTo: { address: payTo, demo: payToDemo },
    settler: { address: settlerAddress, eth: settlerEth },
    delegation,
    block: parseInt(block, 16),
  };
}

// Key that holds DEMO and tops the agent up: demo-ui/.env, else coin-contract/.env's deployer.
const ownerKey = () =>
  process.env.TOKEN_OWNER_PRIVATE_KEY ||
  readEnvFile(path.join(ROOT, "coin-contract", ".env")).DEPLOYER_PRIVATE_KEY ||
  null;

function topUp() {
  const key = ownerKey();
  if (!key) throw new Error("TOKEN_OWNER_PRIVATE_KEY가 설정되지 않아 충전할 수 없어요 (demo-ui/.env)");
  const amount = (10n ** BigInt(token.decimals)).toString(); // 1 token
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const foundryCast = ["cast", "cast.exe"].map((f) => path.join(home, ".foundry", "bin", f)).find(existsSync);
  const out = execFileSync(
    foundryCast ?? "cast",
    ["send", ASSET, "transfer(address,uint256)", agentAddress, amount,
      "--rpc-url", RPC_URL, "--private-key", key, "--json"],
    { encoding: "utf8" },
  );
  return JSON.parse(out).transactionHash;
}

async function findSettlement(from, nonce, fromBlock) {
  const logs = await rpc("eth_getLogs", [{
    address: ASSET,
    fromBlock: "0x" + Math.max(0, Number(fromBlock) - 2).toString(16),
    toBlock: "latest",
    topics: [AUTHORIZATION_USED_TOPIC, pad32(from), pad32(nonce)],
  }]);
  if (logs.length === 0) {
    const failure = settlementFailures.get(paymentKey(from, nonce));
    return failure ? { settled: false, failed: true, reason: failure } : { settled: false };
  }
  const txHash = logs[0].transactionHash;
  const [receipt, tx] = await Promise.all([
    rpc("eth_getTransactionReceipt", [txHash]),
    rpc("eth_getTransactionByHash", [txHash]),
  ]);
  return {
    settled: true,
    txHash,
    blockNumber: parseInt(logs[0].blockNumber, 16),
    status: receipt?.status === "0x1" ? "success" : "reverted",
    sender: tx.from,
    gasUsed: receipt ? parseInt(receipt.gasUsed, 16) : null,
  };
}

// ------------------------------------------------------------------ ledger
//
// What the seller and agent pages show is rebuilt from the services' own structured logs, so it
// covers every payment (agent page, developer page, attacks) without changing the services.
// Saved to demo-ui/data/ so a restart keeps today's numbers.

const DATA_DIR = path.join(HERE, "data");
const LEDGER_FILE = path.join(DATA_DIR, "ledger.json");
const SETTINGS_FILE = path.join(DATA_DIR, "agent-settings.json");

// payments: { nonce, payer, path, amount, at, status, txHash?, reason?, label?, approved? }
//   status: verified -> settling -> settled | failed, or skipped (request failed, not charged)
// blocked:  { kind: replay | forged | malformed, payer?, path?, at }
// agentEvents: approval requests and refusals, { id, kind: pending | declined | denied, label, amount, reason?, at }
const ledger = loadJson(LEDGER_FILE, { payments: [], blocked: [], agentEvents: [] });
const paymentByNonce = new Map(ledger.payments.map((p) => [p.nonce, p]));
const receivedPaths = new Map(); // nonce -> path, from payment.received
const paymentMeta = new Map(); // nonce -> { label, approved }, set by agentPay before the paid request

let saveTimer = null;
function saveLedger() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(LEDGER_FILE, JSON.stringify(ledger));
  }, 300);
}

function recordResourceServerEvent(e) {
  const p = e.nonce ? paymentByNonce.get(e.nonce) : undefined;
  switch (e.event) {
    case "payment.received":
      receivedPaths.set(e.nonce, e.path);
      return;
    case "payment.verified": {
      const payment = {
        nonce: e.nonce, payer: e.payer, amount: e.amount, path: receivedPaths.get(e.nonce),
        at: Date.now(), status: "verified", ...paymentMeta.get(e.nonce),
      };
      ledger.payments.push(payment);
      paymentByNonce.set(e.nonce, payment);
      break;
    }
    case "payment.settle_requested":
      if (p) p.status = "settling";
      break;
    case "payment.settle_skipped":
      if (p) p.status = "skipped";
      break;
    case "payment.settled":
      if (p) Object.assign(p, { status: "settled", txHash: e.txHash });
      break;
    case "payment.settle_failed":
      if (p) Object.assign(p, { status: "failed", reason: e.reason ?? e.err?.message ?? "unknown" });
      break;
    case "payment.replay_blocked":
      ledger.blocked.push({ kind: "replay", payer: e.payer, path: receivedPaths.get(e.nonce), at: Date.now() });
      break;
    case "payment.rejected": {
      // Only attacks count as blocked; e.g. an underfunded agent is not one.
      const kind = /signature/.test(e.reason) ? "forged" : /nonce already used/.test(e.reason) ? "replay" : null;
      if (!kind) return;
      ledger.blocked.push({ kind, payer: e.payer, path: receivedPaths.get(e.nonce), at: Date.now() });
      break;
    }
    case "payment.malformed":
      ledger.blocked.push({ kind: "malformed", path: e.path, at: Date.now() });
      break;
    default:
      return;
  }
  saveLedger();
}

const STOCKS = { "005930": "삼성전자", AAPL: "애플", TSLA: "테슬라" };
const PRODUCTS = [
  { key: "quotes", name: "실시간 시세", icon: "📈", probe: ["GET", "/securities/quotes/005930"], match: /^\/securities\/quotes\// },
  { key: "portfolio", name: "잔고 조회", icon: "💼", probe: ["GET", "/securities/portfolio"], match: /^\/securities\/portfolio/ },
  { key: "orders", name: "주식 주문", icon: "🧾", probe: ["POST", "/securities/orders", { symbol: "005930", side: "buy", quantity: 1 }], match: /^\/securities\/orders/ },
];
const productOf = (p) => PRODUCTS.find((x) => x.match.test(p ?? ""));
function paymentLabel(p) {
  if (p.label) return p.label;
  const product = productOf(p.path);
  if (!product) return p.path ?? "알 수 없는 API";
  const sym = p.path.match(/^\/securities\/quotes\/([^/?]+)/)?.[1]?.toUpperCase();
  return sym ? `${product.name} · ${STOCKS[sym] ?? sym}` : product.name;
}

// Prices come from the Resource Server's own 402 answers, so they can't drift from it.
async function probePrices() {
  for (const product of PRODUCTS) {
    const [method, p, body] = product.probe;
    try {
      const res = await fetch(SERVICE_URL.rs + p, {
        method,
        headers: body ? { "content-type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      product.price = (await res.json()).requirements?.amount ?? null;
    } catch {
      product.price = null;
    }
  }
}

// ------------------------------------------------------------------ agent settings

const EXPIRY_SECONDS = { "1h": 3600, "24h": 86400, "7d": 7 * 86400, none: 10 * 365 * 86400 };
const DEFAULT_SETTINGS = {
  enabled: true,
  perTx: "100000", // 0.1 DEMO
  perWindow: "500000", // 0.5 DEMO
  windowSeconds: 3600,
  askOnExceed: true,
  expiry: "24h",
  securities: true,
};
let settings = loadJson(SETTINGS_FILE, DEFAULT_SETTINGS);

async function applySettings(next) {
  settings = { ...settings, ...next };
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  if (!settings.enabled) {
    await revokeDelegation();
    return;
  }
  const allowedResources = [`${SERVICE_URL.rs}/shop/*`]; // used by the developer page
  if (settings.securities) allowedResources.unshift(`${SERVICE_URL.rs}/securities/*`);
  await setDelegation({
    allowedResources,
    maxAmountPerTx: settings.perTx,
    maxAmountPerWindow: settings.perWindow,
    windowSeconds: settings.windowSeconds,
    expiresIn: EXPIRY_SECONDS[settings.expiry] ?? EXPIRY_SECONDS["24h"],
  });
}

// What the agent has actually paid within the period limit's window: every payment a service
// accepted, approved ones included. Taken from the ledger, so it survives settings changes (which
// reissue the delegation and so reset the Agent Wallet's own counter) and restarts.
const justPaid = new Map(); // nonce -> { amount, at }: accepted, but the ledger hasn't logged it yet
function windowUsage() {
  const since = Date.now() - settings.windowSeconds * 1000;
  const agent = agentAddress?.toLowerCase();
  let total = 0n;
  for (const p of ledger.payments) {
    if (p.payer?.toLowerCase() === agent && p.at >= since && p.status !== "skipped") total += BigInt(p.amount);
  }
  for (const [nonce, s] of justPaid) {
    if (paymentByNonce.has(nonce) || s.at < since) justPaid.delete(nonce);
    else total += BigInt(s.amount);
  }
  return total;
}

// Agent payments run one at a time, so two of them can't both squeeze under the period limit.
let payQueue = Promise.resolve();
const serialized = (fn) => (...args) => {
  const run = payQueue.then(() => fn(...args));
  payQueue = run.catch(() => {});
  return run;
};

// ------------------------------------------------------------------ agent payments

const pendingApprovals = new Map(); // id -> { method, path, body, label, amount }

async function callResource(method, p, body, xPayment) {
  const headers = {};
  if (body) headers["content-type"] = "application/json";
  if (xPayment) headers["x-payment"] = xPayment;
  const res = await fetch(SERVICE_URL.rs + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

async function signPayment(resource, requirements) {
  const res = await fetch(`${SERVICE_URL.aw}/sign-payment`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentId: AGENT_ID, resource, requirements }),
  });
  return { status: res.status, data: await res.json() };
}

// The user approved one payment the standing policy refused: grant exactly that payment through
// a separate delegation that lives for a minute, sign, and revoke it. The standing policy and its
// window usage stay untouched.
async function signApproved(resource, requirements, approvalId) {
  const id = await createDelegation({
    agentId: AGENT_ID,
    allowedResources: [resource],
    maxAmountPerTx: requirements.amount,
    maxAmountPerWindow: requirements.amount,
    windowSeconds: 60,
    allowedChains: [requirements.network],
    expiresAt: Math.floor(Date.now() / 1000) + 60,
    nonce: `approval-${approvalId}`,
  });
  try {
    return await signPayment(resource, requirements);
  } finally {
    await fetch(`${SERVICE_URL.aw}/delegations/${id}`, { method: "DELETE" });
  }
}

function deny(label, amount, reason, extra = {}) {
  ledger.agentEvents.push({ id: randomUUID(), kind: "denied", label, amount, reason, at: Date.now() });
  saveLedger();
  return { denied: true, amount, reason, ...extra };
}

// One paid call, the whole x402 round trip: 402 -> wallet signs -> retry with X-PAYMENT.
// Limits: going over the per-payment limit can be approved by the user, one payment at a time.
// The period limit is a hard cap: nothing (approved payments included) gets past it.
const agentPay = serialized(async ({ method, path: p, body, label }, approvalId = null) => {
  const unpaid = await callResource(method, p, body);
  if (unpaid.status !== 402) return { ok: unpaid.status < 300, status: unpaid.status, data: unpaid.data };
  const requirements = unpaid.data.requirements;
  const resource = SERVICE_URL.rs + p;

  const usage = windowUsage();
  if (settings.enabled && usage + BigInt(requirements.amount) > BigInt(settings.perWindow)) {
    return deny(label, requirements.amount, "amount exceeds maxAmountPerWindow", {
      window: { usage: usage.toString(), limit: settings.perWindow, seconds: settings.windowSeconds },
    });
  }

  let signed = approvalId ? await signApproved(resource, requirements, approvalId) : await signPayment(resource, requirements);
  if (!approvalId && signed.status === 403 && /maxAmountPerTx/.test(signed.data?.error) && settings.askOnExceed) {
    const id = randomUUID();
    pendingApprovals.set(id, { method, path: p, body, label, amount: requirements.amount });
    ledger.agentEvents.push({ id, kind: "pending", label, amount: requirements.amount, reason: signed.data.error, at: Date.now() });
    saveLedger();
    return { needsApproval: true, approvalId: id, amount: requirements.amount, reason: signed.data.error };
  }
  if (signed.status !== 200) return deny(label, requirements.amount, signed.data?.error);

  const { nonce } = signed.data.paymentPayload.payload.authorization;
  paymentMeta.set(nonce, { label, approved: !!approvalId });
  const paid = await callResource(method, p, body, signed.data.xPayment);
  if (paid.status !== 200) return { failed: true, status: paid.status, amount: requirements.amount, reason: paid.data?.error };
  justPaid.set(nonce, { amount: requirements.amount, at: Date.now() });
  return { ok: true, data: paid.data, payment: { nonce, amount: requirements.amount, label } };
});

async function resolveApproval(id, approve) {
  const pending = pendingApprovals.get(id);
  if (!pending) throw new Error("이미 처리된 승인 요청이에요");
  pendingApprovals.delete(id);
  ledger.agentEvents = ledger.agentEvents.filter((e) => e.id !== id);
  if (!approve) {
    ledger.agentEvents.push({ id, kind: "declined", label: pending.label, amount: pending.amount, at: Date.now() });
    saveLedger();
    return { declined: true };
  }
  saveLedger();
  return agentPay(pending, id);
}

// ------------------------------------------------------------------ page summaries

const startOfToday = () => new Date().setHours(0, 0, 0, 0);
const sum = (xs) => xs.reduce((s, x) => s + BigInt(x.amount), 0n).toString();

async function agentSummary() {
  const [demo, eth] = await Promise.all([tokenBalance(agentAddress), ethBalance(agentAddress)]);
  const mine = ledger.payments.filter((p) => p.payer?.toLowerCase() === agentAddress.toLowerCase());
  const history = [
    ...mine.map((p) => ({
      kind: "paid", label: paymentLabel(p), amount: p.amount, at: p.at, status: p.status,
      txHash: p.txHash, approved: p.approved, nonce: p.nonce,
    })),
    ...ledger.agentEvents.filter((e) => e.kind !== "denied" || Date.now() - e.at < 86400_000),
  ].sort((a, b) => b.at - a.at).slice(0, 30);
  return {
    address: agentAddress, demo, eth, explorer: EXPLORER, token,
    settings, policyActive: !!delegation,
    usage: windowUsage().toString(),
    topUpAvailable: !!ownerKey(),
    settlementEnabled: !!settlerAddress,
    history,
    payments: Object.fromEntries(mine.slice(-100).map((p) => [p.nonce, { status: p.status, txHash: p.txHash, reason: p.reason }])),
  };
}

async function sellerSummary() {
  const today = startOfToday();
  const sales = ledger.payments.filter((p) => productOf(p.path) && p.status !== "skipped");
  const todays = sales.filter((p) => p.at >= today);
  const blocked = ledger.blocked.filter((b) => !b.path || productOf(b.path));
  return {
    payTo, explorer: EXPLORER, token,
    balance: await tokenBalance(payTo),
    settlementEnabled: !!settlerAddress,
    today: {
      revenue: sum(todays),
      calls: todays.length,
      agents: new Set(todays.map((p) => p.payer?.toLowerCase())).size,
      blocked: blocked.filter((b) => b.at >= today).length,
    },
    products: PRODUCTS.map((x) => {
      const mineToday = todays.filter((p) => x.match.test(p.path));
      return { key: x.key, name: x.name, icon: x.icon, price: x.price, count: mineToday.length, revenue: sum(mineToday) };
    }),
    recent: sales.slice(-30).reverse().map((p) => ({
      nonce: p.nonce, label: paymentLabel(p), icon: productOf(p.path).icon, payer: p.payer,
      amount: p.amount, at: p.at, status: p.status, txHash: p.txHash, reason: p.reason,
    })),
    blocked: blocked.slice(-10).reverse(),
  };
}

// ------------------------------------------------------------------ http

const PAGES = {
  "/": "index.html",
  "/index.html": "index.html",
  "/agent": "agent.html",
  "/agent/wallet": "wallet.html",
  "/seller": "seller.html",
  "/app.css": "app.css",
};

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "content-type": type });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function proxy(req, res, service, rest) {
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
  const headers = {};
  if (body) headers["content-type"] = "application/json";
  if (req.headers["x-payment"]) headers["x-payment"] = req.headers["x-payment"];
  const upstream = await fetch(SERVICE_URL[service] + rest, { method: req.method, headers, body });
  res.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") ?? "application/json",
  });
  res.end(await upstream.text());
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${UI_PORT}`);
  try {
    const page = req.method === "GET" && PAGES[url.pathname.replace(/\/$/, "") || "/"];
    if (page) {
      const type = page.endsWith(".css") ? "text/css; charset=utf-8" : "text/html; charset=utf-8";
      return send(res, 200, readFileSync(path.join(HERE, page), "utf8"), type);
    }

    // Agent and seller pages
    if (req.method === "GET" && url.pathname === "/api/agent/summary") return send(res, 200, await agentSummary());
    if (req.method === "POST" && url.pathname === "/api/agent/pay") {
      const { method, path: p, body, label } = JSON.parse(await readBody(req));
      if (!/^\/securities\//.test(p ?? "")) return send(res, 400, { error: "only /securities/* is available here" });
      return send(res, 200, await agentPay({ method, path: p, body, label }));
    }
    if (req.method === "POST" && url.pathname === "/api/agent/approval") {
      const { id, approve } = JSON.parse(await readBody(req));
      return send(res, 200, await resolveApproval(id, !!approve));
    }
    if (req.method === "POST" && url.pathname === "/api/agent/settings") {
      await applySettings(JSON.parse(await readBody(req)));
      return send(res, 200, await agentSummary());
    }
    if (req.method === "GET" && url.pathname === "/api/seller/summary") return send(res, 200, await sellerSummary());

    // Developer page
    const proxied = url.pathname.match(/^\/api\/(rs|aw|fac)(\/.*)$/);
    if (proxied) return await proxy(req, res, proxied[1], proxied[2] + url.search);

    if (req.method === "GET" && url.pathname === "/api/state") return send(res, 200, await state());
    if (req.method === "GET" && url.pathname === "/api/logs") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      for (const event of logEvents) res.write(`data: ${JSON.stringify(event)}\n\n`);
      logClients.add(res);
      req.on("close", () => logClients.delete(res));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/delegation") {
      return send(res, 200, await setDelegation(JSON.parse(await readBody(req))));
    }
    if (req.method === "DELETE" && url.pathname === "/api/delegation") {
      await revokeDelegation();
      return send(res, 200, { revoked: true });
    }
    if (req.method === "POST" && url.pathname === "/api/topup") return send(res, 200, { txHash: topUp() });
    if (req.method === "GET" && url.pathname === "/api/settlement") {
      const { from, nonce, fromBlock } = Object.fromEntries(url.searchParams);
      return send(res, 200, await findSettlement(from, nonce, fromBlock));
    }
    send(res, 404, { error: "not found" });
  } catch (err) {
    send(res, 500, { error: err.message });
  }
});

// ------------------------------------------------------------------ main

async function main() {
  await assertPortsFree();
  token = await readToken(ASSET);
  setTokenSymbol(token.symbol, token.decimals);
  console.log(`Payment token: ${token.symbol} (${token.name}, EIP-712 version "${token.version}") ${ASSET}`);
  console.log("Starting Facilitator, Resource Server, Agent Wallet...");
  start("facilitator", "facilitator", {
    PORT: String(PORTS.facilitator),
    ETHEREUM_RPC_URL: RPC_URL,
    ETHEREUM_ASSET_ADDRESS: ASSET,
  });
  start("resourceServer", "resourceServer", {
    PORT: String(PORTS.resourceServer),
    FACILITATOR_URL: SERVICE_URL.fac,
    ASSET_ADDRESS: ASSET,
    TOKEN_NAME: token.name,
    TOKEN_VERSION: token.version,
  });
  start("agentWallet", "agentWallet", {
    PORT: String(PORTS.agentWallet),
    KEYSTORE_DIR: path.join(HERE, ".keystore"),
  });
  await waitHealthy();

  agentAddress = await ensureAgent();
  await probePrices();
  const unpaid = await fetch(`${SERVICE_URL.rs}/securities/quotes/005930`).then((r) => r.json());
  payTo = unpaid.requirements.payTo;
  await applySettings({});

  server.listen(UI_PORT, () => {
    console.log(`\n  Agent:     http://localhost:${UI_PORT}/agent`);
    console.log(`  Seller:    http://localhost:${UI_PORT}/seller`);
    console.log(`  Developer: http://localhost:${UI_PORT}/`);
    console.log(`\n  Agent wallet: ${agentAddress}`);
    console.log(`  Settler:      ${settlerAddress ?? "(FACILITATOR_PRIVATE_KEY not set: settlement disabled)"}`);
    console.log(`  Top-up key:   ${ownerKey() ? "set" : "(TOKEN_OWNER_PRIVATE_KEY not set: top-up disabled)"}`);
    console.log("\n  Ctrl+C stops everything.");
  });
}

main().catch((err) => {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
});
