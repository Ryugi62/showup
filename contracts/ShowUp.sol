// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title ShowUp — refundable booking deposits paid in Arc's native USDC
/// @notice A customer locks a small deposit when booking a slot. Checking in at the shop
///         (with a pass signed by the shop's check-in key) refunds it immediately; a
///         no-show lets the shop claim it after the grace period. Nobody — not the shop,
///         not the deployer — can take a deposit early. There is no owner and no upgrade path.
/// @dev On Arc, USDC is the native gas asset with 18 decimals, so deposits are plain msg.value.
///      Trust model: the shop attests attendance by signing the pass. A shop that withholds the
///      pass and claims anyway is visible on chain through `shopStats` (its claim rate) — a soft
///      signal, not proof: a shop can self-book, so the record also shows unique customers.
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

    /// Public shop record. Outcomes are counted separately so the claim rate
    /// (claimed / (checkedIn + claimed)) is not diluted by cancellations or self-refunds.
    struct Stats {
        uint64 booked;
        uint64 checkedIn;
        uint64 cancelled;
        uint64 released;
        uint64 reclaimed;
        uint64 claimed;
        uint64 uniqueCustomers;
        uint64 since; // registration time — a fresh shop id has no history
    }

    error BadConfig();
    error ShopInactive();
    error WrongDeposit();
    error SlotTooSoon();
    error SlotTooFar();
    error NotAllowed();
    error NotHeld();
    error TooLateToCancel();
    error TooLate();
    error TooEarly();
    error BadPass();
    error PassExpired();
    error NothingOwed();
    error Reentered();

    event ShopRegistered(uint256 indexed shopId, address indexed owner, uint256 deposit, uint64 cancelWindow, uint64 grace, string name);
    event ShopUpdated(uint256 indexed shopId, address owner, address payout, address signer, bool active);
    event Booked(uint256 indexed bookingId, uint256 indexed shopId, address indexed customer, uint64 slotStart, uint256 amount);
    event Cancelled(uint256 indexed bookingId, address indexed customer, uint256 amount);
    event CheckedIn(uint256 indexed bookingId, address indexed customer, uint256 amount);
    event Released(uint256 indexed bookingId, address indexed customer, uint256 amount);
    event Reclaimed(uint256 indexed bookingId, address indexed customer, uint256 amount);
    event Claimed(uint256 indexed bookingId, address indexed payout, uint256 amount);
    event Owed(address indexed to, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);

    /// Shop terms are fixed at registration (deposit, cancel window, grace) so they cannot be
    /// changed under an existing booking. Floors and ceilings keep "only after slot + grace" meaningful.
    uint64 public constant MIN_GRACE = 5 minutes;
    uint64 public constant MAX_GRACE = 1 days;
    uint64 public constant MAX_CANCEL_WINDOW = 30 days;
    uint64 public constant MIN_LEAD = 60; // a slot must start at least a minute after booking
    uint64 public constant MAX_HORIZON = 365 days; // and at most a year ahead
    /// If a shop disappears (lost key), the customer can take a still-held deposit back after this.
    uint64 public constant RECLAIM_AFTER = 30 days;
    /// Gas forwarded with a payout; a recipient that needs more (or refuses) gets a withdrawable credit.
    uint256 internal constant SEND_GAS = 100_000;
    /// Gas allowed for an EIP-1271 signer contract to answer.
    uint256 internal constant ERC1271_GAS = 150_000; // enough for multi-owner Safes / 4337 accounts

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant PASS_TYPEHASH = keccak256("CheckInPass(uint256 bookingId,uint64 validUntil)");
    uint256 private constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;
    bytes4 private constant ERC1271_MAGIC = 0x1626ba7e;

    mapping(uint256 => Shop) public shops;
    mapping(uint256 => Booking) public bookings;
    mapping(uint256 => Stats) public shopStats;
    mapping(address => uint256) public owed;
    mapping(uint256 => mapping(address => bool)) private _seen;
    mapping(uint256 => uint256[]) private _byShop;
    mapping(address => uint256[]) private _byCustomer;
    uint256 public shopCount;
    uint256 public bookingCount;
    uint256 public totalHeld;
    uint256 public totalOwed;

    uint256 private locked = 1;

    modifier nonReentrant() {
        if (locked != 1) revert Reentered();
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
        if (
            payout == address(0) || signer == address(0) || deposit == 0 || bytes(name).length > 64
                || grace < MIN_GRACE || grace > MAX_GRACE || cancelWindow > MAX_CANCEL_WINDOW
        ) revert BadConfig();
        shopId = ++shopCount;
        shops[shopId] = Shop(msg.sender, payout, signer, deposit, cancelWindow, grace, true, name);
        shopStats[shopId].since = uint64(block.timestamp);
        emit ShopRegistered(shopId, msg.sender, deposit, cancelWindow, grace, name);
    }

    function setSigner(uint256 shopId, address signer) external {
        Shop storage s = _ownedShop(shopId);
        if (signer == address(0)) revert BadConfig();
        s.signer = signer;
        _updated(shopId, s);
    }

    function setPayout(uint256 shopId, address payout) external {
        Shop storage s = _ownedShop(shopId);
        if (payout == address(0)) revert BadConfig();
        s.payout = payout;
        _updated(shopId, s);
    }

    function transferShop(uint256 shopId, address newOwner) external {
        Shop storage s = _ownedShop(shopId);
        if (newOwner == address(0)) revert BadConfig();
        s.owner = newOwner;
        _updated(shopId, s);
    }

    function setActive(uint256 shopId, bool active) external {
        Shop storage s = _ownedShop(shopId);
        s.active = active;
        _updated(shopId, s);
    }

    // ------------------------------------------------------------- bookings

    function book(uint256 shopId, uint64 slotStart) external payable returns (uint256 bookingId) {
        Shop storage s = shops[shopId];
        if (!s.active) revert ShopInactive();
        if (msg.value != s.deposit) revert WrongDeposit();
        uint256 lead = s.cancelWindow > MIN_LEAD ? s.cancelWindow : MIN_LEAD;
        if (uint256(slotStart) < block.timestamp + lead) revert SlotTooSoon();
        if (uint256(slotStart) > block.timestamp + MAX_HORIZON) revert SlotTooFar();
        // a shop cannot book itself: self-bookings would only wash its public record
        if (msg.sender == s.owner || msg.sender == s.payout || msg.sender == s.signer) revert NotAllowed();
        bookingId = ++bookingCount;
        bookings[bookingId] = Booking(shopId, msg.sender, slotStart, msg.value, Status.Held);
        _byShop[shopId].push(bookingId);
        _byCustomer[msg.sender].push(bookingId);
        Stats storage st = shopStats[shopId];
        st.booked++;
        if (!_seen[shopId][msg.sender]) {
            _seen[shopId][msg.sender] = true;
            st.uniqueCustomers++;
        }
        totalHeld += msg.value;
        emit Booked(bookingId, shopId, msg.sender, slotStart, msg.value);
    }

    /// @notice Customer cancels before the free-cancel window closes.
    function cancel(uint256 bookingId) external nonReentrant {
        Booking storage b = _held(bookingId);
        if (msg.sender != b.customer) revert NotAllowed();
        if (block.timestamp >= uint256(b.slotStart) - shops[b.shopId].cancelWindow) revert TooLateToCancel();
        uint256 amount = _refund(b);
        shopStats[b.shopId].cancelled++;
        emit Cancelled(bookingId, b.customer, amount);
        _send(b.customer, amount);
    }

    /// @notice Anyone may submit a valid pass (the guest, or the shop's tablet so the guest pays no gas);
    ///         the refund always goes to the booking's customer.
    function checkIn(uint256 bookingId, uint64 validUntil, bytes calldata pass) external nonReentrant {
        Booking storage b = _held(bookingId);
        Shop storage s = shops[b.shopId];
        if (block.timestamp > validUntil) revert PassExpired();
        if (block.timestamp >= uint256(b.slotStart) + s.grace) revert TooLate();
        if (!_validPass(s.signer, passDigest(bookingId, validUntil), pass)) revert BadPass();
        uint256 amount = _refund(b);
        shopStats[b.shopId].checkedIn++;
        emit CheckedIn(bookingId, b.customer, amount);
        _send(b.customer, amount);
    }

    /// @notice Shop forgives the deposit or cancels the slot itself.
    function release(uint256 bookingId) external nonReentrant {
        Booking storage b = _held(bookingId);
        if (msg.sender != shops[b.shopId].owner) revert NotAllowed();
        uint256 amount = _refund(b);
        shopStats[b.shopId].released++;
        emit Released(bookingId, b.customer, amount);
        _send(b.customer, amount);
    }

    /// @notice Escape hatch: if a deposit is still held long after the slot (shop key lost),
    ///         the customer takes it back.
    function reclaim(uint256 bookingId) external nonReentrant {
        Booking storage b = _held(bookingId);
        if (msg.sender != b.customer) revert NotAllowed();
        if (block.timestamp < uint256(b.slotStart) + shops[b.shopId].grace + RECLAIM_AFTER) revert TooEarly();
        uint256 amount = _refund(b);
        shopStats[b.shopId].reclaimed++;
        emit Reclaimed(bookingId, b.customer, amount);
        _send(b.customer, amount);
    }

    /// @notice Shop takes a no-show deposit, only after slotStart + grace.
    function claim(uint256 bookingId) external nonReentrant {
        Booking storage b = _held(bookingId);
        Shop storage s = shops[b.shopId];
        if (msg.sender != s.owner) revert NotAllowed();
        if (block.timestamp < uint256(b.slotStart) + s.grace) revert TooEarly();
        // claim window closes when the guest's reclaim opens — no race between the two
        if (block.timestamp >= uint256(b.slotStart) + s.grace + RECLAIM_AFTER) revert TooLate();
        uint256 amount = b.amount;
        b.status = Status.Claimed;
        totalHeld -= amount;
        shopStats[b.shopId].claimed++;
        emit Claimed(bookingId, s.payout, amount);
        _send(s.payout, amount);
    }

    /// @notice Pull a payout that could not be pushed (recipient contract refused or needed too much gas).
    function withdraw() external nonReentrant {
        uint256 amount = owed[msg.sender];
        if (amount == 0) revert NothingOwed();
        owed[msg.sender] = 0;
        totalOwed -= amount;
        emit Withdrawn(msg.sender, amount);
        (bool ok,) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert NotAllowed();
    }

    // ---------------------------------------------------------------- views

    function statusOf(uint256 bookingId) external view returns (Status) {
        return bookings[bookingId].status;
    }

    function bookingsOfShop(uint256 shopId, uint256 offset, uint256 limit) external view returns (uint256[] memory) {
        return _page(_byShop[shopId], offset, limit);
    }

    function bookingsOfCustomer(address customer, uint256 offset, uint256 limit) external view returns (uint256[] memory) {
        return _page(_byCustomer[customer], offset, limit);
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

    function _updated(uint256 shopId, Shop storage s) private {
        emit ShopUpdated(shopId, s.owner, s.payout, s.signer, s.active);
    }

    function _held(uint256 bookingId) private view returns (Booking storage b) {
        b = bookings[bookingId];
        if (b.status != Status.Held) revert NotHeld();
    }

    function _refund(Booking storage b) private returns (uint256 amount) {
        amount = b.amount;
        b.status = Status.Refunded;
        totalHeld -= amount;
    }

    /// Push the payout; if the recipient refuses (blocked address, reverting contract, gas-hungry
    /// receiver), park it as a withdrawable credit so the settlement itself never fails.
    function _send(address to, uint256 amount) private {
        (bool ok,) = payable(to).call{value: amount, gas: SEND_GAS}("");
        if (!ok) {
            owed[to] += amount;
            totalOwed += amount;
            emit Owed(to, amount);
        }
    }

    function _page(uint256[] storage all, uint256 offset, uint256 limit) private view returns (uint256[] memory out) {
        if (offset >= all.length) return new uint256[](0);
        uint256 end = offset + limit > all.length ? all.length : offset + limit;
        out = new uint256[](end - offset);
        for (uint256 i = offset; i < end; i++) out[i - offset] = all[i];
    }

    function _validPass(address signer, bytes32 digest, bytes calldata sig) private view returns (bool) {
        // Plain signatures first: this also covers EIP-7702 delegated EOAs, which have code but a real key.
        if (sig.length == 65) {
            bytes32 r = bytes32(sig[0:32]);
            bytes32 s = bytes32(sig[32:64]);
            uint8 v = uint8(sig[64]);
            if (uint256(s) <= HALF_N && (v == 27 || v == 28)) {
                address got = ecrecover(digest, v, r, s);
                if (got != address(0) && got == signer) return true;
            }
        }
        if (signer.code.length == 0) return false;
        // EIP-1271 contract signer: bounded gas, at most 32 bytes of return data copied, magic compared by hand.
        bytes memory data = abi.encodeWithSelector(ERC1271_MAGIC, digest, sig);
        bool ok;
        bytes32 word;
        uint256 size;
        uint256 g = ERC1271_GAS;
        assembly ("memory-safe") {
            ok := staticcall(g, signer, add(data, 0x20), mload(data), 0, 0x20)
            size := returndatasize()
            word := mload(0)
        }
        return ok && size >= 32 && bytes4(word) == ERC1271_MAGIC;
    }
}
