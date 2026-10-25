const fs = require("node:fs");
const path = require("node:path");

const VIDEO_EXTENSIONS = new Set([".webm"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg"]);
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const JPEG_SIGNATURE = Buffer.from([255, 216]);
const WEBM_SIGNATURE = Buffer.from([26, 69, 223, 163]);

function insideWorktree(worktree, candidate) {
  const root = fs.realpathSync(worktree);
  const resolved = path.resolve(root, candidate);
  const relative = path.relative(root, resolved);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== "..");
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function hasWebmContent(buffer) {
  if (buffer.length < 12 || !buffer.subarray(0, 4).equals(WEBM_SIGNATURE)) return false;
  // Require an EBML header, a WebM segment, a cluster, and a media block.
  const segment = Buffer.from([0x18, 0x53, 0x80, 0x67]);
  const cluster = Buffer.from([0x1f, 0x43, 0xb6, 0x75]);
  const block = [Buffer.from([0xa3]), Buffer.from([0xa1])];
  const doctype = buffer.indexOf(Buffer.from("webm", "ascii"));
  const segmentAt = buffer.indexOf(segment, doctype + 4);
  const clusterAt = buffer.indexOf(cluster, segmentAt + 4);
  return doctype >= 0 && segmentAt >= 0 && clusterAt >= 0
    && block.some((id) => buffer.indexOf(id, clusterAt + 4) >= 0);
}

function hasPngContent(buffer) {
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return false;
  let offset = 8, sawHeader = false, sawData = false, sawEnd = false;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > buffer.length) return false;
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    const expected = buffer.readUInt32BE(offset + 8 + length);
    if (crc32(buffer.subarray(offset + 4, offset + 8 + length)) !== expected) return false;
    if (type === "IHDR") {
      if (sawHeader || length !== 13 || data.readUInt32BE(0) < 1 || data.readUInt32BE(4) < 1) return false;
      sawHeader = true;
    } else if (type === "IDAT" && length > 0) sawData = true;
    else if (type === "IEND") {
      if (length !== 0 || offset + 12 !== buffer.length) return false;
      sawEnd = true;
      break;
    }
    offset = end;
  }
  return sawHeader && sawData && sawEnd;
}

function hasJpegContent(buffer) {
  if (buffer.length < 4 || !buffer.subarray(0, 2).equals(JPEG_SIGNATURE)
    || !buffer.subarray(buffer.length - 2).equals(Buffer.from([255, 217]))) return false;
  // Walk markers far enough to reject arbitrary SOI/EOI wrappers.
  let offset = 2, sawFrame = false, sawScan = false;
  while (offset < buffer.length - 2) {
    if (buffer[offset++] !== 255) return false;
    while (buffer[offset] === 255) offset++;
    const marker = buffer[offset++];
    if (marker === 217) break;
    if (marker === 216 || (marker >= 208 && marker <= 215)) continue;
    if (offset + 2 > buffer.length) return false;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) return false;
    if (marker >= 192 && marker <= 195) sawFrame = true;
    offset += length;
    // The bytes after SOS are entropy-coded data, not marker segments.
    if (marker === 218) {
      sawScan = true;
      return sawFrame && sawScan && buffer.subarray(-2).equals(Buffer.from([255, 217]));
    }
  }
  return sawFrame && sawScan;
}

function validMediaContent(file, kind, extension) {
  const buffer = fs.readFileSync(file);
  if (kind === "video") return hasWebmContent(buffer);
  if (extension === ".png") return hasPngContent(buffer);
  return hasJpegContent(buffer);
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
  if (!validMediaContent(real, kind, extension)) {
    throw new Error(`${kind} file content does not match its type`);
  }
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
