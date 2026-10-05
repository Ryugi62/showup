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

    // ghost accounting
    uint256 public paidIn;
    uint256 public paidOut;

    constructor(ShowUp _su) {
        su = _su;
        vm.prank(owner);
        shopId = su.registerShop(payout, vm.addr(signerPk), D, 1 hours, 15 minutes, "Inv Shop");
        for (uint256 i; i < 3; i++) {
            customers[i] = makeAddr(string(abi.encode("c", i)));
            vm.deal(customers[i], 1_000 ether);
        }
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

    function travel(uint32 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 2 days));
    }

    function _pick(uint256 seed) internal view returns (uint256) {
        uint256 n = su.bookingCount();
        if (n == 0) return 0;
        return (seed % n) + 1;
    }
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

    /// The contract never holds more or less than the sum of Held deposits.
    function invariant_balanceEqualsTotalHeld() public view {
        assertEq(address(su).balance, su.totalHeld());
    }

    /// Money in = money still held + money paid out; nothing is created or lost.
    function invariant_conservation() public view {
        assertEq(h.paidIn(), su.totalHeld() + h.paidOut());
    }
}
