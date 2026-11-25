# 通过 DSH 命令行派发开发任务

本页用于 Architect 调用外部开发者。2026-11-25 在 Windows 上用 DeepSeek Harness `0.2.2-rc.5` 验证了任务派发、回执、续聊和历史回看。Nexus 自身的生产 Runtime 见[实际架构](../architecture.md)。

## 使用已登录账号派发

在任务工作目录运行安装包自带的 `dsh`。若命令未注册到 PATH，可从实际安装目录调用随附的 `resources/runtime/cli/bin/dsh.cmd`。桌面端和 CLI 需使用同一 `DSH_HOME`，才能复用已保存的账号并回看同一份历史。

默认 headless 配置使用 API Key 路由。验证时通过官方 `--patch` 参数临时启用已保存的账号登录，指定 Flash 模型与 Max 推理档位。将下列内容保存在仓库外的临时 YAML 文件，交由 DSH 自行读取登录状态。[Headless 凭据配置](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/README.md#credentials) · [默认模型字段](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent-default-model/README.md)

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
