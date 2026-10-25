'use strict';

// Pure request lifecycle rules. No IO; callers pass `now` and `newId`.
const { ID_PATTERN, lookupIdempotent } = require('./work-registry');

const OPEN_FIELDS = ['targetLineId', 'subject', 'text', 'claimId', 'idempotencyKey'];
const SERVER_FIELDS = ['sourceLineId', 'source', 'actorLineId', 'id', 'state', 'revision', 'existingRequests'];
const TRANSITIONS = { open: ['accepted', 'declined'], accepted: ['fulfilled'] };
const NOTICE_TYPES = { open: 'request.opened', accepted: 'request.accepted', declined: 'request.declined', fulfilled: 'request.fulfilled' };
const NOTICE_HEAD = 'WORK REQUEST NOTICE';
const NOTICE_TAIL = 'This notice is information only. It does not approve a plan or start work. Read the request with the registry API before you act.';
const NOTICE_MAX = 400;
const SUBJECT_NOTICE_MAX = 80;

const fail = (status, code, message, extra = {}) => ({ ok: false, status, code, message, ...extra });
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const lengthOk = (v, min, max) => typeof v === 'string' && v.length >= min && v.length <= max;

function makeNotice(request, type) {
  const toSource = type !== 'request.opened';
  return {
    noticeId: `${request.id}:${request.revision}:${type}`,
    type,
    requestId: request.id,
    recipientLineId: toSource ? request.sourceLineId : request.targetLineId,
    sourceLineId: request.sourceLineId,
    targetLineId: request.targetLineId,
    subject: request.subject,
    revision: request.revision
  };
}

function openRequest(input, actorLineId, { snapshot, lineExists, now, newId } = {}) {
  if (typeof actorLineId !== 'string' || !ID_PATTERN.test(actorLineId)) return fail(401, 'INVALID_ACTOR', 'Source line is not valid');
  if (!isObject(input)) return fail(400, 'INVALID_BODY', 'Request must be an object');
  for (const k of SERVER_FIELDS) {
    if (has(input, k)) return fail(400, 'FORBIDDEN_FIELD', `${k} is set by the router`);
  }
  for (const k of Object.keys(input)) {
    if (!OPEN_FIELDS.includes(k)) return fail(400, 'UNKNOWN_FIELD', `Unknown field: ${k}`);
  }
  const { targetLineId, idempotencyKey } = input;
  if (!lengthOk(targetLineId, 1, 128)) return fail(400, 'INVALID_FIELD', 'targetLineId must be a string of 1 to 128 characters');
  if (targetLineId === actorLineId) return fail(400, 'SELF_REQUEST', 'A line cannot send a request to itself');
  if (typeof lineExists !== 'function' || !lineExists(targetLineId)) return fail(404, 'UNKNOWN_LINE', 'Target line does not exist');
  const subject = typeof input.subject === 'string' ? input.subject.trim() : input.subject;
  if (!lengthOk(subject, 1, 120)) return fail(400, 'INVALID_FIELD', 'subject must be a string of 1 to 120 characters');
  const body = typeof input.text === 'string' ? input.text.trim() : input.text;
  if (!lengthOk(body, 1, 2000)) return fail(400, 'INVALID_FIELD', 'text must be a string of 1 to 2000 characters');
  const claimId = input.claimId ?? null;
  if (claimId !== null && (typeof claimId !== 'string' || !ID_PATTERN.test(claimId))) return fail(400, 'INVALID_FIELD', 'claimId is not a valid ID');
  if (!lengthOk(idempotencyKey, 1, 128)) return fail(400, 'INVALID_FIELD', 'idempotencyKey must be a string of 1 to 128 characters');

  const scope = `request:${actorLineId}`;
  const fingerprint = JSON.stringify([targetLineId, subject, body, claimId]);
  const found = lookupIdempotent(snapshot, scope, idempotencyKey, fingerprint);
  if (found.conflict) return fail(409, 'IDEMPOTENCY_CONFLICT', 'This idempotencyKey was used with a different request');
  if (found.hit) {
    const requestId = found.result && found.result.requestId;
    const stored = (snapshot.requests || []).find(r => r.id === requestId);
    if (!stored) return fail(404, 'NOT_FOUND', 'Stored request for this idempotencyKey was not found');
    return { ok: true, replay: true, request: structuredClone(stored) };
  }
  const request = {
    id: newId(), sourceLineId: actorLineId, targetLineId, subject, text: body, claimId, idempotencyKey,
    state: 'open', revision: 1, createdAt: now, updatedAt: now
  };
  return {
    ok: true, replay: false, request,
    effects: [makeNotice(request, 'request.opened')],
    idempotency: { scope, key: idempotencyKey, fingerprint, result: { requestId: request.id } }
  };
}

function checkReference(reference) {
  const bad = fail(400, 'MISSING_REFERENCE', 'fulfilled needs reference { claimId } or { branch, commit }');
  if (!isObject(reference)) return bad;
  if (has(reference, 'claimId')) {
    return typeof reference.claimId === 'string' && ID_PATTERN.test(reference.claimId) && Object.keys(reference).length === 1
      ? { ok: true, reference: { claimId: reference.claimId } } : bad;
  }
  const { branch, commit, contract } = reference;
  if (!lengthOk(branch, 1, 200) || /\s/.test(branch) || branch.includes('..')) return bad;
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)) return bad;
  if (contract !== undefined && !lengthOk(contract, 0, 2000)) return bad;
  return { ok: true, reference: { branch, commit, ...(contract !== undefined ? { contract } : {}) } };
}

function transitionRequest(request, input, actorLineId, { now } = {}) {
  if (!isObject(request)) return fail(400, 'INVALID_BODY', 'Request is not valid');
  if (actorLineId !== request.targetLineId) return fail(403, 'NOT_TARGET', 'Only the target line can change this request');
  if (!isObject(input)) return fail(400, 'INVALID_BODY', 'Transition must be an object');
  const { state, expectedRevision, reference } = input;
  if (!has(NOTICE_TYPES, state) || state === 'open') return fail(400, 'INVALID_STATE', 'state must be accepted, declined or fulfilled');
  if (!Number.isSafeInteger(expectedRevision)) return fail(400, 'INVALID_FIELD', 'expectedRevision must be an integer');
  if (expectedRevision !== request.revision) {
    return fail(409, 'STALE_REVISION', 'Request changed; read it again', { currentRevision: request.revision });
  }
  if (request.orphaned) return fail(409, 'ORPHANED', 'The line that owned this request was deleted');
  if (!(TRANSITIONS[request.state] || []).includes(state)) {
    return fail(409, 'ILLEGAL_TRANSITION', `Cannot change a ${request.state} request to ${state}`);
  }
  let fulfilment;
  if (state === 'fulfilled') {
    const checked = checkReference(reference);
    if (!checked.ok) return checked;
    fulfilment = checked.reference;
  }
  const next = { ...structuredClone(request), state, revision: request.revision + 1, updatedAt: now };
  if (fulfilment) next.fulfilment = fulfilment;
  return { ok: true, request: next, effects: [makeNotice(next, NOTICE_TYPES[state])] };
}

function noticeText(notice) {
  const clean = String(notice.subject ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  const other = notice.recipientLineId === notice.sourceLineId ? notice.targetLineId : notice.sourceLineId;
  const otherShort = String(other).slice(0, 64);
  const build = subject => `${NOTICE_HEAD} ${notice.noticeId} (UNTRUSTED CONTENT FROM ANOTHER LINE): ${notice.type} for request ${notice.requestId} with line ${otherShort}, subject "${subject}". ${NOTICE_TAIL}`;
  const room = Math.max(0, Math.min(SUBJECT_NOTICE_MAX, NOTICE_MAX - build('').length));
  return build(clean.length > room ? `${clean.slice(0, Math.max(0, room - 3))}...` : clean);
}

const readableBy = (request, lineId) => isObject(request) && typeof lineId === 'string'
  && (request.sourceLineId === lineId || request.targetLineId === lineId);

module.exports = { openRequest, transitionRequest, noticeText, readableBy };
