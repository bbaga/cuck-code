const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { checkedFile, validateShowcase, publicEvidence } = require("../evidence");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-"));
  const webm = Buffer.alloc(2048);
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3]).copy(webm);
  Buffer.from("webm", "ascii").copy(webm, 16);
  fs.writeFileSync(path.join(root, "demo.webm"), webm);
  fs.writeFileSync(path.join(root, "one.png"), Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  fs.writeFileSync(path.join(root, "one.jpg"), Buffer.from([
    255, 216, 255, 192, 0, 11, 8, 0, 1, 0, 1, 1, 1, 17, 0, 255, 217]));
  return root;
}

test("validates a showcase and keeps ordered step metadata", () => {
  const root = fixture();
  const record = validateShowcase(root, { useCase: "Complete demo", file: "demo.webm",
    steps: [{ title: "First", explanation: "The result proves feature one.", screenshot: "one.png" }] });
  assert.equal(record.kind, "showcase");
  assert.equal(record.version, 1);
  assert.equal(record.steps[0].title, "First");
  assert.match(record.steps[0].screenshot, /one\.png$/);
});

test("validates real PNG, JPEG, and WebM signatures", () => {
  const root = fixture();
  assert.doesNotThrow(() => checkedFile(root, "demo.webm", "video"));
  assert.doesNotThrow(() => checkedFile(root, "one.png", "screenshot"));
  assert.doesNotThrow(() => checkedFile(root, "one.jpg", "screenshot"));
  fs.writeFileSync(path.join(root, "fake.webm"), Buffer.alloc(2048, 7));
  fs.writeFileSync(path.join(root, "fake.png"), Buffer.from("not png"));
  fs.writeFileSync(path.join(root, "fake.jpg"), Buffer.from([255, 216, 0, 0, 255, 217]));
  assert.throws(() => checkedFile(root, "fake.webm", "video"), /content/);
  assert.throws(() => checkedFile(root, "fake.png", "screenshot"), /content/);
  assert.throws(() => checkedFile(root, "fake.jpg", "screenshot"), /content/);
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
