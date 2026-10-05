// Page script for book.html (external so the Content-Security-Policy can forbid inline scripts).
import { book, cancel, withdraw, reclaim, readShop, connect, txUrl, addrUrl, nowSec, bookingsOfCustomer, pub, hasWallet, estimateFee } from "./chain.js";
import { CONFIG } from "./config.js";
import { abi } from "./abi.js";
import { formatUsdc, actionsFor, STATUS, escapeHtml, formatSlot, recordLabel } from "./domain.js";
import { $, msg, fail, walletBanner } from "./ui.js";
const q = new URLSearchParams(location.search); $("shop").value = q.get("shop") || CONFIG.demoShopId || 1;
$("tz").textContent = "(" + Intl.DateTimeFormat().resolvedOptions().timeZone + ")";
walletBanner($("nowallet"));
let shop, me, seq = 0;
async function loadShop() {
  $("go").disabled = true; shop = null;
  const mySeq = ++seq;
  const s = await readShop($("shop").value);
  if (mySeq !== seq) return; // a newer shop number was typed meanwhile
  if (!s.exists) { $("title").textContent = "Book a slot"; $("terms").textContent = "No shop with that number."; return; }
  if (!s.active) { $("title").textContent = s.name; $("terms").textContent = "This shop is not taking bookings right now."; return; }
  const expectOwner = q.get("owner");
  if (expectOwner && expectOwner.toLowerCase() !== s.owner.toLowerCase() && String(s.id) === (q.get("shop") || "")) {
    $("title").textContent = s.name;
    $("terms").innerHTML = `<b class="danger">This shop's owner does NOT match the link you were given.</b> The link says <span class="mono">${escapeHtml(expectOwner)}</span>, but shop #${s.id} belongs to <span class="mono">${s.owner}</span>. Don't book — ask the shop for its link again.`;
    return;
  }
  shop = s;
  $("title").textContent = `Book at ${s.name}`;
  const cw = Number(s.cancelWindow) / 60, gr = Number(s.grace) / 60;
  const now0 = await nowSec();
  $("terms").innerHTML = `Deposit ${formatUsdc(s.deposit)} USDC. Free cancel ${cw ? `until ${cw} min before your time` : "until your time"}. Refunded the moment you check in. If you don't come, the shop can claim it ${gr} min after your time.<br><span class="muted">Shop record (on chain): owner <a class="mono" href="${addrUrl(s.owner)}">${s.owner.slice(0, 10)}…</a> · since ${new Date(Number(s.since) * 1000).toLocaleDateString()} · ${s.uniqueCustomers} guests · ${s.checkedIn} checked in · ${s.claimed} no-shows claimed · ${recordLabel(s, now0)}.${expectOwner ? " ✓ Owner matches your link." : " Open the shop's own link (it carries the owner address) to have it checked automatically."}</span>`;
  const d = new Date(Date.now() + (Number(s.cancelWindow) + 7200) * 1000); d.setMinutes(0, 0, 0); // ≥ 1 h after the cutoff
  $("slot").value = new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  $("go").disabled = !hasWallet();
}
$("shop").oninput = () => loadShop().catch(fail);
$("shop").onchange = () => loadShop().catch(fail);
$("go").onclick = async () => {
  try {
    if (!shop) return;
    const who = (me || (await connect())).toLowerCase(); me = who;
    if ([shop.owner, shop.payout, shop.signer].some((a) => a.toLowerCase() === who)) { msg("This wallet belongs to the shop (owner, payout or check-in key). Use a different wallet to book.", "err"); return; }
    const slot = Math.floor(new Date($("slot").value).getTime() / 1000);
    const now = Number(await nowSec()), lead = Math.max(Number(shop.cancelWindow), 60);
    if (!Number.isFinite(slot) || slot < now + lead) { msg(`Pick a time at least ${Math.ceil(lead / 60)} min from now.`, "err"); return; }
    $("go").disabled = true;
    const fee = await estimateFee("book", [shop.id, BigInt(slot)], shop.deposit);
    msg(`Confirm in your wallet… deposit ${formatUsdc(shop.deposit)} USDC${fee ? ` + network fee ≈ $${fee.usd.toFixed(4)}, also in USDC (no other token needed)` : ""}`);
    const r = await book(shop.id, slot, shop.deposit);
    const paid = Number(r.receipt.gasUsed * r.receipt.effectiveGasPrice) / 1e18;
    msg(`Booked for ${formatSlot(slot)}. Final in ${r.ms} ms, fee $${paid.toFixed(4)} · <a href="${txUrl(r.hash)}">view on explorer</a>`, "ok"); listMine().catch(fail);
  } catch (e) { fail(e); } finally { $("go").disabled = !shop || !hasWallet(); }
};
async function listMine() {
  me = me || await connect();
  const [mine, now, owedAmt] = await Promise.all([bookingsOfCustomer(me), nowSec(), pub.readContract({ address: CONFIG.contract, abi, functionName: "owed", args: [me] })]);
  const shops = {};
  const rows = [];
  for (const b of mine) {
    const s = shops[b.shopId] ||= await readShop(b.shopId);
    const a = actionsFor({ ...b, cancelWindow: s.cancelWindow, grace: s.grace }, now);
    rows.push(`<div class="card row"><div><b>#${b.id}</b> · ${escapeHtml(s.name)}<div class="muted">${formatSlot(b.slotStart)} · ${formatUsdc(b.amount)} USDC</div></div><div><span class="pill ${STATUS[b.status]}">${STATUS[b.status]}</span> ${a.cancel ? `<button class="ghost" data-c="${b.id}">Cancel (full refund)</button>` : ""} ${a.reclaim ? `<button class="ghost" data-r="${b.id}">Take it back (shop never settled)</button>` : ""}</div></div>`);
  }
  $("mine").innerHTML = (owedAmt > 0n ? `<div class="card row"><div>${formatUsdc(owedAmt)} USDC is waiting for you (a payout your wallet could not receive automatically).</div><button id="wd">Withdraw</button></div>` : "") + (rows.join("") || "No bookings from this wallet yet.");
  document.querySelectorAll("[data-c]").forEach((btn) => btn.onclick = async () => {
    try { btn.disabled = true; const r = await cancel(btn.dataset.c); msg(`Cancelled and refunded in ${r.ms} ms · <a href="${txUrl(r.hash)}">tx</a>`, "ok"); listMine().catch(fail); } catch (e) { fail(e); btn.disabled = false; }
  });
  document.querySelectorAll("[data-r]").forEach((btn) => btn.onclick = async () => {
    try { btn.disabled = true; const r = await reclaim(btn.dataset.r); msg(`Deposit taken back · <a href="${txUrl(r.hash)}">tx</a>`, "ok"); listMine().catch(fail); } catch (e) { fail(e); btn.disabled = false; }
  });
  $("wd")?.addEventListener("click", async () => { try { const r = await withdraw(); msg(`Withdrawn · <a href="${txUrl(r.hash)}">tx</a>`, "ok"); listMine().catch(fail); } catch (e) { fail(e); } });
}
$("conn").onclick = () => listMine().catch(fail);
loadShop().catch(fail);
