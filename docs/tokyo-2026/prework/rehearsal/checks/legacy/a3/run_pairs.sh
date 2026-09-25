#!/bin/bash
cd "$(dirname "$0")"
S=https://sepolia.rpc.sentio.xyz; E=https://rpc.sepolia.ethpandaops.io; X=https://0xrpc.io/sep
node pair.mjs 20 $S,$E > logs/pair1.out 2>&1
node pair.mjs 20 $E,$X > logs/pair2.out 2>&1
node pair.mjs 20 $S,$X > logs/pair3.out 2>&1
echo done > logs/pairs.done
