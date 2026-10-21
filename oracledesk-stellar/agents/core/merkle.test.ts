import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  BatchCollector,
  buildTree,
  hashLeaf,
  hashNode,
  MAX_LEAVES,
  proofFor,
  verifyInclusion,
} from "./merkle.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const VECTOR_PATH = join(HERE, "..", "..", "docs", "vectors", "merkle-v1.json");

interface VectorCase {
  index: number;
  trace_hash: string;
  proof: string[];
}

interface VectorGroup {
  leaf_count: number;
  root: string;
  traces: string[];
  cases: VectorCase[];
}

test("merkle-v1 golden vectors match tree and proof generation", () => {
  const file = readFileSync(VECTOR_PATH, "utf8");
  const vectors: Record<string, VectorGroup> = JSON.parse(file);

  for (const [sizeStr, group] of Object.entries(vectors)) {
    const size = Number(sizeStr);
    assert.equal(group.leaf_count, size);

    const tree = buildTree(group.traces);
    assert.equal(tree.root, group.root, `root mismatch for size ${size}`);

    for (const testCase of group.cases) {
      const generatedProof = proofFor(tree, testCase.index);
      assert.deepEqual(
        generatedProof,
        testCase.proof,
        `proof mismatch for size ${size} at index ${testCase.index}`,
      );

      const valid = verifyInclusion(
        group.root,
        group.leaf_count,
        testCase.trace_hash,
        testCase.index,
        generatedProof,
      );
      assert.equal(
        valid,
        true,
        `verifyInclusion failed for size ${size} at index ${testCase.index}`,
      );
    }
  }
});

test("second-preimage resistance: leaf domain prefix differs from node prefix", () => {
  const dummy = "ab".repeat(32);
  const leaf = hashLeaf(dummy);
  const node = hashNode(dummy, dummy);
  assert.notEqual(leaf, node);
});

test("verifyInclusion rejects tampered inputs", () => {
  const dummy = [
    "11".repeat(32),
    "22".repeat(32),
    "33".repeat(32),
  ];
  const tree = buildTree(dummy);
  const proof = proofFor(tree, 0);

  // Wrong root
  assert.equal(verifyInclusion("00".repeat(32), 3, dummy[0], 0, proof), false);

  // Wrong trace hash
  assert.equal(verifyInclusion(tree.root, 3, "ff".repeat(32), 0, proof), false);

  // Wrong index
  assert.equal(verifyInclusion(tree.root, 3, dummy[0], 1, proof), false);

  // Out of bounds index
  assert.equal(verifyInclusion(tree.root, 3, dummy[0], 3, proof), false);

  // Tampered proof element
  const badProof = ["00".repeat(32), ...proof.slice(1)];
  assert.equal(verifyInclusion(tree.root, 3, dummy[0], 0, badProof), false);

  // Extra proof elements (> 12)
  const hugeProof = Array(13).fill("aa".repeat(32));
  assert.equal(verifyInclusion(tree.root, 3, dummy[0], 0, hugeProof), false);
});

test("BatchCollector collects traces and flushes valid manifest", () => {
  const collector = new BatchCollector(MAX_LEAVES);
  assert.equal(collector.size, 0);

  collector.add({
    trace: {
      agent: "trader",
      marketId: 1,
      action: "buy",
      reasoning: "signal",
      inputs: {},
      timestamp: 100,
    },
    traceHash: "11".repeat(32),
    cid: "ipfs://cid-1",
  });

  collector.add({
    trace: {
      agent: "trader",
      marketId: 2,
      action: "skip",
      reasoning: "low edge",
      inputs: {},
      timestamp: 101,
    },
    traceHash: "22".repeat(32),
    cid: "ipfs://cid-2",
  });

  assert.equal(collector.size, 2);

  const { tree, manifest, traces } = collector.flush();
  assert.equal(collector.size, 0);
  assert.equal(tree.leafCount, 2);
  assert.equal(manifest.leafCount, 2);
  assert.equal(manifest.root, tree.root);
  assert.equal(manifest.traces.length, 2);
  assert.equal(manifest.traces[0].traceHash, "11".repeat(32));
  assert.equal(manifest.traces[1].traceHash, "22".repeat(32));

  // Verify inclusion of both traces in flushed tree
  assert.equal(verifyInclusion(tree.root, 2, traces[0].traceHash, 0, proofFor(tree, 0)), true);
  assert.equal(verifyInclusion(tree.root, 2, traces[1].traceHash, 1, proofFor(tree, 1)), true);
});
