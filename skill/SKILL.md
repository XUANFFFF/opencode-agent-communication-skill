---
name: opencode-agent-communication
description: Use when Codex needs to delegate analysis or coding work to the local OpenCode CLI, including one-off tasks, durable multi-turn sessions, session history review, or safe OpenCode agent/task handoff on Windows-heavy environments.
---

# OpenCode Agent Communication

Use this skill when Codex needs to hand off work to a local OpenCode agent, either as a disposable one-shot request or as a named multi-turn session that can be resumed later.

## Core Relationship

OpenCode is the executor. Codex remains the planner, reviewer, and integrator.

```text
Codex -> opencode-agent wrapper -> OpenCode CLI -> OpenCode agent/session -> result returns to Codex
```

Prefer the bundled wrapper:

```text
$CODEX_HOME/skills/opencode-agent-communication/scripts/opencode-agent.mjs
```

If `CODEX_HOME` is unset, use:

```text
~/.codex/skills/opencode-agent-communication/scripts/opencode-agent.mjs
```

Session state lives outside the skill folder:

```text
$CODEX_HOME/state/opencode-agent-communication/sessions.json
```

## Wrapper Requirement

- All OpenCode delegation should go through the wrapper by default.
- If the wrapper fails, stop and report the error instead of continuing the task.
- Do not bypass the wrapper and call OpenCode CLI directly unless the user explicitly approves it.
- Do not let Codex complete the delegated OpenCode work itself just to hide wrapper failure.

## Commands

```text
doctor
preflight <project-dir> <path...>
list-agents
evidence <project-dir> [--file <path> ...] [--required-fact <id> ...] [-- <prompt...>]
oneshot <agent> <project-dir> [--file <path> ...] [-- <prompt...>]
start <agent> <session-name> <project-dir> [--file <path> ...] [-- <prompt...>]
prompt <session-name> <prompt...>
history <session-name>
show <session-name>
delete <session-name>
```

Prompts can be passed as trailing arguments or piped through stdin for long Windows-safe input.

## Before Delegating

Always check the target agent first:

```powershell
node opencode-agent.mjs list-agents
```

Do not invent agent names. If the required agent is missing, stop and tell the user which OpenCode agent needs to exist before delegation continues.

Agent mode matters:
- `oneshot` and `start` only allow selectable primary agents.
- `explore` is a subagent on this machine, not a directly runnable primary agent.
- If OpenCode reports subagent fallback or agent fallback, the wrapper must treat that run as failed.
- Built-in agents such as `compaction`, `summary`, and `title` should not be treated as user-selectable task agents.

## One-Shot vs Multi-Turn

Use `oneshot` when:
- The task boundary is clear.
- No follow-up correction is expected.
- You only need a draft, review, explanation, or analysis.

Use `start` plus `prompt` when:
- The task needs iteration or correction.
- You want OpenCode to retain context across rounds.
- You plan to audit history or resume the session later.

## Prompt Structure

Every delegated prompt should include:
- Background
- Goal
- Inputs
- Output format
- Forbidden actions
- Acceptance criteria

Template:

```text
You are the OpenCode agent for <task>.
Background:
<why this is needed>
Goal:
<what must be produced>
Inputs:
<files, directories, constraints, facts>
Output format:
1. ...
2. ...
Forbidden actions:
- Do not publish, deploy, transact, or bypass permissions.
- Do not read secrets, auth tokens, or unrelated files.
- Do not claim tests passed unless they actually ran.
Acceptance criteria:
- ...
```

## Review Duties

After OpenCode returns:
- Inspect the final assistant message.
- Check session history if the result looks incomplete or inconsistent.
- Review file changes, `git diff`, and test results before accepting implementation output.
- Continue in the same named session if correction is needed.

Codex is the final reviewer. Do not treat OpenCode output as final truth without inspection.

## Repository Analysis Evidence Rules

For repository analysis tasks, split responsibilities clearly between OpenCode and Codex.

OpenCode is responsible for:
- Extracting evidence only from explicitly provided repository attachments.
- Providing file paths.
- Providing stable anchors such as JSON keys, YAML step names, function names, class names, and script names.
- Returning only the JSON evidence protocol, not Markdown presentation.
- Using `quote` facts for exact copied source text and `absence` facts for bounded missing-result checks.
- Marking unresolved items in `unconfirmed`.
- Not providing implementation plans during repository evidence collection.

Codex is responsible for:
- Verifying the `project-dir` and attachment paths before delegation.
- Re-reading the cited files independently.
- Verifying that the file paths, anchors, and quoted text actually exist.
- Verifying that the conclusion is supported by the cited evidence.
- Re-checking current line numbers when useful, without filling in OpenCode's missing core analysis or missing implementation plan.

Do not let Codex silently replace missing OpenCode analysis. Verification is allowed; doing the agent's unfinished work is not.

## Line Number Policy

- OpenCode is not required to provide line numbers for repository analysis.
- OpenCode may provide line numbers, but line numbers are only auxiliary metadata.
- Any line numbers must be re-verified by Codex before acceptance.
- If a line number is wrong but the file path, stable anchor, quoted text, and conclusion are all correct, do not fail the entire analysis for the line number alone.
- If the file, config key, quoted text, or conclusion is wrong, the analysis still fails.

## Validation vs Replacement

Allowed verification by Codex:
- Check whether a cited `package.json` script really exists.
- Check the real content of a cited YAML step.
- Reconfirm current line numbers for cited evidence.
- Check that attached files really exist under the target `project-dir`.
- Reject evidence when the wrapper-verified quote or absence payload still does not support the conclusion.

Not allowed as a substitute for OpenCode output:
- If OpenCode misses a critical test command, Codex must not add it and then claim the OpenCode analysis passed.
- If OpenCode does not provide a modification plan, Codex must not write that plan and pretend the agent completed it.
- Do not use Codex's own repository analysis to hide incomplete or weak agent output.

## Recommended Repository Workflow

For repository work that needs both evidence collection and planning:
- Run `preflight` first to confirm the target files and directories.
- Use `evidence` with explicit `--file` attachments and `--required-fact` ids for known key files.
- Let the wrapper deterministically validate exact quotes, missing-result checks, and attachment scope.
- Have Codex independently verify whether the validated evidence really supports the conclusion.
- Use `oneshot plan` next, but only with already-confirmed facts.
- Have Codex accept or reject the plan on its own merits.
- Use `start build` only after the facts and plan are both acceptable.

This keeps evidence gathering, verification, planning, and implementation separate.

Repository evidence collection must not default to `oneshot explore`.
- `explore` is a subagent and must not be used with `--agent explore`.
- A primary agent may still delegate to `@explore` internally when appropriate.
- For deterministic repository evidence collection, prefer explicit `--file` attachments over asking the model to discover files on its own.
- Do not use Markdown headings, bold labels, or formatting style as evidence acceptance criteria.
- Exact quote authenticity is enforced by the wrapper.
- Missing-result facts are validated by the wrapper with deterministic string search.
- "Minimal change scope" and implementation ideas belong to `plan`, not evidence collection.
- Codex must not add missing facts on OpenCode's behalf, but may reject conclusions that the evidence cannot support.

## Retry Limit

- If the first one-shot output is not acceptable, send one explicit correction to the same agent.
- If the second output is still not acceptable, stop repeating near-duplicate one-shot requests.
- Switch based on the failure mode: use `explore`, use `general`, or stop and report the blocker.
- Do not keep creating multiple similar one-shot sessions for the same unresolved gap.

## Safety Boundaries

Do not ask OpenCode to:
- Auto-publish or deploy without explicit approval.
- Perform external transactions or payments.
- Read keys, cookies, passwords, tokens, or auth files.
- Bypass sandboxing, permissions, or review steps.
- Use `--dangerously-skip-permissions`.

## Typical Flow

```powershell
node opencode-agent.mjs doctor
node opencode-agent.mjs list-agents
node opencode-agent.mjs oneshot plan C:\path\to\project "只读分析任务..."
node opencode-agent.mjs start build feature-pass C:\path\to\project "第一轮实现任务..."
node opencode-agent.mjs prompt feature-pass "第二轮修正..."
node opencode-agent.mjs history feature-pass
node opencode-agent.mjs show feature-pass
```

See `references/opencode-patterns.md` for concrete patterns, PowerShell examples, and troubleshooting.
