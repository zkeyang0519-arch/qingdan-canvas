import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  animalRunners,
  createAnimalCycle,
} from "../src/island/animal-runners.js";

test("animals shuffle through every runner once per round without an adjacent repeat", () => {
  for (const random of [() => 0, () => 0.9999, Math.random]) {
    const next = createAnimalCycle(random);
    let previous;
    for (let round = 0; round < 30; round++) {
      const ids = new Set();
      for (let i = 0; i < animalRunners.length; i++) {
        const runner = next();
        assert.notEqual(runner.id, previous);
        ids.add(runner.id);
        previous = runner.id;
      }
      assert.equal(ids.size, 6);
    }
  }
});

test("every bundled runner has all transparent 36px frames and ships its license", async () => {
  for (const animal of animalRunners) {
    const png = await readFile(
      new URL(`../public/animals/runcat/${animal.id}.png`, import.meta.url),
    );
    assert.equal(png.subarray(1, 4).toString(), "PNG");
    assert.equal(png.readUInt32BE(16), animal.width * animal.frames);
    assert.equal(png.readUInt32BE(20), 36);
    assert.equal(png[25], 6, "RGBA preserves transparent backgrounds");
  }
  assert.match(
    await readFile(
      new URL("../public/animals/runcat/LICENSE", import.meta.url),
      "utf8",
    ),
    /Apache License/,
  );
});
