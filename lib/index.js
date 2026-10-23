// dsh-codex-runs — host half
//
// One job: turn Codex CLI's own rollout files into a run list and hand it to the
// browser panel over the read-only route GET /api/codex-runs.
//
// Data source (verified against real rollouts on 2026-10-23, cli_version 0.162.1):
//   ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ISO local time>-<sessionUuid>.jsonl
//   one JSON object per line, `{ timestamp, ordinal, type, payload }`:
//
//   type=session_meta  (first line, payload keys: session_id, id, timestamp, cwd,
//                       runtime_workspace_roots, originator, cli_version, source,
//                       thread_source, model_provider, base_instructions,
//                       history_mode, context_window[, git])
//                       NOTE: there is no `model` here, and the line is ~22 KB
//                       because base_instructions rides along.
//   type=turn_context  payload: turn_id, cwd, model ("gpt-6.1-sol"), effort, ...
//                       one per turn start; measured at ~67 KB..167 KB into the
//                       file, i.e. beyond a 4 KB head read.
//   type=event_msg payload.type=task_started  { turn_id, started_at (epoch s),
//                                               turn_attribution, ... }
//   type=event_msg payload.type=task_complete { turn_id, last_agent_message,
//                                               started_at, completed_at (epoch s),
//                                               duration_ms, ... }
//   type=event_msg payload.type=turn_aborted  { turn_id, reason,
//                                               started_at, completed_at, duration_ms }
//   type=event_msg payload.type=token_count   info.total_token_usage.total_tokens
//                                               is the cumulative total
//   type=response_item payload.type=message role=assistant, content[].type=output_text
//
// Read budget (a rollout can be many MB, and the panel polls every 10 s):
//   - head: 4 KB, grown to the end of the first line (session_meta is ~22 KB),
//     and only further when the model is still unknown — capped at 256 KB. The
//     forward probe is what reaches turn_context; a per-file cache means it is
//     paid once per file version, not once per poll.
//   - tail: 64 KB, aligned to the first complete line.
//
// Constraints:
//   - read-only: nothing under ~/.codex is modified, no state files are written;
//   - every failure returns diagnosable JSON instead of an empty 400/500 body;
//   - rollout contents never reach the log — only counts, paths and error codes;
//   - self-contained: no dependency beyond node: builtins, no patched ndjson.

import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** Cordis function-plugin name (the entry id in cordis.patch.yml is `codex-runs`). */
export const name = "codex-runs";

/** The route carrier. Declared so apply() only runs once webServer exists. */
export const inject = ["webServer"];

/** The one exact route this plugin claims. */
const ROUTE_PATH = "/api/codex-runs";

/** Codex CLI's own session tree (rollout files live below it). */
const DEFAULT_ROOT = path.join(homedir(), ".codex", "sessions");

/** Only files modified within this window are considered. */
const DEFAULT_WINDOW_DAYS = 7;

/** Hard cap on rollout files opened per scan (newest mtime first). */
const DEFAULT_MAX_FILES = 200;

/** How many runs the endpoint returns. */
const DEFAULT_MAX_RUNS = 50;

/** Head read: the first 4 KB, then grown to line boundaries. */
const HEAD_BYTES = 4 * 1024;

/**
 * Hard cap for the head read. session_meta is ~22 KB, and turn_context sits
 * somewhere past the first user turn; 256 KB covers every rollout observed,
 * while an unchanged file costs nothing thanks to the parse cache.
 */
const MAX_HEAD_BYTES = 256 * 1024;

/** Tail read: enough for the last turns, token totals and the final message. */
const TAIL_BYTES = 64 * 1024;

/** Truncation guard for one agent message (the panel shows it in full). */
const MAX_MESSAGE_CHARS = 32 * 1024;

/**
 * A started-but-unfinished turn whose file went quiet this long reads as
 * aborted. A live Codex turn usually appends within seconds, so the window is
 * generous on purpose: showing a live turn as aborted (and flipping it back on
 * the next write) is worse than showing a killed one as running for a while.
 */
const RUNNING_STALE_MS = 5 * 60 * 1000;

/** Only rollout files, at most 4 directory levels below the root. */
const ROLLOUT_RE = /^rollout-.+\.jsonl$/;
const MAX_DEPTH = 4;

const SESSION_META_MARK = '"type":"session_meta"';
const TURN_CONTEXT_MARK = '"type":"turn_context"';

// ---- small helpers -------------------------------------------------------

/** JSON response helper. Never throws into the route's caller. */
function writeJson(res, status, body) {
  let payload;
  try {
    payload = JSON.stringify(body);
  } catch {
    payload = JSON.stringify({ ok: false, runs: [], error: { message: "response serialization failed" } });
  }
  try {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    });
    res.end(payload);
  } catch {
    // The socket is already gone; there is nothing left to answer on.
    try {
      res.destroy();
    } catch {
      /* ignore */
    }
  }
}

/** A diagnosable error object without ever including rollout content. */
function describeError(error) {
  if (error === null || error === undefined) return { name: "Error", message: "unknown error" };
  if (typeof error === "string") return { name: "Error", message: error };
  const out = {
    name: typeof error.name === "string" ? error.name : "Error",
    message: String(error.message ?? error),
  };
  if (typeof error.code === "string") out.code = error.code;
  return out;
}

/** Best-effort string coercion for a scalar field. */
function textOf(value) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/**
 * Timestamp → epoch ms. Codex writes ISO strings on the envelope and epoch
 * SECONDS inside task payloads (`started_at`, `completed_at`), so a bare number
 * below 1e12 is read as seconds.
 */
function toEpochMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** ISO string for an epoch-ms value, or null. */
function isoOf(ms) {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Parse one ndjson line; null for anything that is not a JSON object. */
function parseLine(line) {
  const text = line.trim();
  if (text === "") return null;
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    return value;
  } catch {
    return null;
  }
}

/**
 * Complete lines only: the trailing element is dropped because the read may end
 * mid-line. A dropped partial line is never parsed, so a cut-off JSON object is
 * never mistaken for a malformed record.
 */
function completeLines(text) {
  if (text === "") return [];
  const lines = text.split("\n");
  lines.pop();
  return lines;
}

// ---- bounded file reads --------------------------------------------------

/**
 * Read exactly one byte range. Short files simply yield a shorter string.
 *
 * @param {string} file - absolute path.
 * @param {number} start - byte offset.
 * @param {number} length - at most this many bytes.
 * @returns {string}
 */
function readRangeSync(file, start, length) {
  if (length <= 0) return "";
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const bytes = readSync(fd, buffer, offset, length - offset, start + offset);
      if (bytes <= 0) break;
      offset += bytes;
    }
    let text = buffer.subarray(0, offset).toString("utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return text;
  } finally {
    closeSync(fd);
  }
}

/** True when the text holds complete lines with both needed markers. */
function headSatisfied(text, wantModel) {
  let hasMeta = false;
  let hasContext = false;
  for (const line of completeLines(text)) {
    if (!hasMeta && line.includes(SESSION_META_MARK)) hasMeta = true;
    if (!hasContext && line.includes(TURN_CONTEXT_MARK)) hasContext = true;
    if (hasMeta && (hasContext || !wantModel)) return true;
  }
  return hasMeta && !wantModel;
}

/**
 * The bounded head read: 4 KB, doubled until session_meta (and, when the model
 * is still unknown, turn_context) is complete, or MAX_HEAD_BYTES is reached.
 *
 * @returns {string}
 */
function readHeadSync(file, size, wantModel) {
  let want = Math.min(size, HEAD_BYTES);
  let text = readRangeSync(file, 0, want);
  while (want < size && want < MAX_HEAD_BYTES) {
    if (headSatisfied(text, wantModel)) break;
    const next = Math.min(size, Math.min(MAX_HEAD_BYTES, want * 2));
    text = readRangeSync(file, 0, next);
    want = next;
  }
  return text;
}

/** The bounded tail read: the last TAIL_BYTES bytes (the whole file when smaller). */
function readTailSync(file, size) {
  const length = Math.min(size, TAIL_BYTES);
  return readRangeSync(file, size - length, length);
}

// ---- rollout parsing -----------------------------------------------------

/** Fresh accumulator for one rollout file. */
function newState() {
  return {
    sessionId: "",
    cwd: "",
    model: "",
    metaAtMs: undefined,
    turnContextCwd: "",
    marker: null, // last of task_started | task_complete | turn_aborted
    lastMessage: "",
    totalTokens: null,
  };
}

/** Join the text blocks of an assistant message; other block types are ignored. */
function assistantText(payload) {
  const blocks = Array.isArray(payload?.content) ? payload.content : [];
  const parts = [];
  for (const block of blocks) {
    if (block === null || typeof block !== "object") continue;
    if (block.type !== "output_text" && block.type !== "text") continue;
    if (typeof block.text === "string" && block.text !== "") parts.push(block.text);
  }
  let text = parts.join("\n");
  if (text.length > MAX_MESSAGE_CHARS) text = text.slice(0, MAX_MESSAGE_CHARS);
  return text;
}

/**
 * Fold one batch of ndjson lines into the accumulator. Batches are applied in
 * file order (head first, tail second); a line seen in both is idempotent.
 *
 * @param {ReturnType<typeof newState>} state
 * @param {string} text - raw slice.
 * @param {boolean} dropFirstPartial - the slice started mid-line (tail read).
 */
function foldLines(state, text, dropFirstPartial) {
  const lines = completeLines(text);
  if (dropFirstPartial && lines.length > 0) lines.shift();

  for (const line of lines) {
    const event = parseLine(line);
    if (event === null) continue;

    if (event.type === "session_meta") {
      const payload = event.payload ?? {};
      if (state.sessionId === "") state.sessionId = textOf(payload.session_id) || textOf(payload.id);
      if (state.cwd === "") state.cwd = textOf(payload.cwd);
      if (state.metaAtMs === undefined) {
        state.metaAtMs = toEpochMs(payload.timestamp) ?? toEpochMs(event.timestamp);
      }
      continue;
    }

    if (event.type === "turn_context") {
      const payload = event.payload ?? {};
      if (textOf(payload.model) !== "") state.model = textOf(payload.model);
      if (textOf(payload.cwd) !== "") state.turnContextCwd = textOf(payload.cwd);
      continue;
    }

    if (event.type === "response_item") {
      const payload = event.payload ?? {};
      if (payload.type === "message" && payload.role === "assistant") {
        const text2 = assistantText(payload);
        if (text2 !== "") state.lastMessage = text2;
      }
      continue;
    }

    if (event.type !== "event_msg") continue;
    const payload = event.payload ?? {};
    const kind = payload.type;

    if (kind === "task_started") {
      const atMs = toEpochMs(payload.started_at) ?? toEpochMs(event.timestamp);
      state.marker = { kind: "task_started", atMs, completedAtMs: undefined };
      continue;
    }

    if (kind === "task_complete" || kind === "turn_aborted") {
      const completedAtMs = toEpochMs(payload.completed_at) ?? toEpochMs(event.timestamp);
      state.marker = {
        kind: kind === "task_complete" ? "task_complete" : "turn_aborted",
        atMs: toEpochMs(payload.started_at) ?? completedAtMs,
        completedAtMs,
      };
      if (kind === "task_complete") {
        const message = textOf(payload.last_agent_message);
        if (message !== "") {
          state.lastMessage = message.length > MAX_MESSAGE_CHARS ? message.slice(0, MAX_MESSAGE_CHARS) : message;
        }
      }
      continue;
    }

    if (kind === "token_count") {
      const total = payload.info?.total_token_usage?.total_tokens;
      if (typeof total === "number" && Number.isFinite(total) && total >= 0) state.totalTokens = total;
    }
  }
}

/** The session uuid baked into the file name (`rollout-<ISO>-<uuid>.jsonl`). */
function sessionIdFromPath(file) {
  const base = path.basename(file);
  const match = /^rollout-(.+)-([0-9a-fA-F-]{36})\.jsonl$/.exec(base);
  if (match !== null) return match[2];
  return base.replace(/\.jsonl$/, "");
}

/**
 * The ISO LOCAL start time baked into the file name (`rollout-2026-10-23T14-09-26-…`).
 * It is the fallback for startedAt when session_meta is unreadable; the value has
 * no offset, so Date.parse reads it in the host's local zone — which is what the
 * name means.
 */
function startedAtFromPath(file) {
  const match = /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-/.exec(path.basename(file));
  if (match === null) return undefined;
  const parsed = Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Turn markers → the panel's status vocabulary. */
function statusOf(state, mtimeMs, nowMs) {
  const marker = state.marker;
  if (marker === null) return "unknown";
  if (marker.kind === "task_complete") return "done";
  if (marker.kind === "turn_aborted") return "aborted";
  // A turn started and never finished: live while the file keeps being written,
  // aborted once Codex stopped touching it.
  return nowMs - mtimeMs <= RUNNING_STALE_MS ? "running" : "aborted";
}

/**
 * Parse one rollout file into the internal run record.
 *
 * @param {{ path: string, size: number, mtimeMs: number }} entry
 * @returns {object} internal record (no cache side effects).
 */
function parseRollout(entry) {
  const state = newState();
  // The model lives in turn_context, which is written at every turn start: a
  // multi-turn session already has one in the tail, so the head only has to
  // probe forward when the tail cannot answer. Read the tail first to decide,
  // then fold head before tail so the markers stay chronological.
  const tail = readTailSync(entry.path, entry.size);
  const tailHasContext = tail.includes(TURN_CONTEXT_MARK);
  const head = readHeadSync(entry.path, entry.size, !tailHasContext);
  foldLines(state, head, false);
  foldLines(state, tail, entry.size > TAIL_BYTES);

  return {
    id: state.sessionId !== "" ? state.sessionId : sessionIdFromPath(entry.path),
    cwd: state.cwd !== "" ? state.cwd : state.turnContextCwd,
    model: state.model,
    metaAtMs: state.metaAtMs,
    marker: state.marker,
    lastMessage: state.lastMessage,
    totalTokens: state.totalTokens,
    mtimeMs: entry.mtimeMs,
    size: entry.size,
    rolloutPath: entry.path,
  };
}

/** Internal record → the endpoint's public shape. */
function toPublicRun(record, nowMs) {
  const status = statusOf(record, record.mtimeMs, nowMs);
  const startedAtMs = record.metaAtMs ?? startedAtFromPath(record.rolloutPath);
  const endedAtMs =
    status === "done" || status === "aborted" ? (record.marker?.completedAtMs ?? undefined) : undefined;
  const durationMs =
    startedAtMs !== undefined && endedAtMs !== undefined ? Math.max(0, endedAtMs - startedAtMs) : null;

  return {
    id: record.id,
    cwd: record.cwd,
    model: record.model,
    startedAt: isoOf(startedAtMs) ?? null,
    endedAt: isoOf(endedAtMs) ?? null,
    status,
    durationMs,
    lastMessage: record.lastMessage,
    totalTokens: record.totalTokens,
    rolloutPath: record.rolloutPath,
  };
}

// ---- discovery -----------------------------------------------------------

/**
 * Every rollout file under the root that was modified inside the window,
 * newest first and capped at maxFiles.
 *
 * @param {string} root
 * @param {number} cutoffMs
 * @returns {Array<{ path: string, size: number, mtimeMs: number }>}
 */
function listRollouts(root, cutoffMs) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable (or vanished) directory: just skip it
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || !ROLLOUT_RE.test(entry.name)) continue;
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.mtimeMs < cutoffMs) continue;
      found.push({ path: full, size: stat.size, mtimeMs: stat.mtimeMs });
    }
  };
  walk(root, 0);
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found;
}

// ---- scan (cached) -------------------------------------------------------

/**
 * Per-path parse cache. A rollout is immutable in practice except while it is
 * being written, so keying on (size, mtimeMs) keeps the 10 s poll cheap: only a
 * file that actually grew is re-read, and the 256 KB head probe is paid once.
 */
const parseCache = new Map();

/**
 * Merge the rollouts under `root` into runs, newest start first.
 *
 * @param {{ root?: string, windowDays?: number, maxFiles?: number, maxRuns?: number, now?: number }} [options]
 * @returns {{ runs: Array<object>, root: string, windowDays: number, scannedFiles: number, matchedFiles: number, skippedFiles: number, truncatedFiles: boolean, truncatedRuns: boolean, rootMissing: boolean }}
 */
export function collectRuns(options = {}) {
  const root = typeof options.root === "string" && options.root !== "" ? options.root : DEFAULT_ROOT;
  const windowDays = Number.isFinite(options.windowDays) && options.windowDays > 0 ? options.windowDays : DEFAULT_WINDOW_DAYS;
  const maxFiles = Number.isInteger(options.maxFiles) && options.maxFiles > 0 ? options.maxFiles : DEFAULT_MAX_FILES;
  const maxRuns = Number.isInteger(options.maxRuns) && options.maxRuns > 0 ? options.maxRuns : DEFAULT_MAX_RUNS;
  const nowMs = Number.isFinite(options.now) ? options.now : Date.now();

  let rootStat;
  try {
    rootStat = statSync(root);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return {
        runs: [],
        root,
        windowDays,
        scannedFiles: 0,
        matchedFiles: 0,
        skippedFiles: 0,
        truncatedFiles: false,
        truncatedRuns: false,
        rootMissing: true,
      };
    }
    throw error;
  }
  if (!rootStat.isDirectory()) {
    throw new Error("session root is not a directory");
  }

  const cutoffMs = nowMs - windowDays * 24 * 60 * 60 * 1000;
  const candidates = listRollouts(root, cutoffMs);
  const capped = candidates.slice(0, maxFiles);

  const records = [];
  let skippedFiles = 0;
  const seen = new Set();
  for (const entry of capped) {
    seen.add(entry.path);
    try {
      const cached = parseCache.get(entry.path);
      let record;
      if (cached !== undefined && cached.size === entry.size && cached.mtimeMs === entry.mtimeMs) {
        record = cached.record;
      } else {
        record = parseRollout(entry);
        parseCache.set(entry.path, { size: entry.size, mtimeMs: entry.mtimeMs, record });
      }
      records.push(record);
    } catch {
      // One unreadable rollout must not hide the rest of the history.
      skippedFiles += 1;
    }
  }
  // Bound the cache to what this scan actually visits.
  for (const key of parseCache.keys()) if (!seen.has(key)) parseCache.delete(key);

  const runs = records.map((record) => toPublicRun(record, nowMs));
  const timeOf = (run) => {
    if (run.startedAt !== null) return Date.parse(run.startedAt);
    if (run.endedAt !== null) return Date.parse(run.endedAt);
    return 0;
  };
  runs.sort((a, b) => {
    const delta = timeOf(b) - timeOf(a);
    if (delta !== 0) return delta;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return {
    runs: runs.slice(0, maxRuns),
    root,
    windowDays,
    scannedFiles: candidates.length,
    matchedFiles: runs.length,
    skippedFiles,
    truncatedFiles: candidates.length > capped.length,
    truncatedRuns: runs.length > maxRuns,
    rootMissing: false,
  };
}

/**
 * Build the endpoint payload. Every failure path returns a body, never throws.
 *
 * @param {{ root?: string, maxRuns?: number }} options
 * @returns {{ status: number, body: object }}
 */
export function buildPayload(options = {}) {
  const generatedAt = new Date().toISOString();
  try {
    const result = collectRuns(options);
    return {
      status: 200,
      body: {
        ok: true,
        runs: result.runs,
        root: result.root,
        windowDays: result.windowDays,
        scannedFiles: result.scannedFiles,
        matchedFiles: result.matchedFiles,
        skippedFiles: result.skippedFiles,
        truncatedFiles: result.truncatedFiles,
        truncatedRuns: result.truncatedRuns,
        rootMissing: result.rootMissing,
        generatedAt,
      },
    };
  } catch (error) {
    return {
      status: 500,
      body: { ok: false, runs: [], error: describeError(error), generatedAt },
    };
  }
}

// ---- browser-trust fence -------------------------------------------------
// The route is read-only, but the payload carries workspace paths and agent
// messages, so it is not open to the whole network: loopback (the panel itself)
// is trusted, and every other caller must be admitted by the host's own
// connection fence (trusted Host/Origin + authenticated browser session).

function parseAuthority(authority) {
  if (typeof authority !== "string" || authority === "") return null;
  try {
    return new URL("http://" + authority);
  } catch {
    return null;
  }
}

function isLoopbackAddress(address) {
  const value = String(address ?? "");
  return value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1" || /^127\./.test(value);
}

/**
 * Accept exactly the flow the host's own fence accepts. Returns true when the
 * request may proceed, otherwise writes the rejection and returns false.
 */
function makeGuard(ctx) {
  return function guard(req, res) {
    if (req.headers["sec-fetch-site"] === "cross-site") {
      writeJson(res, 403, { ok: false, runs: [], error: { name: "Forbidden", message: "cross-site requests are not allowed" } });
      return false;
    }
    if (req.method !== "GET") {
      res.setHeader("allow", "GET");
      writeJson(res, 405, { ok: false, runs: [], error: { name: "MethodNotAllowed", message: "method not allowed: " + String(req.method ?? "") } });
      return false;
    }

    const hostUrl = parseAuthority(req.headers.host);
    if (hostUrl === null) {
      writeJson(res, 400, { ok: false, runs: [], error: { name: "BadRequest", message: "missing or malformed Host header" } });
      return false;
    }

    // Same-origin only: a present Origin must agree with Host.
    const origin = req.headers.origin;
    if (typeof origin === "string" && origin !== "" && origin !== "null") {
      const originUrl = parseAuthority(origin);
      if (originUrl === null || originUrl.host !== hostUrl.host) {
        writeJson(res, 403, { ok: false, runs: [], error: { name: "Forbidden", message: "cross-origin requests are not allowed" } });
        return false;
      }
    }

    // Loopback callers are the panel itself.
    if (isLoopbackAddress(req.socket?.remoteAddress)) return true;

    // Everything else must be admitted by the host's own connection fence
    // (trusted Host/Origin plus an authenticated browser session). The payload
    // carries workspace paths and agent messages, so this route fails CLOSED
    // when the fence is unavailable instead of trusting a non-loopback caller
    // just because it reached the bound interface.
    try {
      const connection = typeof ctx.get === "function" ? ctx.get("connection") : undefined;
      if (connection && typeof connection.requestRejection === "function") {
        const rejection = connection.requestRejection(req);
        if (rejection === undefined) return true;
        writeJson(res, Number.isInteger(rejection) ? rejection : 403, {
          ok: false,
          runs: [],
          error: { name: "Forbidden", message: "request rejected by the host browser-trust fence" },
        });
        return false;
      }
    } catch {
      /* fall through to the plain rejection below */
    }

    writeJson(res, 403, {
      ok: false,
      runs: [],
      error: { name: "Forbidden", message: "requests must come from the local host or be admitted by the host browser-trust fence" },
    });
    return false;
  };
}

/**
 * Register the read-only route on one plugin context.
 *
 * @param ctx - the cordis plugin context (web profile).
 * @param config - optional `{ root, maxRuns }` overrides (kept for diagnostics/tests).
 */
export function apply(ctx, config = {}) {
  const options = {
    root: typeof config?.root === "string" && config.root !== "" ? config.root : DEFAULT_ROOT,
    maxRuns: Number.isInteger(config?.maxRuns) && config.maxRuns > 0 ? config.maxRuns : DEFAULT_MAX_RUNS,
  };
  const guard = makeGuard(ctx);

  // Only the message changes — never rollout content — and a persistent failure
  // is logged at most once a minute so a 10s poll cannot flood the log.
  let lastIssue = "";
  let lastIssueAt = 0;
  const reportIssue = (error) => {
    const message = String(error?.message ?? error);
    const now = Date.now();
    if (message === lastIssue && now - lastIssueAt < 60000) return;
    lastIssue = message;
    lastIssueAt = now;
    ctx.logger?.warn?.("codex-runs: could not scan the Codex session tree: " + message);
  };

  const handler = async (req, res) => {
    try {
      if (!guard(req, res)) return;
      const result = buildPayload(options);
      if (result.body.error !== undefined) reportIssue(result.body.error);
      writeJson(res, result.status, result.body);
    } catch (error) {
      // Any unexpected throw still answers with diagnosable JSON instead of
      // letting webServer turn it into an empty 400.
      reportIssue(error);
      writeJson(res, 500, {
        ok: false,
        runs: [],
        root: options.root,
        error: describeError(error),
        generatedAt: new Date().toISOString(),
      });
    }
  };

  // `sctx` is the webServer-scoped context (same shape free-search uses); the
  // effect owns the route disposer so an unload cannot leave a dangling route.
  ctx.inject(["webServer"], (sctx) => {
    const server = sctx.webServer ?? (typeof sctx.get === "function" ? sctx.get("webServer") : undefined);
    if (!server || typeof server.register !== "function") {
      ctx.logger?.warn?.("codex-runs: webServer.register is unavailable — the run route was not registered");
      return;
    }
    sctx.effect(
      () => server.register({ kind: "exact", path: ROUTE_PATH, handler }),
      "codex-runs: GET " + ROUTE_PATH
    );
    ctx.logger?.info?.("codex-runs: read-only Codex run history at GET " + ROUTE_PATH);
  });
}
