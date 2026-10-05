// Small DOM helpers shared by the pages (no chain access here).
import { walletDeepLink, friendlyError } from "./domain.js";
import { hasWallet } from "./chain.js";

export const $ = (id) => document.getElementById(id);

export function msg(text, cls = "") {
  const el = $("msg");
  el.className = cls;
  el.innerHTML = text;
}
export const fail = (e) => msg(friendlyError(e), "err");

/** When the page is opened in a normal browser (camera scan), explain how to continue. */
export function walletBanner(el) {
  if (hasWallet()) return false;
  const here = location.href;
  el.hidden = false;
  el.innerHTML = `<b>Open this page in your wallet app to continue.</b>
    <p class="muted">Your phone opened it in a normal browser, which can't sign. In MetaMask, Rabby or Coinbase Wallet, open the in-app browser and paste the link.</p>
    <p><a class="btn" href="${walletDeepLink(here)}">Open in MetaMask</a> <button class="ghost" id="copylink">Copy link</button></p>`;
  el.querySelector("#copylink").onclick = async () => {
    try { await navigator.clipboard.writeText(here); el.querySelector("#copylink").textContent = "Copied"; } catch { prompt("Copy this link", here); }
  };
  return true;
}
