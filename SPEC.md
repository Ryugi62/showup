# ShowUp — refundable booking deposits on Arc

## Purpose
Small shops (restaurants, clinics, salons) lose revenue to no-shows but cannot take a $5 card deposit: card fees and chargebacks eat it. ShowUp holds a small USDC deposit on Arc when a customer books. Showing up refunds it on the spot; not showing up lets the shop claim it after the slot. Neither side can take the money early.

Arc is the reason this works: gas is paid in USDC (about one cent, priced in dollars), and finality is sub-second, so a refund at the door settles before the customer sits down.

## Ubiquitous language
- **Shop**: registers once with a payout address, a check-in signer key, a deposit amount, a free-cancel window and a grace period.
- **Booking**: one deposit for one slot (`shopId`, `customer`, `slotStart`, `amount`, `status`).
- **Status**: `Held` → `Refunded` (cancelled in time, checked in, or released by the shop) or `Claimed` (no-show after grace).
- **Check-in pass**: an EIP-712 signature by the shop's check-in signer over (`bookingId`, `validUntil`). The shop's screen shows it as a QR; the customer submits it.
- **Free-cancel window**: the customer can cancel for a full refund until `slotStart - cancelWindow`.
- **Grace**: the shop can claim only after `slotStart + grace` (5 min – 1 day, fixed at registration).
- **Shop record**: on-chain counters booked / refunded / claimed per shop — the public claim rate.
- **Owed**: a payout that could not be pushed, withdrawable by its recipient.

## Success criteria (numbers)
1. Contract tests: 100% of the Given/When/Then cases below pass, plus fuzz tests (≥256 runs each) showing that the contract balance always equals the sum of `Held` deposits.
2. Deployed and verified working on Arc mainnet (chain 5042), with at least one real `Refunded` by check-in and one real `Claimed` booking, linked from the README.
3. Gas per action measured on mainnet and reported in USDC: book, check-in refund, claim (target ≤ $0.02 each).
4. The live page opens without a wallet and shows the shop and its bookings read from chain.

## Given / When / Then
- G shop registered (deposit D) · W customer books with exactly D · T booking `Held`, contract balance +D.
- G booking with value ≠ D · W book · T revert `WrongDeposit`.
- G slot in the past or too soon to cancel window · W book · T revert `SlotTooSoon`.
- G `Held`, now < slotStart − cancelWindow · W customer cancels · T `Refunded`, customer +D.
- G `Held`, now ≥ slotStart − cancelWindow · W customer cancels · T revert `TooLateToCancel`.
- G `Held`, valid pass signed by the shop's signer, now ≤ validUntil, now < slotStart + grace · W customer checks in · T `Refunded`, customer +D, event `CheckedIn`.
- G pass signed by any other key, or for another booking, or expired · W check in · T revert `BadPass` / `PassExpired`.
- G already `Refunded` · W check in again (replay) · T revert `NotHeld`.
- G `Held`, now < slotStart + grace · W shop claims · T revert `TooEarly`.
- G `Held`, now ≥ slotStart + grace · W shop claims · T `Claimed`, shop payout +D.
- G `Held` · W shop releases (shop cancelled the slot, or forgives) · T `Refunded`, customer +D.
- G anyone other than the customer / the shop owner · W cancel / claim / release · T revert `NotAllowed`.
- G shop deactivated · W new booking · T revert `ShopInactive`; existing bookings still settle.
- G grace < 5 min or > 1 day, or cancel window > 30 days · W register · T revert `BadConfig` (terms are fixed after registration).
- G cancel window 0 · W book a slot < 60 s away · T revert `SlotTooSoon`.
- G `Held`, now ≥ slotStart + grace + 30 days · W customer reclaims · T `Refunded` (escape hatch if the shop vanished); earlier → `TooEarly`.
- G a pass signed for another ShowUp instance or another chain · W check in · T revert `BadPass`.
- G shop signer is a contract wallet · W check in with a signature it accepts (EIP-1271) · T `Refunded`.
- G refund recipient rejects the transfer · W any settlement · T booking still settles, amount parked in `owed`, `withdraw` pays it once.
- G any sequence of actions · T contract balance = totalHeld + totalOwed (+ forced transfers), and shopStats equals the per-state counts.

## Non-goals
Payments for the meal or service itself · fiat on-ramp · disputes beyond the release rule · ERC-20 approvals (deposits use Arc's native USDC value) · upgradeability · admin keys (no owner can move deposits).

## Architecture
- `contracts/ShowUp.sol` — the whole domain on chain; no owner, no upgrade path.
- `contracts/test/` — Foundry tests (unit + fuzz + invariant).
- `web/` — static pages (GitHub Pages): `index.html` (read-only shop and booking view, no wallet), `book.html` (customer), `shop.html` (register, show check-in QR, claim). `web/domain.js` is pure (pass encoding, status labels, money formatting) and unit-tested with Node; `web/chain.js` is the only file that talks to the RPC/wallet.
- `scripts/` — deploy and mainnet demo scripts (Foundry `cast`/`forge script`).
