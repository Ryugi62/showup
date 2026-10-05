// The only module that talks to the RPC or the wallet.
import {
  createPublicClient, createWalletClient, custom, http, defineChain, parseAbi,
} from "https://esm.sh/viem@2.57.3";
import { CONFIG } from "./config.js";
import { passTypedData } from "./domain.js";

export const arc = defineChain({
  id: CONFIG.chainId,
  name: CONFIG.chainName,
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [CONFIG.rpc] } },
  blockExplorers: { default: { name: "Arcscan", url: CONFIG.explorer } },
});

export const abi = parseAbi([
  "function shops(uint256) view returns (address owner, address payout, address signer, uint256 deposit, uint64 cancelWindow, uint64 grace, bool active, string name)",
  "function bookings(uint256) view returns (uint256 shopId, address customer, uint64 slotStart, uint256 amount, uint8 status)",
  "function shopCount() view returns (uint256)",
  "function bookingCount() view returns (uint256)",
  "function totalHeld() view returns (uint256)",
  "function registerShop(address payout, address signer, uint256 deposit, uint64 cancelWindow, uint64 grace, string name) returns (uint256)",
  "function book(uint256 shopId, uint64 slotStart) payable returns (uint256)",
  "function cancel(uint256 bookingId)",
  "function checkIn(uint256 bookingId, uint64 validUntil, bytes pass)",
  "function release(uint256 bookingId)",
  "function claim(uint256 bookingId)",
]);

export const pub = createPublicClient({ chain: arc, transport: http(CONFIG.rpc), pollingInterval: 250 });
const address = () => CONFIG.contract;
export const deployed = () => /^0x[0-9a-fA-F]{40}$/.test(CONFIG.contract);
export const txUrl = (h) => `${CONFIG.explorer}/tx/${h}`;
export const addrUrl = (a) => `${CONFIG.explorer}/address/${a}`;

export async function readShop(id) {
  const [owner, payout, signer, deposit, cancelWindow, grace, active, name] =
    await pub.readContract({ address: address(), abi, functionName: "shops", args: [BigInt(id)] });
  return { id: BigInt(id), owner, payout, signer, deposit, cancelWindow, grace, active, name };
}

export async function readBooking(id) {
  const [shopId, customer, slotStart, amount, status] =
    await pub.readContract({ address: address(), abi, functionName: "bookings", args: [BigInt(id)] });
  return { id: BigInt(id), shopId, customer, slotStart, amount, status };
}

export async function overview(limit = 40) {
  const [shopCount, bookingCount, totalHeld] = await Promise.all(
    ["shopCount", "bookingCount", "totalHeld"].map((f) => pub.readContract({ address: address(), abi, functionName: f })));
  const ids = [];
  for (let i = bookingCount; i >= 1n && ids.length < limit; i--) ids.push(i);
  const bookings = await Promise.all(ids.map(readBooking));
  const shopIds = [...new Set(bookings.map((b) => b.shopId.toString()))];
  const shops = Object.fromEntries(await Promise.all(shopIds.map(async (s) => [s, await readShop(s)])));
  return { shopCount, bookingCount, totalHeld, bookings, shops };
}

export async function nowSec() {
  const b = await pub.getBlock();
  return b.timestamp;
}

let wallet;
export async function connect() {
  if (!window.ethereum) throw new Error("No browser wallet found. Install MetaMask or Rabby, then reload.");
  const [account] = await window.ethereum.request({ method: "eth_requestAccounts" });
  const hex = "0x" + CONFIG.chainId.toString(16);
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (e) {
    if (e.code !== 4902) throw e;
    await window.ethereum.request({ method: "wallet_addEthereumChain", params: [{
      chainId: hex, chainName: CONFIG.chainName, rpcUrls: [CONFIG.rpc],
      nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, blockExplorerUrls: [CONFIG.explorer] }] });
  }
  wallet = createWalletClient({ account, chain: arc, transport: custom(window.ethereum) });
  return account;
}

async function write(functionName, args, value) {
  if (!wallet) await connect();
  const t0 = performance.now();
  const hash = await wallet.writeContract({ address: address(), abi, functionName, args, value });
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error("Transaction reverted");
  return { hash, ms: Math.round(performance.now() - t0), receipt: rc };
}

export const book = (shopId, slotStart, value) => write("book", [BigInt(shopId), BigInt(slotStart)], value);
export const cancel = (id) => write("cancel", [BigInt(id)]);
export const checkIn = (id, validUntil, sig) => write("checkIn", [BigInt(id), BigInt(validUntil), sig]);
export const claim = (id) => write("claim", [BigInt(id)]);
export const release = (id) => write("release", [BigInt(id)]);
export const registerShop = (a) => write("registerShop", [a.payout, a.signer, a.deposit, BigInt(a.cancelWindow), BigInt(a.grace), a.name]);

export async function signPass(bookingId, validUntil) {
  if (!wallet) await connect();
  return wallet.signTypedData(passTypedData({ chainId: CONFIG.chainId, contract: address(), bookingId, validUntil }));
}
