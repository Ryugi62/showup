import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CONFIG } from "../web/config.js";

const pages = ["index", "book", "shop", "checkin"];
test("every page ships a strict CSP whose connect-src is exactly self + the configured Arc RPC", () => {
  for (const p of pages) {
    const html = readFileSync(`web/${p}.html`, "utf8");
    const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1];
    assert.ok(csp, `${p}.html has no CSP`);
    assert.match(csp, /script-src 'self';/);
    const connect = /connect-src ([^;]+);/.exec(csp)[1].trim().split(/\s+/);
    assert.deepEqual(connect, ["'self'", new URL(CONFIG.rpc).origin], `${p}.html connect-src`);
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), `${p}.html has an inline script`);
    assert.ok(!/ style="/.test(html), `${p}.html has an inline style`);
  }
});
