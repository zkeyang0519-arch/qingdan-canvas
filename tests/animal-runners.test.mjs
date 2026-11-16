import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { animalRunner } from "../src/island/animal-runners.js";

test("the running cat has all transparent 36px frames and ships its license", async () => {
  const png = await readFile(
    new URL(`../public/animals/runcat/${animalRunner.id}.png`, import.meta.url),
  );
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  assert.equal(png.readUInt32BE(16), animalRunner.width * animalRunner.frames);
  assert.equal(png.readUInt32BE(20), 36);
  assert.equal(png[25], 6, "RGBA preserves transparent backgrounds");
  assert.match(
    await readFile(
      new URL("../public/animals/runcat/LICENSE", import.meta.url),
      "utf8",
    ),
    /Apache License/,
  );
});
