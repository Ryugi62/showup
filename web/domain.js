// Pure helpers — no network, no wallet, no DOM. Unit-tested in tests/domain.test.mjs.

export const STATUS = ["None", "Held", "Refunded", "Claimed"];

/** 18-decimal native USDC (Arc) → "1.25" style string, trimmed. */
export function formatUsdc(wei, maxDecimals = 4) {
  const v = BigInt(wei);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = a / 10n ** 18n;
  let frac = (a % 10n ** 18n).toString().padStart(18, "0").slice(0, maxDecimals).replace(/0+$/, "");
  return (neg ? "-" : "") + whole.toString() + (frac ? "." + frac : "");
}

/** "1.25" → 1250000000000000000n. Rejects more than 18 decimals and junk. */
export function parseUsdc(text) {
  const t = String(text).trim();
  if (!/^\d+(\.\d{1,18})?$/.test(t)) throw new Error("Enter an amount like 5 or 0.25");
  const [w, f = ""] = t.split(".");
  return BigInt(w) * 10n ** 18n + BigInt(f.padEnd(18, "0"));
}

/** Check-in link: <base>#p=<contract>.<bookingId>.<validUntil>.<sig> */
export function encodePass({ contract, bookingId, validUntil, sig }, base = "") {
  if (!/^0x[0-9a-fA-F]{40}$/.test(contract)) throw new Error("bad contract");
  if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) throw new Error("bad signature");
  return `${base}#p=${contract}.${BigInt(bookingId)}.${BigInt(validUntil)}.${sig}`;
}

export function decodePass(hash) {
  const m = /p=(0x[0-9a-fA-F]{40})\.(\d+)\.(\d+)\.(0x[0-9a-fA-F]{130})$/.exec(hash || "");
  if (!m) return null;
  return { contract: m[1], bookingId: BigInt(m[2]), validUntil: BigInt(m[3]), sig: m[4] };
}

/**
 * What can happen to a booking right now, from the chain state alone.
 * Mirrors the contract's rules so the UI never offers a button that will revert.
 */
export const RECLAIM_AFTER = 30 * 24 * 3600;

export function actionsFor({ status, slotStart, cancelWindow, grace }, nowSec) {
  const s = Number(status), start = Number(slotStart), now = Number(nowSec);
  const claimFrom = start + Number(grace);
  const reclaimFrom = claimFrom + RECLAIM_AFTER; // the shop must claim before this, or the guest can take it back
  if (STATUS[s] !== "Held") return { cancel: false, checkIn: false, claim: false, release: false, reclaim: false, phase: STATUS[s] || "None", claimBy: reclaimFrom };
  const cancelUntil = start - Number(cancelWindow);
  return {
    cancel: now < cancelUntil,
    checkIn: now < claimFrom,
    claim: now >= claimFrom,
    release: true,
    reclaim: now >= reclaimFrom,
    claimBy: reclaimFrom,
    phase: now < cancelUntil ? "free-cancel" : now < claimFrom ? "check-in" : "no-show",
  };
}

/** EIP-712 typed data for a check-in pass (signed by the shop's check-in key). */
export function passTypedData({ chainId, contract, bookingId, validUntil }) {
  return {
    domain: { name: "ShowUp", version: "1", chainId: Number(chainId), verifyingContract: contract },
    types: { CheckInPass: [{ name: "bookingId", type: "uint256" }, { name: "validUntil", type: "uint64" }] },
    primaryType: "CheckInPass",
    message: { bookingId: BigInt(bookingId), validUntil: BigInt(validUntil) },
  };
}

/** Shop names come from chain and are attacker-controlled: always escape before innerHTML. */
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** Contract custom errors → one sentence a shop owner or guest understands. */
export const ERROR_TEXT = {
  BadConfig: "Check the shop settings: deposit above 0, valid addresses, name up to 64 characters.",
  ShopInactive: "This shop is not taking bookings right now.",
  WrongDeposit: "The deposit amount does not match the shop's deposit.",
  SlotTooSoon: "That time is inside the shop's free-cancel window or in the past. Pick a later time.",
  SlotTooFar: "Bookings can be at most a year ahead.",
  NotAllowed: "This wallet is not allowed to do that (a shop can't book itself; only the guest or the shop owner can act on a booking).",
  NotHeld: "This booking is already settled (refunded or claimed).",
  TooLateToCancel: "The free-cancel window has closed for this booking.",
  TooLate: "Check-in closed: the grace period after the slot has passed.",
  TooEarly: "Too early: the shop can claim only after the slot plus the grace period.",
  BadPass: "This check-in pass was not signed by the shop's current check-in key, or is for another booking.",
  PassExpired: "This check-in pass expired. Ask the shop to show a fresh QR.",
  NothingOwed: "Nothing to withdraw for this wallet.",
  Reentered: "Another ShowUp action was still running in this transaction. Try again.",
};

export function friendlyError(e) {
  const name = e?.data?.errorName || e?.cause?.data?.errorName || /reverted with the following reason:\s*\n?\s*(\w+)/.exec(e?.message || "")?.[1]
    || Object.keys(ERROR_TEXT).find((k) => (e?.shortMessage || e?.message || "").includes(k));
  if (name && ERROR_TEXT[name]) return ERROR_TEXT[name];
  if (e?.code === 4001 || /User rejected|denied/i.test(e?.message || "")) return "You cancelled the request in your wallet.";
  return e?.shortMessage || e?.message || String(e);
}

/** A link that opens the same page inside the MetaMask mobile in-app browser. */
export function walletDeepLink(href) {
  const u = new URL(href);
  return `https://metamask.app.link/dapp/${u.host}${u.pathname}${u.search}${u.hash}`;
}

/** Slot time with the viewer's time zone spelled out, so nobody books the wrong hour. */
export function formatSlot(sec, locale = undefined, timeZone = undefined) {
  return new Date(Number(sec) * 1000).toLocaleString(locale, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short", timeZone });
}

/** Public reputation from on-chain counters: of guests who reached the slot, the share the shop claimed as
 *  no-shows. Cancellations and shop refunds are excluded so they can't dilute it. A soft signal, not proof. */
export function claimRate(checkedIn, claimed) {
  const r = Number(checkedIn), c = Number(claimed);
  return r + c === 0 ? null : Math.round((c / (r + c)) * 100);
}

/** Countdown helper that uses chain time: skew = chainNow − deviceNow at the moment we read the chain. */
export function secondsLeft(validUntil, deviceNowSec, skew) {
  return Number(validUntil) - (Number(deviceNowSec) + Number(skew));
}
