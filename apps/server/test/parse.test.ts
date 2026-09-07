import { expect, test } from "bun:test";
import type { Hex } from "viem";
import { type RawReceipt, TRANSFER_TOPIC, transfers } from "../src/ingest/parse.ts";

const topic = (address: string) => `0x${"0".repeat(24)}${address.slice(2)}` as Hex;
const alice = "0x1111111111111111111111111111111111111111";
const bob = "0x2222222222222222222222222222222222222222";
const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

const receipt = (...logs: { data: Hex; topics: Hex[] }[]): RawReceipt =>
  ({
    transactionHash: "0xtx",
    blockNumber: "0x1",
    logs: logs.map((log, i) => ({
      address: "0xffffffffffffffffffffffffffffffffffffffff",
      logIndex: `0x${i.toString(16)}`,
      ...log,
    })),
  }) as unknown as RawReceipt;

const erc20 = { topics: [TRANSFER_TOPIC, topic(alice), topic(bob)] as Hex[], data: word(5n) };

test("a Transfer with a value is read, whatever else the receipt carries", () => {
  const read = transfers(receipt(erc20));
  expect(read).toHaveLength(1);
  expect(read[0]!.value).toBe(5n);
  expect(read[0]!.from).toBe(alice);
  expect(read[0]!.to).toBe(bob);
});

test("a three-topic Transfer that carries no value is skipped, not thrown on", () => {
  // Transfer(address indexed, address indexed) — three topics, empty data. BigInt("0x")
  // throws, and the throw used to travel out of the whole transaction's read.
  const empty = { topics: erc20.topics, data: "0x" as Hex };
  expect(() => transfers(receipt(empty))).not.toThrow();
  expect(transfers(receipt(empty))).toHaveLength(0);
  // and it does not take the real transfers of the same transaction with it
  expect(transfers(receipt(empty, erc20))).toHaveLength(1);
});

test("data that is not one word of hex is skipped", () => {
  const cases: Hex[] = ["0x" as Hex, "0xzz" as Hex, `0x${"0".repeat(65)}` as Hex, "" as Hex];
  for (const data of cases) expect(transfers(receipt({ topics: erc20.topics, data }))).toHaveLength(0);
});

test("a four-topic Transfer is an NFT and is not a fill", () => {
  const nft = { topics: [...erc20.topics, word(1n)], data: "0x" as Hex };
  expect(transfers(receipt(nft))).toHaveLength(0);
});
