# Codex 接入的协议依据

适用于 V0.1 的业务提交 `43d2c17`，历史实测环境为 Windows、Node.js 22.18.0 和 `codex-cli 0.171.0-alpha.13.2`。本页保留会影响后续 Adapter 设计或兼容性判断的观测。完整探针记录可用 `git show 43d2c17:docs/runtime-verification.md` 查看。

| 边界 | 实际观测 | 架构含义 |
| --- | --- | --- |
| 可用性 | 进程可完成握手与账户检查时，模型调用仍曾重试、超时。 | Runtime 检测只报告进程、协议和账户状态。真实模型连通性要单独发起 Turn 验证。 |
| 人格与原生续聊 | `developerInstructions` 中的合成口令出现在真实回复。关闭第一轮进程后，第二轮通过 `thread/resume` 复述了仅在首轮提供的标记。 | 同一线程可跨进程恢复。新进程可以取得此前的原生上下文，Host 仍需保存身份和会话快照。 |
| 私有存储 | 原生 rollout、SQLite 和日志有各自的路径。专用目录中生成的线程可恢复；历史实测按同一 ID 查询日常 Codex 列表无结果。 | 配置专用 home 并在握手核对三个位置。旧库里的平台历史仍可读，旧原生线程可能需要另开会话。依据见 [ADR 003](adr/003-private-codex-home.md)。 |
| 工具与审批 | 真实文件编辑分别验证了拒绝和单次同意。命令审批实际报文含 `environmentId` 和 `availableDecisions`，默认生成的类型未完整展示后者。 | 核对当前操作、环境和允许的答复；未知权限范围按拒绝处理。实际协议差异修正在 `2a34236`。 |
| 取消与进程退出 | `turn/start` 返回后曾短暂收到 `no active turn to interrupt`，重试后得到中断终态。独立终止真实 Codex 子进程时，Adapter 报错，Host 调用进程仍可继续。 | 取消要处理启动窗口、有界等待和进程退出。外部执行的结果影响平台终态。 |

**代理生效顺序。** 保存的 HTTP(S) 代理用于后续专用登录、可用性检查及新 Turn，传给子进程并保留已有 `NO_PROXY`。清空后先沿用进程代理变量；再尝试解析可支持的 Windows 手动代理。PAC、`<local>` 和复杂例外规则超出现有转换范围。可运行的配置方法见 [README](../README.md)。

## 复核入口

- [Adapter 回归](../tests/codex-adapter.test.ts)和[代理回归](../tests/proxy.test.ts)使用合成输入，覆盖协议偏差、取消、审批、配置传递及部分失败路径。
- [原生隔离验证](../tests/native-isolation.ts)使用真实 App Server 和回环合成模型，可核对存储、原生列表和跨进程续聊。执行时记录实际版本和使用的对照目录。[工程基线](architect/current-state.md)区分了历史日常列表检查与架构师在空白对照目录的复验。
- [真实 Adapter 验收](../tests/real-runtime.ts)与 [Host 端到端验收](../tests/live-smoke.mjs)使用独立官方登录和真实模型，对应人格、工具、断线、恢复及取消。执行条件和命令见 [README](../README.md)。Runtime 升级时在仓外临时工作区运行相关验证，按实际安装版本生成协议类型并核对原生报文。
