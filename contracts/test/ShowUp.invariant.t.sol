// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ShowUp} from "../ShowUp.sol";

/// Random sequences of book / cancel / check-in / release / claim / time travel.
contract Handler is Test {
    ShowUp public su;
    uint256 public shopId;
    uint256 internal signerPk = 0x5157;
    address public owner = makeAddr("owner");
    address payable public payout = payable(makeAddr("payout"));
    address[3] internal customers;
    uint256 public constant D = 1 ether;

    Picky public picky;
    // ghost accounting
    uint256 public paidIn;
    uint256 public paidOut;

    constructor(ShowUp _su) {
        su = _su;
        vm.prank(owner);
        shopId = su.registerShop(payout, vm.addr(signerPk), D, 1 hours, 15 minutes, "Inv Shop");
        for (uint256 i; i < 2; i++) {
            customers[i] = makeAddr(string(abi.encode("c", i)));
            vm.deal(customers[i], 1_000 ether);
        }
        picky = new Picky(); // a contract customer that refuses pushed refunds → exercises owed/withdraw
        customers[2] = address(picky);
        vm.deal(address(picky), 1_000 ether);
    }

    function book(uint256 who, uint32 ahead) external {
        address c = customers[who % 3];
        uint64 slot = uint64(block.timestamp + 1 hours + bound(ahead, 0, 3 days));
        vm.prank(c);
        su.book{value: D}(shopId, slot);
        paidIn += D;
    }

    function cancel(uint256 seed) external {
        uint256 id = _pick(seed);
        if (id == 0) return;
        (, address c,,,) = su.bookings(id);
        vm.prank(c);
        try su.cancel(id) { paidOut += D; } catch {}
    }

    function checkIn(uint256 seed) external {
        uint256 id = _pick(seed);
        if (id == 0) return;
        uint64 vu = uint64(block.timestamp + 10 minutes);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, su.passDigest(id, vu));
        try su.checkIn(id, vu, abi.encodePacked(r, s, v)) { paidOut += D; } catch {}
    }

    function release(uint256 seed) external {
        uint256 id = _pick(seed);
        if (id == 0) return;
        vm.prank(owner);
        try su.release(id) { paidOut += D; } catch {}
    }

    function claim(uint256 seed) external {
        uint256 id = _pick(seed);
        if (id == 0) return;
        vm.prank(owner);
        try su.claim(id) { paidOut += D; } catch {}
    }

    function reclaim(uint256 seed) external {
        uint256 id = _pick(seed);
        if (id == 0) return;
        (, address c,,,) = su.bookings(id);
        vm.prank(c);
        try su.reclaim(id) { paidOut += D; } catch {}
    }

    function pickyWithdraw() external {
        uint256 o = su.owed(address(picky));
        if (o == 0) return;
        picky.pull(su);
        withdrawn += o;
    }

    uint256 public withdrawn;

    function donate(uint96 amt) external {
        uint256 a = bound(amt, 1, 5 ether);
        vm.deal(address(su), address(su).balance + a);
        donated += a;
    }

    uint256 public donated;

    function travel(uint32 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 40 days));
    }

    function _pick(uint256 seed) internal view returns (uint256) {
        uint256 n = su.bookingCount();
        if (n == 0) return 0;
        return (seed % n) + 1;
    }
}

contract Picky {
    bool internal pulling;
    function pull(ShowUp su) external { pulling = true; su.withdraw(); pulling = false; }
    receive() external payable { require(pulling, "push refused"); }
}

contract ShowUpInvariantTest is Test {
    ShowUp internal su;
    Handler internal h;

    function setUp() public {
        vm.warp(1_800_000_000);
        su = new ShowUp();
        h = new Handler(su);
        targetContract(address(h));
    }

    /// Every held deposit and every parked payout is backed; forced transfers only add a surplus.
    function invariant_solvent() public view {
        assertEq(address(su).balance, su.totalHeld() + su.totalOwed() + h.donated());
        assertEq(su.owed(address(h.picky())), su.totalOwed()); // only the picky customer can be owed
    }

    /// Money in = money still held + money paid out; nothing is created or lost.
    function invariant_conservation() public view {
        // paidOut counts settlements; parked amounts leave via withdraw
        assertEq(h.paidIn(), su.totalHeld() + h.paidOut());
    }

    /// Every booking is in exactly one state, and the public shop counters agree with them.
    function invariant_statesAndStats() public view {
        uint256 n = su.bookingCount();
        uint256 held; uint256 refunded; uint256 claimed;
        for (uint256 i = 1; i <= n; i++) {
            ShowUp.Status st = su.statusOf(i);
            if (st == ShowUp.Status.Held) held++;
            else if (st == ShowUp.Status.Refunded) refunded++;
            else if (st == ShowUp.Status.Claimed) claimed++;
            else revert("booking in None state");
        }
        (uint64 b, uint64 ci, uint64 ca, uint64 re, uint64 rc, uint64 c,,) = su.shopStats(h.shopId());
        assertEq(b, n);
        assertEq(uint256(ci) + ca + re + rc, refunded);
        assertEq(c, claimed);
        assertEq(su.totalHeld(), held * h.D());
    }
}
