// Deploy ShowUp to Arc mainnet and run the real demo flow (one refund by check-in, one no-show claim).
// Usage: node scripts/deploy-mainnet.mjs <path/to/deployer.env>
//   deployer.env holds ARC_DEPLOYER_PK (and optionally ARC_CUSTOMER_PK); it is never committed.
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, parseEther, formatEther } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { runFlow, chainFor, saveRun } from "./flow.mjs";

const RPC = process.env.ARC_RPC || "https://rpc.mainnet.arc.io";
const CHAIN_ID = 5042;
const envPath = process.argv[2];
if (!envPath) { console.error("usage: node scripts/deploy-mainnet.mjs <deployer.env>"); process.exit(2); }
const env = Object.fromEntries(readFileSync(envPath, "utf8").split("\n").filter(Boolean).map((l) => l.split("=")));
const ownerPk = env.ARC_DEPLOYER_PK;
let customerPk = env.ARC_CUSTOMER_PK;
if (!customerPk) { customerPk = generatePrivateKey(); appendFileSync(envPath, `ARC_CUSTOMER_PK=${customerPk}\n`); }

const chain = chainFor(CHAIN_ID, RPC);
const pub = createPublicClient({ chain, transport: http(RPC), pollingInterval: 200 });
const owner = privateKeyToAccount(ownerPk);
const customer = privateKeyToAccount(customerPk);
const deposit = parseEther(process.env.DEMO_DEPOSIT || "0.1");

const id = await pub.getChainId();
if (id !== CHAIN_ID) throw new Error(`RPC chain id ${id} != ${CHAIN_ID}`);
const bal = await pub.getBalance({ address: owner.address });
console.log(`deployer ${owner.address} balance ${formatEther(bal)} USDC`);
const need = deposit * 2n + parseEther("0.3");
if (bal < need) {
  console.error(`NEED_FUNDS: send at least ${formatEther(need)} USDC on Arc mainnet to ${owner.address}`);
  process.exit(3);
}
const cBal = await pub.getBalance({ address: customer.address });
if (cBal < deposit * 2n + parseEther("0.05")) {
  const w = createWalletClient({ account: owner, chain, transport: http(RPC) });
  const hash = await w.sendTransaction({ to: customer.address, value: deposit * 2n + parseEther("0.1") });
  await pub.waitForTransactionReceipt({ hash });
  console.log(`funded demo customer ${customer.address}  ${hash}`);
}

const out = await runFlow({ chainId: CHAIN_ID, rpc: RPC, ownerPk, customerPk, deposit, existing: process.env.SHOWUP_ADDRESS, slotDelaySec: 75 });
const run = { network: "arc-mainnet", chainId: CHAIN_ID, at: new Date().toISOString(), owner: owner.address, customer: customer.address, ...out };
saveRun(new URL("../runs/mainnet.json", import.meta.url), run);

const cfgPath = new URL("../web/config.js", import.meta.url);
const cfg = readFileSync(cfgPath, "utf8").replace(/contract: "[^"]*"/, `contract: "${out.address}"`).replace(/demoShopId: \d+/, `demoShopId: ${out.shopId}`);
writeFileSync(cfgPath, cfg);
console.log(`MAINNET OK ${out.address}`);
