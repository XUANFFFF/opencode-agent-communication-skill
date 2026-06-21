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

// ----- build-run constants -----
const BUILD_RUN_ERROR_CODES = {
  WORKTREE_NOT_CLEAN: "WORKTREE_NOT_CLEAN",
  CHANGE_OUTSIDE_ALLOWLIST: "CHANGE_OUTSIDE_ALLOWLIST",
  PROCESS_TREE_NOT_TERMINATED: "PROCESS_TREE_NOT_TERMINATED",
  WORKSPACE_NOT_STABLE: "WORKSPACE_NOT_STABLE",
  SESSION_QUARANTINED: "SESSION_QUARANTINED",
  MAX_CORRECTION_ROUNDS_EXCEEDED: "MAX_CORRECTION_ROUNDS_EXCEEDED",
  BUILD_REPORT_JSON_INVALID: "BUILD_REPORT_JSON_INVALID",
  BUILD_REPORT_SCHEMA_INVALID: "BUILD_REPORT_SCHEMA_INVALID",
  UNREPORTED_CHANGE: "UNREPORTED_CHANGE",
  REPORTED_CHANGE_NOT_FOUND: "REPORTED_CHANGE_NOT_FOUND",
  REQUIRED_TEST_NOT_REPORTED: "REQUIRED_TEST_NOT_REPORTED",
  AGENT_TEST_FAILED: "AGENT_TEST_FAILED",
  CONTRACT_SCHEMA_INVALID: "CONTRACT_SCHEMA_INVALID",
};
const VALID_PHASES = [
  "created", "running", "terminating", "quarantined",
  "awaiting_review", "accepted", "rejected", "aborted",
];
const VALID_BUILD_STATUSES = new Set(["completed", "blocked", "failed"]);
const STILLNESS_INTERVAL_MS = 2000;
const STILLNESS_MAX_WAIT_MS = 30000;
const STILLNESS_REQUIRED_SNAPSHOTS = 3;

const HIGH_RISK_VERIFICATION_COMMANDS = [
  "ssh", "scp", "sftp", "systemctl", "kubectl", "helm",
  "docker", "docker-compose", "nerdctl", "podman-compose",
  "terraform", "pulumi", "ansible", "ansible-playbook",
  "mysql", "psql", "pg_dump", "pg_restore", "mongosh", "redis-cli",
  "flyctl", "railway", "netlify", "vercel",
];

const FORBIDDEN_AGENT_ACTIONS = [
  { pattern: "deploy", description: "deployment" },
  { pattern: "publish", description: "publication" },
  { pattern: "ssh ", description: "SSH connection" },
  { pattern: "scp ", description: "SCP transfer" },
  { pattern: "systemctl ", description: "systemd service management" },
  { pattern: "kubectl ", description: "Kubernetes management" },
  { pattern: "helm ", description: "Helm chart management" },
  { pattern: "docker ", description: "Docker operations" },
  { pattern: "terraform ", description: "Terraform operations" },
  { pattern: "ansible", description: "Ansible operations" },
  { pattern: "database migration", description: "database migration" },
  { pattern: "git push", description: "remote git push" },
  { pattern: "git commit", description: "git commit (only wrapper commits)" },
  { pattern: "--dangerously-skip-permissions", description: "dangerous permission bypass" },
];

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

  opencode-agent.mjs build-run <project-dir> --contract <contract.json> -- "<task>"
  opencode-agent.mjs build-status <run-id>
  opencode-agent.mjs build-cancel <run-id>
  opencode-agent.mjs build-review <run-id> --accept|--reject [<reason>]
  opencode-agent.mjs takeover <run-id>

Prompt input:
  - Pass prompt as trailing arguments, or
  - Pipe prompt text through stdin when no prompt arguments are provided.

Examples:
  node opencode-agent.mjs doctor
  node opencode-agent.mjs oneshot plan C:\\repo "请只读分析 README"
  @"
  长 prompt
  "@ | node opencode-agent.mjs start build my-session C:\\repo
  node opencode-agent.mjs build-run C:\\project --contract contract.json -- "Implement feature X"`;
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

// ----- build-run: run id generation -----
function generateRunId() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = Math.random().toString(36).slice(2, 8);
  return `br-${stamp}-${suffix}`;
}

// ----- build-run: run state persistence -----
function getRunStateDir() {
  return path.join(STATE_DIR, "runs");
}

function getRunStateFile(runId) {
  return path.join(getRunStateDir(), `${runId}.json`);
}

async function loadRun(runId) {
  const filePath = getRunStateFile(runId);
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw buildJsonErrorResponse({
        errorCode: "SESSION_QUARANTINED",
        exitCode: 4,
        runId,
        message: `Build run not found: ${runId}`,
      });
    }
    throw error;
  }
  return JSON.parse(raw);
}

async function saveRun(runState) {
  const dir = getRunStateDir();
  await fs.mkdir(dir, { recursive: true });
  const temp = path.join(dir, `${runState.runId}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(temp, `${JSON.stringify(runState, null, 2)}\n`, "utf8");
  await fs.rename(temp, getRunStateFile(runState.runId));
}

function createInitialRunState({ runId, projectDir, sessionName, allowedPaths, contract }) {
  return {
    runId,
    sessionName,
    sessionId: null,
    phase: "created",
    editor: "opencode",
    projectDir,
    allowedPaths,
    contract,
    startedAt: null,
    finishedAt: null,
    timedOut: false,
    quarantined: false,
    correctionRounds: 0,
    codexWriteAllowed: false,
    opencodeResumeAllowed: true,
    lastReport: null,
    lastError: null,
  };
}

// ----- build-run: allowedPaths matching -----
function isAllowedPath(filePath, allowedPaths) {
  const normalized = filePath.replace(/\\/g, "/");
  for (const pattern of allowedPaths) {
    const normPattern = pattern.replace(/\\/g, "/");
    if (normPattern.endsWith("/**")) {
      const prefix = normPattern.slice(0, -3);
      if (normalized === prefix || normalized.startsWith(prefix + "/")) {
        return true;
      }
    } else if (normPattern === normalized) {
      return true;
    }
  }
  return false;
}

// ----- build-run: Git changes collection -----
async function collectGitChanges(projectDir) {
  const changes = [];

  const porcelainResult = await runProcess("git", ["status", "--porcelain=v1", "-z"], {
    cwd: projectDir, timeoutMs: 15000,
  });
  const porcelainRaw = porcelainResult.stdout;
  const porcelainEntries = porcelainRaw.split("\0").filter(Boolean);
  for (const entry of porcelainEntries) {
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const pathPart = entry.slice(3).trim();
    if (!pathPart) continue;
    if (xy === "??") {
      changes.push({ path: pathPart, action: "untracked" });
    } else if (xy[1] === "M") {
      changes.push({ path: pathPart, action: "modified" });
    } else if (xy[0] !== " " && xy[0] !== "?") {
      changes.push({ path: pathPart, action: "staged" });
    }
  }

  const diffResult = await runProcess("git", ["diff", "--name-status"], {
    cwd: projectDir, timeoutMs: 15000,
  });
  for (const line of diffResult.stdout.split(/\r?\n/).filter(Boolean)) {
    const parts = line.split(/\t/);
    if (parts.length >= 2) {
      changes.push({ path: parts[parts.length - 1], action: "modified" });
    }
  }

  const diffCachedResult = await runProcess("git", ["diff", "--cached", "--name-status"], {
    cwd: projectDir, timeoutMs: 15000,
  });
  for (const line of diffCachedResult.stdout.split(/\r?\n/).filter(Boolean)) {
    const parts = line.split(/\t/);
    if (parts.length >= 2) {
      changes.push({ path: parts[parts.length - 1], action: "staged" });
    }
  }

  const untrackedResult = await runProcess("git", ["ls-files", "--others", "--exclude-standard"], {
    cwd: projectDir, timeoutMs: 15000,
  });
  for (const line of untrackedResult.stdout.split(/\r?\n/).filter(Boolean)) {
    changes.push({ path: line.trim(), action: "untracked" });
  }

  return changes;
}

function validateChangesAgainstAllowedPaths(changes, allowedPaths) {
  const violations = [];
  const seen = new Set();
  for (const change of changes) {
    const key = change.path;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!isAllowedPath(change.path, allowedPaths)) {
      violations.push({ path: change.path, action: change.action });
    }
  }
  return violations;
}

// ----- build-run: Windows process tree termination -----
async function killProcessTree(pid) {
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      process.kill(pid, "SIGKILL");
    }
    return;
  }
  try {
    await runProcess("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      timeoutMs: 10000,
    });
  } catch {
    // taskkill may fail if process already gone
  }
}

async function waitForProcessExit(pid, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (process.platform === "win32") {
        const result = await runProcess("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], {
          timeoutMs: 5000,
        });
        if (!result.stdout.includes(String(pid))) return true;
      } else {
        process.kill(pid, 0);
      }
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// ----- build-run: deep workspace snapshot -----
async function buildDeepSnapshot(projectDir) {
  const statusResult = await runProcess("git", ["status", "--porcelain=v1", "-z"], {
    cwd: projectDir, timeoutMs: 10000,
  });
  const parts = [statusResult.stdout];

  const entries = statusResult.stdout.split("\0").filter(Boolean);
  for (const entry of entries) {
    if (entry.length < 4) continue;
    const pathPart = entry.slice(3).trim();
    if (!pathPart) continue;
    try {
      const fullPath = path.resolve(projectDir, pathPart);
      const stat = await fs.stat(fullPath);
      parts.push(`${pathPart}:size=${stat.size}:mtime=${stat.mtimeMs}`);
      if (stat.size > 0) {
        const fd = await fs.open(fullPath, "r");
        const buf = Buffer.alloc(Math.min(stat.size, 120));
        await fd.read(buf, 0, buf.length, 0);
        await fd.close();
        parts.push(`hash:${buf.toString("hex")}`);
      }
    } catch {
      parts.push(`${pathPart}:deleted`);
    }
  }

  return parts.join("|");
}

// ----- build-run: workspace stillness check -----
async function checkWorkspaceStillness(projectDir) {
  let previousSnapshot = null;
  let consecutiveMatches = 0;
  const startTime = Date.now();

  while (Date.now() - startTime < STILLNESS_MAX_WAIT_MS) {
    const snapshot = await buildDeepSnapshot(projectDir);
    if (snapshot === previousSnapshot) {
      consecutiveMatches++;
      if (consecutiveMatches >= STILLNESS_REQUIRED_SNAPSHOTS) {
        return true;
      }
    } else {
      consecutiveMatches = 0;
    }
    previousSnapshot = snapshot;
    await new Promise((r) => setTimeout(r, STILLNESS_INTERVAL_MS));
  }
  return false;
}

// ----- build-run: resolve effective command through shell wrappers -----
function resolveEffectiveCommand(args) {
  if (!Array.isArray(args) || args.length === 0) return null;
  const cmd0 = args[0].toLowerCase().split(/[/\\]/).pop();

  if ((cmd0 === "cmd.exe" || cmd0 === "cmd") && args[1] === "/c") {
    const rest = args.slice(2);
    if (rest.length > 0) {
      const firstToken = String(rest[0]).trim().split(/\s+/)[0].toLowerCase();
      if (firstToken) return firstToken;
    }
    return "cmd";
  }

  if ((cmd0 === "powershell" || cmd0 === "pwsh") &&
      (args[1] === "-Command" || args[1] === "-c" || args[1] === "/c")) {
    const rest = args.slice(2);
    if (rest.length > 0) {
      const firstToken = String(rest[0]).trim().split(/\s+/)[0].toLowerCase();
      if (firstToken) return firstToken;
    }
    return cmd0;
  }

  if ((cmd0 === "sh" || cmd0 === "bash" || cmd0 === "zsh" || cmd0 === "dash") && args[1] === "-c") {
    const rest = args.slice(2);
    if (rest.length > 0) {
      const firstToken = String(rest[0]).trim().split(/\s+/)[0].toLowerCase();
      if (firstToken) return firstToken;
    }
    return cmd0;
  }

  if ((cmd0 === "npx" || cmd0 === "npx.cmd") && args.length >= 2) {
    return resolveEffectiveCommand(args.slice(1));
  }

  return cmd0;
}

// ----- build-run: contract validation -----
function validateContract(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw buildJsonErrorResponse({
      errorCode: "CONTRACT_SCHEMA_INVALID",
      exitCode: 2,
      message: "Contract must be a JSON object.",
    });
  }

  const required = ["sessionName", "agent", "allowedPaths", "verification", "hardTimeoutMs"];
  for (const field of required) {
    if (!(field in value)) {
      throw buildJsonErrorResponse({
        errorCode: "CONTRACT_SCHEMA_INVALID",
        exitCode: 2,
        message: `Contract missing required field: ${field}`,
        field,
      });
    }
  }

  if (typeof value.sessionName !== "string" || !value.sessionName.trim()) {
    throw buildJsonErrorResponse({
      errorCode: "CONTRACT_SCHEMA_INVALID",
      exitCode: 2,
      message: "Contract sessionName must be a non-empty string.",
    });
  }

  if (typeof value.agent !== "string" || !value.agent.trim()) {
    throw buildJsonErrorResponse({
      errorCode: "CONTRACT_SCHEMA_INVALID",
      exitCode: 2,
      message: "Contract agent must be a non-empty string.",
    });
  }

  if (!Array.isArray(value.allowedPaths) || value.allowedPaths.length === 0) {
    throw buildJsonErrorResponse({
      errorCode: "CONTRACT_SCHEMA_INVALID",
      exitCode: 2,
      message: "Contract allowedPaths must be a non-empty array.",
    });
  }

  for (const p of value.allowedPaths) {
    if (typeof p !== "string" || !p.trim()) {
      throw buildJsonErrorResponse({
        errorCode: "CONTRACT_SCHEMA_INVALID",
        exitCode: 2,
        message: "Contract allowedPaths entries must be non-empty strings.",
      });
    }
    if (p.includes("*") && !p.endsWith("/**")) {
      throw buildJsonErrorResponse({
        errorCode: "CONTRACT_SCHEMA_INVALID",
        exitCode: 2,
        message: `Contract allowedPaths only supports exact paths or directory/** glob: ${p}`,
        path: p,
      });
    }
  }

  if (!Array.isArray(value.verification)) {
    throw buildJsonErrorResponse({
      errorCode: "CONTRACT_SCHEMA_INVALID",
      exitCode: 2,
      message: "Contract verification must be an array.",
    });
  }

  const allowExternalSideEffects = value.allowExternalSideEffects === true;

  for (const step of value.verification) {
    if (typeof step.id !== "string" || !step.id.trim()) {
      throw buildJsonErrorResponse({
        errorCode: "CONTRACT_SCHEMA_INVALID",
        exitCode: 2,
        message: "Each verification step must have a non-empty string id.",
      });
    }
    if (!Array.isArray(step.command) || step.command.length === 0) {
      throw buildJsonErrorResponse({
        errorCode: "CONTRACT_SCHEMA_INVALID",
        exitCode: 2,
        message: `Each verification step must have a command array: ${step.id}`,
        stepId: step.id,
      });
    }
    if (!allowExternalSideEffects) {
      const baseCmd = resolveEffectiveCommand(step.command);
      if (baseCmd && HIGH_RISK_VERIFICATION_COMMANDS.includes(baseCmd)) {
        throw buildJsonErrorResponse({
          errorCode: "CONTRACT_SCHEMA_INVALID",
          exitCode: 2,
          message: `Verification command resolves to '${baseCmd}' which is not allowed. Set "allowExternalSideEffects": true in contract to enable it.`,
          stepId: step.id,
          command: baseCmd,
          fullCommand: step.command,
        });
      }
    }
  }

  if (typeof value.hardTimeoutMs !== "number" || value.hardTimeoutMs < 10000) {
    throw buildJsonErrorResponse({
      errorCode: "CONTRACT_SCHEMA_INVALID",
      exitCode: 2,
      message: "Contract hardTimeoutMs must be a number >= 10000.",
    });
  }

  return {
    sessionName: value.sessionName,
    agent: value.agent,
    requireCleanWorktree: value.requireCleanWorktree !== false,
    allowedPaths: value.allowedPaths,
    verification: value.verification,
    allowExternalSideEffects,
    hardTimeoutMs: value.hardTimeoutMs,
    idleTimeoutMs: value.idleTimeoutMs ?? 600000,
    terminationGraceMs: value.terminationGraceMs ?? 5000,
    maxCorrectionRounds: value.maxCorrectionRounds ?? 1,
  };
}

// ----- build-run: build report validation -----
function validateBuildReport(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: [{ code: "BUILD_REPORT_SCHEMA_INVALID", message: "Build report must be a JSON object." }] };
  }

  const errors = [];

  if (!value.status || !VALID_BUILD_STATUSES.has(value.status)) {
    errors.push({
      code: "BUILD_REPORT_SCHEMA_INVALID",
      message: `Build report status must be one of: ${[...VALID_BUILD_STATUSES].join(", ")}`,
    });
  }

  if (!Array.isArray(value.changedFiles)) {
    errors.push({
      code: "BUILD_REPORT_SCHEMA_INVALID",
      message: "Build report changedFiles must be an array.",
    });
  } else {
    for (const f of value.changedFiles) {
      if (typeof f.path !== "string" || !f.path.trim()) {
        errors.push({
          code: "BUILD_REPORT_SCHEMA_INVALID",
          message: "Each changedFile must have a non-empty path string.",
        });
      }
    }
  }

  if (!Array.isArray(value.tests)) {
    errors.push({
      code: "BUILD_REPORT_SCHEMA_INVALID",
      message: "Build report tests must be an array.",
    });
  }

  if (!Array.isArray(value.incomplete)) {
    errors.push({
      code: "BUILD_REPORT_SCHEMA_INVALID",
      message: "Build report incomplete must be an array.",
    });
  }

  if (value.status === "completed" && value.incomplete.length > 0) {
    errors.push({
      code: "BUILD_REPORT_SCHEMA_INVALID",
      message: "Build report status is completed but incomplete is not empty.",
    });
  }

  if (typeof value.summary !== "string") {
    errors.push({
      code: "BUILD_REPORT_SCHEMA_INVALID",
      message: "Build report summary must be a string.",
    });
  }

  return { ok: errors.length === 0, errors, report: value };
}

function crossValidateBuildReport(report, contract, gitChanges) {
  const errors = [];

  if (!report || typeof report !== "object") {
    return [{ code: "BUILD_REPORT_JSON_INVALID", message: "No valid build report from agent." }];
  }

  const reportFiles = new Map();
  for (const f of (report.changedFiles ?? [])) {
    reportFiles.set(f.path, f);
  }

  const gitFileSet = new Set();
  for (const change of gitChanges) {
    const normalizedPath = change.path.replace(/\\/g, "/");
    gitFileSet.add(normalizedPath);
    if (!reportFiles.has(normalizedPath)) {
      errors.push({
        code: "UNREPORTED_CHANGE",
        path: normalizedPath,
        action: change.action,
        message: `Git shows change in '${normalizedPath}' but agent did not report it.`,
      });
    }
  }

  for (const [path] of reportFiles) {
    if (!gitFileSet.has(path)) {
      errors.push({
        code: "REPORTED_CHANGE_NOT_FOUND",
        path,
        message: `Agent reported change in '${path}' but Git shows no change.`,
      });
    }
  }

  const violations = validateChangesAgainstAllowedPaths(gitChanges, contract.allowedPaths);
  for (const v of violations) {
    errors.push({
      code: "CHANGE_OUTSIDE_ALLOWLIST",
      path: v.path,
      action: v.action,
      message: `Change to '${v.path}' is outside allowedPaths.`,
    });
  }

  const contractVerificationIds = new Set(contract.verification.map((s) => s.id));
  const reportedTestIds = new Set((report.tests ?? []).map((t) => t.id));

  for (const requiredId of contractVerificationIds) {
    if (!reportedTestIds.has(requiredId)) {
      errors.push({
        code: "REQUIRED_TEST_NOT_REPORTED",
        testId: requiredId,
        message: `Required verification '${requiredId}' was not reported by agent.`,
      });
    }
  }

  for (const test of (report.tests ?? [])) {
    if (test.id && contractVerificationIds.has(test.id)) {
      if (typeof test.exitCode !== "number" || test.exitCode !== 0) {
        errors.push({
          code: "AGENT_TEST_FAILED",
          testId: test.id,
          exitCode: test.exitCode,
          message: `Agent reported test '${test.id}' failed with exit code ${test.exitCode}.`,
        });
      }
    }
  }

  if (report.status === "completed") {
    if (report.incomplete && report.incomplete.length > 0) {
      errors.push({
        code: "BUILD_REPORT_SCHEMA_INVALID",
        message: "Status is 'completed' but incomplete list is not empty.",
      });
    }
  }

  return errors;
}

// ----- build-run: system prompt builder -----
function buildSystemPrompt(contract, userPrompt) {
  const allowedList = contract.allowedPaths.map((p) => `  - ${p}`).join("\n");
  const verificationList = contract.verification.map((v) =>
    `  - "${v.id}": \`${v.command.join(" ")}\``
  ).join("\n");
  const forbiddenList = FORBIDDEN_AGENT_ACTIONS.map((f) =>
    `  - Do not run ${f.description} commands (${f.pattern}).`
  ).join("\n");

  return `You are the OpenCode build agent for session "${contract.sessionName}".

## Scope
You may only modify files within these allowed paths:
${allowedList}

Any change outside these paths will be rejected.

## Required Output
After completing the task, return exactly one JSON object as your final message (no Markdown fences, no other text after it):
{
  "status": "completed" | "blocked" | "failed",
  "summary": "Short summary of what was done.",
  "changedFiles": [
    { "path": "relative/path", "action": "added|modified|deleted", "reason": "Why this change was needed." }
  ],
  "tests": [
    { "id": "<verification-id>", "command": ["<cmd>", ...], "exitCode": 0, "result": "X passed / Y failed" }
  ],
  "incomplete": [],
  "risks": ["Any risks or concerns"],
  "notes": ["Any additional notes"]
}

## Verification
The following verification steps must pass (exitCode 0) for the build to be accepted:
${verificationList}

If any test fails, set status to "failed" and explain what failed.

## Forbidden Actions
${forbiddenList}
  - Do not publish, deploy, transact, or bypass permissions.
  - Do not read secrets, auth tokens, or unrelated files.
  - Do not claim tests passed unless they actually ran.
  - Do not use --dangerously-skip-permissions.
  - Do not modify files outside allowedPaths.
  - Do not commit or push changes.

## Task
${userPrompt}`;
}

// ----- build-run: wrapper verification runner -----
async function runWrapperVerification(verificationSteps, cwd) {
  const results = [];
  for (const step of verificationSteps) {
    const result = await runProcess(step.command[0], step.command.slice(1), {
      cwd,
      timeoutMs: step.timeoutMs ?? 600000,
    });
    results.push({
      id: step.id,
      command: step.command,
      exitCode: result.code ?? 1,
      timedOut: result.timedOut || false,
      interrupted: result.interrupted || false,
      stdoutSummary: (result.stdout ?? "").split("\n").slice(0, 10).join("\n"),
      stderrSummary: (result.stderr ?? "").split("\n").slice(0, 10).join("\n"),
    });
  }
  return results;
}

// ----- build-run: extract build report from events -----
function extractBuildReportFromEvents(events) {
  // Collect only the final contiguous block of text events (final assistant message)
  const textParts = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === "text" && typeof event.part?.text === "string") {
      textParts.unshift(event.part.text);
    } else if (textParts.length > 0) {
      break;
    }
  }
  if (textParts.length === 0) return null;
  const concatenated = textParts.join("").trim();
  if (!concatenated) return null;
  const jsonText = concatenated.startsWith("{") ? extractLeadingJson(concatenated) : concatenated;
  try {
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

// ----- build-run: supervised process runner -----
async function supervisedBuildRun({ args, cwd, contract, runState, projectDir }) {
  const invocation = await resolveOpencodeInvocation();
  const allArgs = [...invocation.prefixArgs, ...args];

  let childPid = null;
  let lastActivity = Date.now();
  let finished = false;
  let timedOut = false;
  let idleTimedOut = false;
  let interrupted = false;

  const result = await new Promise((resolve) => {
    const child = spawn(invocation.command, allArgs, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    childPid = child.pid;
    let stdout = "";
    let stderr = "";

    const cleanup = () => {
      clearTimeout(hardTimer);
      clearInterval(idleTimer);
      process.removeListener("SIGINT", onSigint);
    };

    const settle = (value) => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(value);
    };

    const onSigint = () => {
      interrupted = true;
      timedOut = true;
      child.kill("SIGINT");
    };

    const hardTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, contract.hardTimeoutMs);

    const idleTimer = setInterval(() => {
      if (finished) return;
      if (Date.now() - lastActivity > contract.idleTimeoutMs) {
        idleTimedOut = true;
        timedOut = true;
        child.kill("SIGTERM");
      }
    }, 30000);

    process.on("SIGINT", onSigint);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      lastActivity = Date.now();
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderr += text;
      process.stderr.write(text);
      lastActivity = Date.now();
    });

    child.on("error", (error) => {
      settle({ ok: false, code: 1, signal: null, stdout, stderr, error, timedOut, idleTimedOut, interrupted });
    });

    child.on("close", (code, signal) => {
      if (finished) return;
      stdout;
      stderr;
      settle({
        ok: !timedOut && code === 0 && !signal,
        code: typeof code === "number" ? code : timedOut ? 124 : 1,
        signal,
        stdout,
        stderr,
        timedOut,
        idleTimedOut,
        interrupted: signal === "SIGINT" || interrupted,
      });
    });

    child.stdin.end();
  });

  // ---- timeout handling and termination ----
  if (timedOut || interrupted) {
    runState.phase = "terminating";
    runState.timedOut = true;
    await saveRun(runState);

    await new Promise((r) => setTimeout(r, contract.terminationGraceMs));

    if (childPid) {
      await killProcessTree(childPid);
      const exited = await waitForProcessExit(childPid, 10000);
      if (!exited) {
        runState.phase = "quarantined";
        runState.quarantined = true;
        runState.opencodeResumeAllowed = false;
        await saveRun(runState);
        throw buildJsonErrorResponse({
          errorCode: "PROCESS_TREE_NOT_TERMINATED",
          exitCode: 124,
          runId: runState.runId,
          pid: childPid,
          message: "Process tree could not be fully terminated after timeout.",
        });
      }
    }

    const still = await checkWorkspaceStillness(projectDir);
    if (!still) {
      runState.phase = "quarantined";
      runState.quarantined = true;
      runState.opencodeResumeAllowed = false;
      await saveRun(runState);
      throw buildJsonErrorResponse({
        errorCode: "WORKSPACE_NOT_STABLE",
        exitCode: 124,
        runId: runState.runId,
        message: "Workspace did not stop changing after process termination.",
      });
    }

    result.stdout;
    result.stderr;
    return { ...result, timedOut: true };
  }

  return result;
}

// ----- build-run: build report extraction and cross-validation -----
async function processBuildRunCompletion(events, runState, contract, projectDir, sessionId) {
  if (sessionId) {
    runState.sessionId = sessionId;
  }

  const changes = await collectGitChanges(projectDir);

  const violations = validateChangesAgainstAllowedPaths(changes, contract.allowedPaths);
  if (violations.length > 0) {
    runState.phase = "rejected";
    runState.lastError = { errorCode: "CHANGE_OUTSIDE_ALLOWLIST", violations };
    await saveRun(runState);
    throw buildJsonErrorResponse({
      errorCode: "CHANGE_OUTSIDE_ALLOWLIST",
      exitCode: 8,
      runId: runState.runId,
      violations,
      message: `Changes outside allowedPaths: ${violations.map((v) => v.path).join(", ")}`,
    });
  }

  const report = extractBuildReportFromEvents(events);
  if (!report) {
    runState.phase = "rejected";
    runState.lastError = { errorCode: "BUILD_REPORT_JSON_INVALID", message: "No valid JSON build report in final assistant message." };
    await saveRun(runState);
    throw buildJsonErrorResponse({
      errorCode: "BUILD_REPORT_JSON_INVALID",
      exitCode: 8,
      runId: runState.runId,
      message: "No valid JSON build report in final assistant message.",
    });
  }

  const schemaResult = validateBuildReport(report);
  if (!schemaResult.ok) {
    runState.phase = "rejected";
    runState.lastError = { errorCode: "BUILD_REPORT_SCHEMA_INVALID", errors: schemaResult.errors };
    await saveRun(runState);
    throw buildJsonErrorResponse({
      errorCode: "BUILD_REPORT_SCHEMA_INVALID",
      exitCode: 8,
      runId: runState.runId,
      errors: schemaResult.errors,
      message: "Build report schema validation failed.",
    });
  }

  const crossErrors = crossValidateBuildReport(report, contract, changes);
  if (crossErrors.length > 0) {
    runState.phase = "rejected";
    runState.lastError = { errorCode: crossErrors[0].code, errors: crossErrors };
    await saveRun(runState);
    throw buildJsonErrorResponse({
      errorCode: crossErrors[0].code,
      exitCode: 8,
      runId: runState.runId,
      errors: crossErrors,
      message: `Cross-validation failed: ${crossErrors[0].message}`,
    });
  }

  const agentReportedTests = report.tests ?? [];
  const wrapperVerification = await runWrapperVerification(contract.verification, projectDir);

  const wrapperFailures = wrapperVerification.filter((v) => v.exitCode !== 0 || v.timedOut);
  if (wrapperFailures.length > 0) {
    runState.lastError = {
      errorCode: "AGENT_TEST_FAILED",
      wrapperFailures,
      message: `Wrapper verification failed for: ${wrapperFailures.map((f) => f.id).join(", ")}`,
    };

    if (runState.quarantined) {
      runState.phase = "quarantined";
      runState.opencodeResumeAllowed = false;
      await saveRun(runState);
      throw buildJsonErrorResponse({
        errorCode: "SESSION_QUARANTINED",
        exitCode: 8,
        runId: runState.runId,
        message: "Quarantined run cannot enter correction. Start a new build-run.",
      });
    }

    if (runState.correctionRounds < contract.maxCorrectionRounds) {
      runState.correctionRounds++;
      runState.phase = "running";
      await saveRun(runState);
      return {
        needsCorrection: true,
        correctionReason: `Wrapper verification failed: ${wrapperFailures.map((f) => `${f.id} exit=${f.exitCode}`).join(", ")}`,
        agentReportedTests,
        wrapperVerification,
        report,
      };
    }

    runState.phase = "rejected";
    runState.lastError = {
      errorCode: "MAX_CORRECTION_ROUNDS_EXCEEDED",
      message: `Max correction rounds (${contract.maxCorrectionRounds}) exceeded.`,
    };
    await saveRun(runState);
    throw buildJsonErrorResponse({
      errorCode: "MAX_CORRECTION_ROUNDS_EXCEEDED",
      exitCode: 8,
      runId: runState.runId,
      wrapperFailures,
      message: `Wrapper verification failed after ${contract.maxCorrectionRounds} correction round(s).`,
    });
  }

  runState.phase = "awaiting_review";
  runState.editor = "none";
  runState.codexWriteAllowed = false;
  runState.lastReport = report;
  runState.lastError = null;
  await saveRun(runState);

  printJson({
    ok: true,
    command: "build-run",
    runId: runState.runId,
    sessionName: runState.sessionName,
    sessionId: runState.sessionId,
    phase: "awaiting_review",
    agentReportedTests,
    wrapperVerification,
    report,
    changedFiles: changes,
  });
}

// ----- build-run: main command handler -----
async function cmdBuildRun(projectDir, tailArgs) {
  let contractPath = null;
  let promptParts = [];
  let inPrompt = false;

  for (let i = 0; i < tailArgs.length; i++) {
    const value = tailArgs[i];
    if (inPrompt) {
      promptParts.push(value);
      continue;
    }
    if (value === "--") {
      inPrompt = true;
      continue;
    }
    if (value === "--contract") {
      contractPath = tailArgs[++i];
      if (!contractPath) throw new UsageError("--contract requires a path");
      continue;
    }
    if (value.startsWith("--")) {
      throw new UsageError(`Unknown option: ${value}`);
    }
    promptParts.push(value);
  }

  if (!contractPath) throw new UsageError("build-run requires --contract <contract.json>");
  const cwd = await ensureDirectory(projectDir);
  const contractRaw = await fs.readFile(path.resolve(contractPath), "utf8");
  const contract = validateContract(JSON.parse(contractRaw));

  // Block if an existing quarantined run with same sessionName exists
  const runsDir = getRunStateDir();
  let existingRunDirEntries;
  try {
    existingRunDirEntries = await fs.readdir(runsDir);
  } catch {
    existingRunDirEntries = [];
  }
  for (const entry of existingRunDirEntries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const existingRaw = await fs.readFile(path.join(runsDir, entry), "utf8");
      const existing = JSON.parse(existingRaw);
      if (existing.sessionName === contract.sessionName && existing.quarantined) {
        throw buildJsonErrorResponse({
          errorCode: "SESSION_QUARANTINED",
          exitCode: 4,
          existingRunId: existing.runId,
          sessionName: contract.sessionName,
          message: `Session '${contract.sessionName}' has a quarantined run (${existing.runId}). Create a new sessionName or resolve the quarantine first.`,
        });
      }
    } catch (scanErr) {
      if (scanErr instanceof CommandError) throw scanErr;
      if (scanErr?.code !== "ENOENT" && !(scanErr instanceof SyntaxError)) throw scanErr;
      // skip unreadable / corrupt run state files
    }
  }

  if (contract.requireCleanWorktree) {
    const statusResult = await runProcess("git", ["status", "--porcelain=v1", "-z"], {
      cwd, timeoutMs: 15000,
    });
    if (statusResult.stdout.trim().length > 0) {
      throw buildJsonErrorResponse({
        errorCode: "WORKTREE_NOT_CLEAN",
        exitCode: 2,
        projectDir: cwd,
        message: "Working tree is not clean. Commit or stash changes before build-run.",
      });
    }
  }

  await ensureOpencodeExists();
  await ensureSelectablePrimaryAgent(contract.agent);

  const runId = generateRunId();
  const sessionName = contract.sessionName;
  const runState = createInitialRunState({ runId, projectDir: cwd, sessionName, allowedPaths: contract.allowedPaths, contract });
  runState.startedAt = new Date().toISOString();
  runState.phase = "created";
  await saveRun(runState);

  const rawPrompt = await readPrompt(promptParts);
  const systemPrompt = buildSystemPrompt(contract, rawPrompt);
  const title = buildUniqueTitle(`br-${sessionName}`);

  const before = await sessionList();
  const opencodeArgs = buildRunArgs({
    agent: contract.agent,
    cwd,
    prompt: systemPrompt,
    title,
    files: [],
  });

  runState.phase = "running";
  await saveRun(runState);

  const result = await supervisedBuildRun({
    args: opencodeArgs,
    cwd,
    contract,
    runState,
    projectDir: cwd,
  });

  if (result.timedOut || result.interrupted) {
    runState.phase = runState.quarantined ? "quarantined" : "terminating";
    runState.finishedAt = new Date().toISOString();
    await saveRun(runState);
    const extraCode = runState.quarantined ? "WORKSPACE_NOT_STABLE" : result.idleTimedOut ? "IDLE_TIMEOUT" : "HARD_TIMEOUT";
    printJson({
      ok: false,
      command: "build-run",
      runId,
      sessionName,
      phase: runState.phase,
      timedOut: true,
      errorCode: extraCode,
      message: `Build run ${extraCode.toLowerCase().replace(/_/g, " ")}.`,
    });
    return;
  }

  const events = parseNdjson(result.stdout);
  const sessionId = extractSessionIdFromEvents(events);

  if (!sessionId) {
    const after = await sessionList();
    const discovered = findSessionByTitle({ before, after, title, directory: cwd });
    if (discovered?.id) {
      runState.sessionId = discovered.id;
    }
  } else {
    runState.sessionId = sessionId;
  }

  await processBuildRunCompletion(events, runState, contract, cwd, sessionId);
}

// ----- build-run: status command -----
async function cmdBuildStatus(runId) {
  const runState = await loadRun(runId);
  printJson({
    ok: true,
    command: "build-status",
    runId,
    phase: runState.phase,
    sessionName: runState.sessionName,
    sessionId: runState.sessionId,
    editor: runState.editor,
    timedOut: runState.timedOut,
    quarantined: runState.quarantined,
    correctionRounds: runState.correctionRounds,
    codexWriteAllowed: runState.codexWriteAllowed,
    opencodeResumeAllowed: runState.opencodeResumeAllowed,
    startedAt: runState.startedAt,
    finishedAt: runState.finishedAt,
    lastError: runState.lastError,
  });
}

// ----- build-run: cancel command -----
async function cmdBuildCancel(runId) {
  const runState = await loadRun(runId);
  if (runState.quarantined) {
    throw buildJsonErrorResponse({
      errorCode: "SESSION_QUARANTINED",
      exitCode: 4,
      runId,
      phase: runState.phase,
      message: `Cannot cancel a quarantined build (${runId}). Use takeover to abort.`,
    });
  }
  if (!["created", "running", "terminating"].includes(runState.phase)) {
    throw buildJsonErrorResponse({
      errorCode: "SESSION_QUARANTINED",
      exitCode: 4,
      runId,
      phase: runState.phase,
      message: `Cannot cancel build in phase: ${runState.phase}`,
    });
  }
  runState.phase = "aborted";
  runState.editor = "none";
  runState.finishedAt = new Date().toISOString();
  runState.opencodeResumeAllowed = false;
  await saveRun(runState);
  printJson({
    ok: true,
    command: "build-cancel",
    runId,
    phase: "aborted",
  });
}

// ----- build-run: review command -----
async function cmdBuildReview(runId, rest) {
  const runState = await loadRun(runId);
  if (runState.phase !== "awaiting_review") {
    throw buildJsonErrorResponse({
      errorCode: "SESSION_QUARANTINED",
      exitCode: 4,
      runId,
      phase: runState.phase,
      message: `Cannot review build in phase: ${runState.phase}. Must be awaiting_review.`,
    });
  }

  let accept = false;
  let reason = null;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--accept") {
      accept = true;
    } else if (rest[i] === "--reject") {
      accept = false;
      reason = rest[++i] ?? "No reason provided";
    }
  }

  if (accept) {
    runState.phase = "accepted";
    runState.codexWriteAllowed = false;
  } else {
    runState.phase = "rejected";
    runState.lastError = { errorCode: "REVIEW_REJECTED", reason };
    runState.editor = "opencode";
    runState.codexWriteAllowed = false;
  }

  runState.finishedAt = new Date().toISOString();
  await saveRun(runState);

  printJson({
    ok: true,
    command: "build-review",
    runId,
    phase: runState.phase,
    accepted: accept,
    reason,
  });
}

// ----- build-run: takeover command -----
async function cmdTakeover(runId) {
  const runState = await loadRun(runId);
  if (runState.phase === "accepted") {
    throw buildJsonErrorResponse({
      errorCode: "SESSION_QUARANTINED",
      exitCode: 4,
      runId,
      phase: runState.phase,
      message: "Cannot takeover an accepted build. Use a new build-run for additional changes.",
    });
  }

  runState.phase = "aborted";
  runState.editor = "codex";
  runState.codexWriteAllowed = true;
  runState.opencodeResumeAllowed = false;
  runState.finishedAt = new Date().toISOString();
  await saveRun(runState);

  printJson({
    ok: true,
    command: "takeover",
    runId,
    phase: "aborted",
    editor: "codex",
    codexWriteAllowed: true,
    opencodeResumeAllowed: false,
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
    case "build-run":
      if (rest.length < 2) {
        throw new UsageError("build-run requires <project-dir> --contract <contract.json> [-- <prompt>]");
      }
      await cmdBuildRun(rest[0], rest.slice(1));
      return;
    case "build-status":
      if (rest.length !== 1) {
        throw new UsageError("build-status requires <run-id>");
      }
      await cmdBuildStatus(rest[0]);
      return;
    case "build-cancel":
      if (rest.length !== 1) {
        throw new UsageError("build-cancel requires <run-id>");
      }
      await cmdBuildCancel(rest[0]);
      return;
    case "build-review":
      if (rest.length < 1) {
        throw new UsageError("build-review requires <run-id> --accept|--reject [<reason>]");
      }
      await cmdBuildReview(rest[0], rest.slice(1));
      return;
    case "takeover":
      if (rest.length !== 1) {
        throw new UsageError("takeover requires <run-id>");
      }
      await cmdTakeover(rest[0]);
      return;
    default:
      throw new UsageError(`Unknown command: ${command}`);
  }
}

export {
  isAllowedPath,
  validateContract,
  validateBuildReport,
  crossValidateBuildReport,
  collectGitChanges,
  validateChangesAgainstAllowedPaths,
  generateRunId,
  createInitialRunState,
  extractBuildReportFromEvents,
  killProcessTree,
  checkWorkspaceStillness,
  buildDeepSnapshot,
  runWrapperVerification,
  buildRunArgs,
  buildSystemPrompt,
  resolveEffectiveCommand,
  parseNdjson,
  extractFinalAssistantMessage,
  extractSessionIdFromEvents,
  buildUniqueTitle,
  findSessionByTitle,
  runProcess,
  BUILD_RUN_ERROR_CODES,
  VALID_PHASES,
  VALID_BUILD_STATUSES,
  HIGH_RISK_VERIFICATION_COMMANDS,
  FORBIDDEN_AGENT_ACTIONS,
};

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
