const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { checkedFile, validateShowcase, publicEvidence } = require("../evidence");
const { makeMediaFixtures } = require("./media-fixtures");

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function corruptedPng() {
  const value = fs.readFileSync(path.join(directoryForTest, "one.png"));
  let offset = 8;
  while (offset < value.length) {
    const length = value.readUInt32BE(offset);
    const type = value.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") {
      value[offset + 8] ^= 0xff;
      value.writeUInt32BE(crc32(value.subarray(offset + 4, offset + 8 + length)), offset + 8 + length);
      return value;
    }
    offset += length + 12;
  }
  throw new Error("fixture has no IDAT");
}

let directoryForTest;
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-"));
  directoryForTest = root;
  makeMediaFixtures(root);
  return root;
}

test("validates a genuine showcase and keeps ordered step metadata", () => {
  const root = fixture();
  const record = validateShowcase(root, { useCase: "Complete demo", file: "demo.webm",
    steps: [{ title: "First", explanation: "The result proves feature one.", screenshot: "one.png" }] });
  assert.equal(record.kind, "showcase");
  assert.equal(record.version, 1);
  assert.equal(record.steps[0].title, "First");
  assert.match(record.steps[0].screenshot, /one\.png$/);
});

test("validates genuine PNG, JPEG, and WebM decoder output", () => {
  const root = fixture();
  assert.doesNotThrow(() => checkedFile(root, "demo.webm", "video"));
  assert.doesNotThrow(() => checkedFile(root, "one.png", "screenshot"));
  assert.doesNotThrow(() => checkedFile(root, "one.jpg", "screenshot"));
});

test("rejects forged, truncated, and mismatched media", () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, "fake.webm"), Buffer.alloc(2048, 7));
  fs.writeFileSync(path.join(root, "header-only.webm"), Buffer.from([
    0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0x77, 0x65, 0x62, 0x6d]));
  fs.writeFileSync(path.join(root, "header-only.png"), Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAS0lEQVR42mNk+A8AAQUBAScY42YAAAA=", "base64"));
  fs.writeFileSync(path.join(root, "fake.png"), Buffer.from("not png"));
  fs.writeFileSync(path.join(root, "corrupt-idat.png"), corruptedPng());
  fs.writeFileSync(path.join(root, "fake.jpg"), Buffer.from([255, 216, 0, 0, 255, 217]));
  fs.writeFileSync(path.join(root, "truncated.jpg"), Buffer.from([
    255, 216, 255, 192, 0, 11, 8, 0, 1, 0, 1, 1, 1, 17, 0, 255, 218]));
  fs.writeFileSync(path.join(root, "wrong.jpg"), fs.readFileSync(path.join(root, "one.png")));
  assert.throws(() => checkedFile(root, "fake.webm", "video"));
  assert.throws(() => checkedFile(root, "header-only.webm", "video"));
  assert.throws(() => checkedFile(root, "fake.png", "screenshot"));
  assert.throws(() => checkedFile(root, "corrupt-idat.png", "screenshot"));
  assert.throws(() => checkedFile(root, "header-only.png", "screenshot"));
  assert.throws(() => checkedFile(root, "fake.jpg", "screenshot"));
  assert.throws(() => checkedFile(root, "truncated.jpg", "screenshot"));
  assert.throws(() => checkedFile(root, "wrong.jpg", "screenshot"));
});

test("rejects incomplete steps and unsupported or escaped files", () => {
  const root = fixture();
  assert.throws(() => validateShowcase(root, { useCase: "Demo", file: "demo.webm", steps: [] }), /nonempty/);
  assert.throws(() => validateShowcase(root, { useCase: "Demo", file: "demo.webm",
    steps: [{ title: "", explanation: "x", screenshot: "one.png" }] }), /title/);
  assert.throws(() => checkedFile(root, "../outside.webm", "video"), /inside/);
  fs.mkdirSync(path.join(root, "folder"));
  assert.throws(() => checkedFile(root, "folder", "video"), /not a file/);
  fs.symlinkSync(os.tmpdir(), path.join(root, "escape"));
  assert.throws(() => checkedFile(root, "escape/file.webm", "video"), /inside/);
});

test("returns public URLs without local paths", () => {
  const item = { id: "e1", kind: "showcase", version: 1, useCase: "Demo", name: "demo.webm", at: 1,
    path: "/private/worktree/demo.webm", steps: [{ title: "A", explanation: "B", screenshot: "/private/worktree/a.png" }] };
  const result = publicEvidence("line-1", item);
  assert.equal(result.video, "/api/lines/line-1/evidence/e1/video");
  assert.equal(result.steps[0].screenshot, "/api/lines/line-1/evidence/e1/steps/0/screenshot");
  assert.equal(JSON.stringify(result).includes("/private"), false);
});
