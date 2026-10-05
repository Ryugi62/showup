// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ShowUp} from "../ShowUp.sol";

contract ShowUpTest is Test {
    ShowUp internal su;

    address internal owner = makeAddr("shopOwner");
    address payable internal payout = payable(makeAddr("payout"));
    uint256 internal signerPk = 0xA11CE;
    address internal signer;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    uint256 internal constant D = 5 ether; // 5 USDC (native, 18 decimals on Arc)
    uint64 internal constant CANCEL_WINDOW = 2 hours;
    uint64 internal constant GRACE = 30 minutes;

    uint256 internal shopId;
    uint64 internal slot;

    function setUp() public {
        su = new ShowUp();
        signer = vm.addr(signerPk);
        vm.warp(1_800_000_000);
        vm.prank(owner);
        shopId = su.registerShop(payout, signer, D, CANCEL_WINDOW, GRACE, "Cafe Lumia");
        slot = uint64(block.timestamp + 1 days);
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
    }

    function _book(address who) internal returns (uint256 id) {
        vm.prank(who);
        id = su.book{value: D}(shopId, slot);
    }

    function _pass(uint256 pk, uint256 bookingId, uint64 validUntil) internal view returns (bytes memory) {
        bytes32 digest = su.passDigest(bookingId, validUntil);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    // --- registration ---
    function test_registerShop_storesConfig() public view {
        (address o, address p, address sg, uint256 dep, uint64 cw, uint64 gr, bool active, string memory name) =
            su.shops(shopId);
        assertEq(o, owner);
        assertEq(p, payout);
        assertEq(sg, signer);
        assertEq(dep, D);
        assertEq(cw, CANCEL_WINDOW);
        assertEq(gr, GRACE);
        assertTrue(active);
        assertEq(name, "Cafe Lumia");
    }

    function test_registerShop_rejectsZeroDepositOrZeroAddresses() public {
        vm.expectRevert(ShowUp.BadConfig.selector);
        su.registerShop(payout, signer, 0, CANCEL_WINDOW, GRACE, "x");
        vm.expectRevert(ShowUp.BadConfig.selector);
        su.registerShop(payable(address(0)), signer, D, CANCEL_WINDOW, GRACE, "x");
        vm.expectRevert(ShowUp.BadConfig.selector);
        su.registerShop(payout, address(0), D, CANCEL_WINDOW, GRACE, "x");
    }

    // --- booking ---
    function test_book_holdsDeposit() public {
        uint256 id = _book(alice);
        (uint256 s, address c, uint64 st, uint256 amt, ShowUp.Status status) = su.bookings(id);
        assertEq(s, shopId);
        assertEq(c, alice);
        assertEq(st, slot);
        assertEq(amt, D);
        assertEq(uint8(status), uint8(ShowUp.Status.Held));
        assertEq(address(su).balance, D);
    }

    function test_book_wrongValueReverts() public {
        vm.prank(alice);
        vm.expectRevert(ShowUp.WrongDeposit.selector);
        su.book{value: D - 1}(shopId, slot);
    }

    function test_book_slotInsideCancelWindowReverts() public {
        vm.prank(alice);
        vm.expectRevert(ShowUp.SlotTooSoon.selector);
        su.book{value: D}(shopId, uint64(block.timestamp + CANCEL_WINDOW - 1));
    }

    function test_book_inactiveShopReverts_existingStillSettles() public {
        uint256 id = _book(alice);
        vm.prank(owner);
        su.setActive(shopId, false);
        vm.prank(bob);
        vm.expectRevert(ShowUp.ShopInactive.selector);
        su.book{value: D}(shopId, slot);
        vm.prank(alice);
        su.cancel(id);
        assertEq(alice.balance, 100 ether);
    }

    // --- cancel ---
    function test_cancel_inTime_refunds() public {
        uint256 id = _book(alice);
        vm.warp(slot - CANCEL_WINDOW - 1);
        vm.prank(alice);
        su.cancel(id);
        assertEq(alice.balance, 100 ether);
        assertEq(uint8(su.statusOf(id)), uint8(ShowUp.Status.Refunded));
    }

    function test_cancel_tooLate_reverts() public {
        uint256 id = _book(alice);
        vm.warp(slot - CANCEL_WINDOW);
        vm.prank(alice);
        vm.expectRevert(ShowUp.TooLateToCancel.selector);
        su.cancel(id);
    }

    function test_cancel_byStranger_reverts() public {
        uint256 id = _book(alice);
        vm.prank(bob);
        vm.expectRevert(ShowUp.NotAllowed.selector);
        su.cancel(id);
    }

    // --- check-in ---
    function test_checkIn_validPass_refundsInstantly() public {
        uint256 id = _book(alice);
        vm.warp(slot - 5 minutes);
        bytes memory pass = _pass(signerPk, id, uint64(block.timestamp + 10 minutes));
        vm.expectEmit(true, true, false, true);
        emit ShowUp.CheckedIn(id, alice, D);
        vm.prank(alice);
        su.checkIn(id, uint64(block.timestamp + 10 minutes), pass);
        assertEq(alice.balance, 100 ether);
        assertEq(address(su).balance, 0);
    }

    function test_checkIn_anyoneCanRelay_butMoneyGoesToCustomer() public {
        uint256 id = _book(alice);
        uint64 vu = uint64(block.timestamp + 1 days);
        bytes memory pass = _pass(signerPk, id, vu);
        vm.prank(bob);
        su.checkIn(id, vu, pass);
        assertEq(alice.balance, 100 ether);
        assertEq(bob.balance, 100 ether);
    }

    function test_checkIn_wrongSigner_reverts() public {
        uint256 id = _book(alice);
        uint64 vu = uint64(block.timestamp + 1 hours);
        bytes memory pass = _pass(0xB0B, id, vu);
        vm.prank(alice);
        vm.expectRevert(ShowUp.BadPass.selector);
        su.checkIn(id, vu, pass);
    }

    function test_checkIn_passForOtherBooking_reverts() public {
        uint256 id1 = _book(alice);
        uint256 id2 = _book(bob);
        uint64 vu = uint64(block.timestamp + 1 hours);
        bytes memory passFor2 = _pass(signerPk, id2, vu);
        vm.prank(alice);
        vm.expectRevert(ShowUp.BadPass.selector);
        su.checkIn(id1, vu, passFor2);
    }

    function test_checkIn_expiredPass_reverts() public {
        uint256 id = _book(alice);
        uint64 vu = uint64(block.timestamp + 1 hours);
        bytes memory pass = _pass(signerPk, id, vu);
        vm.warp(vu + 1);
        vm.prank(alice);
        vm.expectRevert(ShowUp.PassExpired.selector);
        su.checkIn(id, vu, pass);
    }

    function test_checkIn_afterGrace_reverts() public {
        uint256 id = _book(alice);
        vm.warp(slot + GRACE);
        uint64 vu = uint64(block.timestamp + 1 hours);
        bytes memory pass = _pass(signerPk, id, vu);
        vm.prank(alice);
        vm.expectRevert(ShowUp.TooLate.selector);
        su.checkIn(id, vu, pass);
    }

    function test_checkIn_replay_reverts() public {
        uint256 id = _book(alice);
        uint64 vu = uint64(block.timestamp + 1 hours);
        bytes memory pass = _pass(signerPk, id, vu);
        vm.prank(alice);
        su.checkIn(id, vu, pass);
        vm.prank(alice);
        vm.expectRevert(ShowUp.NotHeld.selector);
        su.checkIn(id, vu, pass);
    }

    function test_checkIn_malleableHighS_reverts() public {
        uint256 id = _book(alice);
        uint64 vu = uint64(block.timestamp + 1 hours);
        bytes32 digest = su.passDigest(id, vu);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, digest);
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes32 s2 = bytes32(n - uint256(s));
        uint8 v2 = v == 27 ? 28 : 27;
        vm.prank(alice);
        vm.expectRevert(ShowUp.BadPass.selector);
        su.checkIn(id, vu, abi.encodePacked(r, s2, v2));
    }

    // --- claim ---
    function test_claim_beforeGrace_reverts() public {
        uint256 id = _book(alice);
        vm.warp(slot + GRACE - 1);
        vm.prank(owner);
        vm.expectRevert(ShowUp.TooEarly.selector);
        su.claim(id);
    }

    function test_claim_afterGrace_paysShop() public {
        uint256 id = _book(alice);
        vm.warp(slot + GRACE);
        vm.prank(owner);
        su.claim(id);
        assertEq(payout.balance, D);
        assertEq(uint8(su.statusOf(id)), uint8(ShowUp.Status.Claimed));
    }

    function test_claim_byStranger_reverts() public {
        uint256 id = _book(alice);
        vm.warp(slot + GRACE);
        vm.prank(alice);
        vm.expectRevert(ShowUp.NotAllowed.selector);
        su.claim(id);
    }

    function test_claim_afterCheckIn_reverts() public {
        uint256 id = _book(alice);
        uint64 vu = uint64(block.timestamp + 1 hours);
        bytes memory pass = _pass(signerPk, id, vu);
        vm.prank(alice);
        su.checkIn(id, vu, pass);
        vm.warp(slot + GRACE);
        vm.prank(owner);
        vm.expectRevert(ShowUp.NotHeld.selector);
        su.claim(id);
    }

    // --- release ---
    function test_release_byShop_refundsCustomer() public {
        uint256 id = _book(alice);
        vm.warp(slot + 3 days);
        vm.prank(owner);
        su.release(id);
        assertEq(alice.balance, 100 ether);
    }

    function test_release_byCustomer_reverts() public {
        uint256 id = _book(alice);
        vm.prank(alice);
        vm.expectRevert(ShowUp.NotAllowed.selector);
        su.release(id);
    }

    // --- admin surface ---
    function test_setSigner_onlyOwner_andOldPassStopsWorking() public {
        uint256 id = _book(alice);
        uint64 vu = uint64(block.timestamp + 1 hours);
        bytes memory oldPass = _pass(signerPk, id, vu);
        vm.prank(alice);
        vm.expectRevert(ShowUp.NotAllowed.selector);
        su.setSigner(shopId, alice);
        vm.prank(owner);
        su.setSigner(shopId, vm.addr(0xC0FFEE));
        vm.prank(alice);
        vm.expectRevert(ShowUp.BadPass.selector);
        su.checkIn(id, vu, oldPass);
    }

    // --- fuzz ---
    function testFuzz_balanceEqualsHeld(uint8 nBook, uint8 actions, uint256 seed) public {
        nBook = uint8(bound(nBook, 1, 12));
        uint256[] memory ids = new uint256[](nBook);
        for (uint256 i; i < nBook; i++) {
            ids[i] = _book(i % 2 == 0 ? alice : bob);
        }
        vm.warp(slot + GRACE);
        for (uint256 j; j < actions; j++) {
            uint256 id = ids[uint256(keccak256(abi.encode(seed, j))) % nBook];
            if (su.statusOf(id) != ShowUp.Status.Held) continue;
            vm.prank(owner);
            if (j % 2 == 0) su.claim(id);
            else su.release(id);
        }
        uint256 held;
        for (uint256 i; i < nBook; i++) {
            if (su.statusOf(ids[i]) == ShowUp.Status.Held) held += D;
        }
        assertEq(address(su).balance, held);
        assertEq(su.totalHeld(), held);
    }
}
