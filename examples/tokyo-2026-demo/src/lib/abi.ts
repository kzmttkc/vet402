// Generated from the deployed ENSv2 Sepolia ABIs (2026-09-15 deployment) that the rehearsal uses.
// Only the functions admin.ts calls, plus every error and event, so reverts and logs decode by name.
// Selectors were checked against the JSON ABIs when this file was generated. Do not edit by hand.
import { parseAbi } from 'viem';

export const PermissionedResolverImpl_FNS = [
  "function initialize((address account, uint256 roleBitmap)[] grants, bytes[] calls)",
  "function setText(bytes name, string key, string value)",
  "function setAddress(bytes name, uint256 coinType, bytes addressBytes)",
  "function multicall(bytes[] calls) returns (bytes[] results)",
  "function grantSetterRoles(bytes setter, address account) returns (bool)",
  "function linkToRecord(bytes sourceName, uint256 recordId)",
  "function linkToNode(bytes sourceName, bytes32 targetNode)",
  "function getRecordId(bytes32 node) view returns (uint256)",
  "function roles(uint256 resource, address account) view returns (uint256)",
] as const;

export const VerifiableFactory_FNS = [
  "function deployProxy(address implementation, uint256 salt, bytes data) returns (address proxy)",
] as const;

export const ETHRegistry_FNS = [
  "function getState(uint256 anyId) view returns ((uint8 status, uint64 expiry, address latestOwner, uint256 tokenId, uint256 resource) state)",
  "function setResolver(uint256 anyId, address resolver)",
  "function setSubregistry(uint256 anyId, address registry)",
] as const;

export const ETHRegistrar_FNS = [
  "function makeCommitment(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, bytes32 referrer) pure returns (bytes32)",
  "function commit(bytes32 commitment)",
  "function register(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, address paymentToken, bytes32 referrer) returns (uint256 tokenId)",
  "function isAvailable(string label) view returns (bool)",
  "function MIN_COMMITMENT_AGE() view returns (uint64)",
] as const;

export const UserRegistryImpl_FNS = [
  "function initialize((address account, uint256 roleBitmap)[] grants)",
  "function register(string label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expiry) returns (uint256)",
  // D-6a / T7 (ABI from the 2026-09-15 UserRegistryImpl: unregister(uint256 anyId), revokeRootRoles(uint256,address) 0xce156e82)
  "function unregister(uint256 anyId)",
  "function revokeRootRoles(uint256 roleBitmap, address account) returns (bool)",
  "function isEmancipated() view returns (bool)",
] as const;

export const UniversalResolverV2_FNS = [
  "function resolve(bytes name, bytes data) view returns (bytes, address)",
  "function findResolver(bytes name) view returns (address resolver, bytes32 node, uint256 offset)",
] as const;

export const ALL_ERRORS = parseAbi([
  "error AddressEmptyCode(address target)",
  "error DNSDecodingFailed(bytes dns)",
  "error EACCannotGrantRoles(uint256 resource, uint256 roleBitmap, address account)",
  "error EACCannotRevokeRoles(uint256 resource, uint256 roleBitmap, address account)",
  "error EACInvalidAccount()",
  "error EACInvalidRoleBitmap(uint256 roleBitmap)",
  "error EACMaxAssignees(uint256 resource, uint256 role)",
  "error EACMinAssignees(uint256 resource, uint256 role)",
  "error EACRootResourceNotAllowed()",
  "error EACUnauthorizedAccountRoles(uint256 resource, uint256 roleBitmap, address account)",
  "error ERC1967InvalidImplementation(address implementation)",
  "error ERC1967NonPayable()",
  "error FailedCall()",
  "error InvalidContentType(uint256 contentType)",
  "error InvalidEVMAddress(bytes addressBytes)",
  "error InvalidInitialization()",
  "error InvalidRecord()",
  "error NotInitializing()",
  "error UUPSUnauthorizedCallContext()",
  "error UUPSUnsupportedProxiableUUID(bytes32 slot)",
  "error UnsupportedResolverProfile(bytes4 selector)",
  "error VerificationFailed(address proxy)",
  "error CannotReduceExpiry(uint64 oldExpiry, uint64 newExpiry)",
  "error CannotSetPastExpiry(uint64 expiry)",
  "error ERC1155InsufficientBalance(address sender, uint256 balance, uint256 needed, uint256 tokenId)",
  "error ERC1155InvalidApprover(address approver)",
  "error ERC1155InvalidArrayLength(uint256 idsLength, uint256 valuesLength)",
  "error ERC1155InvalidOperator(address operator)",
  "error ERC1155InvalidReceiver(address receiver)",
  "error ERC1155InvalidSender(address sender)",
  "error ERC1155MissingApprovalForAll(address operator, address owner)",
  "error LabelAlreadyRegistered(string label)",
  "error LabelAlreadyReserved(string label)",
  "error LabelExpired(uint256 tokenId)",
  "error TransferDisallowed(uint256 tokenId, address from)",
  "error TransferUnsafeUntilRegistryIsEmancipated()",
  "error TransferUnsafeWithMultipleAssignees(uint256 tokenId, address from)",
  "error CommitmentTooNew(bytes32 commitment, uint64 validFrom, uint64 blockTimestamp)",
  "error CommitmentTooOld(bytes32 commitment, uint64 validTo, uint64 blockTimestamp)",
  "error DurationTooShort(uint64 duration, uint64 minDuration)",
  "error InvalidOwner()",
  "error MaxCommitmentAgeTooLow()",
  "error NameNotAvailable(string label)",
  "error NameNotRenewable(string label)",
  "error OwnableInvalidOwner(address owner)",
  "error OwnableUnauthorizedAccount(address account)",
  "error SafeERC20FailedOperation(address token)",
  "error UnexpiredCommitmentExists(bytes32 commitment)",
  "error DNSEncodingFailed(string ens)",
  "error EmptyAddress()",
  "error HttpError(uint16 status, string message)",
  "error InvalidBatchGatewayResponse()",
  "error LabelIsEmpty()",
  "error LabelIsTooLong(string label)",
  "error NormalizationChangedName(bytes normalizedName, bytes result, address resolver)",
  "error OffchainLookup(address sender, string[] urls, bytes callData, bytes4 callbackFunction, bytes extraData)",
  "error OffsetOutOfBoundsError(uint256 offset, uint256 length)",
  "error PrimaryNameNotNormalized(string primary)",
  "error ResolverError(bytes errorData)",
  "error ResolverNotContract(bytes name, address resolver)",
  "error ResolverNotFound(bytes name)",
  "error ReverseAddressMismatch(string primary, bytes primaryAddress)",
  "error UnsafeBatchGatewayResponse(bytes)",
]);

export const ALL_EVENTS = parseAbi([
  "event ABIUpdated(uint256 indexed recordId, uint256 indexed contentType)",
  "event AddressUpdated(uint256 indexed recordId, uint256 coinType, bytes addressBytes)",
  "event Cleared(uint256 indexed recordId)",
  "event ContenthashUpdated(uint256 indexed recordId, bytes hash)",
  "event DataUpdated(uint256 indexed recordId, string indexed keyHash, string key, bytes value)",
  "event EACRolesChanged(uint256 indexed resource, address indexed account, uint256 oldRoleBitmap, uint256 newRoleBitmap)",
  "event Initialized(uint64 version)",
  "event InterfaceUpdated(uint256 indexed recordId, bytes4 indexed interfaceId, address implementer)",
  "event Linked(uint256 indexed recordId, bytes32 indexed node, bytes name)",
  "event NameUpdated(uint256 indexed recordId, string primaryName)",
  "event ResolverCreated()",
  "event ResourceArgument(uint256 indexed resource, bytes arg)",
  "event TextUpdated(uint256 indexed recordId, string indexed keyHash, string key, string value)",
  "event Upgraded(address indexed implementation)",
  "event ProxyDeployed(address indexed sender, address indexed proxyAddress, uint256 salt, address implementation)",
  "event ApprovalForAll(address indexed account, address indexed operator, bool approved)",
  "event ExpiryUpdated(uint256 indexed tokenId, uint64 indexed newExpiry, address indexed sender)",
  "event LabelRegistered(uint256 indexed tokenId, bytes32 indexed labelHash, string label, address owner, uint64 expiry, address indexed sender)",
  "event LabelReserved(uint256 indexed tokenId, bytes32 indexed labelHash, string label, uint64 expiry, address indexed sender)",
  "event LabelUnregistered(uint256 indexed tokenId, address indexed sender)",
  "event ParentUpdated(address indexed parent, string label, address indexed sender)",
  "event RegistryCreated()",
  "event ResolverUpdated(uint256 indexed tokenId, address indexed resolver, address indexed sender)",
  "event SubregistryUpdated(uint256 indexed tokenId, address indexed subregistry, address indexed sender)",
  "event TokenRegenerated(uint256 indexed oldTokenId, uint256 indexed newTokenId)",
  "event TokenResource(uint256 indexed tokenId, uint256 indexed resource)",
  "event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)",
  "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
  "event URI(string value, uint256 indexed id)",
  "event URIUpdated(string uri, address renderer, address indexed sender)",
  "event CommitmentMade(bytes32 commitment)",
  "event NameRegistered(uint256 indexed tokenId, string label, address owner, address subregistry, address resolver, uint64 duration, address paymentToken, bytes32 indexed referrer, uint256 base, uint256 premium)",
  "event NameRenewed(uint256 indexed tokenId, string label, uint64 duration, uint64 newExpiry, address paymentToken, bytes32 indexed referrer, uint256 amount)",
  "event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)",
  "event RentPriceOracleUpdated(address oracle)",
]);

export const PR = parseAbi(PermissionedResolverImpl_FNS);
export const VF = parseAbi(VerifiableFactory_FNS);
export const ER = parseAbi(ETHRegistry_FNS);
export const RG = parseAbi(ETHRegistrar_FNS);
export const URI = parseAbi(UserRegistryImpl_FNS);
export const UR = parseAbi(UniversalResolverV2_FNS);
export const ERC20 = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);
export const RESOLVER_READ = parseAbi([
  'function addr(bytes32 node) view returns (address)',
  'function text(bytes32 node, string key) view returns (string)',
]);

// ---- Added by hand 2026-09-26 for admin.ts expiring / nontransferable / agent-context (ENSv2 Best Use: U3, U8, U9).
// Not part of the generated block above. Each signature was checked on Sepolia by eth_call against U 0xB093…0dac,
// P_AG1 0xd3F4…bcd6 and UniversalHelper 0x33f5…7DF5 (2026-09-26, block 11,783,064).
export const USER_TOKEN = parseAbi([
  'function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)',
  'function roles(uint256 resource, address account) view returns (uint256)',
]);
export const UNIVERSAL_HELPER_READ = parseAbi([
  'function findExactOwner(bytes name) view returns (address)',
]);
