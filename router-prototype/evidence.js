const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const FFMPEG = process.env.EVIDENCE_FFMPEG || "ffmpeg";
const IMAGE_TYPES = new Set([".png", ".jpg", ".jpeg"]);

function inside(root, file) {
  const rel = path.relative(root, file);
  return rel === "" || (!rel.startsWith(".." + path.sep) && rel !== "..");
}

function checkMedia(root, value, kind) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${kind} file is required`);
  const worktree = fs.realpathSync(root);
  const resolved = path.resolve(worktree, value.trim());
  if (!inside(worktree, resolved)) throw new Error(`${kind} file must be inside your workdir`);
  let file;
  try { file = fs.realpathSync(resolved); } catch { throw new Error(`${kind} file does not exist`); }
  if (!inside(worktree, file)) throw new Error(`${kind} file must be inside your workdir`);
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size === 0) throw new Error(`${kind} file is empty or not a file`);
  const ext = path.extname(file).toLowerCase();
  if (kind === "video" && ext !== ".webm") throw new Error("video file must be WebM");
  if (kind === "screenshot" && !IMAGE_TYPES.has(ext)) throw new Error("screenshot must be PNG or JPEG");
  const format = kind === "video" ? "webm" : "image2";
  const result = spawnSync(FFMPEG, ["-v", "error", "-xerror", "-nostdin", "-f", format,
    "-i", file, "-frames:v", "1", "-f", "null", "-"], { encoding: "utf8", timeout: 5000 });
  if (result.error && result.error.code === "ENOENT") throw new Error("ffmpeg is required to validate evidence media");
  if (result.error || result.status !== 0) throw new Error(`${kind} media failed ffmpeg validation`);
  return { path: file, name: path.basename(file), size: stat.size };
}

function validateShowcase(worktree, body) {
  if (!body || body.kind !== "showcase" || body.version !== 1) {
    throw new Error("showcase request must use kind showcase and version 1");
  }
  if (typeof body.useCase !== "string" || !body.useCase.trim()) throw new Error("useCase is required");
  if (!Array.isArray(body.steps) || body.steps.length === 0) throw new Error("steps must be a nonempty list");
  const steps = body.steps.map((step, index) => {
    if (!step || typeof step.title !== "string" || !step.title.trim()) throw new Error(`step ${index + 1} title is required`);
    if (typeof step.explanation !== "string" || !step.explanation.trim()) throw new Error(`step ${index + 1} explanation is required`);
    const screenshot = checkMedia(worktree, step.screenshot, "screenshot");
    return { title: step.title.trim(), explanation: step.explanation.trim(), screenshot: screenshot.path };
  });
  const video = checkMedia(worktree, body.file, "video");
  if (video.size < 1024) throw new Error("video file is suspiciously small; close the browser context before registration");
  return { kind: "showcase", version: 1, useCase: body.useCase.trim(), path: video.path, name: video.name, steps };
}

function publicEvidence(lineId, item) {
  const result = { id: item.id, useCase: item.useCase, name: item.name, at: item.at,
    video: `/api/lines/${lineId}/evidence/${item.id}/video` };
  if (item.kind === "showcase") {
    result.kind = "showcase"; result.version = 1;
    result.steps = item.steps.map((step, index) => ({ title: step.title, explanation: step.explanation,
      screenshot: `/api/lines/${lineId}/evidence/${item.id}/steps/${index}/screenshot` }));
  }
  return result;
}

module.exports = { checkMedia, validateShowcase, publicEvidence };
