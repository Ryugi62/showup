# ShowUp — refundable booking deposits on Arc

**A small USDC deposit that a customer gets back the moment they walk in, and a shop can claim only if they never come.** Built for [Arc](https://arc.io) mainnet, where gas is paid in USDC and finality is sub-second.

**Live page (no wallet needed):** https://ryugi62.github.io/showup/ · **Contract (Arc mainnet, chain 5042):** see [`runs/mainnet.json`](runs/mainnet.json) and [`web/config.js`](web/config.js) — filled in by the deploy script.

## The problem
Restaurants, clinics and salons hold a slot for someone who doesn't come. A deposit would fix it, but a card deposit doesn't pay for itself: on a $5 deposit a typical online card rate of 2.9% + 30¢ ([Stripe pricing](https://stripe.com/pricing)) takes about 45¢ (9%), and when the guest does show up, a card refund takes 5–10 business days to reach them ([Stripe refunds FAQ](https://support.stripe.com/questions/refunds-faq)). So most small shops take no deposit at all.

## How it works
```
customer                         ShowUp contract (Arc)                         shop
book(shop, slot) + 5 USDC ───►   Held  ─ free cancel until slot − cutoff ─►  (customer refunded)
                                    │
walks in, scans the shop's QR       │   EIP-712 pass: (bookingId, validUntil)
checkIn(id, validUntil, sig) ───►   Refunded → 5 USDC back to the customer, same transaction
                                    │
never comes                         │   after slot + grace
                                    └► Claimed  → 5 USDC to the shop's payout address ◄─── claim(id)
```
- **No admin key, no upgrade path.** The deployer cannot move a deposit. The shop can only claim after `slot + grace`, only to its payout address; the customer can only cancel before the cutoff. A shop can always refund (`release`).
- **Check-in pass = an EIP-712 signature** by the shop's check-in key over `(bookingId, validUntil)`. Anyone may submit it (the customer, or the shop's tablet), but the refund always goes to the wallet that booked. Each pass works once, for one booking, until it expires; high-`s` (malleable) signatures are rejected; the shop can rotate its check-in key.
- **Accounting invariant:** the contract's balance always equals `totalHeld`, the sum of deposits still `Held` (Foundry invariant test over random book / cancel / check-in / release / claim / time-travel sequences).

## Why Arc
- Gas is USDC, priced in dollars, at about a cent per action — so protecting a $5 deposit makes sense. Measured costs per action are in [`runs/mainnet.json`](runs/mainnet.json) (gas used × effective gas price, in USDC).
- Deterministic sub-second finality: the refund is final before the guest sits down. The demo script records wall-clock time from send to receipt for each action.
- Deposits are plain `msg.value` in Arc's native USDC (18 decimals) — no token approvals, one transaction to book.

## Run it
```bash
npm install
forge test                     # 25 unit/fuzz tests + 2 invariants
node --test tests/*.test.mjs   # web domain helpers
npm run e2e                    # Anvil (chain id 5042): deploy, book, check in, no-show, claim
node scripts/smoke-web.mjs     # same flow + the static pages in headless Chromium
node scripts/deploy-mainnet.mjs path/to/deployer.env   # Arc mainnet deploy + real demo flow
```
`deployer.env` contains `ARC_DEPLOYER_PK=` (never committed). The deploy script refuses to run without enough USDC on Arc and prints the address to fund.

## Pages
- `index.html` — read-only view of shops and bookings straight from chain.
- `book.html?shop=N` — customer books with a browser wallet (adds the Arc network if missing), sees and cancels their bookings.
- `shop.html` — register a shop; for each booking, show a check-in QR (signed in the wallet, no transaction), claim no-shows, or refund.
- `checkin.html#p=…` — what the guest's phone opens from the QR.

## Layout
`contracts/ShowUp.sol` (domain, on chain) · `contracts/test/` (Foundry) · `web/domain.js` (pure helpers, unit-tested) · `web/chain.js` (the only RPC/wallet code) · `scripts/` (flow, e2e, smoke, deploy) · `SPEC.md` (purpose, numbers, Given/When/Then).

## Status and next
Proof of concept. Next: a hosted shop tablet mode so the shop's device submits check-ins (guests need no gas), card-to-USDC on-ramp for guests without a wallet, and a pilot with real shops. Not audited.

## Tools used
Solidity 0.8.28, Foundry, viem, qrcode-generator (cdnjs), Playwright for the smoke test. Written with help from an AI coding assistant (Claude).

## License
MIT
