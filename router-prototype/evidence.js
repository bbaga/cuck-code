const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const VIDEO_EXTENSIONS = new Set([".webm"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg"]);
const FFMPEG = process.env.EVIDENCE_FFMPEG || "ffmpeg";
const DECODER_TIMEOUT_MS = 5000;

function insideWorktree(worktree, candidate) {
  const root = fs.realpathSync(worktree);
  const resolved = path.resolve(root, candidate);
  const relative = path.relative(root, resolved);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== "..");
}

function decodeMedia(file, kind, extension) {
  const format = kind === "video" ? "webm" : "image2";
  const codec = kind === "video" ? null : extension === ".png" ? "png" : "mjpeg";
  const args = ["-v", "error", "-xerror", "-nostdin", "-threads", "1", "-probesize", "5000000",
    "-analyzeduration", "5000000", "-f", format];
  if (codec) args.push("-c:v", codec);
  args.push("-i", file, "-map", "0:v:0",
    "-frames:v", "1", "-f", "null", "-");
  const result = spawnSync(FFMPEG, args, { encoding: "utf8", timeout: DECODER_TIMEOUT_MS,
    maxBuffer: 64 * 1024, windowsHide: true });
  if (result.error && result.error.code === "ENOENT") {
    throw new Error("media decoder is unavailable: ffmpeg is required");
  }
  if (result.error) throw new Error(`media decoder failed: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || "decoder rejected media").trim().split("\n")[0].slice(0, 240);
    throw new Error(`${kind} media failed decoder validation: ${detail}`);
  }
}

function checkedFile(worktree, value, kind) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${kind} file is required`);
  const root = fs.realpathSync(worktree);
  const resolved = path.resolve(root, value.trim());
  if (!insideWorktree(root, resolved)) throw new Error(`${kind} file must be inside your workdir`);
  let real;
  try { real = fs.realpathSync(resolved); }
  catch { throw new Error(`${kind} file must be inside your workdir or exist`); }
  if (!insideWorktree(root, real)) throw new Error(`${kind} file must be inside your workdir`);
  const stat = fs.statSync(real);
  if (!stat.isFile()) throw new Error(`${kind} path is not a file`);
  if (stat.size === 0) throw new Error(`${kind} file is empty`);
  const extension = path.extname(real).toLowerCase();
  if (kind !== "video" && extension !== ".png" && stat.size < 64) {
    throw new Error(`${kind} file is too small to contain a JPEG frame`);
  }
  const allowed = kind === "video" ? VIDEO_EXTENSIONS : IMAGE_EXTENSIONS;
  if (!allowed.has(extension)) throw new Error(`${kind} file has an unsupported type`);
  decodeMedia(real, kind, extension);
  return { path: real, relative: path.relative(root, real), size: stat.size };
}

function validateShowcase(worktree, body) {
  if (!body || body.kind !== undefined && body.kind !== "showcase") {
    throw new Error("showcase kind must be showcase");
  }
  if (body && body.version !== undefined && body.version !== 1) {
    throw new Error("unsupported showcase version");
  }
  if (!body || typeof body.useCase !== "string" || !body.useCase.trim()) {
    throw new Error("showcase title is required");
  }
  if (!Array.isArray(body.steps) || body.steps.length === 0) {
    throw new Error("showcase steps must be a nonempty list");
  }
  const steps = body.steps.map((step, index) => {
    if (!step || typeof step.title !== "string" || !step.title.trim()) {
      throw new Error(`step ${index + 1} title is required`);
    }
    if (typeof step.explanation !== "string" || !step.explanation.trim()) {
      throw new Error(`step ${index + 1} explanation is required`);
    }
    const screenshot = checkedFile(worktree, step.screenshot, "screenshot");
    return { title: step.title.trim(), explanation: step.explanation.trim(),
      screenshot: screenshot.path, screenshotName: path.basename(screenshot.path) };
  });
  const video = checkedFile(worktree, body.file, "video");
  if (video.size < 1024) throw new Error("video file is suspiciously small");
  return { kind: "showcase", version: 1, useCase: body.useCase.trim(),
    path: video.path, name: path.basename(video.path), steps };
}

function publicEvidence(lineId, item) {
  const result = { id: item.id, useCase: item.useCase, name: item.name, at: item.at,
    attemptId: item.attemptId || null,
    video: `/api/lines/${lineId}/evidence/${item.id}/video` };
  if (item.kind === "showcase" && item.version === 1) {
    result.kind = item.kind;
    result.version = item.version;
    result.steps = item.steps.map((step, index) => ({ title: step.title,
      explanation: step.explanation,
      screenshot: `/api/lines/${lineId}/evidence/${item.id}/steps/${index}/screenshot` }));
  }
  return result;
}

module.exports = { checkedFile, validateShowcase, publicEvidence };
