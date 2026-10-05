// Page script for index.html (external so the Content-Security-Policy can forbid inline scripts).
import { CONFIG } from "./config.js";
import { overview, deployed, addrUrl, nowSec } from "./chain.js";
import { formatUsdc, STATUS, actionsFor, escapeHtml as esc, formatSlot, recordLabel } from "./domain.js";
const el = document.getElementById("live");
async function render() {
  if (!deployed()) { el.textContent = "Contract address not configured yet."; return; }
  const [o, now] = await Promise.all([overview(), nowSec()]);
  const shops = Object.values(o.shops).filter((s) => s.exists).map((s) => {
    return `<div class="card row"><div><b>${esc(s.name)}</b> <span class="muted">#${s.id} · owner <a class="mono" href="${addrUrl(s.owner)}">${s.owner.slice(0, 8)}…</a></span><div class="muted">deposit ${formatUsdc(s.deposit)} USDC · since ${new Date(Number(s.since) * 1000).toLocaleDateString()} · ${s.booked} booked by ${s.uniqueCustomers} guests · ${s.checkedIn} checked in · ${s.claimed} no-shows claimed · ${recordLabel(s, now)}</div></div><a class="btn" href="book.html?shop=${s.id}&owner=${s.owner}">Book</a></div>`;
  }).join("");
  const rows = o.bookings.map((b) => {
    const s = o.shops[b.shopId.toString()];
    const a = actionsFor({ ...b, cancelWindow: s.cancelWindow, grace: s.grace }, now);
    return `<div class="card row"><div><b>#${b.id}</b> · ${esc(s.name)}<div class="muted">${formatSlot(b.slotStart)} · ${formatUsdc(b.amount)} USDC · <span class="mono">${b.customer.slice(0, 8)}…</span></div></div><span class="pill ${STATUS[b.status]}">${STATUS[b.status]}${STATUS[b.status] === "Held" ? " · " + a.phase : ""}</span></div>`;
  }).join("");
  el.innerHTML = `<div class="grid3"><div class="card"><div class="muted">Shops</div><div class="stat">${o.shopCount}</div></div><div class="card"><div class="muted">Bookings</div><div class="stat">${o.bookingCount}</div></div><div class="card"><div class="muted">Deposits held now</div><div class="stat">${formatUsdc(o.totalHeld)} USDC</div></div></div>
  <p class="muted">Contract <a class="mono" href="${addrUrl(CONFIG.contract)}">${CONFIG.contract}</a> on Arc (chain ${CONFIG.chainId})</p>
  <h3>Shops</h3>${shops || '<p class="muted">No shops yet.</p>'}<h3>Latest bookings</h3>${rows || '<p class="muted">No bookings yet.</p>'}`;
}
render().catch((e) => { el.textContent = "Could not read the chain: " + e.message; });
