// Turns the services' structured (pino JSON) log entries into one-line, human-readable demo
// log events, shared by the terminal output and the page's log panel.

export const SERVICES = {
  resourceServer: { label: "Resource Server", ansi: 36 },
  agentWallet: { label: "Agent Wallet", ansi: 35 },
  facilitator: { label: "Facilitator", ansi: 33 },
};

let DECIMALS = 6n;
let SYMBOL = "DEMO";
// Set once at startup from the payment token's contract.
export function setTokenSymbol(symbol, decimals) {
  SYMBOL = symbol;
  DECIMALS = BigInt(decimals);
}
function demo(raw) {
  if (raw == null) return "?";
  const v = BigInt(raw);
  const unit = 10n ** DECIMALS;
  const frac = (v % unit).toString().padStart(Number(DECIMALS), "0").replace(/0+$/, "");
  return (v / unit).toString() + (frac ? "." + frac : "");
}
const short = (hex) => (hex ? `${hex.slice(0, 6)}…${hex.slice(-4)}` : "?");
const pathOf = (url) => {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
};

// event -> [level, text]. Levels: info | ok | warn | error ("ok" marks the milestones).
const EVENTS = {
  // Resource Server
  "payment.required": (e) => ["info", `402 결제 요구 · ${e.method} ${e.path} · ${demo(e.amount)} ${SYMBOL}`],
  "payment.malformed": () => ["warn", "X-PAYMENT 헤더 형식 오류 → 402"],
  "payment.received": (e) => ["info", `X-PAYMENT 수신 · ${demo(e.amount)} ${SYMBOL} (payer ${short(e.payer)})`],
  "payment.replay_blocked": () => ["warn", "이미 사용된 결제 → 402 차단"],
  "payment.rejected": (e) => ["warn", `결제 거부 → 402 · ${e.reason}`],
  "payment.verified": () => ["ok", "검증 통과 → API 응답 제공"],
  "payment.settle_skipped": (e) => ["info", `응답 실패(HTTP ${e.statusCode}) → 정산하지 않음`],
  "payment.settle_requested": (e) => ["info", `HTTP ${e.statusCode} 응답 완료 → Facilitator에 정산 요청 (비동기)`],
  "payment.settled": (e) => ["ok", `정산 완료 확인 · tx ${short(e.txHash)}`],
  "payment.settle_failed": (e) => ["error", `정산 실패 · ${e.reason ?? e.err?.message ?? "unknown"}`],

  // Agent Wallet
  "wallet.created": (e) => ["info", `에이전트 지갑 생성 · ${short(e.address)} (Key Custody: ${e.provider})`],
  "delegation.created": (e) => ["info",
    `위임 정책 발급 · 건당 ${demo(e.maxAmountPerTx)} / ${e.windowSeconds}초 누적 ${demo(e.maxAmountPerWindow)} ${SYMBOL} · ${e.allowedResources.map(pathOf).join(", ")}`],
  "delegation.revoked": (e) => ["info", `위임 정책 철회 · ${e.delegationId.slice(0, 8)}`],
  "sign.requested": (e) => ["info", `결제 서명 요청 · ${demo(e.amount)} ${SYMBOL} · ${pathOf(e.resource)}`],
  "policy.denied": (e) => ["warn", `[Permission Delegation] 거부 · ${e.reason}`],
  "policy.approved": (e) => ["ok",
    `[Permission Delegation] 승인 · 건당 한도 ${demo(e.maxAmountPerTx)}, 누적 ${demo(e.spentInWindow)} + ${demo(e.amount)} / ${demo(e.maxAmountPerWindow)} ${SYMBOL}`],
  "approval.issued": (e) => ["info", `[Permission Delegation] 승인 토큰(JWT, ${e.ttlSeconds}초) 발급 → Key Custody`],
  "custody.signed": (e) => ["ok", `[Key Custody] 토큰 검증 후 EIP-3009 서명 · signer ${short(e.signer)}`],
  "custody.failed": (e) => ["error", `[Key Custody] 서명 거부 · ${e.reason}`],

  // Facilitator
  "verify.passed": (e) => ["ok", `검증 통과 · 서명·금액·수신자·잔액·nonce 확인 · ${demo(e.amount)} ${SYMBOL}`],
  "verify.failed": (e) => ["warn", `검증 실패 · ${e.reason}`],
  "settle.requested": (e) => ["info", `정산 요청 수신 · ${demo(e.amount)} ${SYMBOL}`],
  "settle.duplicate": () => ["warn", "이미 제출된 결제 → 중복 정산 생략"],
  "settle.submitted": (e) => ["info", `transferWithAuthorization 전송 · tx ${short(e.txHash)} (가스: Facilitator ${short(e.settler)})`],
  "settle.confirmed": (e) => ["ok",
    `블록 #${e.blockNumber} 확정 · ${demo(e.amount)} ${SYMBOL} → ${short(e.to)} · ${Number(e.gasUsed).toLocaleString()} gas`],
  "settle.reverted": (e) => ["error", `정산 트랜잭션 revert · tx ${short(e.txHash)}`],
  "settle.failed": (e) => ["error", `정산 실패 · ${e.reason}`],
};

const PINO_FIELDS = new Set(["level", "time", "pid", "hostname", "reqId", "msg", "event"]);

/**
 * Creates a formatter for one service. Returns null for entries not worth showing (Fastify's
 * per-request lines, duplicate startup lines).
 */
export function createFormatter(service) {
  const urlByReqId = new Map();
  let announcedListening = false;

  return function format(entry) {
    const base = {
      service,
      time: entry.time ?? Date.now(),
      pay: entry.nonce ? entry.nonce.slice(2, 8) : null,
      tx: entry.txHash ?? null,
      details: Object.fromEntries(Object.entries(entry).filter(([k]) => !PINO_FIELDS.has(k))),
    };

    const handler = entry.event && EVENTS[entry.event];
    if (handler) {
      const [level, text] = handler(entry);
      return { ...base, event: entry.event, level, text };
    }

    // Fastify request logging: the events above tell the story, so only surface server errors.
    if (entry.msg === "incoming request") {
      urlByReqId.set(entry.reqId, `${entry.req?.method} ${entry.req?.url}`);
      return null;
    }
    if (entry.msg === "request completed") {
      const url = urlByReqId.get(entry.reqId);
      urlByReqId.delete(entry.reqId);
      if ((entry.res?.statusCode ?? 0) < 500) return null;
      return { ...base, level: "error", text: `HTTP ${entry.res.statusCode} · ${url ?? ""}` };
    }

    if (entry.msg?.startsWith("Server listening at")) {
      if (announcedListening) return null;
      announcedListening = true;
      return { ...base, level: "info", text: `서버 시작 · ${entry.msg.replace("Server listening at ", "")}` };
    }
    if (entry.msg === "settlement enabled") {
      return { ...base, level: "info", text: `정산 활성화 · settler ${short(entry.settler)}` };
    }

    const level = entry.level >= 50 ? "error" : entry.level >= 40 ? "warn" : "info";
    if (level === "info" && !entry.msg) return null;
    const errText = entry.err?.message ? ` · ${entry.err.message}` : "";
    return { ...base, level, text: `${entry.msg ?? ""}${errText}` };
  };
}

// ------------------------------------------------------------------ terminal

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const PAY_COLORS = [32, 34, 36, 35, 33, 92, 94, 96, 95, 93];
const LEVEL_COLOR = { ok: 32, warn: 33, error: 31 };

export function toTerminalLine(e) {
  const t = new Date(e.time);
  const time = `${t.toTimeString().slice(0, 8)}.${String(t.getMilliseconds()).padStart(3, "0")}`;
  const svc = SERVICES[e.service];
  const label = paint(`1;${svc.ansi}`, svc.label.padEnd(15));
  const mark = { ok: "✔", warn: "!", error: "✖", info: "·" }[e.level];
  const text = LEVEL_COLOR[e.level] ? paint(LEVEL_COLOR[e.level], `${mark} ${e.text}`) : `${mark} ${e.text}`;
  const pay = e.pay ? " " + paint(PAY_COLORS[parseInt(e.pay, 16) % PAY_COLORS.length], `#${e.pay}`) : "";
  return `${paint(2, time)}  ${label} ${text}${pay}`;
}
