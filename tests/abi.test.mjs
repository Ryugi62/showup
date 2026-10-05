import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { abi } from "../web/abi.js";

test("web/abi.js matches the compiled contract (run `npm run abi` after changing the contract)", { skip: !existsSync("out/ShowUp.sol/ShowUp.json") }, () => {
  const compiled = JSON.parse(readFileSync("out/ShowUp.sol/ShowUp.json")).abi;
  assert.deepEqual(abi, compiled);
});

test("ABI exposes the custom errors the UI translates", async () => {
  const { ERROR_TEXT } = await import("../web/domain.js");
  const errors = abi.filter((x) => x.type === "error").map((x) => x.name);
  for (const e of errors) assert.ok(ERROR_TEXT[e], `no friendly text for ${e}`);
});
