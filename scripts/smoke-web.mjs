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
let server, browser, failed = false;
try {
  for (let i = 0; i < 50; i++) { try { if (await call("eth_chainId")) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
  const out = await runFlow({
    chainId: 5042, rpc, deposit: parseEther("0.1"), slotDelaySec: 120, log: () => {},
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
  await page.goto(`http://127.0.0.1:${WEB}/index.html`);
  await page.waitForSelector(".stat", { timeout: 20000 });
  const text = await page.textContent("#live");
  for (const want of ["Refunded", "Claimed", "ShowUp demo shop", out.address]) {
    if (!text.includes(want)) throw new Error(`index.html missing "${want}"`);
  }
  await page.goto(`http://127.0.0.1:${WEB}/checkin.html#p=garbage`);
  await page.waitForFunction(() => !document.getElementById("info").textContent.includes("Reading"));
  if (!(await page.textContent("#info")).includes("no valid pass")) throw new Error("checkin.html did not reject a bad pass");
  await page.goto(`http://127.0.0.1:${WEB}/book.html?shop=1`);
  await page.waitForFunction(() => document.getElementById("terms").textContent.includes("Deposit"));
  if (!(await page.textContent("#terms")).includes("0.1 USDC")) throw new Error("book.html terms wrong");
  await page.screenshot({ path: new URL("../docs/smoke-book.png", import.meta.url).pathname });
  await page.goto(`http://127.0.0.1:${WEB}/index.html`);
  await page.waitForSelector(".stat");
  await page.screenshot({ path: new URL("../docs/smoke-index.png", import.meta.url).pathname, fullPage: true });
  if (errors.length) throw new Error("page errors: " + errors.join(" | "));
  console.log("SMOKE OK", out.address);
} catch (e) {
  failed = true; console.error("SMOKE FAIL", e.message);
} finally {
  await browser?.close(); server?.close(); anvil.kill();
  process.exit(failed ? 1 : 0);
}
