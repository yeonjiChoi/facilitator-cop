import type { Network } from "x402-contracts";

export const config = {
  facilitatorUrl: process.env.FACILITATOR_URL ?? "http://localhost:4001",
  network: (process.env.NETWORK as Network) ?? "ethereum",
  assetAddress: process.env.ASSET_ADDRESS ?? "0x025311Ca250150E9c3684b614566c9f187a47e16",
  payToAddress: process.env.PAY_TO_ADDRESS ?? "0x0E79409e5f2b822d2046cC28E99FF6b411B3beBE",
  // EIP-712 domain of the token's transferWithAuthorization: must match the contract's own
  // name() and version() (DemoCoin: "DemoCoin"/"1", Circle USDC: "USDC"/"2").
  tokenName: process.env.TOKEN_NAME ?? "DemoCoin",
  tokenVersion: process.env.TOKEN_VERSION ?? "1",
};
