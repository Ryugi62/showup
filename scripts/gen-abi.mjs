import { readFileSync, writeFileSync } from "node:fs";
const abi = JSON.parse(readFileSync("out/ShowUp.sol/ShowUp.json")).abi;
writeFileSync("web/abi.js", "// Generated from out/ShowUp.sol/ShowUp.json by `npm run abi` — checked by tests/abi.test.mjs.\nexport const abi = " + JSON.stringify(abi) + ";\n");
