const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const FFMPEG = process.env.EVIDENCE_FFMPEG || "ffmpeg";

function makeMediaFixtures(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const common = [FFMPEG, "-v", "error", "-y"];
  const images = [
    ["-f", "lavfi", "-i", "color=c=blue:s=64x64", "-frames:v", "1", path.join(directory, "one.png")],
    ["-f", "lavfi", "-i", "color=c=red:s=64x64", "-frames:v", "1", path.join(directory, "one.jpg")],
  ];
  for (const args of images) run([...common, ...args]);
  run([...common, "-f", "lavfi", "-i", "testsrc=size=64x64:rate=10:duration=1",
    "-c:v", "libvpx", "-deadline", "realtime", path.join(directory, "demo.webm")]);
}

function run(args) {
  const result = spawnSync(args[0], args.slice(1), { encoding: "utf8", timeout: 10000,
    maxBuffer: 64 * 1024, windowsHide: true });
  if (result.error) throw new Error(`media fixture generation failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`media fixture generation failed: ${(result.stderr || "").trim()}`);
}

module.exports = { makeMediaFixtures };
