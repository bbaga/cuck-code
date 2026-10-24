"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JsonlDecoder, parseJsonRecord } = require("../jsonl");
const { createHarness } = require("../harness");

test("decodes records split across chunks and preserves Unicode separators inside JSON", () => {
  const decoder = new JsonlDecoder();
  assert.deepEqual(decoder.push('{"text":"hi '), []);
  assert.deepEqual(decoder.push('there\u2028ok"}\r\n{"n":2}\n'), [
    '{"text":"hi there\u2028ok"}',
    '{"n":2}',
  ]);
  assert.deepEqual(decoder.finish(), []);
});

test("feeds fragmented Pi JSONL records to the adapter and uses completed text once", () => {
  const decoder = new JsonlDecoder();
  const pi = createHarness("pi");
  const serialized = fs.readFileSync(path.join(__dirname, "fixtures", "pi-handoff.jsonl"), "utf8");
  const split = serialized.indexOf("Preserve") + 4;
  const records = [...decoder.push(serialized.slice(0, split)),
    ...decoder.push(serialized.slice(split))];
  records.push(...decoder.finish());
  const output = records.map((record) => pi.normalize(parseJsonRecord(record))).filter(Boolean);
  const flushed = pi.finalize();
  if (flushed) output.push(flushed);
  assert.equal(output.length, 1);
  assert.equal(output[0].text, "1. Check the report ✓\n2. Preserve punctuation!");
});

test("flushes a buffered EOF record and ignores malformed records", () => {
  const decoder = new JsonlDecoder();
  decoder.push('{"tail":"✓"}');
  assert.deepEqual(decoder.finish(), ['{"tail":"✓"}']);
  assert.deepEqual(parseJsonRecord('{malformed'), null);
  assert.deepEqual(parseJsonRecord('{"tail":"✓"}'), { tail: "✓" });
  assert.deepEqual(decoder.finish(), []);

  const pi = createHarness("pi");
  const eof = new JsonlDecoder();
  eof.push(JSON.stringify({ type: "message_end", message: {
    role: "assistant", content: "EOF report ✓",
  } }));
  const parsed = eof.finish().map(parseJsonRecord).map((event) => pi.normalize(event)).filter(Boolean);
  assert.equal(parsed[0].text, "EOF report ✓");
});
