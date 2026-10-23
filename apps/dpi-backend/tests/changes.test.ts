import { test } from "node:test";
import assert from "node:assert/strict";
import { ChangeFeed } from "../src/changes.js";

test("change feed: notifies every listener until it unsubscribes", () => {
  const feed = new ChangeFeed();
  const seen: string[] = [];
  const offA = feed.subscribe(() => seen.push("a"));
  feed.subscribe(() => seen.push("b"));

  feed.notify();
  assert.deepEqual(seen, ["a", "b"]);

  offA();
  feed.notify();
  assert.deepEqual(seen, ["a", "b", "b"]);
});

test("change feed: unsubscribing twice is harmless", () => {
  const feed = new ChangeFeed();
  let calls = 0;
  const off = feed.subscribe(() => calls++);
  off();
  off();
  feed.notify();
  assert.equal(calls, 0);
});
