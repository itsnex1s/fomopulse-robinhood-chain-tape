import type { Address, Hex } from "viem";

export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** What `eth_getCode` says about an address; a delegated EOA (EIP-7702) counts as an EOA. */
export type Kind = "eoa" | "contract";

/** A receipt as the node returns it. */
export interface RawReceipt {
  transactionHash: Hex;
  blockNumber: Hex;
  logs: { address: Address; topics: Hex[]; data: Hex; logIndex: Hex }[];
}

export interface Transfer {
  logIndex: number;
  token: Address;
  from: Address;
  to: Address;
  value: bigint;
}

/** The transfers reconstruction reads; also what the database stores, so a rebuild replays what the ingester saw. */
export interface ParsedReceipt {
  tx: Hex;
  block: number;
  transfers: Transfer[];
}

export type ReceiptInput = RawReceipt | ParsedReceipt;

/** Either shape is accepted everywhere: the node's receipt at ingest, the stored transfers on a rebuild. */
export function parse(receipt: ReceiptInput): ParsedReceipt {
  if ("transfers" in receipt) return receipt;
  return { tx: receipt.transactionHash, block: Number(receipt.blockNumber), transfers: transfers(receipt) };
}

const addressFromTopic = (t: Hex) => `0x${t.slice(26)}`.toLowerCase() as Address;

// One uint256 word. `Transfer(address indexed, address indexed)` also has three topics and puts
// nothing in `data`, where `BigInt("0x")` throws rather than returning zero.
const VALUE = /^0x[0-9a-fA-F]{1,64}$/;

export function transfers(receipt: RawReceipt): Transfer[] {
  const out: Transfer[] = [];
  for (const log of receipt.logs) {
    if (log.topics[0] !== TRANSFER_TOPIC || log.topics.length !== 3) continue;
    if (!VALUE.test(log.data)) continue;
    out.push({
      logIndex: Number(log.logIndex),
      token: log.address.toLowerCase() as Address,
      from: addressFromTopic(log.topics[1]!),
      to: addressFromTopic(log.topics[2]!),
      value: BigInt(log.data),
    });
  }
  return out;
}
