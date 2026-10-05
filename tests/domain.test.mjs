import { test } from "node:test";
import assert from "node:assert/strict";
import { formatUsdc, parseUsdc, encodePass, decodePass, actionsFor, passTypedData } from "../web/domain.js";

test("formatUsdc trims and keeps up to 4 decimals", () => {
  assert.equal(formatUsdc(5n * 10n ** 18n), "5");
  assert.equal(formatUsdc(1250000000000000000n), "1.25");
  assert.equal(formatUsdc(24000000000000000n), "0.024");
  assert.equal(formatUsdc(1n), "0");
});

test("parseUsdc round-trips and rejects junk", () => {
  assert.equal(parseUsdc("0.25"), 250000000000000000n);
  assert.equal(formatUsdc(parseUsdc("12.5")), "12.5");
  assert.throws(() => parseUsdc("-1"));
  assert.throws(() => parseUsdc("1.2.3"));
  assert.throws(() => parseUsdc("abc"));
});

const sig = "0x" + "ab".repeat(65);
const contract = "0x" + "12".repeat(20);

test("pass link encodes and decodes", () => {
  const link = encodePass({ contract, bookingId: 7n, validUntil: 1800000600n, sig }, "https://x/checkin.html");
  const p = decodePass(new URL(link).hash);
  assert.deepEqual(p, { contract, bookingId: 7n, validUntil: 1800000600n, sig });
  assert.equal(decodePass("#p=garbage"), null);
  assert.throws(() => encodePass({ contract: "0x1", bookingId: 1, validUntil: 1, sig }));
});

test("actionsFor mirrors contract windows", () => {
  const b = { status: 1, slotStart: 10_000, cancelWindow: 3600, grace: 900 };
  assert.deepEqual(actionsFor(b, 6_399), { cancel: true, checkIn: true, claim: false, release: true, phase: "free-cancel" });
  assert.equal(actionsFor(b, 6_400).cancel, false);
  assert.equal(actionsFor(b, 10_899).checkIn, true);
  assert.equal(actionsFor(b, 10_900).checkIn, false);
  assert.equal(actionsFor(b, 10_900).claim, true);
  assert.equal(actionsFor({ ...b, status: 2 }, 0).phase, "Refunded");
});

test("passTypedData matches the contract's EIP-712 domain and type", () => {
  const td = passTypedData({ chainId: 5042, contract, bookingId: 3, validUntil: 99 });
  assert.equal(td.domain.name, "ShowUp");
  assert.equal(td.domain.version, "1");
  assert.equal(td.domain.chainId, 5042);
  assert.deepEqual(td.types.CheckInPass.map((f) => f.type), ["uint256", "uint64"]);
});

import { escapeHtml } from "../web/domain.js";
test("escapeHtml neutralises on-chain shop names", () => {
  assert.equal(escapeHtml(`<img src=x onerror="alert(1)">`), "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  assert.equal(escapeHtml("Cafe 'Lumia' & Co"), "Cafe &#39;Lumia&#39; &amp; Co");
});
