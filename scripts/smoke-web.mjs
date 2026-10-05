// Browser smoke test: Anvil (chain 5042) + real flow + the static pages in headless Chromium.
// Checks that the read-only page renders the on-chain state without a wallet.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, mkdtempSync, cpSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, extname } from "node:path";
import { chromium } from "playwright";
import { parseEther } from "viem";
import { runFlow } from "./flow.mjs";

const PORT = 8548, WEB = 8549, rpc = `http://127.0.0.1:${PORT}`;
const call = async (method, params = []) => (await (await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()).result;

const anvil = spawn(`${homedir()}/.foundry/bin/anvil`, ["--port", String(PORT), "--chain-id", "5042", "--silent"], { stdio: "ignore" });
let server, browser, failed = false; const steps = []; const pages = {};
try {
  for (let i = 0; i < 50; i++) { try { if (await call("eth_chainId")) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
  const out = await runFlow({
    chainId: 5042, rpc, deposit: parseEther("0.1"), slotDelaySec: 75, log: () => {},
    ownerPk: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    customerPk: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    warp: async (s) => { await call("evm_increaseTime", [s + 5]); await call("evm_mine"); },
  });
  const dir = mkdtempSync(join(tmpdir(), "showup-web-"));
  cpSync(new URL("../web", import.meta.url).pathname, dir, { recursive: true });
  writeFileSync(join(dir, "config.js"), `export const CONFIG = { chainId: 5042, chainName: "Arc (local)", rpc: "${rpc}", explorer: "https://explorer.arc.io", contract: "${out.address}", demoShopId: 1 };\n`);
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
  server = createServer((req, res) => {
    const p = join(dir, decodeURIComponent(new URL(req.url, "http://x").pathname.replace(/\/$/, "/index.html")));
    try { res.writeHead(200, { "content-type": types[extname(p)] || "text/plain" }); res.end(readFileSync(p)); } catch { res.writeHead(404); res.end(); }
  }).listen(WEB);
  browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const cspWatch = (pg, tag) => pg.on("console", (m) => { if (m.type() === "error" && /Content Security Policy|Refused to/.test(m.text())) errors.push(`${tag} CSP: ${m.text()}`); });
  cspWatch(page, "index");
  await page.goto(`http://127.0.0.1:${WEB}/index.html`);
  steps.push(37); await page.waitForSelector(".stat", { timeout: 20000 });
  const text = await page.textContent("#live");
  for (const want of ["Refunded", "Claimed", "ShowUp demo shop", out.address]) {
    if (!text.includes(want)) throw new Error(`index.html missing "${want}"`);
  }
  await page.goto(`http://127.0.0.1:${WEB}/checkin.html#p=garbage`);
  steps.push(43); await page.waitForFunction(() => !document.getElementById("info").textContent.includes("Reading"));
  if (!(await page.textContent("#info")).includes("no valid pass")) throw new Error("checkin.html did not reject a bad pass");
  await page.goto(`http://127.0.0.1:${WEB}/book.html?shop=1`);
  steps.push(46); await page.waitForFunction(() => document.getElementById("terms").textContent.includes("Deposit"));
  if (!(await page.textContent("#terms")).includes("0.1 USDC")) throw new Error("book.html terms wrong");
  await page.screenshot({ path: new URL("../docs/smoke-book.png", import.meta.url).pathname });
  await page.goto(`http://127.0.0.1:${WEB}/index.html`);
  steps.push(50); await page.waitForSelector(".stat");
  await page.screenshot({ path: new URL("../docs/smoke-index.png", import.meta.url).pathname, fullPage: true });
  // ---- full UI flow with an injected EIP-1193 wallet backed by Anvil's unlocked dev accounts ----
  const shim = (acct) => `window.ethereum = { request: async ({ method, params }) => {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return ["${acct}"];
      if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null;
      const r = await fetch("${rpc}", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      const j = await r.json(); if (j.error) { const e = new Error(j.error.message); e.code = j.error.code; e.data = j.error.data; throw e; } return j.result;
    }, on() {} };`;
  const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", GUEST = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
  const ctxOwner = await browser.newContext(); await ctxOwner.addInitScript(shim(OWNER));
  const ctxGuest = await browser.newContext(); await ctxGuest.addInitScript(shim(GUEST));
  const shopPage = await ctxOwner.newPage(); pages.shop = shopPage;
  shopPage.on("pageerror", (e) => errors.push("shop: " + e.message)); cspWatch(shopPage, "shop");
  shopPage.on("dialog", (d) => d.accept());
  await shopPage.goto(`http://127.0.0.1:${WEB}/shop.html`);
  await shopPage.fill("#name", "UI Test Bistro"); await shopPage.fill("#dep", "0.2"); await shopPage.fill("#cw", "0"); await shopPage.fill("#gr", "5");
  await shopPage.click("#reg");
  steps.push(68); await shopPage.waitForFunction(() => /Shop #\d+ registered/.test(document.getElementById("msg").textContent), null, { timeout: 20000 });
  const newShop = await shopPage.inputValue("#shop");
  // move pass signing to a separate key on this device (owner key stays off the counter)
  await shopPage.waitForSelector("#mkdev", { state: "visible", timeout: 20000 });
  await shopPage.click("#mkdev");
  await shopPage.waitForFunction(() => document.getElementById("msg").textContent.includes("This device now signs"), null, { timeout: 20000 });
  await shopPage.waitForFunction(() => document.getElementById("signerInfo").textContent.includes("(this device)"), null, { timeout: 20000 });
  const guestPage = await ctxGuest.newPage(); pages.guest = guestPage;
  const chainNow = async () => Number(BigInt((await call("eth_getBlockByNumber", ["latest", false])).timestamp));
  const setSlot = async (sec) => guestPage.evaluate((t) => { const d = new Date(t * 1000); document.getElementById("slot").value = new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }, sec);
  guestPage.on("pageerror", (e) => errors.push("guest: " + e.message)); cspWatch(guestPage, "guest");
  await guestPage.goto(`http://127.0.0.1:${WEB}/book.html?shop=${newShop}`);
  steps.push(73); await guestPage.waitForFunction(() => document.getElementById("terms").textContent.includes("0.2 USDC"));
  await setSlot((await chainNow()) + 3 * 3600);
  await guestPage.click("#go");
  steps.push(75); await guestPage.waitForFunction(() => document.getElementById("msg").textContent.includes("Booked"), null, { timeout: 20000 });
  steps.push(76); await shopPage.reload(); await shopPage.waitForSelector("[data-pass]", { timeout: 20000 });
  await shopPage.click("[data-pass]");
  steps.push(78); await shopPage.waitForSelector("#qr svg");
  const checkinLink = await shopPage.getAttribute("#qrnote a", "href", { timeout: 5000 }).catch(() => null);
  await shopPage.screenshot({ path: new URL("../docs/smoke-shop-qr.png", import.meta.url).pathname });
  // guest opens the QR link and checks in
  const linkNow = checkinLink || await shopPage.evaluate(() => document.querySelector("#qrnote a")?.href);
  await guestPage.goto(linkNow);
  steps.push(84); await guestPage.waitForFunction(() => !document.getElementById("go").disabled, null, { timeout: 20000 });
  await guestPage.click("#go");
  steps.push(86); await guestPage.waitForFunction(() => document.getElementById("msg").textContent.includes("Refunded"), null, { timeout: 20000 });
  await guestPage.screenshot({ path: new URL("../docs/smoke-checkin.png", import.meta.url).pathname });
  // tablet path: guest without a wallet — the shop's device submits the pass
  await guestPage.goto(`http://127.0.0.1:${WEB}/book.html?shop=${newShop}`);
  await guestPage.waitForFunction(() => document.getElementById("terms").textContent.includes("0.2 USDC"));
  await setSlot((await chainNow()) + 2 * 3600);
  await guestPage.click("#go");
  await guestPage.waitForFunction(() => document.getElementById("msg").textContent.includes("Booked"), null, { timeout: 20000 });
  await shopPage.goto(`http://127.0.0.1:${WEB}/shop.html?shop=${newShop}`); await shopPage.waitForSelector("[data-pass]", { timeout: 20000 });
  await shopPage.click("[data-pass]"); await shopPage.waitForSelector("#qr svg");
  // a guest whose phone opens the QR in a plain browser gets the wallet-app path, on a phone-sized screen
  const heldLink = await shopPage.evaluate(() => document.querySelector("#qrnote a")?.href);
  const phone = await (await browser.newContext({ viewport: { width: 375, height: 760 }, deviceScaleFactor: 2 })).newPage();
  phone.on("pageerror", (e) => errors.push("phone: " + e.message)); cspWatch(phone, "phone");
  await phone.goto(heldLink);
  await phone.waitForSelector("#nowallet:not([hidden])", { timeout: 20000 });
  if (!(await phone.textContent("#nowallet")).includes("Open in MetaMask")) throw new Error("wallet-less banner missing");
  if (!(await phone.isDisabled("#go"))) throw new Error("check-in button should stay disabled without a wallet");
  await phone.screenshot({ path: new URL("../docs/smoke-phone-nowallet.png", import.meta.url).pathname });
  await shopPage.click("#tablet");
  await shopPage.waitForFunction(() => document.getElementById("msg").textContent.includes("Checked in"), null, { timeout: 20000 });
  // second booking → no-show → owner claims after grace
  await guestPage.goto(`http://127.0.0.1:${WEB}/book.html?shop=${newShop}`);
  steps.push(90); await guestPage.waitForFunction(() => document.getElementById("terms").textContent.includes("0.2 USDC"));
  await setSlot((await chainNow()) + 5 * 60);
  await guestPage.click("#go");
  steps.push(93); await guestPage.waitForFunction(() => document.getElementById("msg").textContent.includes("Booked"), null, { timeout: 20000 });
  await call("evm_increaseTime", [20 * 60]); await call("evm_mine");
  steps.push(95); await shopPage.reload(); await shopPage.waitForSelector("[data-claim]", { timeout: 20000 });
  await shopPage.click("[data-claim]");
  steps.push(97); await shopPage.waitForFunction(() => document.getElementById("msg").textContent.includes("Claimed"), null, { timeout: 20000 });
  steps.push(98); await shopPage.reload(); await shopPage.waitForFunction(() => document.getElementById("head").textContent.includes("2 checked in") && document.getElementById("head").textContent.includes("1 no-shows claimed"), null, { timeout: 20000 });
  await shopPage.screenshot({ path: new URL("../docs/smoke-shop.png", import.meta.url).pathname, fullPage: true });
  // a plain browser (no wallet) on the check-in link gets the "open in wallet app" path, not a dead button
  const plain = await (await browser.newContext()).newPage();
  await plain.goto(`http://127.0.0.1:${WEB}/checkin.html#p=${out.address}.1.1.0x${"ab".repeat(65)}`);
  steps.push(103); await plain.waitForFunction(() => !document.getElementById("info").textContent.includes("Reading"));
  if (errors.length) throw new Error("page errors: " + errors.join(" | "));
  console.log("SMOKE OK", out.address);
} catch (e) {
  failed = true; console.error("SMOKE FAIL", e.message, "after step line", steps.at(-1));
  for (const [k, pg] of Object.entries(pages)) { try { console.error(k, "msg:", await pg.textContent("#msg"), "| url:", pg.url()); } catch {} }
} finally {
  await browser?.close(); server?.close(); anvil.kill();
  process.exit(failed ? 1 : 0);
}
