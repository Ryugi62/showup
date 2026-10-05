# ShowUp — refundable booking deposits on Arc

[![tests](https://github.com/Ryugi62/showup/actions/workflows/pages.yml/badge.svg)](https://github.com/Ryugi62/showup/actions/workflows/pages.yml) — CI runs the Foundry suite, the Node tests and a reproducible-vendor check on every push, then deploys the pages.

**A small USDC deposit that a guest gets back the moment they check in, and that a shop can claim only after a no-show.** It sits next to whatever booking system a shop already uses. Built for [Arc](https://arc.io) mainnet, where gas is paid in USDC and finality is sub-second.

**Try it (no wallet needed to look):** https://ryugi62.github.io/showup/ · **Code:** this repo · **Builder:** [github.com/Ryugi62](https://github.com/Ryugi62)

## Arc mainnet
<!-- MAINNET:START -->
_Filled in by `scripts/deploy-mainnet.mjs` with the contract address, each demo transaction, its gas, fee in USDC and send→final time._
<!-- MAINNET:END -->

## The problem
Restaurants, clinics and salons hold slots for people who don't come. A deposit would fix it, but a card deposit doesn't pay for itself. On $5, a typical online card rate of 2.9% + 30¢ ([Stripe pricing](https://stripe.com/pricing)) takes about 45¢, or 9%. When the guest does show up, a card refund takes 5–10 business days to reach them ([Stripe refunds FAQ](https://support.stripe.com/questions/refunds-faq)). So most small shops take no deposit at all.

## How it works
```
guest                                ShowUp contract (Arc)                          shop
book(shop, slot) + 5 USDC ──────►    Held ── free cancel until slot − cutoff ──►  (guest refunded)
                                       │
arrives, scans the shop's QR           │  EIP-712 pass (bookingId, validUntil), valid 3 min
checkIn(id, validUntil, sig) ───►      Refunded → 5 USDC back to the guest in the same tx
  (or the shop's tablet submits it — the guest needs no gas)
                                       │
never comes                            │  only after slot + grace (≥ 5 min), and within 30 days
                                       └► Claimed → 5 USDC to the shop's payout ◄──── claim(id)
                                          (not claimed by then → the guest can reclaim it)
```

## Why Arc
- **One balance pays for everything.** On Arc, USDC is the gas, so the deposit and the fee come out of the same dollar balance. A guest needs no second token to book, and a shop needs no ETH to run.
- **About a cent per action, priced in dollars, shown before you press.** Gas is USDC, so a fee in dollars is just gas × gas price, with no price oracle. Every booking shows its exact network fee in dollars before the wallet opens and the fee actually paid afterwards. That makes a $5 deposit worth protecting. The fee for every demo action is in the table above.
- **Deterministic, sub-second finality** ([Arc docs](https://docs.arc.io)). A block is final when it is committed, so a refund at the door is final in one block. The guest can walk to the table, and the shop never waits for "confirmations". The measured send→final time for each real mainnet action is in the table above.
- Deposits are plain `msg.value` in Arc's native USDC (18 decimals), so booking is one transaction with no token approval.

## Trust model and guarantees
- **No admin key, no upgrade path.** The deployer cannot move a deposit.
- **The shop attests attendance** by signing the guest's pass. A shop could withhold the pass and claim anyway. So each shop's record is public and kept on chain in `shopStats`: when it registered, how many different guests booked, and how many bookings were checked in, cancelled, refunded by the shop, reclaimed or claimed. The pages show the claim rate before anyone books: claimed ÷ (checked in + claimed), so cancellations can't dilute it. A percentage is shown only after 10 settled bookings from at least 10 different guests and 30 days of history. Before that, the page says "new shop — not enough history". A shop can't book its own slots (owner, payout and signer are refused). Even so, the rate is a soft signal, not proof, since someone can still book from other wallets. The pages also show the owner address, so a guest can tell a real shop from a copy with the same name.
- **Terms are fixed at registration.** Deposit, free-cancel window and grace can't change under an existing booking. Grace is 5 minutes to 1 day, the cancel window is at most 30 days, and a slot must start between one minute and one year after booking, so "only after slot + grace" always means something.
- **Passes.** A pass is bound to one booking, this contract and this chain (EIP-712 domain), and to an expiry; the pages issue 3-minute passes that count down in chain time. A pass works once, and high-`s` (malleable) signatures are rejected. The signer can be a plain key or an EIP-7702 delegated account, which is verified by `ecrecover` first. It can also be a smart-contract wallet via EIP-1271, which gets a 150k gas cap and at most 32 bytes of return data. A pass is a bearer token for its 3 minutes, but the refund always goes to the wallet that booked.
- **Keys.** The owner can move pass signing to a separate check-in key kept on the shop's tablet ("Use a key on this device"). That key signs passes without a wallet prompt. A tablet holding only that key, with no wallet app at all, can issue passes. With about $1 of USDC for fees, it can also submit check-ins itself. Keep that key under $5, since it lives in the browser; one click sweeps it to the payout address. It can only authorize check-ins, which refund the guest who booked; it can never claim, pause, change settings or withdraw. The key is stored in the tablet's browser storage. If site data is cleared, the owner presses "Reset check-in key to this wallet" or creates a new one. At worst, a stolen key can authorize check-ins (refunds to the real guests) until the owner rotates it. Owners can also change the payout address, pause bookings or transfer the shop.
- **Claim deadline and escape hatch.** A shop must claim a no-show within 30 days after slot + grace. After that, `claim` reverts with `ClaimWindowClosed`, and the guest can `reclaim` the still-held deposit. The guest can do the same if the shop vanished.
- **Payouts can't get stuck.** A payout is pushed with a gas cap. If the transfer fails (for example, a recipient contract that reverts or needs more gas), the amount is parked as a withdrawable credit (`owed`, `withdraw`), and the booking still settles.
- **Guest-side checks.** The shop's booking link carries its owner address. If the shop number and the owner don't match, `book.html` stops and warns, and the guest must confirm to continue (a shop transfer also triggers it). This catches altered or mistyped links. It doesn't catch a copycat shop handing out its own link, which is why the owner address and the shop's age and record are shown too.
- **Accounting.** The contract balance always equals deposits held plus credits owed, plus anything force-sent to it. Foundry invariants check this over random sequences of book, cancel, check-in, release, claim, reclaim, force-send, withdraw and time travel (256 runs × depth 100). One of the random customers is a contract that refuses pushed refunds, so the `owed`/`withdraw` path is exercised too. The shop counters always match the per-state counts.

## Verify it in two minutes
1. Open https://ryugi62.github.io/showup/. It shows the live shops, their claim rates and the latest bookings, read straight from chain.
2. Follow the contract link to the Arc explorer. The demo booking that was refunded at check-in and the one claimed as a no-show are linked in the table above.
3. Run it locally:
```bash
npm install
forge test                     # 44 unit/fuzz tests + 3 invariants
node --test tests/*.test.mjs   # web domain helpers, ABI sync, CSP of every page
npm run e2e                    # Anvil (chain id 5042): deploy, book, check in, no-show, claim
node scripts/smoke-web.mjs     # the real pages in headless Chromium with an injected wallet:
                               # register shop → device check-in key → book → QR → guest check-in →
                               # wallet-less phone path → tablet check-in → wallet-free counter tablet
                               # (device key only) → altered-link warning → no-show claim → public record
```

## Pages
- `index.html` — read-only view: shops with their public record, the latest bookings.
- `book.html?shop=N` — the guest books with a browser wallet (adds the Arc network if missing), sees their bookings, cancels while it's free, withdraws any parked payout.
- `shop.html?shop=N` — anyone can view it. The owner's wallet can show a check-in QR (signed in the wallet, no transaction), check a guest in from the shop's device, claim no-shows (with a confirmation step) or refund. It also has the shareable booking link and a form to register a shop.
- `checkin.html#p=…` — what the guest's phone opens from the QR. Opened in a plain browser, it points to the wallet app and doesn't show a dead button.

Every page sends a strict Content-Security-Policy (`script-src 'self'`, no inline scripts or styles, network access limited to the Arc RPC). No third-party scripts are loaded at runtime. viem and the QR encoder are vendored into `web/vendor/` (`npm run vendor`), their SHA-256 is recorded in `web/vendor/SHA256SUMS`, and CI rebuilds them and checks the hashes (`npm run vendor:check`). Every write is simulated first, so a would-be revert shows up as a plain sentence before the wallet asks for anything.

## Layout
`contracts/ShowUp.sol` (the domain, on chain) · `contracts/test/` (Foundry unit, fuzz and invariant tests) · `web/domain.js` (pure helpers, unit-tested) · `web/chain.js` (the only RPC and wallet code) · `web/abi.js` (generated, checked against the build) · `scripts/` (flow, e2e, smoke, deploy) · `SPEC.md` (purpose, numbers, Given/When/Then).

## Status and next
This is a proof of concept, and it is not audited. With a microgrant, the next four weeks would be:
1. A pilot with 3 shops. The measure is the no-show rate before and after, and the share of deposits refunded at the door.
2. Gas sponsorship for the shop tablet, so its key never needs topping up. Today the tablet already submits check-ins from its own key or the owner wallet, so guests never pay gas.
3. A card-to-USDC on-ramp for guests without a wallet.
4. A webhook for common booking tools, so a deposit is requested automatically.

## Tools used
Solidity 0.8.28, Foundry, viem, qrcode-generator, esbuild, Playwright (smoke test). Written with help from an AI coding assistant (Claude).

## License
MIT
