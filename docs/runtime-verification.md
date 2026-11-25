# 本机 Codex Runtime 验证

验证日期为 2026-11-25，环境为 Windows、Node.js 22.18.0、Codex Desktop 随附的 `codex-cli 0.171.0-alpha.13.2`。首次 MVP 云端推理验收使用本机常规 Codex 的原生 ChatGPT 登录及临时工作区。当前版本将新线程存入 Nexus 专用 Codex 目录。

## 如何复现

```powershell
Get-Command codex
codex --version
npm run codex:login -- status
codex app-server --help
codex app-server generate-ts --out "$env:TEMP\namica-codex-protocol"
npx vitest run tests/codex-adapter.test.ts
npx tsx tests/native-isolation.ts
# 首次使用先运行 npm run codex:login，按实际数据目录指定独立登录的 codex-home。
$env:NEXUS_TEST_CODEX_HOME = (Resolve-Path '.\data\codex-home').Path
npx tsx tests/real-runtime.ts
```

最后一条命令会产生真实模型用量，启动三个 Turn，测试人格口令、恢复上一轮随机标记、工作区文件写入和中断。测试只允许自己为这次验证创建的目录中指定文件的编辑审批，结束后删除该目录。Codex 自己维护的 Thread 使用其原生存储。可用 `NEXUS_TEST_CODEX` 指定真实可执行文件路径，`NEXUS_TEST_MODEL` 指定账户可用的模型。Windows 上优先使用 `codex.exe`，不通过 Shell 运行批处理启动器。

## 专用线程目录与验收

每个 Host 数据目录使用自己的 `codex-home`。App Server 的 `CODEX_HOME` 和 `CODEX_SQLITE_HOME` 指向同一专用目录。固定 CLI 配置将 `sqlite_home` 指向该目录，将 `log_dir` 指向其中的 `log`。Adapter 在开始或恢复线程前核对 `initialize.codexHome` 及 `config/read` 返回的有效数据库和日志路径。如有不一致，任务直接报告错误。配置目录和实际工作区须分开，路径重叠与指向相同目录的连接点均受检查。

本机以空专用目录执行官方 `codex login status` 得到 `Not logged in`，独立 App Server 的 `account/read` 也返回未登录。登录入口只在专用目录执行官方命令。旧平台会话的聊天记录仍在 Nexus 数据库中。若其原生 Thread 仅存在于以往的常规 Codex 目录，恢复会报告错误，用户可新建 Nexus 会话继续。

`npx tsx tests/native-isolation.ts` 已通过。测试运行真实的本机 App Server，使用回环 HTTP 服务生成确定性的 Responses 消息，无需账户和云模型用量。两轮分别使用不同进程，第二轮原生恢复请求含第一轮的随机标记。专用 `sessions` 中有相应 rollout，专用 `thread/list` 查到该 ID，常规 Codex 的 `thread/list` 按相同 ID 查询无结果。测试在临时配置中另设两个目录，证实 CLI 覆盖后均未创建。自动化另覆盖握手路径不符、数据库或日志配置不符时终止、工作区包含专用目录时拒绝。

负责人随后通过 `npm run codex:login` 完成专用目录的官方登录。生产实例的 Runtime 检查报告可用。另启使用相同配置与代理的临时 Host，向真实云模型发送随机口令；重启测试 Host 后，下一轮在同一线程复述了口令。逐 ID 查询两份原生列表，只在专用列表中找到它。生产实例的 Nexus 身份和消息列表没有写入这组测试数据。

仅调整 `sqlite_home` 无法指定原生 rollout 根目录。本机生成的类型把 `threadSource` 描述为来源分类，`sessionStartSource` 只有 `startup` 和 `clear`。新建 Thread 使用官方持久化会话，进程关闭后通过原生 ID 恢复。参考 [官方配置定义](https://github.com/openai/codex/blob/main/codex-rs/core/config.schema.json)。

## 首次 MVP 的云模型与工具验收

| 项目 | 观测结果 |
| --- | --- |
| 认证与握手 | `codex login status` 报告 ChatGPT 已登录，App Server 完成 `initialize`、`initialized` 和 `account/read`。可用性检查只返回版本、可用状态和简短提示。 |
| 人格与流式回复 | 在 `thread/start.developerInstructions` 中设置测试口令，模型在真实 Turn 中回复了口令，首次探针收到四次 `item/agentMessage/delta`。保留了 Codex 原生基础指令。 |
| 会话恢复 | 关闭第一轮的进程，下一进程以 `thread/resume` 加载相同的 Thread ID，回复包含仅在第一轮用户消息中提供的随机标记。 |
| 工具与审批 | 在独立目录用文件编辑工具写入指定文本。原生 `item/fileChange/requestApproval` 在拒绝时没有创建文件，明确允许当前文件编辑后创建了文件，已读取内容核对。随后请求为 PowerShell 验证命令扩权时，探针拒绝，任务保留已完成的文件。 |
| 真实代码任务 | 用本机 `model/list` 返回的 `gpt-6.2-sol`，在专用目录创建只含固定输出语句的 `hello.cjs`。探针只同意该文件的原生编辑审批。读回源码匹配预期后执行 `node hello.cjs`，输出为 `NAMICA-CODE-OK`。同一任务用本机默认模型的一次尝试在 240 秒后超时。 |
| 取消 | 本机有时在 `turn/start` 返回 ID 后短暂回复 `no active turn to interrupt`。Turn 真正开始后再次调用 `turn/interrupt` 收到确认和 `turn/completed` 的 `interrupted` 状态。Adapter 对此窗口短暂重试，并有关闭进程的时限。 |
| 异常与边界 | 本地协议测试使用测试进程在发送部分文字后以退出码 12 退出，检查 Adapter 拒绝 Promise 并保留已产生的事件。另覆盖失败 Turn、审批一次性响应、跨 Turn 消息过滤、未知 RPC、模糊文件请求、敏感命令拒绝及失败工具退出码。 |
| 真实进程异常 | 在独立临时工作区启动真实 Adapter，收到 `turn.started` 后通过 `Get-CimInstance Win32_Process` 按本次 Node PID 与 `codex.exe` 名称定位唯一直接子进程，终止该进程。Adapter 以 `Codex app-server exited` 拒绝该次 Turn，Node 进程存活并完成清理。 |

最终在本机设置显式进程代理及 `$env:NEXUS_TEST_MODEL = 'gpt-6.2-sol'` 后执行 `npx tsx tests/real-runtime.ts`，三轮均满足断言。第一轮收到 32 次文本更新，恢复后收到 54 次更新与 4 个工具终态事件。原生审批允许隔离工作区的 `hello.txt` 编辑，文件内容与上一轮的随机标记一致。后续验证工具出现失败和拒绝状态，Adapter 分别报告了这些状态。第三轮返回取消。使用默认 `gpt-6.2-astra` 重跑时也出现过首轮成功、第二轮无文本并在五分钟上限处中断的情况。

每个 Turn 启动一个独立的 App Server。Adapter 在调用模型前核对返回的沙箱类型及审批策略，请求 `workspace-write`、`on-request` 和用户审核。在本机原生沙箱不能完成个别操作时，Codex 会发起“重试时绕过沙箱”的请求，此时必须由用户判断命令或文件操作是否可接受。超出一次性命令或已知文件范围的请求由 Adapter 拒绝。前端不展示原始 stderr、账号记录、MCP 参数或命令输出。

## 命令审批兼容性

命令审批的本机报文包含 `environmentId: "local"` 以及可由实验性类型生成选项查看的 `availableDecisions`。仅参考默认生成的声明会遗漏后者。集成复测曾因此将普通的工作区读取直接拒绝。修正后仅在本地环境且允许一次性 `accept` 时提供按钮，并按该请求支持的 `decline` 或 `cancel` 处理否定答复。已在 Chrome 内核对实际工作区路径、批准一次 `Get-Content` 并确认审批消失。回归进程另测试了远程环境、仅允许会话级授权及额外权限字段的拒绝。

## 模型连接与代理

本机出现过模型连接多次 `Reconnecting`，也有过等待超过三分钟仍无文本的尝试。一次未给子进程显式设置代理的运行重连后收到真实回复。无法仅据此判断 Codex 内部实际网络路由。另一次在调用进程显式设置已有 HTTP(S) 代理后约九秒收到包含口令的回复，其他经代理的运行也观察到较长等待。启动和登录检查本身无法验证模型连接。

Settings 中保存的 Runtime 代理地址（`proxyUrl`）对后续可用性检查和每个新 Turn 生效。它支持 HTTP(S) 的回环地址、局域网主机或域名，可带端口。只允许地址本身，带账号密码、路径、查询参数或片段的输入会返回 400。Adapter 将保存值传给子进程的 `HTTP_PROXY` 与 `HTTPS_PROXY`，保留进程已有的 `NO_PROXY` 绕过规则。

清空代理地址后，Adapter 先采用进程中配置的 `HTTP_PROXY`、`HTTPS_PROXY` 或 `ALL_PROXY`。无显式代理时，Windows 可读取当前用户已启用的手动代理，将可转换的设置和绕过列表传给子进程。遇到 PAC、`<local>`、端口匹配或复杂通配时跳过自动转换。本机绕过列表包含 `<local>`。可在启动 Host 的 PowerShell 会话中设置代理及适用的 `NO_PROXY`；前端只显示通过 Settings 保存的地址。

回归覆盖旧版数据库的空代理默认值、保存并重启、清空回退及无效输入。另以 Host 的 HTTP 接口保存合成代理地址，启动两个独立的协议测试子进程，分别确认可用性检查和发送消息时均已收到该地址。此项检查在进程边界完成，无需模型服务。

协议字段以本机生成的 TypeScript 定义为准。第三方升级后建议重新运行上述检查。参考 [OpenAI Codex App Server](https://github.com/openai/codex/tree/main/codex-rs/app-server)。
