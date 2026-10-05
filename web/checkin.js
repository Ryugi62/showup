// Page script for checkin.html (external so the Content-Security-Policy can forbid inline scripts).
import { readBooking, readShop, checkIn, txUrl, nowSec, hasWallet } from "./chain.js";
import { decodePass, formatUsdc, STATUS, secondsLeft } from "./domain.js";
import { CONFIG } from "./config.js";
import { $, msg, fail, walletBanner } from "./ui.js";
const p = decodePass(location.hash);
(async () => {
  if (!p) { $("info").textContent = "This link has no valid pass. Ask the shop to show the QR again."; return; }
  if (p.contract.toLowerCase() !== CONFIG.contract.toLowerCase()) { $("info").textContent = "This pass is for a different ShowUp contract."; return; }
  const [b, now] = await Promise.all([readBooking(p.bookingId), nowSec()]);
  const s = await readShop(b.shopId);
  const left = Number(p.validUntil) - Number(now);
  const closesAt = Number(b.slotStart) + Number(s.grace);
  $("h").textContent = `Check in at ${s.name}`;
  let why = "";
  if (b.status === 0) why = "No such booking.";
  else if (STATUS[b.status] !== "Held") why = `This booking is already ${STATUS[b.status].toLowerCase()}.`;
  else if (left <= 0) why = "This pass expired. Ask the shop for a new QR.";
  else if (Number(now) >= closesAt) why = "Check-in for this booking has closed (the grace period passed).";
  const base = `Booking #${b.id} · deposit ${formatUsdc(b.amount)} USDC · `;
  $("info").textContent = base + (why || `pass valid ${left}s more`);
  if (why) return;
  const skew = Number(now) - Math.floor(Date.now() / 1000);
  const tick = setInterval(() => {
    const l = secondsLeft(p.validUntil, Math.floor(Date.now() / 1000), skew);
    if (l > 0) { $("info").textContent = base + `pass valid ${l}s more`; return; }
    clearInterval(tick); $("go").disabled = true; $("info").textContent = base + "this pass expired — ask the shop for a new QR.";
  }, 1000);
  if (walletBanner($("nowallet"))) return;
  $("go").disabled = false;
  $("go").onclick = async () => {
    try { $("go").disabled = true; msg("Confirm in your wallet…"); const r = await checkIn(p.bookingId, p.validUntil, p.sig);
      clearInterval(tick); $("info").textContent = base + "refunded.";
      const paid = Number(r.receipt.gasUsed * r.receipt.effectiveGasPrice) / 1e18;
      msg(`Refunded. Final in ${r.ms} ms, network fee $${paid.toFixed(4)} · <a href="${txUrl(r.hash)}">view on explorer</a>`, "ok"); }
    catch (e) { fail(e); $("go").disabled = false; }
  };
})().catch((e) => { $("info").textContent = "Could not read the chain: " + e.message; });
