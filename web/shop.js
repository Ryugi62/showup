// Page script for shop.html (external so the Content-Security-Policy can forbid inline scripts).
import { readShop, connect, signPass, claim, release, checkIn, txUrl, addrUrl, nowSec, registerShop, bookingsOfShop, currentAccount, hasWallet, deviceKey, createDeviceKey, setSigner, setPayout, setActive, transferShop } from "./chain.js";
import { CONFIG } from "./config.js";
import { formatUsdc, actionsFor, STATUS, escapeHtml, encodePass, parseUsdc, formatSlot, recordLabel, secondsLeft } from "./domain.js";
import { $, msg, fail, walletBanner } from "./ui.js";
const q = new URLSearchParams(location.search); $("shop").value = q.get("shop") || CONFIG.demoShopId || 1;
let shop, pass, timer, seq = 0;
const isOwner = () => shop && currentAccount() && shop.owner.toLowerCase() === currentAccount().toLowerCase();
const deviceIsSigner = () => { const d = shop && deviceKey(shop.id); return !!d && d.address.toLowerCase() === shop.signer.toLowerCase(); };
const walletIsSigner = () => shop && currentAccount() && shop.signer.toLowerCase() === currentAccount().toLowerCase();
const canCheckIn = () => deviceIsSigner() || walletIsSigner(); // a tablet with only the device key can still issue passes

async function render() {
  history.replaceState(null, "", `?shop=${encodeURIComponent($("shop").value)}`);
  const mySeq = ++seq;
  const s = await readShop($("shop").value);
  if (mySeq !== seq) return; // a newer shop number was typed meanwhile
  shop = s.exists ? s : null;
  if (!shop) { $("head").innerHTML = ""; $("list").textContent = "No shop with that number. Register one below."; return; }
  const link = new URL(`book.html?shop=${s.id}&owner=${s.owner}`, location.href).href;
  const nowRec = await nowSec();
  $("head").innerHTML = `<h2>${escapeHtml(s.name)} · deposit ${formatUsdc(s.deposit)} USDC${s.active ? "" : " · paused"}</h2>
    <p class="muted">Owner <a class="mono" href="${addrUrl(s.owner)}">${s.owner.slice(0, 10)}…</a> · ${s.booked} booked by ${s.uniqueCustomers} guests · ${s.checkedIn} checked in · ${s.cancelled} cancelled · ${s.released} refunded by you · ${s.claimed} no-shows claimed · ${recordLabel(s, nowRec)} (public)${deviceIsSigner() ? " · this device signs check-in passes" : ""}</p>
    <div class="card row"><div class="mono">${link}</div><div><button class="ghost" id="copy">Copy booking link</button></div></div>
    ${isOwner() || !hasWallet() ? "" : `<p><button id="conn">Connect the shop wallet to manage bookings</button></p>`}`;
  if (!hasWallet()) walletBanner($("nowallet"));
  $("copy").onclick = async () => { try { await navigator.clipboard.writeText(link); $("copy").textContent = "Copied"; } catch { prompt("Booking link", link); } };
  $("conn")?.addEventListener("click", async () => { try { await connect(); if (!isOwner()) msg("This wallet does not own this shop.", "err"); render(); } catch (e) { fail(e); } });
  renderSettings();
  const [list, now] = await Promise.all([bookingsOfShop(s.id), nowSec()]);
  if (mySeq !== seq) return;
  $("list").innerHTML = list.map((b) => {
    const a = actionsFor({ ...b, cancelWindow: s.cancelWindow, grace: s.grace }, now);
    const btns = `${a.checkIn && canCheckIn() ? `<button data-pass="${b.id}">Check-in QR</button>` : ""} ${isOwner() && a.claim ? `<button class="ghost" data-claim="${b.id}">Claim no-show</button>` : ""} ${isOwner() && a.release ? `<button class="ghost" data-rel="${b.id}">Refund (forgive)</button>` : ""}`;
    const due = STATUS[b.status] === "Held" && a.claim ? ` · claim by ${formatSlot(a.claimBy)}` : "";
    return `<div class="card row"><div><b>#${b.id}</b> · ${formatSlot(b.slotStart)}<div class="muted">${formatUsdc(b.amount)} USDC · <span class="mono">${b.customer.slice(0, 10)}…</span>${STATUS[b.status] === "Held" ? " · " + a.phase : ""}${due}</div></div><div><span class="pill ${STATUS[b.status]}">${STATUS[b.status]}</span> ${btns}</div></div>`;
  }).join("") || `No bookings yet. Share your booking link.`;
  document.querySelectorAll("[data-pass]").forEach((b) => b.onclick = () => showPass(b.dataset.pass).catch(fail));
  document.querySelectorAll("[data-claim]").forEach((b) => b.onclick = () => confirm(`Claim the deposit of booking #${b.dataset.claim} as a no-show? This can't be undone.`) && act(claim, b.dataset.claim, "Claimed"));
  document.querySelectorAll("[data-rel]").forEach((b) => b.onclick = () => confirm(`Refund booking #${b.dataset.rel} to the guest? This can't be undone.`) && act(release, b.dataset.rel, "Refunded"));
}
async function act(fn, id, word) {
  try { msg("Confirm in your wallet…"); const r = await fn(id); msg(`${word}. Confirmed in ${r.ms} ms · <a href="${txUrl(r.hash)}">tx</a>`, "ok"); await render(); }
  catch (e) { fail(e); }
}
function renderSettings() {
  $("settings").hidden = !isOwner();
  if (!isOwner()) return;
  const dev = deviceKey(shop.id);
  const usingDev = dev && dev.address.toLowerCase() === shop.signer.toLowerCase();
  $("signerInfo").innerHTML = `Current: <span class="mono">${shop.signer.slice(0, 10)}…</span> ${usingDev ? "(this device)" : shop.signer.toLowerCase() === shop.owner.toLowerCase() ? "(the owner wallet)" : ""}`;
  $("mkdev").hidden = !!usingDev;
  // the stored device key was lost (site data cleared) or belongs to another device: let the owner take signing back
  $("resetSigner").hidden = usingDev || shop.signer.toLowerCase() === shop.owner.toLowerCase();
  $("payout").value = shop.payout;
  $("toggleActive").textContent = shop.active ? "Pause new bookings" : "Resume bookings";
}
$("mkdev").onclick = async () => {
  try { const dev = deviceKey(shop.id) || createDeviceKey(shop.id); msg("Confirm the key change in your wallet…");
    const r = await setSigner(shop.id, dev.address); msg(`This device now signs check-in passes · <a href="${txUrl(r.hash)}">tx</a>`, "ok"); await render(); } catch (e) { fail(e); }
};
$("resetSigner").onclick = async () => {
  try { const r = await setSigner(shop.id, currentAccount()); msg(`This wallet signs check-in passes again · <a href="${txUrl(r.hash)}">tx</a>`, "ok"); await render(); } catch (e) { fail(e); }
};
$("savePayout").onclick = async () => {
  const to = $("payout").value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) { msg("Enter a full 0x… payout address.", "err"); return; }
  if (!confirm(`Send future no-show deposits to\n${to}?`)) return;
  try { const r = await setPayout(shop.id, to); msg(`Payout updated · <a href="${txUrl(r.hash)}">tx</a>`, "ok"); await render(); } catch (e) { fail(e); }
};
$("toggleActive").onclick = async () => { try { const r = await setActive(shop.id, !shop.active); msg(`${shop.active ? "Paused" : "Resumed"} · <a href="${txUrl(r.hash)}">tx</a>`, "ok"); await render(); } catch (e) { fail(e); } };
$("transfer").onclick = async () => {
  const to = $("newOwner").value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) { msg("Enter a full 0x… address.", "err"); return; }
  if (!confirm(`Transfer shop #${shop.id} to ${to}? Only the new owner can manage it afterwards.`)) return;
  try { const r = await transferShop(shop.id, to); msg(`Transferred · <a href="${txUrl(r.hash)}">tx</a>`, "ok"); await render(); } catch (e) { fail(e); }
};
async function showPass(id) {
  if (!canCheckIn()) { msg("Neither this device nor this wallet is the shop's current check-in key, so a pass would be rejected.", "err"); return; }
  const chainNow = Number(await nowSec());
  const skew = chainNow - Math.floor(Date.now() / 1000); // count down in chain time, not the device clock
  const validUntil = chainNow + 180; // short-lived: a forwarded photo of the QR goes stale fast
  msg("Signing the check-in pass (free, no transaction)…");
  const { sig } = await signPass(id, validUntil, shop);
  pass = { id, validUntil, sig };
  const link = encodePass({ contract: CONFIG.contract, bookingId: id, validUntil, sig }, new URL("checkin.html", location.href).href);
  const qr = qrcode(0, "M"); qr.addData(link); qr.make();
  $("qr").innerHTML = qr.createSvgTag({ cellSize: 5, margin: 2 });
  $("qrtitle").textContent = `Check-in pass · booking #${id}`;
  $("qrbox").hidden = false; msg("");
  clearInterval(timer);
  const tick = () => {
    const left = secondsLeft(validUntil, Math.floor(Date.now() / 1000), skew);
    $("qrnote").innerHTML = left > 0 ? `The guest scans this with their phone. Valid for ${left}s, only for booking #${id}. <a href="${link}">Open link</a>` : "Expired — tap New pass.";
    if (left <= 0) clearInterval(timer);
  };
  tick();
  timer = setInterval(tick, 1000);
}
$("qrclose").onclick = () => { $("qrbox").hidden = true; clearInterval(timer); };
$("qrrefresh").onclick = () => pass && showPass(pass.id).catch(fail);
$("tablet").onclick = async () => {
  if (!pass) return;
  try { msg("Submitting the check-in from this device (you pay the ~1¢ fee)…"); const r = await checkIn(pass.id, pass.validUntil, pass.sig);
    msg(`Checked in — deposit refunded to the guest in ${r.ms} ms · <a href="${txUrl(r.hash)}">tx</a>`, "ok"); $("qrbox").hidden = true; render(); }
  catch (e) { fail(e); }
};
$("shop").oninput = () => render().catch(fail);
$("shop").onchange = () => render().catch(fail);
$("reg").onclick = async () => {
  try {
    const cw = Number($("cw").value), gr = Number($("gr").value);
    if (!Number.isInteger(cw) || cw < 0 || cw > 43200) { msg("Cancel window must be 0–43200 minutes.", "err"); return; }
    if (!Number.isInteger(gr) || gr < 5 || gr > 1440) { msg("Grace must be 5–1440 minutes.", "err"); return; }
    const deposit = parseUsdc($("dep").value);
    if (deposit === 0n) { msg("Deposit must be above 0.", "err"); return; }
    const me = await connect();
    const r = await registerShop({ payout: me, signer: me, deposit, cancelWindow: cw * 60, grace: gr * 60, name: $("name").value.trim() || "My shop" });
    $("shop").value = r.shopId; msg(`Shop #${r.shopId} registered · <a href="${txUrl(r.hash)}">tx</a>`, "ok"); render();
  } catch (e) { fail(e); }
};
// If this wallet already authorised the page, reconnect silently so the owner sees their buttons after a reload.
(async () => {
  try { if (hasWallet() && (await window.ethereum.request({ method: "eth_accounts" })).length) await connect(); } catch {}
  await render();
})().catch(fail);
