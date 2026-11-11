import test from "node:test";
import assert from "node:assert/strict";
import { loadAgentModules, makeTask } from "./fixtures/agent-fixtures.mjs";

let rules;
try {
  rules = await loadAgentModules();
} catch (error) {
  test("Agent ordering rules are implemented", () =>
    assert.fail(error.message));
}

if (rules) {
  const { sortPlan, validateManualOrder, resolveRelativeDeadline } = rules;

  test("dependencies outrank urgency and deadlines, including multi-level prerequisites", () => {
    assert.deepEqual(
      sortPlan([
        makeTask("a", {
          dependsOn: ["b"],
          priority: 0,
          dueAt: "2026-11-01T00:00:00.000Z",
        }),
        makeTask("b", { dependsOn: ["c"], priority: 1 }),
        makeTask("c", { priority: 3 }),
      ]),
      ["c", "b", "a"],
    );
  });

  test("ready tasks use priority, earliest deadline, then their original order", () => {
    const tasks = [
      makeTask("none"),
      makeTask("late", { dueAt: "2026-11-05T00:00:00.000Z" }),
      makeTask("z", { dueAt: "2026-11-04T00:00:00.000Z" }),
      makeTask("a", { dueAt: "2026-11-04T00:00:00.000Z" }),
      makeTask("urgent", { priority: 0 }),
    ];
    const before = structuredClone(tasks);
    assert.deepEqual(sortPlan(tasks), ["urgent", "z", "a", "late", "none"]);
    assert.deepEqual(tasks, before);
  });

  test("newly available tasks compete immediately on priority", () => {
    assert.deepEqual(
      sortPlan([
        makeTask("low", { priority: 3 }),
        makeTask("after", { dependsOn: ["first"], priority: 0 }),
        makeTask("first", { priority: 1 }),
      ]),
      ["first", "after", "low"],
    );
  });

  test("explicit ordering wins among ready tasks but never bypasses a dependency", () => {
    const tasks = [
      makeTask("a", { dependsOn: ["b"], priority: 0 }),
      makeTask("b"),
      makeTask("c", { priority: 3 }),
    ];
    assert.deepEqual(sortPlan(tasks, ["c", "a", "b"]), ["c", "b", "a"]);
    assert.deepEqual(sortPlan(tasks, ["c", "b", "a"]), ["c", "b", "a"]);
  });

  test("manual ordering accepts every dependency-respecting permutation without resorting", () => {
    const tasks = [
      makeTask("a", { dependsOn: ["b"], priority: 0 }),
      makeTask("b"),
      makeTask("c", { priority: 3 }),
    ];
    const order = ["c", "b", "a"];
    assert.equal(validateManualOrder(tasks, order), undefined);
    assert.deepEqual(order, ["c", "b", "a"]);
    assert.throws(
      () => validateManualOrder(tasks, ["a", "b", "c"]),
      (error) => {
        assert.equal(error.code, "DEPENDENCY_ORDER");
        assert.deepEqual(error.details.conflicts, [
          { taskId: "a", dependencyId: "b" },
        ]);
        return true;
      },
    );
  });

  test("manual and explicit orders reject omissions, duplicates and unknown task IDs", () => {
    const tasks = [makeTask("a"), makeTask("b")];
    for (const order of [
      [],
      ["a"],
      ["a", "a"],
      ["a", "missing"],
      ["a", "b", "c"],
    ]) {
      assert.throws(() => validateManualOrder(tasks, order), {
        code: "MANUAL_ORDER_INVALID",
      });
      assert.throws(() => sortPlan(tasks, order), {
        code: "MANUAL_ORDER_INVALID",
      });
    }
  });

  test("unknown dependencies and duplicate task IDs fail before sorting", () => {
    assert.throws(
      () => sortPlan([makeTask("a", { dependsOn: ["missing"] })]),
      (error) => {
        assert.equal(error.code, "DEPENDENCY_MISSING");
        assert.deepEqual(error.details, {
          taskId: "a",
          dependencyId: "missing",
        });
        return true;
      },
    );
    assert.throws(() => sortPlan([makeTask("a"), makeTask("a")]), {
      code: "DUPLICATE_TASK_ID",
    });
  });

  test("cycles name the actual cycle and do not blame unrelated blocked descendants", () => {
    const tasks = [
      makeTask("downstream", { dependsOn: ["a"] }),
      makeTask("a", { dependsOn: ["b"] }),
      makeTask("b", { dependsOn: ["a"] }),
      makeTask("free"),
    ];
    assert.throws(
      () => sortPlan(tasks),
      (error) => {
        assert.equal(error.code, "DEPENDENCY_CYCLE");
        assert.deepEqual(error.details.taskIds, ["a", "b"]);
        assert.deepEqual(error.details.cycle, ["a", "b", "a"]);
        return true;
      },
    );
    assert.throws(() => sortPlan([makeTask("self", { dependsOn: ["self"] })]), {
      code: "DEPENDENCY_CYCLE",
    });
  });

  test("empty ordering is a no-op and untrusted sorting fields are rejected", () => {
    assert.deepEqual(sortPlan([]), []);
    assert.equal(validateManualOrder([], []), undefined);
    for (const changes of [
      { priority: NaN },
      { priority: 4 },
      { dependsOn: ["b", "b"] },
      { dueAt: "not-a-date" },
      { taskId: "" },
    ]) {
      assert.throws(() => sortPlan([makeTask("a", changes), makeTask("b")]), {
        code: "VALIDATION_ERROR",
      });
    }
  });

  test("relative dates use Shanghai's calendar across the UTC day boundary", () => {
    assert.equal(
      resolveRelativeDeadline(
        { daysFromNow: 0, time: "09:00" },
        "2026-11-02T17:00:00.000Z",
      ),
      "2026-11-03T01:00:00.000Z",
    );
    assert.equal(
      resolveRelativeDeadline(
        { daysFromNow: 1, time: "18:30", timeZone: "Asia/Shanghai" },
        "2026-12-31T15:30:00.000Z",
      ),
      "2027-01-01T10:30:00.000Z",
    );
  });

  test("relative date conversion rejects ambiguous or nonexistent local times", () => {
    for (const input of [
      { daysFromNow: 0, time: "24:00" },
      { daysFromNow: 0.5, time: "09:00" },
      { daysFromNow: 0, time: "09:00", timeZone: "Invalid/Zone" },
      { daysFromNow: 0, time: "02:30", timeZone: "America/New_York" },
    ]) {
      assert.throws(
        () => resolveRelativeDeadline(input, "2026-03-08T06:00:00.000Z"),
        { code: "VALIDATION_ERROR" },
      );
    }
    assert.throws(
      () =>
        resolveRelativeDeadline(
          { daysFromNow: 0, time: "01:30", timeZone: "America/New_York" },
          "2026-11-01T04:00:00.000Z",
        ),
      { code: "VALIDATION_ERROR" },
    );
  });
}
