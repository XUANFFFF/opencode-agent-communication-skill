#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DEBUG_ENABLED = process.env.OPENCODE_AGENT_DEBUG === "1";
const SYSTEM_AGENT_NAMES = new Set(["compaction", "summary", "title"]);
const FALLBACK_PATTERNS = [
  /is a subagent, not a primary agent/i,
  /falling back to default agent/i,
  /agent not found/i,
  /falling back/i,
];
const CODEX_HOME = process.env.CODEX_HOME
  ? path.resolve(process.env.CODEX_HOME)
  : path.join(os.homedir(), ".codex");
const STATE_DIR = path.join(
  CODEX_HOME,
  "state",
  "opencode-agent-communication",
);
const STATE_FILE = path.join(STATE_DIR, "sessions.json");
let resolvedOpencode = null;

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

class CommandError extends Error {
  constructor(message, code = 1, extra = {}) {
    super(message);
    this.name = "CommandError";
    this.code = code;
    this.extra = extra;
  }
}

function debugLog(label, value) {
  if (!DEBUG_ENABLED) {
    return;
  }
  const rendered =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  process.stderr.write(`[opencode-agent debug] ${label}: ${rendered}\n`);
}

function buildJsonErrorResponse({
  errorCode,
  message,
  processExitCode = null,
  exitCode = 1,
  ...rest
}) {
  return new CommandError(message, processExitCode ?? exitCode, {
    jsonResponse: {
      ok: false,
      errorCode,
      message,
      ...rest,
    },
  });
}

function usage() {
  return `Usage:
  opencode-agent.mjs doctor
  opencode-agent.mjs preflight <project-dir> <path...>
  opencode-agent.mjs list-agents
  opencode-agent.mjs evidence <project-dir> [--file <path> ...] [--required-fact <id> ...] [-- <prompt...>]
  opencode-agent.mjs oneshot <agent> <project-dir> [--file <path> ...] [-- <prompt...>]
  opencode-agent.mjs start <agent> <session-name> <project-dir> [--file <path> ...] [-- <prompt...>]
  opencode-agent.mjs prompt <session-name> <prompt...>
  opencode-agent.mjs history <session-name>
  opencode-agent.mjs show <session-name>
  opencode-agent.mjs delete <session-name>

Prompt input:
  - Pass prompt as trailing arguments, or
  - Pipe prompt text through stdin when no prompt arguments are provided.

Examples:
  node opencode-agent.mjs doctor
  node opencode-agent.mjs oneshot plan C:\\repo "请只读分析 README"
  @"
  长 prompt
  "@ | node opencode-agent.mjs start build my-session C:\\repo`;
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function isPathInside(parentDir, candidatePath) {
  const relative = path.relative(parentDir, candidatePath);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function ensureSafeName(kind, value) {
  if (!SAFE_NAME.test(value)) {
    throw new CommandError(
      `${kind} contains unsafe characters: ${value}`,
      2,
      { kind, value },
    );
  }
}

async function ensureDirectory(projectDir) {
  const resolved = path.resolve(projectDir);
  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch {
    throw new CommandError(`project-dir does not exist: ${resolved}`, 2, {
      projectDir: resolved,
    });
  }
  if (!stat.isDirectory()) {
    throw new CommandError(`project-dir is not a directory: ${resolved}`, 2, {
      projectDir: resolved,
    });
  }
  return resolved;
}

async function inspectProjectPath(projectDir, requestedPath) {
  const resolved = path.resolve(projectDir, requestedPath);
  if (!isPathInside(projectDir, resolved)) {
    throw buildJsonErrorResponse({
      errorCode: "PATH_OUTSIDE_PROJECT",
      exitCode: 2,
      projectDir,
      requestedPath,
      resolvedPath: resolved,
      message: `Path escapes project-dir: ${requestedPath}`,
    });
  }

  try {
    const stat = await fs.stat(resolved);
    if (stat.isFile()) {
      return {
        requested: requestedPath,
        resolved,
        relativePath: toPosixRelativePath(path.relative(projectDir, resolved)),
        exists: true,
        type: "file",
      };
    }
    if (stat.isDirectory()) {
      return {
        requested: requestedPath,
        resolved,
        relativePath: toPosixRelativePath(path.relative(projectDir, resolved)),
        exists: true,
        type: "directory",
      };
    }
    return {
      requested: requestedPath,
      resolved,
      relativePath: toPosixRelativePath(path.relative(projectDir, resolved)),
      exists: true,
      type: "other",
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        requested: requestedPath,
        resolved,
        relativePath: toPosixRelativePath(path.relative(projectDir, resolved)),
        exists: false,
        type: "missing",
      };
    }
    throw error;
  }
}

async function resolveAttachmentFiles(projectDir, requestedFiles) {
  const attachments = [];
  for (const requested of requestedFiles) {
    const inspected = await inspectProjectPath(projectDir, requested);
    if (!inspected.exists) {
      throw buildJsonErrorResponse({
        errorCode: "ATTACHMENT_NOT_FOUND",
        exitCode: 2,
        projectDir,
        requestedPath: requested,
        resolvedPath: inspected.resolved,
        message: `Attachment file does not exist: ${requested}`,
      });
    }
    if (inspected.type !== "file") {
      throw buildJsonErrorResponse({
        errorCode: "ATTACHMENT_NOT_FILE",
        exitCode: 2,
        projectDir,
        requestedPath: requested,
        resolvedPath: inspected.resolved,
        type: inspected.type,
        message: `Attachment must be a regular file: ${requested}`,
      });
    }
    attachments.push(inspected);
  }
  return attachments;
}

function parseCommandTailArgs(args) {
  const filePaths = [];
  const promptParts = [];
  let inPrompt = false;

  for (let i = 0; i < args.length; i += 1) {
    const value = args[i];
    if (inPrompt) {
      promptParts.push(value);
      continue;
    }
    if (value === "--") {
      inPrompt = true;
      continue;
    }
    if (value === "--file") {
      const next = args[i + 1];
      if (!next) {
        throw new UsageError("--file requires a path");
      }
      filePaths.push(next);
      i += 1;
      continue;
    }
    if (value.startsWith("--")) {
      throw new UsageError(`Unknown option: ${value}`);
    }
    promptParts.push(value);
  }

  return { filePaths, promptParts };
}

function parseEvidenceTailArgs(args) {
  const filePaths = [];
  const requiredFacts = [];
  const promptParts = [];
  let inPrompt = false;

  for (let i = 0; i < args.length; i += 1) {
    const value = args[i];
    if (inPrompt) {
      promptParts.push(value);
      continue;
    }
    if (value === "--") {
      inPrompt = true;
      continue;
    }
    if (value === "--file") {
      const next = args[i + 1];
      if (!next) {
        throw new UsageError("--file requires a path");
      }
      filePaths.push(next);
      i += 1;
      continue;
    }
    if (value === "--required-fact") {
      const next = args[i + 1];
      if (!next) {
        throw new UsageError("--required-fact requires an id");
      }
      requiredFacts.push(next);
      i += 1;
      continue;
    }
    if (value.startsWith("--")) {
      throw new UsageError(`Unknown option: ${value}`);
    }
    promptParts.push(value);
  }

  return { filePaths, requiredFacts, promptParts };
}

function toPosixRelativePath(value) {
  return value.split(path.sep).join("/");
}

function normalizeMultilineText(value) {
  return String(value).replace(/\r\n/g, "\n");
}

function countLines(value) {
  return normalizeMultilineText(value).split("\n").length;
}

function countCaseInsensitiveMatches(haystack, needle) {
  const source = haystack.toLocaleLowerCase();
  const target = needle.toLocaleLowerCase();
  if (!target) {
    return 0;
  }
  let count = 0;
  let index = 0;
  while (true) {
    index = source.indexOf(target, index);
    if (index === -1) {
      return count;
    }
    count += 1;
    index += target.length;
  }
}

async function readPrompt(parts) {
  if (parts.length > 0) {
    return parts.join(" ");
  }
  if (process.stdin.isTTY) {
    throw new CommandError(
      "prompt is required as arguments or stdin",
      2,
      { usage: usage() },
    );
  }

  let text = "";
  for await (const chunk of process.stdin) {
    text += chunk.toString("utf8");
  }
  const prompt = text.replace(/\r\n/g, "\n").trimEnd();
  if (!prompt.trim()) {
    throw new CommandError("stdin prompt is empty", 2);
  }
  return prompt;
}

async function runProcess(
  command,
  args,
  {
    cwd = process.cwd(),
    stdinText = null,
    timeoutMs = 120000,
    debugInfo = null,
  } = {},
) {
  return await new Promise((resolve) => {
    debugLog("nodeVersion", process.version);
    debugLog("cwd", cwd);
    debugLog("command", command);
    debugLog("args", debugInfo?.args ?? args);
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let finished = false;
    let interrupted = false;
    let timedOut = false;

    const cleanup = () => {
      clearTimeout(timer);
      process.removeListener("SIGINT", onSigint);
    };

    const settle = (result) => {
      if (finished) {
        return;
      }
      finished = true;
      cleanup();
      resolve(result);
    };

    const onSigint = () => {
      interrupted = true;
      child.kill("SIGINT");
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!finished) {
          child.kill("SIGKILL");
        }
      }, 3000).unref();
    }, timeoutMs);

    process.on("SIGINT", onSigint);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderr += text;
      process.stderr.write(text);
    });

    child.on("error", (error) => {
      debugLog("childStatus", {
        code: 1,
        signal: null,
        timedOut,
        interrupted,
        error: error.message,
      });
      settle({
        ok: false,
        code: 1,
        signal: null,
        stdout,
        stderr,
        error,
        interrupted,
        timedOut,
      });
    });

    child.on("close", (code, signal) => {
      debugLog("childStatus", {
        code: typeof code === "number" ? code : interrupted ? 130 : 1,
        signal,
        timedOut,
        interrupted,
      });
      settle({
        ok: code === 0 && !signal && !timedOut,
        code: typeof code === "number" ? code : interrupted ? 130 : 1,
        signal,
        stdout,
        stderr,
        interrupted,
        timedOut,
      });
    });

    if (stdinText !== null) {
      child.stdin.write(stdinText);
    }
    child.stdin.end();
  });
}

function relevantPathEntries() {
  const rawPath = process.env.PATH || "";
  return rawPath
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => /node|npm|opencode/i.test(entry));
}

function buildNodeCommand() {
  return [process.execPath, ...process.argv.slice(1)];
}

function redactOpencodeArgs(args) {
  if (!Array.isArray(args) || args.length === 0) {
    return args;
  }
  const redacted = [];
  for (let i = 0; i < args.length; i += 1) {
    const value = args[i];
    if (value === "--file") {
      redacted.push(value);
      redacted.push(args[i + 1] ?? "<missing-file-arg>");
      i += 1;
      continue;
    }
    redacted.push(value);
  }
  if (redacted[0] === "run" && redacted.length > 0) {
    redacted[redacted.length - 1] = "<prompt omitted>";
  }
  return redacted;
}

function buildFailureContext({
  invocation = null,
  result = null,
  cwd = process.cwd(),
  args = [],
}) {
  return {
    nodeCommand: buildNodeCommand(),
    cwd,
    nodeVersion: process.version,
    relevantPathEntries: relevantPathEntries(),
    resolvedExecutable: invocation?.command ?? null,
    resolvedPrefixArgs: invocation?.prefixArgs ?? [],
    childArgs: redactOpencodeArgs(args),
    exitCode: result?.code ?? null,
    signal: result?.signal ?? null,
    stdout: result?.stdout ?? "",
    stderr: result?.stderr ?? "",
    timedOut: Boolean(result?.timedOut),
  };
}

async function resolveOpencodeInvocation() {
  if (resolvedOpencode) {
    return resolvedOpencode;
  }

  if (process.env.OPENCODE_BIN) {
    if (
      process.platform === "win32" &&
      /\.(cmd|bat)$/i.test(process.env.OPENCODE_BIN)
    ) {
      resolvedOpencode = {
        command: process.env.ComSpec || "cmd.exe",
        prefixArgs: ["/d", "/s", "/c", process.env.OPENCODE_BIN],
      };
      return resolvedOpencode;
    }
    resolvedOpencode = { command: process.env.OPENCODE_BIN, prefixArgs: [] };
    return resolvedOpencode;
  }

  if (process.platform !== "win32") {
    resolvedOpencode = { command: "opencode", prefixArgs: [] };
    return resolvedOpencode;
  }

  const whereResult = await runProcess("where.exe", ["opencode"], {
    timeoutMs: 10000,
  });
  ensureSuccess(whereResult, "where.exe opencode failed");

  const candidates = whereResult.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const candidate of candidates) {
    if (candidate.toLowerCase().endsWith(".exe")) {
      resolvedOpencode = { command: candidate, prefixArgs: [] };
      return resolvedOpencode;
    }

    const shimExe = path.join(
      path.dirname(candidate),
      "node_modules",
      "opencode-ai",
      "bin",
      "opencode.exe",
    );
    if (await exists(shimExe)) {
      resolvedOpencode = { command: shimExe, prefixArgs: [] };
      return resolvedOpencode;
    }
  }

  for (const candidate of candidates) {
    if (candidate.toLowerCase().endsWith(".cmd")) {
      resolvedOpencode = {
        command: process.env.ComSpec || "cmd.exe",
        prefixArgs: ["/d", "/s", "/c", candidate],
      };
      return resolvedOpencode;
    }
  }

  resolvedOpencode = { command: "opencode", prefixArgs: [] };
  return resolvedOpencode;
}

async function runOpencode(args, options = {}) {
  const invocation = await resolveOpencodeInvocation();
  debugLog("resolvedExecutable", invocation.command);
  debugLog("resolvedPrefixArgs", invocation.prefixArgs);
  return runProcess(
    invocation.command,
    [...invocation.prefixArgs, ...args],
    {
      ...options,
      debugInfo: {
        args: [...invocation.prefixArgs, ...redactOpencodeArgs(args)],
      },
    },
  );
}

function detectFallbackWarning(text) {
  for (const pattern of FALLBACK_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      return match[0];
    }
  }
  return null;
}

function ensureNoFallbackWarnings(result, args, cwd = process.cwd()) {
  const matched = detectFallbackWarning(
    `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  );
  if (!matched) {
    return;
  }
  throw buildJsonErrorResponse({
    errorCode: "AGENT_FALLBACK_DETECTED",
    processExitCode: 5,
    cwd,
    warning: matched,
    message: "OpenCode reported agent fallback or agent resolution failure.",
    ...buildFailureContext({
      result,
      cwd,
      args,
    }),
  });
}

function ensureSuccess(result, message, extra = {}) {
  if (result.ok) {
    return;
  }
  if (result.interrupted) {
    throw new CommandError(`${message} interrupted by Ctrl+C`, 130, extra);
  }
  if (result.timedOut) {
    throw new CommandError(`${message} timed out`, 124, extra);
  }
  throw new CommandError(message, result.code ?? 1, {
    ...extra,
    stdout: result.stdout,
    stderr: result.stderr,
  });
}

function parseNdjson(stdout) {
  const events = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    events.push(JSON.parse(trimmed));
  }
  return events;
}

function extractLeadingJson(text) {
  const source = text.trimStart();
  const first = source[0];
  if (!first || !["{", "["].includes(first)) {
    throw new Error("No leading JSON document found");
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      depth += 1;
      continue;
    }
    if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(0, i + 1);
      }
    }
  }
  throw new Error("Unterminated JSON document");
}

async function ensureOpencodeExists() {
  const result = await runOpencode(["--version"], { timeoutMs: 10000 });
  const invocation = await resolveOpencodeInvocation();
  ensureSuccess(result, "opencode --version failed", buildFailureContext({
    invocation,
    result,
    args: ["--version"],
  }));
  return result.stdout.trim();
}

async function listAgentsRaw() {
  const result = await runOpencode(["agent", "list"], {
    timeoutMs: 20000,
  });
  const invocation = await resolveOpencodeInvocation();
  ensureSuccess(result, "opencode agent list failed", buildFailureContext({
    invocation,
    result,
    args: ["agent", "list"],
  }));
  const agents = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9._-]+)\s+\(([^)]+)\)\s*$/);
    if (match) {
      agents.push({
        name: match[1],
        mode: match[2].trim().toLowerCase(),
      });
    }
  }

  const deduped = [];
  const seen = new Set();
  for (const agent of agents) {
    if (seen.has(agent.name)) {
      continue;
    }
    seen.add(agent.name);
    deduped.push(agent);
  }

  const selectablePrimaryAgents = [];
  const subagents = [];
  const systemAgents = [];
  for (const agent of deduped) {
    if (agent.mode === "subagent") {
      subagents.push(agent.name);
      continue;
    }
    if (agent.mode === "system" || SYSTEM_AGENT_NAMES.has(agent.name)) {
      systemAgents.push(agent.name);
      continue;
    }
    if (agent.mode === "primary") {
      selectablePrimaryAgents.push(agent.name);
    }
  }

  return {
    agents: deduped,
    selectablePrimaryAgents,
    subagents,
    systemAgents,
    stdout: result.stdout,
  };
}

async function ensureSelectablePrimaryAgent(agent) {
  ensureSafeName("agent", agent);
  const {
    agents,
    selectablePrimaryAgents,
    subagents,
    systemAgents,
  } = await listAgentsRaw();
  const matched = agents.find((entry) => entry.name === agent);
  if (!matched) {
    throw buildJsonErrorResponse({
      errorCode: "AGENT_NOT_FOUND",
      exitCode: 3,
      agent,
      message: `Agent '${agent}' was not found.`,
      selectablePrimaryAgents,
      subagents,
      systemAgents,
    });
  }
  if (matched.mode === "subagent") {
    throw buildJsonErrorResponse({
      errorCode: "AGENT_NOT_PRIMARY",
      exitCode: 3,
      agent,
      mode: matched.mode,
      message: `Agent '${agent}' is a subagent and cannot be used with oneshot or start.`,
    });
  }
  if (matched.mode === "system" || SYSTEM_AGENT_NAMES.has(agent)) {
    throw buildJsonErrorResponse({
      errorCode: "AGENT_NOT_SELECTABLE",
      exitCode: 3,
      agent,
      mode: matched.mode,
      message: `Agent '${agent}' is reserved and cannot be used with oneshot or start.`,
    });
  }
  return {
    agent: matched,
    selectablePrimaryAgents,
    subagents,
    systemAgents,
  };
}

async function sessionList() {
  const result = await runOpencode(
    ["session", "list", "--format", "json"],
    { timeoutMs: 20000 },
  );
  const invocation = await resolveOpencodeInvocation();
  ensureSuccess(result, "opencode session list failed", buildFailureContext({
    invocation,
    result,
    args: ["session", "list", "--format", "json"],
  }));
  return JSON.parse(result.stdout);
}

function defaultState() {
  return { version: 1, sessions: {} };
}

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !parsed.sessions) {
      return defaultState();
    }
    return parsed;
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return defaultState();
    }
    throw error;
  }
}

async function saveState(state) {
  await fs.mkdir(STATE_DIR, { recursive: true });
  const temp = path.join(
    STATE_DIR,
    `sessions.${process.pid}.${Date.now()}.tmp`,
  );
  await fs.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await fs.rename(temp, STATE_FILE);
}

function buildUniqueTitle(sessionName = "oneshot") {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = Math.random().toString(36).slice(2, 8);
  return `codex-opencode-${sessionName}-${stamp}-${suffix}`;
}

function extractSessionIdFromEvents(events) {
  for (const event of events) {
    if (event.sessionID) {
      return event.sessionID;
    }
    if (event.sessionId) {
      return event.sessionId;
    }
    if (event.part?.sessionID) {
      return event.part.sessionID;
    }
    if (event.part?.sessionId) {
      return event.part.sessionId;
    }
  }
  return null;
}

function extractFinalAssistantMessage(events) {
  const texts = [];
  for (const event of events) {
    if (event.type === "text" && typeof event.part?.text === "string") {
      texts.push(event.part.text);
    }
  }
  return texts.at(-1) ?? null;
}

async function runOpencodeSession({
  args,
  cwd,
  timeoutMs,
}) {
  const result = await runOpencode(args, {
    cwd,
    stdinText: null,
    timeoutMs,
  });
  ensureNoFallbackWarnings(result, args, cwd);
  const invocation = await resolveOpencodeInvocation();
  ensureSuccess(result, `opencode ${args[0]} failed`, buildFailureContext({
    invocation,
    result,
    cwd,
    args,
  }));
  const events = parseNdjson(result.stdout);
  return {
    events,
    sessionId: extractSessionIdFromEvents(events),
    finalAssistantMessage: extractFinalAssistantMessage(events),
  };
}

function findSessionByTitle({
  before,
  after,
  title,
  directory,
}) {
  const beforeIds = new Set(before.map((item) => item.id));
  const created = after
    .filter((item) => !beforeIds.has(item.id))
    .filter((item) => item.title === title)
    .filter((item) => path.resolve(item.directory) === path.resolve(directory))
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
  return created[0] ?? null;
}

async function exportSession(sessionId) {
  const result = await runOpencode(["export", sessionId], {
    timeoutMs: 30000,
  });
  const invocation = await resolveOpencodeInvocation();
  ensureSuccess(
    result,
    `opencode export failed for ${sessionId}`,
    buildFailureContext({
      invocation,
      result,
      args: ["export", sessionId],
    }),
  );
  const jsonText = extractLeadingJson(result.stdout);
  return JSON.parse(jsonText);
}

function summarizeExportMessages(exported) {
  return (exported.messages ?? []).map((message) => {
    const textParts = [];
    for (const part of message.parts ?? []) {
      if (part.type === "text" && typeof part.text === "string") {
        textParts.push(part.text);
      }
    }
    return {
      id: message.info?.id ?? null,
      role: message.info?.role ?? null,
      agent: message.info?.agent ?? null,
      created: message.info?.time?.created ?? null,
      text: textParts.join("\n").trim(),
    };
  });
}

async function cmdDoctor() {
  const version = await ensureOpencodeExists();
  const {
    agents,
    selectablePrimaryAgents,
    subagents,
    systemAgents,
  } = await listAgentsRaw();
  const sessions = await sessionList();
  const state = await loadState();
  printJson({
    ok: true,
    codexHome: CODEX_HOME,
    stateFile: STATE_FILE,
    stateExists: await exists(STATE_FILE),
    opencodeVersion: version,
    agents,
    selectablePrimaryAgents,
    subagents,
    systemAgents,
    sessionCount: sessions.length,
    localSessionNames: Object.keys(state.sessions).sort(),
  });
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function cmdPreflight(projectDir, requestedPaths) {
  if (requestedPaths.length === 0) {
    throw new UsageError("preflight requires <project-dir> <path...>");
  }
  const cwd = await ensureDirectory(projectDir);
  const paths = [];
  for (const requested of requestedPaths) {
    paths.push(await inspectProjectPath(cwd, requested));
  }
  printJson({
    ok: true,
    projectDir: cwd,
    paths,
  });
}

function buildRunArgs({
  agent,
  cwd,
  prompt,
  title = null,
  sessionId = null,
  files = [],
}) {
  const args = ["run"];
  if (sessionId) {
    args.push("--session", sessionId);
  }
  if (agent) {
    args.push("--agent", agent);
  }
  args.push("--format", "json");
  if (title) {
    args.push("--title", title);
  }
  args.push("--dir", cwd);
  for (const file of files) {
    args.push("--file", file.resolved);
  }
  args.push("--");
  args.push(prompt);
  return args;
}

function buildEvidencePrompt({
  userPrompt,
  attachments,
  requiredFacts,
}) {
  const attachmentList = attachments.map((item) => `- ${item.relativePath}`).join("\n");
  const requiredFactList = requiredFacts.length > 0
    ? requiredFacts.map((item) => `- ${item}`).join("\n")
    : "- none";
  return `You are repo-evidence.
Return exactly one JSON object and nothing else.
Do not use Markdown.
Do not use code fences.
Allowed fact types: "quote", "absence".
Forbidden output types: inference, recommendation, plan, inventory.
Each quote must be copied exactly from an attached file, be contiguous, and contain at most 3 lines.
Do not use "..." or "…" inside quote.
Each absence fact must stay within the attached file and its searchTerms scope.
Do not discuss unattached files.
If you cannot confirm something, put it in "unconfirmed".

Attached files:
${attachmentList}

Required fact ids:
${requiredFactList}

Return schema:
{
  "facts": [
    {
      "id": "string",
      "type": "quote",
      "path": "relative/path",
      "anchor": "stable anchor",
      "quote": "exact source text",
      "conclusion": "bounded factual conclusion"
    },
    {
      "id": "string",
      "type": "absence",
      "path": "relative/path",
      "searchTerms": ["term1", "term2"],
      "conclusion": "bounded absence conclusion"
    }
  ],
  "unconfirmed": [
    {
      "id": "string",
      "reason": "why it cannot be confirmed from attached files"
    }
  ]
}

Task:
${userPrompt}`;
}

function parseEvidenceJson(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    throw buildJsonErrorResponse({
      errorCode: "EVIDENCE_JSON_INVALID",
      exitCode: 6,
      message: "Final assistant reply is not a single JSON object.",
      errors: [
        {
          code: "EVIDENCE_JSON_INVALID",
          message: "Final assistant reply is not a single JSON object.",
        },
      ],
    });
  }
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw buildJsonErrorResponse({
      errorCode: "EVIDENCE_JSON_INVALID",
      exitCode: 6,
      message: "Final assistant reply is not valid JSON.",
      errors: [
        {
          code: "EVIDENCE_JSON_INVALID",
          message: error.message,
        },
      ],
    });
  }
}

function collectPlanLikeFieldErrors(factId, value, trail = []) {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      collectPlanLikeFieldErrors(factId, item, [...trail, String(index)]),
    );
  }
  if (!value || typeof value !== "object") {
    return [];
  }

  const errors = [];
  for (const [key, child] of Object.entries(value)) {
    if (/(^|_)(plan|steps|yaml|patch|diff|recommendation|proposal)(_|$)/i.test(key)) {
      errors.push({
        factId,
        code: "PLAN_CONTENT_NOT_ALLOWED",
        message: `Field '${[...trail, key].join(".")}' is not allowed in evidence output.`,
      });
    }
    errors.push(...collectPlanLikeFieldErrors(factId, child, [...trail, key]));
  }
  return errors;
}

async function validateEvidencePayload({
  payload,
  projectDir,
  attachments,
  requiredFacts,
}) {
  const errors = [];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw buildJsonErrorResponse({
      errorCode: "EVIDENCE_JSON_INVALID",
      exitCode: 6,
      message: "Evidence reply must be a JSON object.",
      errors: [
        {
          code: "EVIDENCE_JSON_INVALID",
          message: "Evidence reply must be a JSON object.",
        },
      ],
    });
  }
  if (!Array.isArray(payload.facts) || !Array.isArray(payload.unconfirmed)) {
    throw buildJsonErrorResponse({
      errorCode: "EVIDENCE_JSON_INVALID",
      exitCode: 6,
      message: "Evidence reply must contain array fields 'facts' and 'unconfirmed'.",
      errors: [
        {
          code: "EVIDENCE_JSON_INVALID",
          message: "Evidence reply must contain array fields 'facts' and 'unconfirmed'.",
        },
      ],
    });
  }

  const attachmentMap = new Map(
    attachments.map((item) => [item.relativePath, item]),
  );
  const seenIds = new Set();
  const allIds = new Set();
  const verifiedFacts = [];

  for (const fact of payload.facts) {
    const factId = typeof fact?.id === "string" ? fact.id : null;
    if (!factId) {
      errors.push({
        factId: null,
        code: "EVIDENCE_JSON_INVALID",
        message: "Each fact must contain a non-empty string id.",
      });
      continue;
    }
    if (seenIds.has(factId)) {
      errors.push({
        factId,
        code: "DUPLICATE_FACT_ID",
        message: `Duplicate fact id: ${factId}`,
      });
    }
    seenIds.add(factId);
    allIds.add(factId);
    errors.push(...collectPlanLikeFieldErrors(factId, fact));

    if (!["quote", "absence"].includes(fact.type)) {
      errors.push({
        factId,
        code: "INVALID_EVIDENCE_TYPE",
        message: `Unsupported evidence type: ${fact.type}`,
      });
      continue;
    }

    if (typeof fact.path !== "string" || !fact.path.trim()) {
      errors.push({
        factId,
        code: "UNATTACHED_PATH",
        message: "Evidence path must be a non-empty project-relative path.",
      });
      continue;
    }

    const normalizedPath = fact.path.replace(/\\/g, "/");
    if (
      path.isAbsolute(fact.path) ||
      normalizedPath.startsWith("../") ||
      normalizedPath.includes("/../") ||
      normalizedPath === ".."
    ) {
      errors.push({
        factId,
        code: "UNATTACHED_PATH",
        message: `Evidence path must stay inside project-dir: ${fact.path}`,
      });
      continue;
    }

    const attachment = attachmentMap.get(normalizedPath);
    if (!attachment) {
      errors.push({
        factId,
        code: "UNATTACHED_PATH",
        message: `Evidence path was not attached: ${fact.path}`,
      });
      continue;
    }

    const sourceText = normalizeMultilineText(
      await fs.readFile(attachment.resolved, "utf8"),
    );

    if (fact.type === "quote") {
      if (typeof fact.quote !== "string" || fact.quote.length === 0) {
        errors.push({
          factId,
          code: "QUOTE_EMPTY",
          message: "Quote evidence must contain a non-empty quote string.",
        });
      } else {
        const normalizedQuote = normalizeMultilineText(fact.quote);
        if (normalizedQuote.includes("...") || normalizedQuote.includes("…")) {
          errors.push({
            factId,
            code: "QUOTE_CONTAINS_ELLIPSIS",
            message: "Quote evidence must not contain ellipsis.",
          });
        }
        if (countLines(normalizedQuote) > 3) {
          errors.push({
            factId,
            code: "QUOTE_TOO_LONG",
            message: "Quote evidence must not exceed 3 lines.",
          });
        }
        if (!sourceText.includes(normalizedQuote)) {
          errors.push({
            factId,
            code: "QUOTE_NOT_FOUND",
            message: `Quote was not found in attached file ${normalizedPath}.`,
          });
        }
      }

      if (typeof fact.anchor !== "string" || !fact.anchor.trim()) {
        errors.push({
          factId,
          code: "EVIDENCE_JSON_INVALID",
          message: "Quote evidence must contain a non-empty anchor.",
        });
      } else if (
        !sourceText.includes(fact.anchor) &&
        !/manual review|human review|人工复核|人工检查/i.test(fact.anchor)
      ) {
        errors.push({
          factId,
          code: "EVIDENCE_JSON_INVALID",
          message: `Anchor was not found in attached file ${normalizedPath}.`,
        });
      }

      verifiedFacts.push({
        id: factId,
        type: "quote",
        path: normalizedPath,
        anchor: fact.anchor,
        quote: fact.quote,
        conclusion: fact.conclusion,
        verified: true,
      });
      continue;
    }

    if (
      !Array.isArray(fact.searchTerms) ||
      fact.searchTerms.length === 0 ||
      fact.searchTerms.some((item) => typeof item !== "string" || !item.trim())
    ) {
      errors.push({
        factId,
        code: "EVIDENCE_JSON_INVALID",
        message: "Absence evidence must contain a non-empty string array searchTerms.",
      });
      continue;
    }

    const searchResults = fact.searchTerms.map((term) => ({
      term,
      matchCount: countCaseInsensitiveMatches(sourceText, term),
    }));
    for (const result of searchResults) {
      if (result.matchCount !== 0) {
        errors.push({
          factId,
          code: "ABSENCE_TERM_FOUND",
          message: `Search term '${result.term}' was found ${result.matchCount} time(s) in ${normalizedPath}.`,
          matchCount: result.matchCount,
        });
      }
    }

    verifiedFacts.push({
      id: factId,
      type: "absence",
      path: normalizedPath,
      searchResults,
      conclusion: fact.conclusion,
      verified: true,
    });
  }

  const verifiedUnconfirmed = [];
  for (const item of payload.unconfirmed) {
    const itemId = typeof item?.id === "string" ? item.id : null;
    if (!itemId) {
      errors.push({
        factId: null,
        code: "EVIDENCE_JSON_INVALID",
        message: "Each unconfirmed item must contain a non-empty string id.",
      });
      continue;
    }
    if (seenIds.has(itemId)) {
      errors.push({
        factId: itemId,
        code: "DUPLICATE_FACT_ID",
        message: `Duplicate fact id: ${itemId}`,
      });
    }
    seenIds.add(itemId);
    allIds.add(itemId);
    if (typeof item.reason !== "string" || !item.reason.trim()) {
      errors.push({
        factId: itemId,
        code: "EVIDENCE_JSON_INVALID",
        message: "Each unconfirmed item must contain a non-empty reason string.",
      });
    }
    verifiedUnconfirmed.push({
      id: itemId,
      reason: item.reason,
    });
  }

  for (const requiredFact of requiredFacts) {
    if (!allIds.has(requiredFact)) {
      errors.push({
        factId: requiredFact,
        code: "REQUIRED_FACT_MISSING",
        message: `Required fact id was not returned: ${requiredFact}`,
      });
    }
  }

  if (errors.length > 0) {
    throw buildJsonErrorResponse({
      errorCode: "EVIDENCE_VALIDATION_FAILED",
      exitCode: 7,
      message: "Evidence output failed deterministic validation.",
      errors,
    });
  }

  return {
    facts: verifiedFacts,
    unconfirmed: verifiedUnconfirmed,
  };
}

async function cmdListAgents() {
  const version = await ensureOpencodeExists();
  const {
    agents,
    selectablePrimaryAgents,
    subagents,
    systemAgents,
  } = await listAgentsRaw();
  printJson({
    ok: true,
    opencodeVersion: version,
    agents,
    selectablePrimaryAgents,
    subagents,
    systemAgents,
  });
}

async function cmdEvidence(projectDir, tailArgs) {
  await ensureOpencodeExists();
  await ensureSelectablePrimaryAgent("repo-evidence");
  const cwd = await ensureDirectory(projectDir);
  const { filePaths, requiredFacts, promptParts } = parseEvidenceTailArgs(tailArgs);
  const attachments = await resolveAttachmentFiles(cwd, filePaths);
  const userPrompt = await readPrompt(promptParts);
  const prompt = buildEvidencePrompt({
    userPrompt,
    attachments,
    requiredFacts,
  });
  const title = buildUniqueTitle("evidence");
  const { sessionId, finalAssistantMessage } = await runOpencodeSession({
    args: buildRunArgs({
      agent: "repo-evidence",
      cwd,
      prompt,
      title,
      files: attachments,
    }),
    cwd,
    timeoutMs: 300000,
  });
  const payload = parseEvidenceJson(finalAssistantMessage);
  const validated = await validateEvidencePayload({
    payload,
    projectDir: cwd,
    attachments,
    requiredFacts,
  });
  printJson({
    ok: true,
    agent: "repo-evidence",
    sessionId,
    attachments: attachments.map((item) => item.relativePath),
    facts: validated.facts,
    unconfirmed: validated.unconfirmed,
  });
}

async function cmdOneshot(agent, projectDir, tailArgs) {
  await ensureOpencodeExists();
  await ensureSelectablePrimaryAgent(agent);
  const cwd = await ensureDirectory(projectDir);
  const { filePaths, promptParts } = parseCommandTailArgs(tailArgs);
  const attachments = await resolveAttachmentFiles(cwd, filePaths);
  const prompt = await readPrompt(promptParts);
  const title = buildUniqueTitle("oneshot");
  const { events, sessionId, finalAssistantMessage } =
    await runOpencodeSession({
      args: buildRunArgs({
        agent,
        cwd,
        prompt,
        title,
        files: attachments,
      }),
      cwd,
      timeoutMs: 300000,
    });
  printJson({
    ok: true,
    command: "oneshot",
    agent,
    projectDir: cwd,
    title,
    attachedFiles: attachments.map((item) => item.resolved),
    sessionId,
    finalAssistantMessage,
    events,
  });
}

async function cmdStart(agent, sessionName, projectDir, tailArgs) {
  await ensureOpencodeExists();
  await ensureSelectablePrimaryAgent(agent);
  ensureSafeName("session-name", sessionName);
  const cwd = await ensureDirectory(projectDir);
  const { filePaths, promptParts } = parseCommandTailArgs(tailArgs);
  const attachments = await resolveAttachmentFiles(cwd, filePaths);
  const prompt = await readPrompt(promptParts);
  const state = await loadState();
  if (state.sessions[sessionName]) {
    throw new CommandError(`Session already exists in local state: ${sessionName}`, 2, {
      sessionName,
    });
  }

  const before = await sessionList();
  const title = buildUniqueTitle(sessionName);
  const { events, sessionId: eventSessionId, finalAssistantMessage } =
    await runOpencodeSession({
      args: buildRunArgs({
        agent,
        cwd,
        prompt,
        title,
        files: attachments,
      }),
      cwd,
      timeoutMs: 300000,
    });

  const after = await sessionList();
  const discovered = eventSessionId
    ? { id: eventSessionId }
    : findSessionByTitle({ before, after, title, directory: cwd });
  const sessionId = discovered?.id ?? null;
  if (!sessionId) {
    throw new CommandError(
      "Unable to determine OpenCode session ID after start",
      1,
      { sessionName, title },
    );
  }

  state.sessions[sessionName] = {
    sessionId,
    agent,
    projectDir: cwd,
    title,
    createdAt: new Date().toISOString(),
  };
  await saveState(state);

  printJson({
    ok: true,
    command: "start",
    sessionName,
    sessionId,
    agent,
    projectDir: cwd,
    title,
    attachedFiles: attachments.map((item) => item.resolved),
    finalAssistantMessage,
    events,
  });
}

async function requireStoredSession(sessionName) {
  ensureSafeName("session-name", sessionName);
  const state = await loadState();
  const entry = state.sessions[sessionName];
  if (!entry) {
    throw new CommandError(`Session not found in local state: ${sessionName}`, 4, {
      sessionName,
      stateFile: STATE_FILE,
    });
  }
  return { state, entry };
}

async function validatePromptSession(sessionName) {
  const { state, entry } = await requireStoredSession(sessionName);
  if (typeof entry.agent !== "string" || !entry.agent.trim()) {
    throw new CommandError(`Stored session agent is missing: ${sessionName}`, 4, {
      sessionName,
      stateFile: STATE_FILE,
      entry,
    });
  }
  await ensureSelectablePrimaryAgent(entry.agent);
  const cwd = await ensureDirectory(entry.projectDir);
  return { state, entry, cwd };
}

async function cmdPrompt(sessionName, promptParts) {
  await ensureOpencodeExists();
  const { state, entry, cwd } = await validatePromptSession(sessionName);
  const prompt = await readPrompt(promptParts);
  const { events, sessionId, finalAssistantMessage } =
    await runOpencodeSession({
      args: buildRunArgs({
        agent: entry.agent,
        cwd,
        prompt,
        sessionId: entry.sessionId,
      }),
      cwd,
      timeoutMs: 300000,
    });

  entry.lastUsedAt = new Date().toISOString();
  state.sessions[sessionName] = entry;
  await saveState(state);

  printJson({
    ok: true,
    command: "prompt",
    sessionName,
    sessionId: sessionId ?? entry.sessionId,
    agent: entry.agent,
    projectDir: cwd,
    finalAssistantMessage,
    events,
  });
}

async function cmdHistory(sessionName) {
  await ensureOpencodeExists();
  const { entry } = await requireStoredSession(sessionName);
  const exported = await exportSession(entry.sessionId);
  printJson({
    ok: true,
    command: "history",
    sessionName,
    sessionId: entry.sessionId,
    agent: entry.agent,
    projectDir: entry.projectDir,
    messages: summarizeExportMessages(exported),
  });
}

async function cmdShow(sessionName) {
  await ensureOpencodeExists();
  const { entry } = await requireStoredSession(sessionName);
  const exported = await exportSession(entry.sessionId);
  printJson({
    ok: true,
    command: "show",
    sessionName,
    state: entry,
    export: exported,
  });
}

async function cmdDelete(sessionName) {
  await ensureOpencodeExists();
  const { state, entry } = await requireStoredSession(sessionName);
  const invocation = await resolveOpencodeInvocation();
  const args = ["session", "delete", entry.sessionId];
  const result = await runProcess(
    invocation.command,
    [...invocation.prefixArgs, ...args],
    {
      timeoutMs: 30000,
      debugInfo: { args: [...invocation.prefixArgs, ...args] },
    },
  );
  ensureSuccess(
    result,
    `opencode session delete failed for ${entry.sessionId}`,
    {
      sessionName,
      sessionId: entry.sessionId,
      ...buildFailureContext({
        invocation,
        result,
        args,
      }),
    },
  );
  delete state.sessions[sessionName];
  await saveState(state);
  printJson({
    ok: true,
    command: "delete",
    sessionName,
    sessionId: entry.sessionId,
  });
}

async function main(argv) {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const [command, ...rest] = argv;

  switch (command) {
    case "doctor":
      if (rest.length !== 0) {
        throw new UsageError("doctor takes no arguments");
      }
      await cmdDoctor();
      return;
    case "preflight":
      if (rest.length < 2) {
        throw new UsageError("preflight requires <project-dir> <path...>");
      }
      await cmdPreflight(rest[0], rest.slice(1));
      return;
    case "list-agents":
      if (rest.length !== 0) {
        throw new UsageError("list-agents takes no arguments");
      }
      await cmdListAgents();
      return;
    case "evidence":
      if (rest.length < 1) {
        throw new UsageError("evidence requires <project-dir> [options] [prompt]");
      }
      await cmdEvidence(rest[0], rest.slice(1));
      return;
    case "oneshot":
      if (rest.length < 2) {
        throw new UsageError("oneshot requires <agent> <project-dir> [prompt]");
      }
      await cmdOneshot(rest[0], rest[1], rest.slice(2));
      return;
    case "start":
      if (rest.length < 3) {
        throw new UsageError(
          "start requires <agent> <session-name> <project-dir> [prompt]",
        );
      }
      await cmdStart(rest[0], rest[1], rest[2], rest.slice(3));
      return;
    case "prompt":
      if (rest.length < 1) {
        throw new UsageError("prompt requires <session-name> [prompt]");
      }
      await cmdPrompt(rest[0], rest.slice(1));
      return;
    case "history":
      if (rest.length !== 1) {
        throw new UsageError("history requires <session-name>");
      }
      await cmdHistory(rest[0]);
      return;
    case "show":
      if (rest.length !== 1) {
        throw new UsageError("show requires <session-name>");
      }
      await cmdShow(rest[0]);
      return;
    case "delete":
      if (rest.length !== 1) {
        throw new UsageError("delete requires <session-name>");
      }
      await cmdDelete(rest[0]);
      return;
    default:
      throw new UsageError(`Unknown command: ${command}`);
  }
}

main(process.argv.slice(2)).catch((error) => {
  if (error instanceof UsageError) {
    process.stderr.write(`${error.message}\n\n${usage()}\n`);
    process.exit(2);
    return;
  }
  if (error instanceof CommandError) {
    if (error.extra?.jsonResponse) {
      printJson(error.extra.jsonResponse);
      process.exit(error.code);
      return;
    }
    process.stderr.write(`${error.message}\n`);
    if (error.extra && Object.keys(error.extra).length > 0) {
      process.stderr.write(`${JSON.stringify(error.extra, null, 2)}\n`);
    }
    process.exit(error.code);
    return;
  }
  process.stderr.write(`${error?.stack ?? String(error)}\n`);
  process.exit(1);
});
