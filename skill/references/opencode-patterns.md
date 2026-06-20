# OpenCode 调用模式

## plan 只读分析示例

```powershell
node opencode-agent.mjs oneshot plan C:\work\repo @"
背景：
这是一个只读分析任务。
目标：
总结当前目录 README.md 的用途。
输入：
- 当前项目目录
- README.md
输出格式：
1. 一段中文摘要
禁止事项：
- 不要修改文件
- 不要运行写操作
验收标准：
- 明确说明目录用途
"@
```

## build 实施修改示例

```powershell
node opencode-agent.mjs start build ui-fix C:\work\repo @"
背景：
需要修复一个前端问题。
目标：
在不破坏现有行为的前提下完成修改。
输入：
- 项目目录
- 相关报错与验收标准
输出格式：
1. 修改摘要
2. 涉及文件
3. 测试结果
禁止事项：
- 不要自动提交、发布、部署
- 不要读取密钥文件
验收标准：
- 问题修复
- 说明验证过程
"@
```

## oneshot 示例

```powershell
node opencode-agent.mjs oneshot plan C:\work\repo "请只读分析 src 结构，并列出 5 个主要模块。"
```

## 仓库分析推荐流程

第一步先做 `preflight`，由 wrapper 用本地文件系统确认路径，不把“文件是否存在”交给模型判断：

```powershell
node opencode-agent.mjs preflight C:\work\repo `
  .github/workflows/ci.yml `
  package.json `
  requirements.txt `
  ocr_service/app/main.py `
  ocr_service/tests/test_api.py
```

第二步使用 `evidence` 和明确附件做只读取证：

```powershell
node opencode-agent.mjs evidence C:\work\repo `
  --file .github/workflows/ci.yml `
  --file package.json `
  --file requirements.txt `
  --file ocr_service/app/main.py `
  --file ocr_service/tests/test_api.py `
  --required-fact ci-pytest-step `
  --required-fact package-test-script `
  --required-fact no-ci-lint-step `
  -- @"
背景：
需要先确认仓库事实，再决定是否修改。
目标：
只基于附加文件，返回机器可校验的 JSON 证据。
输出要求：
返回一个 JSON 对象：
- facts: quote 或 absence
- unconfirmed: 无法从附件确认的项
禁止事项：
- 不要修改文件
- 不要编造不存在的命令、键名或配置
- 不要提供实施方案
- 不要把未附加或未读取到的内容写成事实
- 不要输出 Markdown 或代码围栏
- quote 必须逐字复制附件中的连续文本，最多 3 行
- 无法直接引用的缺失性事实必须使用 absence
验收标准：
- wrapper 能通过 JSON、quote、absence 和附件范围校验
"@
```

注意：
- `explore` 是 subagent，不能通过 `--agent explore` 直接运行。
- 如果 OpenCode 提示 subagent fallback 或 default-agent fallback，wrapper 必须将本次运行判定为失败。
- 对已知关键文件，优先使用 `--file` 附件，而不是依赖模型自行搜索。
- 不再把 Markdown 标题、粗体或字段样式作为验收标准。

第三步由 Codex 独立验证：
- 重新读取 wrapper 已验证过的附件与 quote。
- 检查 `project-dir` 和附件路径是否正确。
- 让 wrapper 负责精确引用真实性和缺失搜索校验。
- 判断结论是否真的受到证据支持。
- 如有需要，重新确认当前行号，但不要替 OpenCode 补做遗漏的核心分析。

第四步再把已确认事实交给 `plan`，让 `plan` 只负责方案，不再重复取证：

```powershell
node opencode-agent.mjs oneshot plan C:\work\repo @"
背景：
下面这些仓库事实已经由 Codex 独立验证为真实：
- <confirmed fact 1>
- <confirmed fact 2>
目标：
基于以上已确认事实，提出修改方案。
输入：
- 只使用已确认事实
- 如某项前提不确定，明确标记为待确认，不要自行补假设
输出格式：
1. 修改目标
2. 影响文件
3. 方案步骤
4. 风险与验证方法
禁止事项：
- 不要重新编造仓库事实
- 不要把未确认项写成既定事实
验收标准：
- 方案必须建立在已确认事实之上
"@
```

推荐顺序：
- `preflight` 验证 project-dir 和关键路径
- `evidence` + 明确 `--file` + `--required-fact` 收集机器可校验的证据
- wrapper 确定性验证 quote、absence 和附件范围
- Codex 验证“证据是否支持结论”
- `oneshot plan` 基于已确认事实制定方案
- Codex 验收方案
- `start build` 实施修改

重试限制：
- 第一次输出不合格时，可以对同一 agent 做一次明确纠偏。
- 第二次仍不合格时，停止重复相似的 `oneshot`。
- 根据问题类型切换到 `explore`、`general`，或者停止任务并报告阻塞点。

## 多轮 session 示例

第一轮：

```powershell
node opencode-agent.mjs start build auth-refactor C:\work\repo "请先实现第一版认证重构。"
```

第二轮：

```powershell
node opencode-agent.mjs prompt auth-refactor "请根据刚才的输出，补充测试并修正命名。"
```

## history / show / delete 示例

```powershell
node opencode-agent.mjs history auth-refactor
node opencode-agent.mjs show auth-refactor
node opencode-agent.mjs delete auth-refactor
```

## Windows PowerShell 长 prompt

推荐 here-string 走 stdin，避免引号和换行问题：

```powershell
@"
背景：
这是一个长 prompt。
目标：
只读分析当前目录。
禁止事项：
- 不要修改文件
"@ | node opencode-agent.mjs oneshot plan C:\work\repo
```

对多轮 session 也一样：

```powershell
@"
请继续刚才的 session，并把输出改成项目验收清单。
"@ | node opencode-agent.mjs prompt auth-refactor
```

## 常见错误与排查

`opencode` 不存在：
- 先确认 `opencode --version` 能运行。
- 如果不行，先安装或修复 PATH。

`Agent not found`：
- 先运行 `node opencode-agent.mjs list-agents`。
- 不要猜 agent 名称。

`Session not found in local state`：
- 说明 `sessions.json` 里没有该名字。
- 不能偷偷新建；应提示用户先 `start`。

`project-dir does not exist`：
- 检查目录路径。
- 在 Windows 上优先传绝对路径。

`run` 成功但没有稳定拿到 session ID：
- wrapper 会先从事件里取 `sessionID`。
- 如果事件缺失，再用运行前后的 `opencode session list --format json` 按唯一 title 和目录定位。

`export` 解析失败：
- 当前本机 `opencode export <session-id>` 输出为一个 JSON 文档，后面可能跟一行 `Exporting session: ...`。
- 解析时应先提取前导 JSON 再忽略尾部提示。

`Ctrl+C` 中止：
- wrapper 会把中止信号转发给子进程。
- 如仍残留 session，请用 `show` / `delete` 检查并清理。
