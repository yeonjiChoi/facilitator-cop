import type { FastifyReply, FastifyRequest } from "fastify";
import {
  PaymentPayloadSchema,
  type PaymentPayload,
  type PaymentRequirements,
  type SettleResult,
  type VerifyResult,
} from "x402-contracts";
import { config } from "./config.js";

declare module "fastify" {
  interface FastifyRequest {
    paymentContext?: { payload: PaymentPayload; requirements: PaymentRequirements };
  }
}

// Payments already accepted by this server, keyed by payer + EIP-3009 nonce. Settlement is
// async and takes a block or more, so until it lands the on-chain nonce check in /verify
// can't stop the same X-PAYMENT header from being replayed for free content.
const acceptedPayments = new Set<string>();

function paymentKey(payload: PaymentPayload): string {
  const { from, nonce } = payload.payload.authorization;
  return `${from.toLowerCase()}:${nonce.toLowerCase()}`;
}

interface PaymentOptions {
  price: (req: FastifyRequest) => string;
}

export function requirePayment(opts: PaymentOptions) {
  return async function paymentPreHandler(req: FastifyRequest, reply: FastifyReply) {
    let amount: string;
    try {
      amount = opts.price(req);
    } catch (err) {
      return reply
        .code(400)
        .send({ error: err instanceof Error ? err.message : "invalid request" });
    }

    const requirements: PaymentRequirements = {
      scheme: "exact",
      network: config.network,
      amount,
      asset: config.assetAddress,
      payTo: config.payToAddress,
      maxTimeoutSeconds: 300,
      extra: { name: config.tokenName, version: config.tokenVersion },
    };

    const header = req.headers["x-payment"];
    if (!header || typeof header !== "string") {
      req.log.info(
        { event: "payment.required", method: req.method, path: req.url, amount, payTo: requirements.payTo },
        "payment required (402)",
      );
      return reply.code(402).send({ error: "payment required", requirements });
    }

    let payload: PaymentPayload;
    try {
      const decoded = Buffer.from(header, "base64").toString("utf8");
      payload = PaymentPayloadSchema.parse(JSON.parse(decoded));
    } catch {
      req.log.warn({ event: "payment.malformed", path: req.url }, "invalid X-PAYMENT header");
      return reply.code(402).send({ error: "invalid X-PAYMENT header", requirements });
    }

    const { from: payer, nonce } = payload.payload.authorization;
    req.log.info(
      { event: "payment.received", path: req.url, payer, amount: payload.payload.authorization.value, nonce },
      "X-PAYMENT received, verifying with facilitator",
    );

    // Claim before the async /verify call so two concurrent replays can't both pass.
    const key = paymentKey(payload);
    if (acceptedPayments.has(key)) {
      req.log.warn({ event: "payment.replay_blocked", payer, nonce }, "payment already used");
      return reply.code(402).send({ error: "payment already used", requirements });
    }
    acceptedPayments.add(key);

    let verifyRes: VerifyResult;
    try {
      verifyRes = (await fetch(`${config.facilitatorUrl}/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payload, requirements }),
      }).then((r) => r.json())) as VerifyResult;
    } catch (err) {
      acceptedPayments.delete(key);
      throw err;
    }

    if (!verifyRes.isValid) {
      acceptedPayments.delete(key);
      req.log.warn({ event: "payment.rejected", payer, reason: verifyRes.reason, nonce }, "payment rejected");
      return reply
        .code(402)
        .send({ error: verifyRes.reason ?? "payment invalid", requirements });
    }

    req.log.info({ event: "payment.verified", payer, amount, nonce }, "payment verified, serving resource");
    req.paymentContext = { payload, requirements };
  };
}

export async function settlePaymentOnResponse(req: FastifyRequest, reply: FastifyReply) {
  const ctx = req.paymentContext;
  if (!ctx) return;
  const { from: payer, nonce } = ctx.payload.payload.authorization;
  // Only charge for requests that were actually served.
  if (reply.statusCode >= 400) {
    req.log.info(
      { event: "payment.settle_skipped", statusCode: reply.statusCode, payer, nonce },
      "request failed, payment not settled",
    );
    return;
  }
  req.log.info(
    { event: "payment.settle_requested", statusCode: reply.statusCode, payer, nonce },
    "resource served, requesting settlement",
  );
  fetch(`${config.facilitatorUrl}/settle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(ctx),
  })
    .then((r) => r.json() as Promise<SettleResult>)
    .then((result) => {
      if (result.success) {
        req.log.info({ event: "payment.settled", txHash: result.txHash, network: result.network, payer, nonce }, "payment settled");
      } else {
        req.log.error({ event: "payment.settle_failed", reason: result.reason, txHash: result.txHash, payer, nonce }, "payment settlement failed");
      }
    })
    .catch((err) => req.log.error({ event: "payment.settle_failed", err, payer, nonce }, "settle call failed"));
}
