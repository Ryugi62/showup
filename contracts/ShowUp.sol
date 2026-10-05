// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title ShowUp — refundable booking deposits paid in Arc's native USDC
/// @notice A customer locks a small deposit when booking a slot. Checking in at the shop
///         (with a pass signed by the shop's check-in key) refunds it immediately; a
///         no-show lets the shop claim it after the grace period. Nobody — not the shop,
///         not the deployer — can take a deposit early. There is no owner and no upgrade path.
/// @dev On Arc, USDC is the native gas asset with 18 decimals, so deposits are plain msg.value.
contract ShowUp {
    enum Status {
        None,
        Held,
        Refunded,
        Claimed
    }

    struct Shop {
        address owner;
        address payout;
        address signer;
        uint256 deposit;
        uint64 cancelWindow;
        uint64 grace;
        bool active;
        string name;
    }

    struct Booking {
        uint256 shopId;
        address customer;
        uint64 slotStart;
        uint256 amount;
        Status status;
    }

    error BadConfig();
    error ShopInactive();
    error WrongDeposit();
    error SlotTooSoon();
    error NotAllowed();
    error NotHeld();
    error TooLateToCancel();
    error TooLate();
    error TooEarly();
    error BadPass();
    error PassExpired();
    error TransferFailed();

    event ShopRegistered(uint256 indexed shopId, address indexed owner, uint256 deposit, string name);
    event ShopUpdated(uint256 indexed shopId, address signer, bool active);
    event Booked(uint256 indexed bookingId, uint256 indexed shopId, address indexed customer, uint64 slotStart, uint256 amount);
    event Cancelled(uint256 indexed bookingId, address indexed customer, uint256 amount);
    event CheckedIn(uint256 indexed bookingId, address indexed customer, uint256 amount);
    event Released(uint256 indexed bookingId, address indexed customer, uint256 amount);
    event Claimed(uint256 indexed bookingId, address indexed payout, uint256 amount);

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant PASS_TYPEHASH = keccak256("CheckInPass(uint256 bookingId,uint64 validUntil)");
    uint256 private constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    mapping(uint256 => Shop) public shops;
    mapping(uint256 => Booking) public bookings;
    uint256 public shopCount;
    uint256 public bookingCount;
    uint256 public totalHeld;

    uint256 private locked = 1;

    modifier nonReentrant() {
        if (locked != 1) revert NotAllowed();
        locked = 2;
        _;
        locked = 1;
    }

    // ---------------------------------------------------------------- shops

    function registerShop(
        address payout,
        address signer,
        uint256 deposit,
        uint64 cancelWindow,
        uint64 grace,
        string calldata name
    ) external returns (uint256 shopId) {
        if (payout == address(0) || signer == address(0) || deposit == 0 || bytes(name).length > 64) {
            revert BadConfig();
        }
        shopId = ++shopCount;
        shops[shopId] = Shop(msg.sender, payout, signer, deposit, cancelWindow, grace, true, name);
        emit ShopRegistered(shopId, msg.sender, deposit, name);
    }

    function setSigner(uint256 shopId, address signer) external {
        Shop storage s = _ownedShop(shopId);
        if (signer == address(0)) revert BadConfig();
        s.signer = signer;
        emit ShopUpdated(shopId, signer, s.active);
    }

    function setActive(uint256 shopId, bool active) external {
        Shop storage s = _ownedShop(shopId);
        s.active = active;
        emit ShopUpdated(shopId, s.signer, active);
    }

    // ------------------------------------------------------------- bookings

    function book(uint256 shopId, uint64 slotStart) external payable returns (uint256 bookingId) {
        Shop storage s = shops[shopId];
        if (!s.active) revert ShopInactive();
        if (msg.value != s.deposit) revert WrongDeposit();
        if (uint256(slotStart) < block.timestamp + s.cancelWindow) revert SlotTooSoon();
        bookingId = ++bookingCount;
        bookings[bookingId] = Booking(shopId, msg.sender, slotStart, msg.value, Status.Held);
        totalHeld += msg.value;
        emit Booked(bookingId, shopId, msg.sender, slotStart, msg.value);
    }

    /// @notice Customer cancels before the free-cancel window closes.
    function cancel(uint256 bookingId) external nonReentrant {
        Booking storage b = _held(bookingId);
        if (msg.sender != b.customer) revert NotAllowed();
        if (block.timestamp >= uint256(b.slotStart) - shops[b.shopId].cancelWindow) revert TooLateToCancel();
        uint256 amount = _settle(b, Status.Refunded);
        emit Cancelled(bookingId, b.customer, amount);
        _send(b.customer, amount);
    }

    /// @notice Anyone may submit a valid pass; the refund always goes to the booking's customer.
    function checkIn(uint256 bookingId, uint64 validUntil, bytes calldata pass) external nonReentrant {
        Booking storage b = _held(bookingId);
        Shop storage s = shops[b.shopId];
        if (block.timestamp > validUntil) revert PassExpired();
        if (block.timestamp >= uint256(b.slotStart) + s.grace) revert TooLate();
        if (_recover(passDigest(bookingId, validUntil), pass) != s.signer) revert BadPass();
        uint256 amount = _settle(b, Status.Refunded);
        emit CheckedIn(bookingId, b.customer, amount);
        _send(b.customer, amount);
    }

    /// @notice Shop forgives the deposit or cancels the slot itself.
    function release(uint256 bookingId) external nonReentrant {
        Booking storage b = _held(bookingId);
        if (msg.sender != shops[b.shopId].owner) revert NotAllowed();
        uint256 amount = _settle(b, Status.Refunded);
        emit Released(bookingId, b.customer, amount);
        _send(b.customer, amount);
    }

    /// @notice Shop takes a no-show deposit, only after slotStart + grace.
    function claim(uint256 bookingId) external nonReentrant {
        Booking storage b = _held(bookingId);
        Shop storage s = shops[b.shopId];
        if (msg.sender != s.owner) revert NotAllowed();
        if (block.timestamp < uint256(b.slotStart) + s.grace) revert TooEarly();
        uint256 amount = _settle(b, Status.Claimed);
        emit Claimed(bookingId, s.payout, amount);
        _send(s.payout, amount);
    }

    // ---------------------------------------------------------------- views

    function statusOf(uint256 bookingId) external view returns (Status) {
        return bookings[bookingId].status;
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("ShowUp"), keccak256("1"), block.chainid, address(this)));
    }

    function passDigest(uint256 bookingId, uint64 validUntil) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(PASS_TYPEHASH, bookingId, validUntil));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    // ------------------------------------------------------------- internal

    function _ownedShop(uint256 shopId) private view returns (Shop storage s) {
        s = shops[shopId];
        if (msg.sender != s.owner || s.owner == address(0)) revert NotAllowed();
    }

    function _held(uint256 bookingId) private view returns (Booking storage b) {
        b = bookings[bookingId];
        if (b.status != Status.Held) revert NotHeld();
    }

    function _settle(Booking storage b, Status to) private returns (uint256 amount) {
        amount = b.amount;
        b.status = to;
        totalHeld -= amount;
    }

    function _send(address to, uint256 amount) private {
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) revert BadPass();
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (uint256(s) > HALF_N || (v != 27 && v != 28)) revert BadPass();
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert BadPass();
        return signer;
    }
}
