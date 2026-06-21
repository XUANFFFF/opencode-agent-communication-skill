# feat: 增加受监督的 build-run 工作流，强化超时终止、改动白名单与结构化验收

## 背景

当前 skill 已具备：

- 通过 wrapper 调用 OpenCode；
- primary/subagent 校验与 fallback 阻断；
- Windows `opencode.exe` / npm shim 兼容；
- `preflight`、附件白名单与路径穿越防护；
- `evidence` JSON 协议及 quote / absence 确定性校验；
- 命名 session 和多轮续跑。

但在真实 OCR URL 输入任务中，正式编码流程仍暴露出以下问题：

1. OpenCode 超时后仍可能在后台继续写文件；
2. Codex 与 OpenCode 可能交替编辑同一批文件；
3. 修改范围主要靠 prompt 约束，缺少机器白名单；
4. OpenCode 没有稳定返回机器可验证的 build 总结；
5. Codex 可能绕过统一编排，自行组合 `start` / `prompt`；
6. 超时、纠偏、接管和验收缺少统一状态机。

本 issue 的目标是把这些规则从文档约束升级为 wrapper 的确定性机制：

- 全程只通过 wrapper 调用 OpenCode；
- 无超时，或超时后完整终止进程树并确认工作区停止变化；
- OpenCode 独立完成编码和测试；
- Codex 只做只读审查，不直接接管编辑；
- 修改范围严格符合白名单；
- build 返回结构化总结，并由 wrapper 与 Git/测试结果交叉验证。

---

## 目标命令

新增正式编码入口：

```powershell
node opencode-agent.mjs build-run <project-dir> `
  --contract <contract.json> `
  -- "<task>"
```

同时新增：

```text
build-status <run-id>
build-cancel <run-id>
build-review <run-id> --accept
build-review <run-id> --reject --reason <text>
takeover <run-id>
```

原有 `oneshot`、`start`、`prompt` 可保留为低级调试接口，但正式编码任务统一使用 `build-run`。

---

## Contract Schema

```json
{
  "sessionName": "ocr-url-input",
  "agent": "build",
  "requireCleanWorktree": true,
  "allowedPaths": [
    "ocr_service/**",
    "README.md",
    ".env.example"
  ],
  "verification": [
    {
      "id": "ocr-tests",
      "command": [
        "python",
        "-m",
        "pytest",
        "ocr_service/tests",
        "-q"
      ],
      "timeoutMs": 600000
    }
  ],
  "hardTimeoutMs": 2700000,
  "idleTimeoutMs": 600000,
  "terminationGraceMs": 5000,
  "maxCorrectionRounds": 1
}
```

要求：

- `command` 必须是参数数组；
- 所有进程继续使用 `spawn(..., { shell: false })`；
- `allowedPaths` 第一版只支持精确文件和 `directory/**`；
- 项目目录、合同路径和 Git 路径统一规范化；
- `requireCleanWorktree: true` 时，工作区不干净必须在调用 OpenCode 前失败。

---

## Run 状态机

每次运行生成唯一 `runId`，状态保存到：

```text
$CODEX_HOME/state/opencode-agent-communication/runs/<runId>.json
```

状态仅允许：

```text
created
running
terminating
quarantined
awaiting_review
accepted
rejected
aborted
```

至少保存：

```text
runId
sessionName
sessionId
phase
editor
projectDir
allowedPaths
startedAt
finishedAt
timedOut
quarantined
correctionRounds
codexWriteAllowed
opencodeResumeAllowed
```

运行期间：

```json
{
  "editor": "opencode",
  "codexWriteAllowed": false
}
```

---

## 进程与超时监督

同时实现：

- idle timeout；
- hard timeout；
- Ctrl+C 中止；
- Windows 完整进程树终止。

Windows 超时流程：

1. `phase = terminating`；
2. 尝试正常终止；
3. 等待 `terminationGraceMs`；
4. 执行：

```powershell
taskkill.exe /PID <pid> /T /F
```

5. 检查 PID 是否仍存在；
6. 每 2 秒检查一次工作区；
7. 连续 3 次状态摘要相同才算静止；
8. 最多等待 30 秒。

工作区摘要至少包含：

- `git status --porcelain=v1 -z`；
- 变更文件的 size/mtime 或等效摘要。

若进程树未完整终止或工作区仍变化：

```json
{
  "phase": "quarantined",
  "timedOut": true,
  "quarantined": true
}
```

被隔离 session 不得自动 resume。

---

## 修改白名单

运行前默认要求 clean worktree。

运行后收集：

- tracked modified；
- added；
- deleted；
- renamed；
- staged；
- untracked。

建议使用：

```bash
git status --porcelain=v1 -z
git diff --name-status
git diff --cached --name-status
git ls-files --others --exclude-standard
```

任一变化不符合 `allowedPaths` 时返回：

```text
CHANGE_OUTSIDE_ALLOWLIST
```

不要自动删除或回滚越界文件；应保留现场并标记 rejected。

---

## Build Report JSON

OpenCode 最终只返回一个 JSON 对象：

```json
{
  "status": "completed",
  "summary": "Added image URL OCR input with SSRF protection.",
  "changedFiles": [
    {
      "path": "ocr_service/app/services/image_url_loader.py",
      "action": "added",
      "reason": "Implements remote image loading and URL validation."
    }
  ],
  "tests": [
    {
      "id": "ocr-tests",
      "command": [
        "python",
        "-m",
        "pytest",
        "ocr_service/tests",
        "-q"
      ],
      "exitCode": 0,
      "result": "43 passed"
    }
  ],
  "incomplete": [],
  "risks": [],
  "notes": []
}
```

`status` 只允许：

```text
completed
blocked
failed
```

wrapper 必须交叉验证：

- 报告中的 changedFiles 与 Git 实际变化一致；
- 实际有、报告无：`UNREPORTED_CHANGE`；
- 报告有、实际无：`REPORTED_CHANGE_NOT_FOUND`；
- tests 覆盖合同中全部 verification id；
- completed 时 incomplete 为空；
- completed 时所有必需测试 exitCode 为 0；
- 超时、越界、工作区不稳定时不得 completed。

错误码至少包括：

```text
BUILD_REPORT_JSON_INVALID
BUILD_REPORT_SCHEMA_INVALID
UNREPORTED_CHANGE
REPORTED_CHANGE_NOT_FOUND
CHANGE_OUTSIDE_ALLOWLIST
REQUIRED_TEST_NOT_REPORTED
AGENT_TEST_FAILED
WORKTREE_NOT_CLEAN
PROCESS_TREE_NOT_TERMINATED
WORKSPACE_NOT_STABLE
SESSION_QUARANTINED
MAX_CORRECTION_ROUNDS_EXCEEDED
```

---

## Wrapper 独立验证

OpenCode 报告通过后，wrapper 必须独立运行 `contract.verification`，不得只相信 agent 自报。

输出分开保留：

```json
{
  "agentReportedTests": [],
  "wrapperVerification": [
    {
      "id": "ocr-tests",
      "command": [
        "python",
        "-m",
        "pytest",
        "ocr_service/tests",
        "-q"
      ],
      "exitCode": 0,
      "timedOut": false,
      "stdoutSummary": "43 passed",
      "stderrSummary": ""
    }
  ]
}
```

任何 wrapper verification 失败，任务不得进入 `awaiting_review`。

---

## 自动纠偏与编辑所有权

当报告、白名单或验证失败时，可以在同一 session 自动发送一次结构化纠偏，明确列出错误码和问题。

纠偏次数受 `maxCorrectionRounds` 限制；超过后停止，不得由 Codex 自动接管。

Codex 在 OpenCode 运行或纠偏期间只能：

- 读取文件；
- 查看 diff；
- 查看状态和日志；
- 拒绝结果；
- 要求同一 OpenCode session 修正。

Codex 不得：

- 使用补丁工具修改项目；
- 替 OpenCode 补实现或测试；
- 超时后立即接管；
- 恢复 quarantined session。

用户明确批准后才能执行：

```text
takeover <run-id>
```

接管后：

```json
{
  "phase": "aborted",
  "editor": "codex",
  "opencodeResumeAllowed": false
}
```

---

## Codex 只读审查

`build-run` 成功后进入：

```json
{
  "phase": "awaiting_review",
  "editor": "none",
  "codexWriteAllowed": false
}
```

Codex 只做：

- `git diff --check`；
- `git diff --stat`；
- 白名单内 diff 审查；
- 测试结果核验；
- 安全边界检查。

通过：

```text
build-review <run-id> --accept
```

拒绝：

```text
build-review <run-id> --reject --reason <text>
```

拒绝后仍只允许 OpenCode 继续修正，除非用户批准 takeover。

---

## 文档更新

更新 `SKILL.md` 和 `references/opencode-patterns.md`：

- 正式编码任务必须使用 `build-run`；
- 不得直接调用 `opencode`；
- 不得由 Codex 手工组合 `start` / `prompt` 执行正式编码；
- wrapper 失败时停止并报告；
- OpenCode 运行时 Codex 不得修改项目文件；
- OpenCode 失败时只能纠偏、停止或请求 takeover；
- SSH、SCP、systemctl、数据库迁移和生产部署不属于 build-run 默认权限。

---

## 测试要求

全部在临时 Git 仓库完成，不修改真实业务仓库：

- [ ] clean worktree 正常启动；
- [ ] dirty worktree 返回 `WORKTREE_NOT_CLEAN`；
- [ ] 白名单内修改通过；
- [ ] 白名单外修改返回 `CHANGE_OUTSIDE_ALLOWLIST`；
- [ ] 未跟踪越界文件能被发现；
- [ ] 合法 build report 通过；
- [ ] 漏报文件返回 `UNREPORTED_CHANGE`；
- [ ] 虚报文件返回 `REPORTED_CHANGE_NOT_FOUND`；
- [ ] 缺少测试返回 `REQUIRED_TEST_NOT_REPORTED`；
- [ ] agent 报告测试失败时拒绝；
- [ ] wrapper 独立验证失败时整体失败；
- [ ] idle timeout 能触发；
- [ ] hard timeout 能触发；
- [ ] Windows 进程树完整终止；
- [ ] 超时后工作区停止变化；
- [ ] 工作区持续变化时进入 quarantined；
- [ ] quarantined session 无法 resume；
- [ ] takeover 后原 session 无法继续；
- [ ] 临时测试目录无意外残留。

---

## Agent 实施 Prompt

```text
请处理本 issue：为 opencode-agent-communication-skill 增加受监督的 build-run 正式编码工作流。

开始前：
1. 阅读 issue 全文；
2. 阅读当前 SKILL.md、references/opencode-patterns.md 和 scripts/opencode-agent.mjs；
3. 总结当前命令、状态文件、OpenCode JSONL 解析、Windows 进程启动与超时处理方式；
4. 不要重写现有 evidence、preflight、agent mode、fallback 检测等已通过功能。

实现目标：
- 正式编码统一走 build-run；
- 使用 contract JSON 管理 agent、session、allowedPaths、verification 和超时；
- 建立 run 状态机与持久化状态；
- 实现 clean worktree、Git 变化收集和白名单校验；
- 实现 idle/hard timeout、Windows 进程树终止、工作区静止检测和 quarantine；
- 实现机器可校验的 build report JSON；
- 交叉验证 changedFiles、测试报告和 Git 实际状态；
- wrapper 独立重跑 verification；
- 支持一次受限自动纠偏；
- 支持 build-status、build-cancel、build-review、takeover；
- 明确 Codex 只读审查和编辑所有权；
- 保留 shell:false、参数数组、脱敏日志、原子写入和 Ctrl+C。

实施约束：
1. 先设计状态机和数据结构，再改代码。
2. allowedPaths 第一版只支持精确文件和 directory/**，不要引入复杂 glob 库。
3. 不要自动回滚、删除或清理越界文件，应保留失败现场。
4. 不得使用 --dangerously-skip-permissions。
5. 不得把部署、SSH、SCP、systemctl restart 纳入默认 build-run。
6. 不得让 Codex 在 OpenCode 运行或失败后自动接管编辑。
7. Windows 超时必须终止整个进程树，并验证工作区停止变化。
8. OpenCode 最终报告必须是单个 JSON；若 JSONL text part 被拆分，只拼接最终 assistant message 的 text parts。
9. 所有文件写入继续使用原子写入。
10. 所有新增错误使用稳定 errorCode。

测试：
- 在临时 Git 仓库中完成 issue 列出的全部测试；
- 进程树终止和持续写入使用可控测试子进程；
- 测试前后检查临时目录残留；
- 不修改真实业务仓库。

完成后：
1. 运行全部现有测试和新增测试；
2. 检查 evidence / preflight / oneshot / start / prompt 是否回归；
3. 更新 SKILL.md 和 references/opencode-patterns.md；
4. 报告修改文件、命令用法、contract schema、build report schema、状态机、超时终止方式、白名单规则和测试结果；
5. 明确未覆盖风险；
6. 创建 PR，但不要合并。
```

---

## 验收标准

- [ ] 正式编码可通过单个 `build-run` 受监督执行；
- [ ] wrapper 能区分正常完成、失败、超时、隔离、待审查和人工接管；
- [ ] 超时后没有后台 OpenCode 继续写文件；
- [ ] OpenCode 独立完成修改和测试，Codex 不直接编辑；
- [ ] 实际修改全部位于合同白名单内；
- [ ] build report 能与 Git 和 verification 交叉验证；
- [ ] Codex 可只读 accept/reject；
- [ ] 原有 evidence、preflight、agent mode、fallback 阻断和 Windows 兼容能力无回归；
- [ ] 所有新增测试通过；
- [ ] PR 附带实际命令和测试结果，且不自动合并。
