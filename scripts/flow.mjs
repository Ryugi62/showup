// End-to-end flow used by both the local Anvil check and the Arc mainnet demo.
// Every step reads the chain back and asserts — nothing is taken on faith.
import { readFileSync, writeFileSync } from "node:fs";
import {
  createPublicClient, createWalletClient, http, defineChain, hashTypedData, parseEther, formatEther,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { passTypedData, STATUS } from "../web/domain.js";

const artifact = JSON.parse(readFileSync(new URL("../out/ShowUp.sol/ShowUp.json", import.meta.url)));
export const abi = artifact.abi;
const bytecode = artifact.bytecode.object;

export function chainFor(id, rpc) {
  return defineChain({ id, name: `chain-${id}`, nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runFlow({ chainId, rpc, ownerPk, customerPk, deposit, log = console.log, existing, slotDelaySec = 75, warp }) {
  const chain = chainFor(chainId, rpc);
  const pub = createPublicClient({ chain, transport: http(rpc), pollingInterval: 200 });
  const owner = privateKeyToAccount(ownerPk);
  const customer = privateKeyToAccount(customerPk);
  const wOwner = createWalletClient({ account: owner, chain, transport: http(rpc) });
  const wCust = createWalletClient({ account: customer, chain, transport: http(rpc) });
  const receipts = [];
  const send = async (label, wallet, req) => {
    const t0 = Date.now();
    const hash = await wallet.writeContract({ address, abi, ...req });
    const rc = await pub.waitForTransactionReceipt({ hash });
    const ms = Date.now() - t0;
    if (rc.status !== "success") throw new Error(`${label} failed: ${hash}`);
    const feeWei = rc.gasUsed * rc.effectiveGasPrice;
    receipts.push({ label, hash, gasUsed: rc.gasUsed.toString(), feeUsdc: formatEther(feeWei), ms });
    log(`${label.padEnd(22)} ${hash}  gas ${rc.gasUsed}  fee ${formatEther(feeWei)} USDC  ${ms} ms`);
    return rc;
  };
  const read = (functionName, args = []) => pub.readContract({ address, abi, functionName, args });

  let address = existing;
  if (!address) {
    const t0 = Date.now();
    const hash = await wOwner.deployContract({ abi, bytecode });
    const rc = await pub.waitForTransactionReceipt({ hash });
    address = rc.contractAddress;
    const feeWei = rc.gasUsed * rc.effectiveGasPrice;
    receipts.push({ label: "deploy", hash, gasUsed: rc.gasUsed.toString(), feeUsdc: formatEther(feeWei), ms: Date.now() - t0 });
    log(`deploy                 ${hash}  -> ${address}  fee ${formatEther(feeWei)} USDC`);
  }

  // 1. shop: no cancel window and the minimum 5-minute grace, so the no-show path can be shown within minutes
  const GRACE = 300;
  await send("registerShop", wOwner, { functionName: "registerShop", args: [owner.address, owner.address, deposit, 0n, BigInt(GRACE), "ShowUp demo shop"] });
  const shopId = await read("shopCount");

  // 2. booking A → customer checks in with a pass signed by the shop → refund
  const now = BigInt(Math.floor(Date.now() / 1000));
  const slotA = now + 3600n;
  await send("book (A, show-up)", wCust, { functionName: "book", args: [shopId, slotA], value: deposit });
  const idA = await read("bookingCount");
  const validUntil = now + 900n;
  const td = passTypedData({ chainId, contract: address, bookingId: idA, validUntil });
  const onchainDigest = await read("passDigest", [idA, validUntil]);
  if (hashTypedData(td) !== onchainDigest) throw new Error("EIP-712 digest mismatch between web/domain.js and contract");
  log(`pass digest matches    ${onchainDigest}`);
  const sig = await wOwner.signTypedData(td);
  const before = await pub.getBalance({ address: customer.address });
  await send("checkIn (A)", wCust, { functionName: "checkIn", args: [idA, validUntil, sig] });
  if ((await read("statusOf", [idA])) !== 2) throw new Error("A not Refunded");

  // 3. booking B → nobody shows up → shop claims after slot + grace
  const slotB = BigInt(Math.floor(Date.now() / 1000)) + BigInt(slotDelaySec);
  await send("book (B, no-show)", wCust, { functionName: "book", args: [shopId, slotB], value: deposit });
  const idB = await read("bookingCount");
  const waitSec = slotDelaySec + GRACE + 5;
  if (warp) await warp(waitSec);
  else {
    log(`waiting ${waitSec}s for slot B + grace to pass…`);
    await sleep(waitSec * 1000);
  }
  await send("claim (B)", wOwner, { functionName: "claim", args: [idB] });
  if ((await read("statusOf", [idB])) !== 3) throw new Error("B not Claimed");

  const held = await read("totalHeld");
  const owedTotal = await read("totalOwed");
  const bal = await pub.getBalance({ address });
  if (bal < held + owedTotal) throw new Error("contract balance below held + owed");
  const [booked, refunded, claimed] = await read("shopStats", [shopId]);
  log(`statuses: A=${STATUS[2]} B=${STATUS[3]} · shop stats booked ${booked} refunded ${refunded} claimed ${claimed} · balance ${formatEther(bal)} ≥ held ${formatEther(held)} + owed ${formatEther(owedTotal)}`);
  return { address, shopId: shopId.toString(), bookingA: idA.toString(), bookingB: idB.toString(), receipts };
}

export function saveRun(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}
