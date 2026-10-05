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
export function actionsFor({ status, slotStart, cancelWindow, grace }, nowSec) {
  const s = Number(status), start = Number(slotStart), now = Number(nowSec);
  if (STATUS[s] !== "Held") return { cancel: false, checkIn: false, claim: false, release: false, phase: STATUS[s] || "None" };
  const cancelUntil = start - Number(cancelWindow);
  const claimFrom = start + Number(grace);
  return {
    cancel: now < cancelUntil,
    checkIn: now < claimFrom,
    claim: now >= claimFrom,
    release: true,
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
