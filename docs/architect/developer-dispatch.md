# 开发者派发与能力核对

本页记录 Architect 可用的派发渠道。选择与验收原则见[接手指南](working-guide.md#调度与交接)。Nexus 产品自身的 Runtime 见[实际架构](../architecture.md)。

## 当前环境的证据

2026-11-25 在 Windows 核对。换设备、更新工具或更换账号时，先核对当前调用器的能力清单。清单用于选参数，成功的调用用于确认渠道，工程能力按具体任务的验收记录判断。

| 渠道 | 可选配置与调用 | 已取得的证据 |
| --- | --- | --- |
| Codex 子 Agent | 当前 `spawn_agent` 为 `gpt-6.2-sol` 和 `gpt-6.2-astra` 列出 `low / medium / high / xhigh / max / ultra`。显式指定模型或推理档时使用 `fork_turns: "none"`，在任务消息中提供仓库、基线、必要约束与交付要求。同一 Developer 的后续修正可用 `followup_task`。 | Sol Ultra 已返回连通性回执。Sol Low 已按范围读完仓库规范并准确指出提交与验收的硬约束，样本是一项只读核对。Astra 此处仅有调用器声明。 |
| DeepSeek Harness | 本机 CLI `0.2.2-rc.5` 用 headless 派发。ACP 的 `session/new` 列出账号路由下的 Flash、V4-Pro。选择 `deepseek-account / deepseek-flash` 后，`session/set_config_option` 返回 `off / low / high / max`，并接受 `low`。目录可能回退到安装包内置列表。 | Flash Max 已用 headless 跨进程续聊，负责人已在桌面回看两轮历史。Flash Low 此次只验证了配置选择。V4-Pro 此处仅有目录证据。 |

对新组合，先检查宿主或账号目录、任务权限以及预算。实际任务遇到不可用的模型或档位时，记录所请求的配置与错误，改用已授权的可用组合，并在交付时注明实际配置。当前样本还不足以给两种产品的代码交付质量或成本排名。

## 用 DSH 已登录账号派发

在任务工作目录运行安装包自带的 `dsh`。若命令未注册到 PATH，可从实际安装目录调用随附的 `resources/runtime/cli/bin/dsh.cmd`。桌面端和 CLI 需使用同一 `DSH_HOME`，才能复用已保存的账号并回看同一份历史。

默认 headless 配置使用 API Key 路由。下面是已验证的 Flash Max 示例。按任务选择时，修改临时 YAML 文件中的 `model` 和 `reasoningEffort`，再通过官方 `--patch` 参数传入。文件放在仓库外，登录状态由 DSH 自行读取。[Headless 凭据配置](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/README.md#credentials) · [默认模型字段](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent-default-model/README.md)

```yaml
- id: credentials
  disabled: false
- id: authorization
  disabled: false
- id: deepseek-account
  disabled: false
- id: agent-default-model
  config:
    provider: deepseek-account
    model: deepseek-flash
    reasoningEffort: max
```

以下为合成的只读示例。`$patchFile` 是上述文件的路径，第二条命令的 `$sessionId` 取自第一条输出的 `session.sessionId`。

```powershell
dsh headless --patch $patchFile --permission-mode read-only --json "记住标记 MAPLE，回复收到。"
dsh headless --patch $patchFile --permission-mode read-only --json --session-id $sessionId "上一轮的标记是什么？"
```

正式派发时传入[接手指南](working-guide.md)中的任务指令，在任务工作目录按所需范围选择权限。Architect 将会话 ID 随任务编号发给负责人，用 `--json` 读取执行事件；进程退出后核对退出码和 `final.reason.kind`。退出码为零且终态为 `completed` 表示本轮执行完成，代码交付仍按任务验收。追问或返工时，等上一进程退出，在同一工作目录使用同一个会话 ID。若账号路由已生效但报 `TRANSPORT`，检查 CLI 继承的代理是否可用；本次通过只为子进程使用 Windows 当前代理恢复了连接。[官方派发与续聊说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/README.md#choosing-the-session-identity)

## 负责人如何回看

1. 在 DSH 左侧「工作区」旁点「搜索会话」，粘贴 Architect 回报的会话 ID。「搜索会话名称」也支持匹配 ID，标题为「未命名」时同样可查。
2. 桌面端已经打开却搜不到新记录时，等桌面任务结束，从 Windows 托盘退出 DeepSeek Harness，再打开并搜索。窗口的 × 会收起至托盘。负责人已在本机确认，退出重进后可以看到命令行会话。

此次确认的是已落盘的历史回看。执行期间由 Architect 从 CLI 事件获取进度并回报。会话 ID 在协作对话中交接，仓库中的任务记录使用可分享的提交、测试结果和验收结论。[桌面生命周期](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/README.zh.md#closing-the-window-and-quitting)
