// The only module that talks to the RPC or the wallet. viem is vendored (web/vendor/viem.js) — no CDN code.
import { createPublicClient, createWalletClient, custom, http, defineChain, decodeEventLog, privateKeyToAccount, generatePrivateKey } from "./vendor/viem.js";
import { CONFIG } from "./config.js";
import { abi } from "./abi.js";
import { passTypedData, feeUsd } from "./domain.js";

export { abi };
export const arc = defineChain({
  id: CONFIG.chainId,
  name: CONFIG.chainName,
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [CONFIG.rpc] } },
  blockExplorers: { default: { name: "Arcscan", url: CONFIG.explorer } },
});

export const pub = createPublicClient({ chain: arc, transport: http(CONFIG.rpc), pollingInterval: 250 });
const address = () => CONFIG.contract;
export const deployed = () => /^0x[0-9a-fA-F]{40}$/.test(CONFIG.contract);
export const txUrl = (h) => `${CONFIG.explorer}/tx/${h}`;
export const addrUrl = (a) => `${CONFIG.explorer}/address/${a}`;
export const hasWallet = () => typeof window !== "undefined" && !!window.ethereum;
const read = (functionName, args = []) => pub.readContract({ address: address(), abi, functionName, args });
const ZERO = "0x0000000000000000000000000000000000000000";

export async function readShop(id) {
  const [owner, payout, signer, deposit, cancelWindow, grace, active, name] = await read("shops", [BigInt(id)]);
  const [booked, checkedIn, cancelled, released, reclaimed, claimed, uniqueCustomers, since] = await read("shopStats", [BigInt(id)]);
  return { id: BigInt(id), exists: owner !== ZERO, owner, payout, signer, deposit, cancelWindow, grace, active, name,
    booked, checkedIn, cancelled, released, reclaimed, claimed, uniqueCustomers, since };
}

export async function readBooking(id) {
  const [shopId, customer, slotStart, amount, status] = await read("bookings", [BigInt(id)]);
  return { id: BigInt(id), shopId, customer, slotStart, amount, status: Number(status) };
}

/** Newest-first list of booking ids from the on-chain index (no log scanning). */
async function latest(fn, key, limit) {
  const total = fn === "bookingsOfShop" ? (await readShop(key)).booked : null;
  let ids;
  if (total !== null) {
    const off = total > BigInt(limit) ? total - BigInt(limit) : 0n;
    ids = await read(fn, [key, off, BigInt(limit)]);
  } else {
    // customer index: page through (customers rarely have many bookings)
    ids = [];
    for (let off = 0n; ; off += 50n) {
      const page = await read(fn, [key, off, 50n]);
      ids.push(...page);
      if (page.length < 50) break;
    }
    ids = ids.slice(-limit);
  }
  return [...ids].reverse();
}

export async function bookingsOfShop(shopId, limit = 30) {
  return Promise.all((await latest("bookingsOfShop", BigInt(shopId), limit)).map(readBooking));
}
export async function bookingsOfCustomer(customer, limit = 20) {
  return Promise.all((await latest("bookingsOfCustomer", customer, limit)).map(readBooking));
}

export async function overview(limit = 20) {
  const [shopCount, bookingCount, totalHeld] = await Promise.all(["shopCount", "bookingCount", "totalHeld"].map((f) => read(f)));
  const ids = [];
  for (let i = bookingCount; i >= 1n && ids.length < limit; i--) ids.push(i);
  const bookings = await Promise.all(ids.map(readBooking));
  const shopIds = new Set(bookings.map((b) => b.shopId.toString()));
  for (let i = shopCount; i >= 1n && shopIds.size < 12; i--) shopIds.add(i.toString()); // newest shops first
  const shops = Object.fromEntries(await Promise.all([...shopIds].map(async (s) => [s, await readShop(s)])));
  return { shopCount, bookingCount, totalHeld, bookings, shops };
}

/** Chain time — passes and windows are judged by block time, not the phone's clock. */
export async function nowSec() {
  return (await pub.getBlock()).timestamp;
}

let wallet, account;
export async function connect() {
  if (!hasWallet()) throw new Error("No browser wallet found. Open this page inside your wallet app (MetaMask, Rabby, Coinbase Wallet).");
  [account] = await window.ethereum.request({ method: "eth_requestAccounts" });
  const hex = "0x" + CONFIG.chainId.toString(16);
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (e) {
    const code = e?.code ?? e?.data?.originalError?.code;
    if (code !== 4902 && code !== -32603) throw e;
    await window.ethereum.request({ method: "wallet_addEthereumChain", params: [{
      chainId: hex, chainName: CONFIG.chainName, rpcUrls: [CONFIG.rpc],
      nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, blockExplorerUrls: [CONFIG.explorer] }] });
  }
  if (!connect.listening) {
    connect.listening = true;
    window.ethereum.on?.("accountsChanged", () => location.reload());
    window.ethereum.on?.("chainChanged", () => location.reload());
  }
  wallet = createWalletClient({ account, chain: arc, transport: custom(window.ethereum) });
  return account;
}
export const currentAccount = () => account;

async function write(functionName, args, value) {
  if (!wallet) await connect();
  // Simulate first: a revert surfaces as a decoded custom error (friendly text) before any wallet prompt.
  const { request } = await pub.simulateContract({ address: address(), abi, functionName, args, value, account });
  const hash = await wallet.writeContract(request);
  const t0 = performance.now(); // after the wallet prompt: measures network confirmation only
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("Transaction reverted");
  return { hash, ms: Math.round(performance.now() - t0), receipt };
}

/** Exact network fee in dollars before pressing a button: Arc gas is USDC, so gas × gasPrice needs no oracle. */
export async function estimateFee(functionName, args, value) {
  if (!account) return null;
  try {
    const [gas, price] = await Promise.all([
      pub.estimateContractGas({ address: address(), abi, functionName, args, value, account }),
      pub.getGasPrice(),
    ]);
    return { gas, usd: feeUsd(gas, price) };
  } catch { return null; }
}

export const book = (shopId, slotStart, value) => write("book", [BigInt(shopId), BigInt(slotStart)], value);
export const cancel = (id) => write("cancel", [BigInt(id)]);
export const checkIn = (id, validUntil, sig) => write("checkIn", [BigInt(id), BigInt(validUntil), sig]);
export const claim = (id) => write("claim", [BigInt(id)]);
export const release = (id) => write("release", [BigInt(id)]);
export const withdraw = () => write("withdraw", []);
export const reclaim = (id) => write("reclaim", [BigInt(id)]);
export const setSigner = (shopId, a) => write("setSigner", [BigInt(shopId), a]);
export const setPayout = (shopId, a) => write("setPayout", [BigInt(shopId), a]);
export const setActive = (shopId, on) => write("setActive", [BigInt(shopId), !!on]);
export const transferShop = (shopId, a) => write("transferShop", [BigInt(shopId), a]);
export async function registerShop(a) {
  const r = await write("registerShop", [a.payout, a.signer, a.deposit, BigInt(a.cancelWindow), BigInt(a.grace), a.name]);
  for (const log of r.receipt.logs) {
    try {
      const ev = decodeEventLog({ abi, data: log.data, topics: log.topics });
      if (ev.eventName === "ShopRegistered") return { ...r, shopId: ev.args.shopId };
    } catch {}
  }
  throw new Error("Registered, but the ShopRegistered event was not found in the receipt");
}

// ---- device check-in key: a separate key kept on the shop's tablet, so the owner key can live elsewhere ----
const keyName = (shopId) => `showup.checkin.${CONFIG.chainId}.${address().toLowerCase()}.${shopId}`;
export function deviceKey(shopId) {
  try { const pk = localStorage.getItem(keyName(shopId)); return pk ? privateKeyToAccount(pk) : null; } catch { return null; }
}
export function createDeviceKey(shopId) {
  const pk = generatePrivateKey();
  localStorage.setItem(keyName(shopId), pk);
  return privateKeyToAccount(pk);
}

/** Sign with the device key if it is the shop's current signer; otherwise with the connected wallet. */
export async function signPass(bookingId, validUntil, shop) {
  const td = passTypedData({ chainId: CONFIG.chainId, contract: address(), bookingId, validUntil });
  const dev = shop ? deviceKey(shop.id) : null;
  if (dev && shop.signer.toLowerCase() === dev.address.toLowerCase()) return { sig: await dev.signTypedData(td), by: "device" };
  if (!wallet) await connect();
  return { sig: await wallet.signTypedData(td), by: "wallet" };
}
