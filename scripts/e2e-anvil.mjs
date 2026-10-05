// Local end-to-end check: spawns Anvil (chain id 5042, like Arc mainnet), runs the full flow.
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { runFlow } from "./flow.mjs";
import { parseEther } from "viem";

const PORT = 8547;
const rpc = `http://127.0.0.1:${PORT}`;
const anvilBin = process.env.ANVIL || `${homedir()}/.foundry/bin/anvil`;

async function rpcCall(method, params = []) {
  const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return (await r.json()).result;
}

async function main() {
  const anvil = spawn(anvilBin, ["--port", String(PORT), "--chain-id", "5042", "--silent"], { stdio: "ignore" });
  try {
    for (let i = 0; i < 50; i++) {
      try { if (await rpcCall("eth_chainId")) break; } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    // Anvil default dev keys #0 and #1
    const ownerPk = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
    const customerPk = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
    const out = await runFlow({
      chainId: 5042, rpc, ownerPk, customerPk, deposit: parseEther("0.1"), slotDelaySec: 75,
      warp: async (s) => { await rpcCall("evm_increaseTime", [s + 5]); await rpcCall("evm_mine"); },
    });
    console.log("E2E OK", JSON.stringify({ address: out.address, steps: out.receipts.length }));
  } finally {
    anvil.kill();
  }
}

main().catch((e) => { console.error("E2E FAIL", e.message); process.exit(1); });
