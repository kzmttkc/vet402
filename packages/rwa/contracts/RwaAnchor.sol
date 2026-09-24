// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title RwaAnchor — a timestamped commitment to one reconstruction
/// @notice vet402 /rwa publishes a wallet's Stock Token track record rebuilt from
///         public chain data. This contract is how a reader checks, later, that a
///         published record is the one that was published: before a submission the
///         operator anchors `keccak256(method_version | address | as_of |
///         r1_status | realized_usd_or_null)` here, and anyone can recompute that
///         hash from the facts JSON and compare it with this log.
/// @dev docs/rwa/SPEC.md §9. Deliberately minimal and final: no owner, no proxy,
///      no upgrade path, no token, no admin function, nothing to migrate. The
///      contract cannot alter or delete what it recorded, which is the only
///      property that makes the record worth anything.
contract RwaAnchor {
    /// @param subject      keccak256 of the lower-cased address the record is about
    /// @param factsHash    keccak256 of the canonical fields (SPEC §9)
    /// @param methodVersion the reconstruction method, e.g. 1 for rwa-recon-0.1
    /// @param asOf         unix seconds of the block the record was computed at
    /// @param anchoredBy   whoever sent the transaction
    event Anchored(
        bytes32 indexed subject,
        bytes32 indexed factsHash,
        uint32 methodVersion,
        uint64 asOf,
        address indexed anchoredBy
    );

    /// @notice How many records have been anchored. Only ever increases.
    uint256 public count;

    /// @notice Record one reconstruction. Anyone may call it; the log names the sender,
    ///         so a reader decides which anchorer they believe rather than trusting a
    ///         permission this contract would have to be trusted to enforce.
    function anchor(bytes32 subject, bytes32 factsHash, uint32 methodVersion, uint64 asOf) external {
        require(subject != bytes32(0), "subject required");
        require(factsHash != bytes32(0), "factsHash required");
        require(asOf != 0, "asOf required");
        unchecked {
            count++;
        }
        emit Anchored(subject, factsHash, methodVersion, asOf, msg.sender);
    }
}
