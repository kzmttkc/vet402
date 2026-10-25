// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title DeliveryLedger
/// @notice Buyer-side receipts for x402 purchases settled through Circle Gateway batches on Arc.
/// Each round commits a Merkle root over per-purchase records (signed payment authorization,
/// request hash, response hash, outcome). The recorder can add rounds but never change one.
contract DeliveryLedger {
    struct Round {
        bytes32 root;
        uint32 purchases;
        uint32 delivered;
        uint64 anchoredAt;
        string uri;
    }

    address public immutable recorder;
    uint256 public rounds;
    mapping(uint256 => Round) private _rounds;

    event RoundAnchored(uint256 indexed round, bytes32 indexed root, uint32 purchases, uint32 delivered, string uri);

    error NotRecorder();
    error EmptyRoot();

    constructor(address recorder_) {
        recorder = recorder_;
    }

    function anchor(bytes32 root, uint32 purchases, uint32 delivered, string calldata uri) external returns (uint256 round) {
        if (msg.sender != recorder) revert NotRecorder();
        if (root == bytes32(0)) revert EmptyRoot();
        round = ++rounds;
        _rounds[round] = Round(root, purchases, delivered, uint64(block.timestamp), uri);
        emit RoundAnchored(round, root, purchases, delivered, uri);
    }

    function roundOf(uint256 round) external view returns (Round memory) {
        return _rounds[round];
    }
}
