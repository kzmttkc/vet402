// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {RwaAnchor} from "../RwaAnchor.sol";

/// The few Foundry cheatcodes these tests use, declared here so the project has
/// no git submodule and no library to install. Same address and signatures as forge-std.
interface Vm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function expectRevert(bytes calldata revertData) external;
    function expectEmit(bool checkTopic1, bool checkTopic2, bool checkTopic3, bool checkData, address emitter) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
    function prank(address sender) external;
    function assume(bool condition) external pure;
    function record() external;
    function accesses(address target) external returns (bytes32[] memory reads, bytes32[] memory writes);
    function load(address target, bytes32 slot) external view returns (bytes32);
    function deal(address account, uint256 newBalance) external;
    function readFile(string calldata path) external view returns (string memory);
    function parseJsonBytes32(string calldata json, string calldata key) external pure returns (bytes32);
    function parseJsonBytes(string calldata json, string calldata key) external pure returns (bytes memory);
    function parseJsonUint(string calldata json, string calldata key) external pure returns (uint256);
}

abstract contract Base {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    bytes32 internal constant ANCHORED_TOPIC = keccak256("Anchored(bytes32,bytes32,uint32,uint64,address)");

    function eq(uint256 a, uint256 b, string memory what) internal pure {
        require(a == b, what);
    }

    function eq(bytes32 a, bytes32 b, string memory what) internal pure {
        require(a == b, what);
    }

    function eq(address a, address b, string memory what) internal pure {
        require(a == b, what);
    }

    function eq(bytes memory a, bytes memory b, string memory what) internal pure {
        require(keccak256(a) == keccak256(b), what);
    }

    function reason(string memory s) internal pure returns (bytes memory) {
        return abi.encodeWithSignature("Error(string)", s);
    }

    /// One Anchored log, checked field by field against what was sent.
    function checkLog(Vm.Log memory log, address emitter, bytes32 subject, bytes32 factsHash, uint32 mv, uint64 asOf, address by)
        internal
        pure
    {
        eq(log.emitter, emitter, "emitter");
        eq(log.topics.length, 4, "three indexed fields plus the signature");
        eq(log.topics[0], ANCHORED_TOPIC, "event signature");
        eq(log.topics[0], RwaAnchor.Anchored.selector, "event selector");
        eq(log.topics[1], subject, "subject");
        eq(log.topics[2], factsHash, "factsHash");
        eq(log.topics[3], bytes32(uint256(uint160(by))), "anchoredBy");
        eq(log.data, abi.encode(mv, asOf), "data is methodVersion then asOf");
        (uint32 mvOut, uint64 asOfOut) = abi.decode(log.data, (uint32, uint64));
        eq(mvOut, mv, "methodVersion");
        eq(asOfOut, asOf, "asOf");
    }
}

contract RwaAnchorTest is Base {
    RwaAnchor internal anchor;

    // The record anchored on Robinhood Chain on 2026-09-27 (fixtures/rwa/anchor.json).
    bytes32 internal constant SUBJECT = 0xa158baaf573f2b072b47acaa019ef60de680571a8a2a6ad234faf0e8a3d3bfc5;
    bytes32 internal constant FACTS = 0xd155c8b1b71125aa922fcb517f047e1a42a0aaf6d028f2cf3470ad1372c8f579;
    uint32 internal constant MV = 1;
    uint64 internal constant AS_OF = 1790545228;
    address internal constant OPERATOR = 0x973cD8a91A771C2C04C6036888F8175D6b4F6227;

    function setUp() public {
        anchor = new RwaAnchor();
    }

    // ---- revert conditions ----

    function test_RevertsOnZeroSubject() public {
        vm.expectRevert(reason("subject required"));
        anchor.anchor(bytes32(0), FACTS, MV, AS_OF);
    }

    function test_RevertsOnZeroFactsHash() public {
        vm.expectRevert(reason("factsHash required"));
        anchor.anchor(SUBJECT, bytes32(0), MV, AS_OF);
    }

    function test_RevertsOnZeroAsOf() public {
        vm.expectRevert(reason("asOf required"));
        anchor.anchor(SUBJECT, FACTS, MV, 0);
    }

    function test_ChecksRunInOrderSubjectFactsAsOf() public {
        vm.expectRevert(reason("subject required"));
        anchor.anchor(bytes32(0), bytes32(0), MV, 0);
        vm.expectRevert(reason("factsHash required"));
        anchor.anchor(SUBJECT, bytes32(0), MV, 0);
    }

    function test_ARevertedCallLeavesNoTrace() public {
        vm.recordLogs();
        (bool ok,) = address(anchor).call(abi.encodeCall(RwaAnchor.anchor, (bytes32(0), FACTS, MV, AS_OF)));
        require(!ok, "must revert");
        eq(vm.getRecordedLogs().length, 0, "no log");
        eq(anchor.count(), 0, "count unchanged");
    }

    /// methodVersion is not checked on chain: the reader decides what a version means.
    function test_MethodVersionZeroIsAccepted() public {
        anchor.anchor(SUBJECT, FACTS, 0, AS_OF);
        eq(anchor.count(), 1, "count");
    }

    // ---- the event ----

    function test_EmitsEveryFieldOfTheLiveRecord() public {
        vm.expectEmit(true, true, true, true, address(anchor));
        emit RwaAnchor.Anchored(SUBJECT, FACTS, MV, AS_OF, OPERATOR);
        vm.prank(OPERATOR);
        anchor.anchor(SUBJECT, FACTS, MV, AS_OF);
    }

    function test_LogLayoutIsWhatVerifiersDecode() public {
        vm.recordLogs();
        vm.prank(OPERATOR);
        anchor.anchor(SUBJECT, FACTS, MV, AS_OF);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        eq(logs.length, 1, "exactly one log");
        checkLog(logs[0], address(anchor), SUBJECT, FACTS, MV, AS_OF, OPERATOR);
    }

    function test_AnchoredByIsTheSenderNotTheOrigin() public {
        address relayer = address(0xBEEF);
        vm.recordLogs();
        vm.prank(relayer);
        anchor.anchor(SUBJECT, FACTS, MV, AS_OF);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        eq(logs[0].topics[3], bytes32(uint256(uint160(relayer))), "anchoredBy is msg.sender");
    }

    // ---- count ----

    function test_CountStartsAtZeroAndAddsOnePerRecord() public {
        eq(anchor.count(), 0, "starts at 0");
        anchor.anchor(SUBJECT, FACTS, MV, AS_OF);
        eq(anchor.count(), 1, "1");
        anchor.anchor(SUBJECT, FACTS, MV, AS_OF);
        eq(anchor.count(), 2, "the same record twice is two records");
        anchor.anchor(bytes32(uint256(1)), bytes32(uint256(2)), 2, 3);
        eq(anchor.count(), 3, "3");
    }

    function test_OnlyStorageSlotZeroIsEverWritten() public {
        vm.record();
        anchor.anchor(SUBJECT, FACTS, MV, AS_OF);
        (, bytes32[] memory writes) = vm.accesses(address(anchor));
        eq(writes.length, 1, "one write");
        eq(writes[0], bytes32(0), "slot 0 is count");
        eq(vm.load(address(anchor), bytes32(0)), bytes32(uint256(1)), "slot 0 holds count");
        eq(vm.load(address(anchor), bytes32(uint256(1))), bytes32(0), "slot 1 untouched");
    }

    // ---- fuzz ----

    function testFuzz_AnyNonZeroInputIsRecordedExactly(
        bytes32 subject,
        bytes32 factsHash,
        uint32 mv,
        uint64 asOf,
        address sender,
        uint8 before
    ) public {
        vm.assume(subject != 0 && factsHash != 0 && asOf != 0);
        for (uint256 i = 0; i < before; i++) {
            anchor.anchor(bytes32(i + 1), bytes32(i + 1), 1, 1);
        }
        uint256 countBefore = anchor.count();
        vm.recordLogs();
        vm.prank(sender);
        anchor.anchor(subject, factsHash, mv, asOf);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        eq(logs.length, 1, "one log");
        checkLog(logs[0], address(anchor), subject, factsHash, mv, asOf, sender);
        eq(anchor.count(), countBefore + 1, "count + 1");
    }

    function testFuzz_RevertsIffARequiredFieldIsZero(bytes32 subject, bytes32 factsHash, uint32 mv, uint64 asOf) public {
        bool shouldRevert = subject == 0 || factsHash == 0 || asOf == 0;
        uint256 countBefore = anchor.count();
        vm.recordLogs();
        (bool ok,) = address(anchor).call(abi.encodeCall(RwaAnchor.anchor, (subject, factsHash, mv, asOf)));
        require(ok == !shouldRevert, "reverts exactly when a required field is zero");
        eq(vm.getRecordedLogs().length, ok ? 1 : 0, "a log only on success");
        eq(anchor.count(), countBefore + (ok ? 1 : 0), "count follows success");
    }

    // ---- no owner, no admin, no upgrade, no ether ----

    /// The runtime answers exactly two selectors. Everything else reverts: there is
    /// no fallback, no receive, and no function that is not in onchain.json.
    function testFuzz_UnknownSelectorsRevert(bytes4 sel, bytes calldata tail) public {
        vm.assume(sel != anchor.count.selector && sel != anchor.anchor.selector);
        (bool ok,) = address(anchor).call(abi.encodePacked(sel, tail));
        require(!ok, "unknown selector must revert");
    }

    function test_SelectorListIsFixed() public view {
        eq(uint256(uint32(anchor.count.selector)), 0x06661abd, "count()");
        eq(uint256(uint32(anchor.anchor.selector)), 0xea77b5a7, "anchor(bytes32,bytes32,uint32,uint64)");
    }

    function test_AdminAndUpgradeSelectorsDoNotExist() public {
        bytes[9] memory probes = [
            abi.encodeWithSignature("owner()"),
            abi.encodeWithSignature("transferOwnership(address)", address(this)),
            abi.encodeWithSignature("renounceOwnership()"),
            abi.encodeWithSignature("upgradeTo(address)", address(this)),
            abi.encodeWithSignature("upgradeToAndCall(address,bytes)", address(this), ""),
            abi.encodeWithSignature("initialize()"),
            abi.encodeWithSignature("pause()"),
            abi.encodeWithSignature("implementation()"),
            abi.encodeWithSignature("proxiableUUID()")
        ];
        for (uint256 i = 0; i < probes.length; i++) {
            (bool ok,) = address(anchor).call(probes[i]);
            require(!ok, "admin or upgrade selector answered");
        }
    }

    function test_RejectsEther() public {
        vm.deal(address(this), 1 ether);
        (bool plain,) = address(anchor).call{value: 1}("");
        require(!plain, "plain transfer must revert");
        (bool withCall,) =
            address(anchor).call{value: 1}(abi.encodeCall(RwaAnchor.anchor, (SUBJECT, FACTS, MV, AS_OF)));
        require(!withCall, "anchor is not payable");
        eq(address(anchor).balance, 0, "holds no ether");
    }

    /// Reentrancy, delegatecall and self-destruct need an opcode that calls out,
    /// creates, or destroys. Walk the runtime (skipping PUSH data and the metadata
    /// tail) and show none of them is there.
    function test_RuntimeHasNoCallCreateDelegatecallOrSelfdestruct() public view {
        bytes memory code = address(anchor).code;
        uint256 metaLen = (uint256(uint8(code[code.length - 2])) << 8) | uint256(uint8(code[code.length - 1]));
        uint256 end = code.length - metaLen - 2;
        uint256 sstores;
        for (uint256 i = 0; i < end; i++) {
            uint8 op = uint8(code[i]);
            require(op != 0xf0, "CREATE");
            require(op != 0xf1, "CALL");
            require(op != 0xf2, "CALLCODE");
            require(op != 0xf4, "DELEGATECALL");
            require(op != 0xf5, "CREATE2");
            require(op != 0xfa, "STATICCALL");
            require(op != 0xff, "SELFDESTRUCT");
            if (op == 0x55) sstores++;
            if (op >= 0x60 && op <= 0x7f) i += op - 0x5f; // skip PUSH1..PUSH32 data
        }
        eq(sstores, 1, "one SSTORE (count)");
    }

    // ---- the code on chain is this source ----

    /// Full match, metadata included (see match_rule in onchain.json): the runtime
    /// forge builds from RwaAnchor.sol hashes to what eth_getCode returned for
    /// 0x1955137e7773f2459eb75fb88842026c6517c22d on Robinhood Chain.
    function test_RuntimeEqualsTheDeployedContract() public view {
        string memory pinned = vm.readFile("onchain.json");
        bytes32 onchain = vm.parseJsonBytes32(pinned, ".runtime_keccak256");
        eq(keccak256(type(RwaAnchor).runtimeCode), onchain, "built runtime != chain runtime");
        eq(keccak256(address(anchor).code), onchain, "deployed runtime != chain runtime");
        eq(type(RwaAnchor).runtimeCode.length, vm.parseJsonUint(pinned, ".runtime_bytes"), "runtime length");
    }

    /// The creation code in RwaAnchor.json (what the deploy script sent) is what forge builds.
    function test_CommittedArtifactEqualsTheBuild() public view {
        bytes memory committed = vm.parseJsonBytes(vm.readFile("RwaAnchor.json"), ".bytecode");
        eq(committed, type(RwaAnchor).creationCode, "RwaAnchor.json bytecode != forge build");
    }
}

/// Drives anchor() with arbitrary inputs, zeros included, from arbitrary senders.
contract Handler is Base {
    RwaAnchor public immutable anchor;
    uint256 public successes;
    uint256 public reverts;
    uint256 public logsSeen;

    constructor(RwaAnchor a) {
        anchor = a;
    }

    function anchorAny(bytes32 subject, bytes32 factsHash, uint32 mv, uint64 asOf, uint8 zeroMask, address sender)
        external
    {
        if (zeroMask & 1 != 0) subject = 0;
        if (zeroMask & 2 != 0) factsHash = 0;
        if (zeroMask & 4 != 0) asOf = 0;
        vm.recordLogs();
        vm.prank(sender);
        (bool ok,) = address(anchor).call(abi.encodeCall(RwaAnchor.anchor, (subject, factsHash, mv, asOf)));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        logsSeen += logs.length;
        if (ok) {
            successes++;
            checkLog(logs[0], address(anchor), subject, factsHash, mv, asOf, sender);
        } else {
            reverts++;
            require(subject == 0 || factsHash == 0 || asOf == 0, "reverted on valid input");
        }
    }
}

contract RwaAnchorInvariantTest is Base {
    RwaAnchor internal anchor;
    Handler internal handler;
    bytes32 internal codeHash;

    function setUp() public {
        anchor = new RwaAnchor();
        handler = new Handler(anchor);
        codeHash = keccak256(address(anchor).code);
    }

    /// Only the handler is fuzzed (read by forge in place of forge-std's StdInvariant).
    function targetContracts() public view returns (address[] memory t) {
        t = new address[](1);
        t[0] = address(handler);
    }

    function invariant_CountEqualsSuccessfulCalls() public view {
        eq(anchor.count(), handler.successes(), "count == successful anchors");
    }

    function invariant_OneLogPerSuccessNoneOnRevert() public view {
        eq(handler.logsSeen(), handler.successes(), "logs == successes");
    }

    function invariant_OnlySlotZeroHoldsState() public view {
        eq(vm.load(address(anchor), bytes32(0)), bytes32(anchor.count()), "slot 0 is count");
        for (uint256 s = 1; s < 4; s++) {
            eq(vm.load(address(anchor), bytes32(s)), bytes32(0), "no other slot");
        }
    }

    function invariant_CodeNeverChanges() public view {
        eq(keccak256(address(anchor).code), codeHash, "code changed");
        eq(address(anchor).balance, 0, "holds no ether");
    }
}
