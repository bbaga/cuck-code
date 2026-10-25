const fs = require("node:fs");
const path = require("node:path");

const VIDEO_EXTENSIONS = new Set([".webm"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg"]);

function insideWorktree(worktree, candidate) {
  const root = fs.realpathSync(worktree);
  const resolved = path.resolve(root, candidate);
  const relative = path.relative(root, resolved);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== "..");
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
  const allowed = kind === "video" ? VIDEO_EXTENSIONS : IMAGE_EXTENSIONS;
  if (!allowed.has(extension)) throw new Error(`${kind} file has an unsupported type`);
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
  const video = checkedFile(worktree, body.file, "video");
  if (video.size < 1024) throw new Error("video file is suspiciously small");
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
  return { kind: "showcase", version: 1, useCase: body.useCase.trim(),
    path: video.path, name: path.basename(video.path), steps };
}

function publicEvidence(lineId, item) {
  const result = { id: item.id, useCase: item.useCase, name: item.name, at: item.at,
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
