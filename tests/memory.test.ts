// What a run may be handed over from earlier ones in the same folder: a plain file beside the install, written by
// whoever distils finished runs, read here before a job starts. Failure cases: a memory written for another folder
// reaches this one; a memory a later finding pushed down is still handed over; a folder's memories pile up without
// limit; a file that's missing or half-written keeps the run from starting at all.
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setup } from "./helpers.ts";

const home = setup("memory");
const { recall } = await import("../worker/memory.ts");
const cwd = join(home, "project");

const memory = (id: string, over: object = {}) => ({
  id,
  scope: cwd,
  text: `上次的结论 ${id}`,
  at: "2026-11-01T00:00:00+08:00",
  ...over,
});
const write = (entries: object[]) => writeFileSync(join(home, "memory.json"), JSON.stringify(entries, null, 2));

test("a memory of another folder is not handed over", () => {
  write([memory("mine"), memory("theirs", { scope: join(home, "other") })]);
  assert.deepEqual(
    recall(cwd).map((kept) => kept.id),
    ["mine"],
  );
});

test("a memory a later finding pushed down is not handed over", () => {
  write([memory("old", { superseded_by: "new" }), memory("new")]);
  assert.deepEqual(
    recall(cwd).map((kept) => kept.id),
    ["new"],
  );
});

test("the newest few are handed over, not every one of them", () => {
  write(Array.from({ length: 8 }, (_, i) => memory(`m${i}`, { at: `2026-11-0${i + 1}T00:00:00+08:00` })));
  const kept = recall(cwd);
  assert.equal(kept.length, 5, "only the newest few");
  assert.equal(kept[0].id, "m7", "the newest first");
  assert.equal(kept.at(-1)?.id, "m3", "the ones that fell out of the top are gone");
});

test("a memory file that's missing or broken hands over nothing", () => {
  rmSync(join(home, "memory.json"), { force: true });
  assert.deepEqual(recall(cwd), []);
  writeFileSync(join(home, "memory.json"), '{"half-written"');
  assert.deepEqual(recall(cwd), []);
});

test("a malformed timestamp cannot prevent a job from starting", () => {
  write([memory("good"), memory("bad", { at: 42 })]);
  assert.deepEqual(
    recall(cwd).map((entry) => entry.id),
    ["good"],
  );
});
