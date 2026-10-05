# ShowUp — refundable booking deposits on Arc

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
arrives, scans the shop's QR           │  EIP-712 pass (bookingId, validUntil), valid 2 min
checkIn(id, validUntil, sig) ───►      Refunded → 5 USDC back to the guest in the same tx
  (or the shop's tablet submits it — the guest needs no gas)
                                       │
never comes                            │  only after slot + grace (≥ 5 min)
                                       └► Claimed → 5 USDC to the shop's payout ◄──── claim(id)
```

## Why Arc
- **One balance pays for everything.** On Arc, USDC is the gas, so the deposit and the fee come out of the same dollar balance. A guest needs no second token to book, and a shop needs no ETH to run.
- **About a cent per action, priced in dollars.** That makes a $5 deposit worth protecting. The fee for every demo action is in the table above (gas used × effective gas price, in USDC).
- **Sub-second finality.** The refund is final before the guest reaches the table. The demo records the time from send to receipt for every action.
- Deposits are plain `msg.value` in Arc's native USDC (18 decimals), so booking is one transaction with no token approval.

## Trust model and guarantees
- **No admin key, no upgrade path.** The deployer cannot move a deposit.
- **The shop attests attendance** by signing the guest's pass. A shop could withhold the pass and claim anyway. So each shop's record is public and kept on chain (`shopStats`: booked, refunded, claimed), and the pages show it as a claim rate before anyone books.
- **Terms are fixed at registration.** Deposit, free-cancel window and grace can't change under an existing booking. Grace is 5 minutes to 1 day, the cancel window is at most 30 days, and a slot must start at least a minute after booking, so "only after slot + grace" always means something.
- **Passes.** A pass is bound to one booking, this contract and this chain (EIP-712 domain), and to an expiry; the pages issue 2-minute passes. A pass works once. High-`s` (malleable) signatures are rejected. The shop can rotate its check-in key, and smart-contract wallets can sign through EIP-1271. A pass is a bearer token for its 2 minutes, but the refund always goes to the wallet that booked.
- **Escape hatch.** If a shop vanishes (lost key), the guest can `reclaim` a still-held deposit 30 days after the slot. Shops can `transferShop` and `setPayout`.
- **Payouts can't get stuck.** A payout is pushed with a gas cap. If the transfer fails (for example, a recipient contract that reverts or needs more gas), the amount is parked as a withdrawable credit (`owed`, `withdraw`), and the booking still settles.
- **Accounting.** The contract balance always equals deposits held plus credits owed, plus anything force-sent to it (Foundry invariants over random book / cancel / check-in / release / claim / reclaim / force-send / time-travel sequences, 256 runs × depth 100).

## Verify it in two minutes
1. Open https://ryugi62.github.io/showup/. It shows the live shops, their claim rates and the latest bookings, read straight from chain.
2. Follow the contract link to the Arc explorer. The demo booking that was refunded at check-in and the one claimed as a no-show are linked in the table above.
3. Run it locally:
```bash
npm install
forge test                     # 37 unit/fuzz tests + 3 invariants
node --test tests/*.test.mjs   # web domain helpers + ABI sync
npm run e2e                    # Anvil (chain id 5042): deploy, book, check in, no-show, claim
node scripts/smoke-web.mjs     # the real pages in headless Chromium with an injected wallet:
                               # register shop → book → QR → guest check-in → tablet check-in → no-show claim
```

## Pages
- `index.html` — read-only view: shops with their public record, the latest bookings.
- `book.html?shop=N` — the guest books with a browser wallet (adds the Arc network if missing), sees their bookings, cancels while it's free, withdraws any parked payout.
- `shop.html?shop=N` — anyone can view it. The owner's wallet can show a check-in QR (signed in the wallet, no transaction), check a guest in from the shop's device, claim no-shows (with a confirmation step) or refund. It also has the shareable booking link and a form to register a shop.
- `checkin.html#p=…` — what the guest's phone opens from the QR. Opened in a plain browser, it points to the wallet app and doesn't show a dead button.

No third-party scripts are loaded at runtime. viem and the QR encoder are vendored into `web/vendor/` (`npm run vendor`).

## Layout
`contracts/ShowUp.sol` (the domain, on chain) · `contracts/test/` (Foundry unit, fuzz and invariant tests) · `web/domain.js` (pure helpers, unit-tested) · `web/chain.js` (the only RPC and wallet code) · `web/abi.js` (generated, checked against the build) · `scripts/` (flow, e2e, smoke, deploy) · `SPEC.md` (purpose, numbers, Given/When/Then).

## Status and next
This is a proof of concept, and it is not audited. With a microgrant, the next four weeks would be:
1. A pilot with 3 shops. The measure is the no-show rate before and after, and the share of deposits refunded at the door.
2. A shop tablet mode that submits every check-in, so guests never pay gas.
3. A card-to-USDC on-ramp for guests without a wallet.
4. A webhook for common booking tools, so a deposit is requested automatically.

## Tools used
Solidity 0.8.28, Foundry, viem, qrcode-generator, esbuild, Playwright (smoke test). Written with help from an AI coding assistant (Claude).

## License
MIT
