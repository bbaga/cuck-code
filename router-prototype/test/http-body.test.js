"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");
const { readJsonBody, withJsonBody } = require("../http-body");

function fakeRequest(headers, chunks) {
  const req = new PassThrough();
  req.headers = headers;
  for (const chunk of chunks) req.write(chunk);
  req.end();
  return req;
}

const JSON_HEADERS = { "content-type": "application/json", "content-length": "1" };

test("keeps a UTF-8 character that is split across chunks", async () => {
  const bytes = Buffer.from('{"t":"é"}');
  const cut = bytes.indexOf(0xc3) + 1;
  const body = await readJsonBody(fakeRequest(JSON_HEADERS, [bytes.subarray(0, cut), bytes.subarray(cut)]));
  assert.deepEqual(body, { t: "é" });
});

test("reads an empty body as an empty object", async () => {
  assert.deepEqual(await readJsonBody(fakeRequest({}, [])), {});
});

test("accepts a charset parameter on the JSON media type", async () => {
  const headers = { ...JSON_HEADERS, "content-type": "application/json; charset=utf-8" };
  assert.deepEqual(await readJsonBody(fakeRequest(headers, ['{"a":1}'])), { a: 1 });
});

test("refuses wrong media types, large bodies, bad JSON, and non-objects", async () => {
  const textHeaders = { "content-type": "text/plain", "content-length": "2" };
  await assert.rejects(readJsonBody(fakeRequest(textHeaders, ["{}"])), { status: 415 });
  await assert.rejects(readJsonBody(fakeRequest(JSON_HEADERS, ['{"a":"0123456789"}']), 10), { status: 413 });
  await assert.rejects(readJsonBody(fakeRequest(JSON_HEADERS, ["{"])), { status: 400 });
  await assert.rejects(readJsonBody(fakeRequest(JSON_HEADERS, ["[1]"])), { status: 400 });
});

test("runs a throwing handler one time and reports the error one time", async () => {
  let calls = 0;
  const errors = [];
  await withJsonBody(fakeRequest({}, []), {}, () => { calls += 1; throw new Error("bug"); }, {
    respond: () => assert.fail("no body error expected"),
    onError: (_req, _res, err) => errors.push(err.message),
  });
  assert.equal(calls, 1);
  assert.deepEqual(errors, ["bug"]);
});

test("sends an async handler rejection to onError", async () => {
  const errors = [];
  await withJsonBody(fakeRequest({}, []), {}, async () => { throw new Error("async bug"); }, {
    respond: () => assert.fail("no body error expected"),
    onError: (_req, _res, err) => errors.push(err.message),
  });
  assert.deepEqual(errors, ["async bug"]);
});

test("answers a body error and does not run the handler", async () => {
  const answers = [];
  await withJsonBody(fakeRequest(JSON_HEADERS, ["{"]), {}, () => assert.fail("handler must not run"), {
    respond: (_res, status, body) => answers.push([status, body.error]),
    onError: (_req, _res, err) => assert.fail(err.message),
  });
  assert.deepEqual(answers, [[400, "invalid JSON"]]);
});
