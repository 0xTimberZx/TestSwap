// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IPoolLedger {
    function collect(address from, uint256 amount) external;
    function fundSeed(address from, uint256 amount) external;
    function creditWinnings(address[] calldata recipients, uint256[] calldata amounts) external;
    function refund(address to, uint256 amount) external;
    function sweep(address to, uint256 amount) external;
    function unowed() external view returns (uint256);
}

interface ISeedRegistry {
    function markUsed(uint256 round) external;
}

interface IEntropy {
    function deriveEntropy(bytes32 commitment, bytes32 secret, uint256 lockBlock, bytes32 salt)
        external view returns (bytes32);
    function fallbackEntropy(uint256 lockBlock, bytes32 salt) external view returns (bytes32);
}

interface ITimbPrize {
    function roundWinningString(uint256 round) external view returns (bytes6);
}

/**
 * @title SegmentBoard
 * @notice The SwapTables roulette board: one immutable generation of segment
 *         tables. Seats players, holds their six per-segment tokens, settles the
 *         seven pools per table pari-mutuel, and retires at six.
 *         Spec: SwapTables/docs/SEGMENT_TABLES.md §5-§10, §13.
 */
contract SegmentBoard is Ownable, ReentrancyGuard {
    string constant ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

    uint8 public constant SEGMENTS = 6;
    uint8 public constant POOLS = 7;
    uint8 public constant DD_POOL = 6;

    uint8 public constant SEATS_MIN = 2;
    uint8 public constant SEATS_HARD_MAX = 12;
    uint8 public constant SEED_MIN_WALLETS = 2;

    uint256 public constant TABLE_SEED = 100e18;
    uint256 public constant SEED_SHARE = TABLE_SEED / POOLS;

    uint256 public constant RAKE_BASE = 800;
    uint256 public constant RAKE_FLOOR = 175;
    uint256 public constant BPS = 10000;

    uint256 public constant WEIGHT_SCALE = 10000;
    uint256 public constant REVEAL_WINDOW = 64;

    uint64 constant RED_MASK = 0x1555555555;
    uint64 constant VOWEL_MASK = uint64((1 << 0) | (1 << 4) | (1 << 8) | (1 << 14) | (1 << 20) | (1 << 24));

    uint8 public constant KIND_EXACTLY = 0;
    uint8 public constant KIND_COLUMN = 1;
    uint8 public constant KIND_DOZEN = 2;
    uint8 public constant KIND_VOWELS = 3;
    uint8 public constant KIND_COLOR = 4;
    uint8 public constant KIND_LETTER = 5;
    uint8 public constant KIND_NUMBER = 6;
    uint8 public constant KIND_LOWHIGH = 7;
    uint8 public constant KIND_YOURTICKET = 8;
    uint8 public constant KIND_DOUBLEDIGIT = 9;
    uint8 constant KIND_COUNT = 10;

    IPoolLedger public immutable ledger;
    ISeedRegistry public immutable seedRegistry;
    IEntropy public immutable entropy;
    ITimbPrize public immutable timbPrize;
    address public immutable treasury;

    uint64 public immutable entryWindow;
    uint64 public immutable pickDelay;
    uint64 public immutable betsCloseLead;

    address public guardian;
    bool public newTablesHalted;
    bool public newBetsHalted;

    struct Table {
        uint64 openedAt;
        uint64 pickTime;
        uint64 lockBlock;
        uint32 seedRound;
        uint8 seatCount;
        uint8 lockedMask;
        bool ddSettled;
        bool retired;
        bytes6 seedString;
        bytes6 lockedChars;
    }

    struct Seat {
        uint64 chipPack;
        uint8 placedMask;
        uint8 ddChip;
        bool seated;
        bytes6 ticket;
    }

    struct Bet {
        address wallet;
        uint8 chipIdx;
        uint8 kind;
        uint8 pick;
    }

    uint256 public tableCount;

    mapping(uint256 => Table) public tables;
    mapping(uint256 => address[]) public seatList;
    mapping(uint256 => mapping(address => Seat)) public seats;
    mapping(uint256 => mapping(uint8 => Bet[])) internal _bets;
    mapping(uint256 => mapping(uint8 => bytes32)) public commitments;

    uint256[7] public CHIPS = [5e18, 10e18, 25e18, 50e18, 100e18, 500e18, 1000e18];

    error ZeroAddress();
    error NotGuardian();
    error Halted();
    error TableUnknown();
    error TableClosedForEntry();
    error TableRetiredAlready();
    error AlreadySeated();
    error NotSeated();
    error TableFull();
    error NotEnoughSeats(uint8 seated, uint8 required);
    error BadChip();
    error NotLoaded();
    error AlreadyLoaded();
    error BetsClosed();
    error AlreadyPlaced(uint8 segment);
    error BadSegment();
    error BadKind();
    error BadPick();
    error NotYetPickTime();
    error NotArmed();
    error AlreadyArmed();
    error SameBlockAsArm();
    error SegmentAlreadyLocked(uint8 segment);
    error RevealWindowOpen();
    error SegmentsOutstanding();
    error SeedNotSettled(uint256 round);

    event TableOpened(uint256 indexed tableId, uint256 indexed seedRound, bytes6 seedString, uint64 pickTime);
    event Seated(uint256 indexed tableId, address indexed wallet);
    event TokensLoaded(uint256 indexed tableId, address indexed wallet, uint256 total);
    event BetPlaced(uint256 indexed tableId, uint8 indexed pool, address indexed wallet, uint8 kind, uint8 pick);
    event TableArmed(uint256 indexed tableId, uint256 lockBlock);
    event SegmentLocked(uint256 indexed tableId, uint8 indexed segment, bytes1 lockedChar, bool viaFallback);
    event PoolSettled(uint256 indexed tableId, uint8 indexed pool, uint256 pot, uint256 rake, uint256 distributed);
    event TableRetired(uint256 indexed tableId, uint256 sweptToTreasury);
    event GuardianSet(address indexed guardian);
    event NewTablesHalted(bool halted);
    event NewBetsHalted(bool halted);

    modifier onlyGuardian() {
        if (guardian != address(0) && msg.sender != guardian) revert NotGuardian();
        _;
    }

    constructor(
        address _ledger,
        address _seedRegistry,
        address _entropy,
        address _timbPrize,
        address _treasury,
        address _guardian,
        uint64 _entryWindow,
        uint64 _pickDelay,
        uint64 _betsCloseLead
    ) Ownable(msg.sender) {
        if (_ledger == address(0) || _seedRegistry == address(0) || _entropy == address(0) || _timbPrize == address(0) || _treasury == address(0)) {
            revert ZeroAddress();
        }
        ledger = IPoolLedger(_ledger);
        seedRegistry = ISeedRegistry(_seedRegistry);
        entropy = IEntropy(_entropy);
        timbPrize = ITimbPrize(_timbPrize);
        treasury = _treasury;
        guardian = _guardian;
        entryWindow = _entryWindow;
        pickDelay = _pickDelay;
        betsCloseLead = _betsCloseLead;
    }

    function openTable(uint256 seedRound, bytes32[6] calldata segmentCommitments) external nonReentrant returns (uint256 tableId) {
        if (newTablesHalted) revert Halted();
        bytes6 seedString = timbPrize.roundWinningString(seedRound);
        if (seedString == bytes6(0)) revert SeedNotSettled(seedRound);
        seedRegistry.markUsed(seedRound);
        tableId = ++tableCount;
        Table storage t = tables[tableId];
        t.openedAt = uint64(block.timestamp);
        t.pickTime = uint64(block.timestamp) + pickDelay;
        t.seedRound = uint32(seedRound);
        t.seedString = seedString;
        for (uint8 i; i < SEGMENTS; ++i) {
            commitments[tableId][i + 1] = segmentCommitments[i];
        }
        ledger.fundSeed(treasury, TABLE_SEED);
        emit TableOpened(tableId, seedRound, seedString, t.pickTime);
        return tableId;
    }

    function sit(uint256 tableId, bytes6 ticket) external {
        Table storage t = _liveTable(tableId);
        if (block.timestamp >= t.openedAt + entryWindow) revert TableClosedForEntry();
        if (t.seatCount >= SEATS_HARD_MAX) revert TableFull();
        Seat storage s = seats[tableId][msg.sender];
        if (s.seated) revert AlreadySeated();
        s.seated = true;
        s.ticket = ticket;
        ++t.seatCount;
        seatList[tableId].push(msg.sender);
        emit Seated(tableId, msg.sender);
    }

    function loadTokens(uint256 tableId, uint8[6] calldata chipIdxs) external nonReentrant {
        Table storage t = _liveTable(tableId);
        if (block.timestamp >= t.openedAt + entryWindow) revert TableClosedForEntry();
        Seat storage s = seats[tableId][msg.sender];
        if (!s.seated) revert NotSeated();
        if (s.chipPack != 0) revert AlreadyLoaded();
        uint256 total;
        uint64 pack;
        for (uint8 i; i < SEGMENTS; ++i) {
            uint8 c = chipIdxs[i];
            if (c >= CHIPS.length) revert BadChip();
            total += CHIPS[c];
            pack |= uint64(uint64(c) + 1) << (8 * i);
        }
        s.chipPack = pack;
        ledger.collect(msg.sender, total);
        emit TokensLoaded(tableId, msg.sender, total);
    }

    function place(uint256 tableId, uint8 segment, uint8 kind, uint8 pick) external {
        Table storage t = _liveTable(tableId);
        if (newBetsHalted) revert Halted();
        if (segment == 0 || segment > SEGMENTS) revert BadSegment();
        if (block.timestamp + betsCloseLead >= t.pickTime) revert BetsClosed();
        Seat storage s = seats[tableId][msg.sender];
        if (!s.seated) revert NotSeated();
        if (s.chipPack == 0) revert NotLoaded();
        uint8 bit = uint8(1) << (segment - 1);
        if (s.placedMask & bit != 0) revert AlreadyPlaced(segment);
        if (kind >= KIND_COUNT || kind == KIND_DOUBLEDIGIT) revert BadKind();
        _validatePick(kind, pick);
        s.placedMask |= bit;
        uint8 chipIdx = uint8((s.chipPack >> (8 * (segment - 1))) & 0xFF) - 1;
        _bets[tableId][segment - 1].push(Bet({wallet: msg.sender, chipIdx: chipIdx, kind: kind, pick: pick}));
        emit BetPlaced(tableId, segment - 1, msg.sender, kind, pick);
    }

    function placeDoubleDigit(uint256 tableId, uint8 chipIdx) external nonReentrant {
        Table storage t = _liveTable(tableId);
        if (newBetsHalted) revert Halted();
        if (block.timestamp + betsCloseLead >= t.pickTime) revert BetsClosed();
        if (chipIdx >= CHIPS.length) revert BadChip();
        Seat storage s = seats[tableId][msg.sender];
        if (!s.seated) revert NotSeated();
        if (s.ddChip != 0) revert AlreadyPlaced(DD_POOL);
        s.ddChip = chipIdx + 1;
        ledger.collect(msg.sender, CHIPS[chipIdx]);
        _bets[tableId][DD_POOL].push(Bet({wallet: msg.sender, chipIdx: chipIdx, kind: KIND_DOUBLEDIGIT, pick: 0}));
        emit BetPlaced(tableId, DD_POOL, msg.sender, KIND_DOUBLEDIGIT, 0);
    }

    function armTable(uint256 tableId) external {
        Table storage t = _liveTable(tableId);
        if (block.timestamp < t.pickTime) revert NotYetPickTime();
        if (t.lockBlock != 0) revert AlreadyArmed();
        if (t.seatCount < SEATS_MIN) revert NotEnoughSeats(t.seatCount, SEATS_MIN);
        t.lockBlock = uint64(block.number);
        emit TableArmed(tableId, block.number);
    }

    function lockSegment(uint256 tableId, uint8 segment, bytes32 secret) external nonReentrant {
        Table storage t = _prepLock(tableId, segment);
        bytes32 e = entropy.deriveEntropy(commitments[tableId][segment], secret, t.lockBlock, _salt(tableId, segment));
        _applyLock(tableId, t, segment, e, false);
    }

    function lockSegmentFallback(uint256 tableId, uint8 segment) external nonReentrant {
        Table storage t = _prepLock(tableId, segment);
        if (block.number <= t.lockBlock + REVEAL_WINDOW) revert RevealWindowOpen();
        bytes32 e = entropy.fallbackEntropy(t.lockBlock, _salt(tableId, segment));
        _applyLock(tableId, t, segment, e, true);
    }

    function _prepLock(uint256 tableId, uint8 segment) internal view returns (Table storage t) {
        t = _liveTable(tableId);
        if (segment == 0 || segment > SEGMENTS) revert BadSegment();
        if (t.lockBlock == 0) revert NotArmed();
        if (block.number <= t.lockBlock) revert SameBlockAsArm();
        if (t.lockedMask & (uint8(1) << (segment - 1)) != 0) revert SegmentAlreadyLocked(segment);
        return t;
    }

    function _applyLock(uint256 tableId, Table storage t, uint8 segment, bytes32 e, bool viaFallback) internal {
        uint8 idx = uint8(uint256(e) % 36);
        bytes1 c = bytes(ALPHABET)[idx];
        bytes6 memory newChars = t.lockedChars;
        newChars[5 - uint256(segment - 1)] = c;
        t.lockedChars = newChars;
        t.lockedMask |= uint8(1) << (segment - 1);
        emit SegmentLocked(tableId, segment, c, viaFallback);
        _settlePool(tableId, segment - 1, idx, false);
        if (t.lockedMask == 0x3F && !t.ddSettled) {
            t.ddSettled = true;
            _settlePool(tableId, DD_POOL, 0, _hasRepeat(t.lockedChars));
        }
    }

    function _settlePool(uint256 tableId, uint8 pool, uint8 charIdx, bool ddWins) internal {
        Bet[] storage bs = _bets[tableId][pool];
        uint256 n = bs.length;
        if (n == 0) {
            emit PoolSettled(tableId, pool, 0, 0, 0);
            return;
        }
        uint256 pot = _potOf(bs, n);
        uint256 distributable = (pot * (BPS - (RAKE_FLOOR + (RAKE_BASE - RAKE_FLOOR) / n))) / BPS;
        (address[] memory who, uint256[] memory amt, uint256 totalWeight) = _weigh(tableId, pool, charIdx, ddWins);
        uint256 distributed;
        if (totalWeight > 0) {
            for (uint256 i; i < n; ++i) {
                if (amt[i] == 0) continue;
                uint256 pay = (distributable * amt[i]) / totalWeight;
                amt[i] = pay;
                distributed += pay;
            }
            ledger.creditWinnings(who, amt);
        }
        emit PoolSettled(tableId, pool, pot, pot - distributed, distributed);
    }

    function _potOf(Bet[] storage bs, uint256 n) internal view returns (uint256) {
        uint256 pot;
        for (uint256 i; i < n; ++i) {
            pot += CHIPS[bs[i].chipIdx];
        }
        if (n >= SEED_MIN_WALLETS) pot += SEED_SHARE;
        return pot;
    }

    function _weigh(uint256 tableId, uint8 pool, uint8 charIdx, bool ddWins) internal view returns (address[] memory who, uint256[] memory amt, uint256 totalWeight) {
        Bet[] storage bs = _bets[tableId][pool];
        uint256 n = bs.length;
        who = new address[](n);
        amt = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            Bet storage b = bs[i];
            address wallet = b.wallet;
            who[i] = wallet;
            bool won;
            if (pool == DD_POOL) {
                won = ddWins;
            } else {
                bytes1 tc = _getTicketChar(tableId, wallet, pool);
                won = _wins(b.kind, b.pick, charIdx, tc);
            }
            if (won) {
                uint256 weight = CHIPS[b.chipIdx] * _weightBps(b.kind);
                amt[i] = weight;
                totalWeight += weight;
            } else {
                amt[i] = 0;
            }
        }
        return (who, amt, totalWeight);
    }

    function _getTicketChar(uint256 tableId, address wallet, uint8 pool) internal view returns (bytes1) {
        Seat storage s = seats[tableId][wallet];
        return s.ticket[pool];
    }

    function retire(uint256 tableId) external nonReentrant {
        Table storage t = _liveTable(tableId);
        if (t.lockedMask != 0x3F) revert SegmentsOutstanding();
        address[] storage list = seatList[tableId];
        uint256 len = list.length;
        for (uint256 i; i < len; ++i) {
            Seat storage s = seats[tableId][list[i]];
            if (s.chipPack == 0) continue;
            uint256 owed;
            for (uint8 g; g < SEGMENTS; ++g) {
                if (s.placedMask & (uint8(1) << g) != 0) continue;
                uint8 packed = uint8((s.chipPack >> (8 * g)) & 0xFF);
                if (packed == 0) continue;
                owed += CHIPS[packed - 1];
            }
            if (owed > 0) ledger.refund(list[i], owed);
        }
        t.retired = true;
        uint256 leftover = ledger.unowed();
        if (leftover > 0) ledger.sweep(treasury, leftover);
        emit TableRetired(tableId, leftover);
    }

    function setNewTablesHalted(bool halted) external onlyGuardian {
        newTablesHalted = halted;
        emit NewTablesHalted(halted);
    }

    function setNewBetsHalted(bool halted) external onlyGuardian {
        newBetsHalted = halted;
        emit NewBetsHalted(halted);
    }

    function retireGuardian() external onlyGuardian {
        guardian = address(0);
        emit GuardianSet(address(0));
    }

    function setGuardian(address _guardian) external onlyOwner {
        guardian = _guardian;
        emit GuardianSet(_guardian);
    }

    function betCount(uint256 tableId, uint8 pool) external view returns (uint256) {
        return _bets[tableId][pool].length;
    }

    function betAt(uint256 tableId, uint8 pool, uint256 i) external view returns (Bet memory) {
        return _bets[tableId][pool][i];
    }

    function weightBps(uint8 kind) external pure returns (uint256) {
        return _weightBps(kind);
    }

    function hasRepeat(bytes6 s) external pure returns (bool) {
        return _hasRepeat(s);
    }

    function isRed(uint8 idx) external pure returns (bool) {
        return ((RED_MASK >> idx) & 1) != 0;
    }

    function lockedCharsOf(uint256 tableId) external view returns (bytes6) {
        return tables[tableId].lockedChars;
    }

    function _liveTable(uint256 tableId) internal view returns (Table storage t) {
        if (tableId == 0 || tableId > tableCount) revert TableUnknown();
        t = tables[tableId];
        if (t.retired) revert TableRetiredAlready();
        return t;
    }

    function _salt(uint256 tableId, uint8 segment) internal pure returns (bytes32) {
        return keccak256(abi.encode(tableId, segment));
    }

    function _weightBps(uint8 kind) internal pure returns (uint256) {
        if (kind == KIND_EXACTLY || kind == KIND_YOURTICKET) return 35 * WEIGHT_SCALE;
        if (kind == KIND_COLUMN || kind == KIND_DOZEN) return 2 * WEIGHT_SCALE;
        if (kind == KIND_VOWELS) return 5 * WEIGHT_SCALE;
        if (kind == KIND_COLOR || kind == KIND_LOWHIGH) return WEIGHT_SCALE;
        if (kind == KIND_LETTER) return (35 * WEIGHT_SCALE) / 26 * 26 + (35 * WEIGHT_SCALE) % 26;
        if (kind == KIND_NUMBER) return (35 * WEIGHT_SCALE) / 10 * 10 + (35 * WEIGHT_SCALE) % 10;
        if (kind == KIND_DOUBLEDIGIT) return (18 * WEIGHT_SCALE + 9) / 10;
        revert BadKind();
    }

    function _validatePick(uint8 kind, uint8 pick) internal pure {
        if (kind == KIND_EXACTLY) {
            if (pick >= 36) revert BadPick();
        } else if (kind == KIND_COLUMN || kind == KIND_DOZEN) {
            if (pick > 2) revert BadPick();
        } else if (kind == KIND_COLOR || kind == KIND_LOWHIGH) {
            if (pick > 1) revert BadPick();
        } else if (pick != 0) {
            revert BadPick();
        }
    }

    function _wins(uint8 kind, uint8 pick, uint8 idx, bytes1 ticketChar) internal pure returns (bool won) {
        if (kind == KIND_EXACTLY) return idx == pick;
        if (kind == KIND_COLUMN) return idx % 3 == pick;
        if (kind == KIND_DOZEN) return idx / 12 == pick;
        if (kind == KIND_VOWELS) return ((VOWEL_MASK >> idx) & 1) != 0;
        if (kind == KIND_COLOR) {
            bool isRed = ((RED_MASK >> idx) & 1) != 0;
            return pick == 0 ? isRed : !isRed;
        }
        if (kind == KIND_LETTER) return idx < 26;
        if (kind == KIND_NUMBER) return idx >= 26;
        if (kind == KIND_LOWHIGH) return pick == 0 ? idx < 18 : idx >= 18;
        if (kind == KIND_YOURTICKET) return ticketChar == bytes(ALPHABET)[idx];
        return false;
    }

    function _hasRepeat(bytes6 s) internal pure returns (bool) {
        for (uint256 i = 0; i < 6; ++i) {
            for (uint256 j = i + 1; j < 6; ++j) {
                if (s[i] == s[j]) return true;
            }
        }
        return false;
    }
}
