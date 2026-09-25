// guards/lib.mjs の置き換え。**絶対パスを1つも持たない。**
// 旧版は調査用 scratchpad の ur/abi と ~/hackathon-monitor の node_modules を直に指していたので、
// その scratchpad が消えた時点で「正典のガスを測り直す唯一の道具」が二度と動かなくなるところだった。
//
// 中身（アドレス・ロール・キー・測り方）は変えていない。rehearsal 自身の lib/common.mjs へ名前を付け替えただけ。
// 生きている入口は `node run.mjs --gas`（= checks/gas.mjs）。ここの5本は当時の調査そのままの控えで、
// **関門ではない**（`run.mjs --all` は走らせない）。
import {
  viem as _viem, sepolia as _sepolia, viemVersion as _viemVersion, L as _L, ABI as _ABI, A as _A, UR_IMPL,
  R_VET as _R_VET, HCA_VET as _HCA_VET, W_VET as _W_VET, W_ENS as _W_ENS, W_OP as _W_OP, W_OBS as _W_OBS,
  K_ATST as _K_ATST, K_AG1 as _K_AG1, K_AG2 as _K_AG2, W_OP_REAL as _W_OP_REAL,
  RPC_S as _RPC_S, RPC_P as _RPC_P, ZERO as _ZERO, ALL_ROLES as _ALL_ROLES,
  ROLE_UNREGISTER, ROLE_RENEW, ROLE_SET_SUBREGISTRY, ROLE_SET_RESOLVER, ROLE_CAN_TRANSFER_ADMIN, ROLE_UPGRADE,
  UNEMANCIPATED as _UNEMANCIPATED, dns as _dns, client as _client, pr as _pr, er as _er, urv as _urv, uh as _uh,
  RD as _RD, ATT_KEY as _ATT_KEY, OBS_KEYS as _OBS_KEYS, decErr, rpc, usr as _usr,
} from '../../../lib/common.mjs';

export const viem = _viem;
export const sepolia = _sepolia;
export const viemVersion = _viemVersion;
export const L = _L;
// 旧 lib.mjs は UserRegistryImpl を ABI.USR と呼んでいた。common.mjs では ABI.URI。両方の名で引けるようにする。
export const ABI = { ..._ABI, USR: _ABI.URI };
export const A = { ..._A, usrImpl: UR_IMPL };
export const R_VET = _R_VET, HCA_VET = _HCA_VET, W_VET = _W_VET, W_ENS = _W_ENS;
export const W_OP = _W_OP, W_OBS = _W_OBS, K_ATST = _K_ATST, K_AG1 = _K_AG1, K_AG2 = _K_AG2, W_OP_REAL = _W_OP_REAL;
export const RPC_S = _RPC_S, RPC_P = _RPC_P, ZERO = _ZERO, ALL_ROLES = _ALL_ROLES;
export const R_UNREGISTER = ROLE_UNREGISTER, R_RENEW = ROLE_RENEW, R_SET_SUBREG = ROLE_SET_SUBREGISTRY,
  R_SET_RESOLVER = ROLE_SET_RESOLVER, R_CAN_TRANSFER_ADMIN = ROLE_CAN_TRANSFER_ADMIN, R_UPGRADE = ROLE_UPGRADE;
export const UNEMANCIPATED = _UNEMANCIPATED;
export const dns = _dns, client = _client, pr = _pr, er = _er, urv = _urv, uh = _uh, usr = _usr;
export const RD = _RD;
export const rd = (fn, args) => viem.encodeFunctionData({ abi: RD, functionName: fn, args });
export const ATT_KEY = _ATT_KEY, OBS_KEYS = _OBS_KEYS;
export const dec = decErr;

// 旧 simRaw と同じ形（1ブロックぶんの calls を返す）。読み取りだけ。
export const simRaw = async (url, calls, B, blockOverrides) => {
  const bsc = { calls };
  if (blockOverrides) bsc.blockOverrides = blockOverrides;
  const r = await rpc(url, 'eth_simulateV1', [{ blockStateCalls: [bsc], validation: false, traceTransfers: false }, viem.toHex(B)]);
  return r[0].calls;
};
