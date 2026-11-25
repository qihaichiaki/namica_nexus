# Namica Nexus — Development Handoff

## 1. 基础信息

2026-11-25 · v0.1.0 · M0–M4 本机 MVP 验收 · Git 分支 `main`。初始实现 `905f8e5`，本机原生命令审批兼容修正 `2a34236`。Git 使用开发机已配置的作者与提交者身份。

## 2. 当前开发目标

在个人 Windows PC 上从空工程打通“浏览器 → Host → 本机 Codex → 实际回复与工具结果”的闭环，并验证身份、会话和先前任务的状态可以恢复。

## 3. 已完成工作

完成 Chat、Agents、Settings 中文界面；真实模型对话、Markdown、工具活动、停止与单次审批；多身份和版本化人格、会话映射、消息及配置的 SQLite 持久化；运行时可用性检查；客户端重连、Host 重启及进程退出处理。

## 4. 当前实际架构

React/Vite Web 通过 HTTP 和 SSE 访问 Fastify Host。一个 Host 独占一份 SQLite 数据库，持有运行中的任务。通用 Agent 接口通过 Codex Adapter 为每个 Turn 启动 App Server 子进程，利用原生 Thread 恢复推理上下文。具体状态和 API 表见 [架构文档](architecture.md)。

## 5. 关键实现

| 文件 | 审查重点 |
| --- | --- |
| `apps/host/src/store.ts` | 人格快照、单会话并发约束、消息写入顺序和重启恢复事务 |
| `apps/host/src/tasks.ts` | 后台任务、取消、超时、工具与审批归属 |
| `packages/agent-core/src/index.ts`、`packages/agent-codex/src/index.ts` | 通用接口与原生协议映射、沙箱、流式更新和线程恢复 |
| `apps/web/src/main.tsx`、`apps/web/src/chat.tsx` | SSE 重连、当前会话选择及消息展示 |
| `tests/live-smoke.mjs`、`tests/real-runtime.ts` | 从 Host 和从 Adapter 两个层次复验真实模型 |

## 6. 技术验证与测试结果

- 运行 `codex --version`、`codex login status`、`codex app-server generate-ts`；本机为 `codex-cli 0.171.0-alpha.13.2`，使用原生 ChatGPT 登录。
- `npm ci`、`npm run build`、`npm test`（3 个文件、13 项）、`npm audit` 已通过。开发模式与生产模式均实际启动并接受请求。
- 已运行 `npm run test:live`。模型读取临时文件并报告随机结果，客户端断开期间任务继续；重新启动 Host 后继续使用原线程，模型复述之前的结果，下一轮可取消。
- 系统 Chrome 实际创建身份、修改设置、检测 Runtime、发消息并在执行中关闭页面。重开后收到含预设人格前缀的回复。390px 宽下三页均可操作。
- 在独立进程强制终止 Host 后重新启动：保留部分文本和线程映射，遗留任务标记为中断，再次发送成功。测试结果、网络超时记录及其他未验证范围见 [进度](progress.md) 和 [协议探针](runtime-verification.md)。
- 对真实 Codex 子进程单独执行异常终止，调用方收到退出错误后仍可运行。真实原生审批分别验证了拒绝写入、允许指定文件编辑，以及在 Chrome 中核对命令并允许一次读取。

## 7. 与原始设计的差异

本机已有 Node.js 22.18 与 npm，使用 npm 锁文件和内置 SQLite 驱动，减少 Windows 安装步骤。前端使用 React、Lucide、自有 CSS 和 Markdown 渲染器。每个 Turn 启动一个进程以隔离故障。SSE 合并资源变化通知，Client 获取顺序一致的快照，免于维护事件重放队列；后续可在协议内增加分页和增量更新。

## 8. 当前问题与风险

- 模型服务曾出现连接重试乃至超时，显式设置已有代理后真实调用成功。进程、协议、账户检测和模型连通性是不同的检查。Windows 复杂代理例外须由用户按实际网络策略处理。
- 部分 PowerShell 操作遇到本机 Windows 沙箱启动问题；已验证单次批准限定文件读取后工具正常返回。未知权限请求拒绝。交付保留原生沙箱和审批。
- 复测曾因默认模型在三分钟内未返回正文而超时。另一轮从实际拒绝的命令审批报文中发现了协议版本差异，已修复并添加回归覆盖，详见 [协议探针](runtime-verification.md)。
- 平台会话历史与 Codex 原生线程分别存储。若 Codex 线程被清除或不能恢复，平台记录错误并保留历史。大规模长会话与其他 Codex 版本尚未验收。

## 9. 需要云端 ChatGPT 参与讨论的问题

暂无。第二种 Runtime 的选择及其能力映射可在 V0.2 立项时讨论。

## 10. 下一步开发计划

负责人提供远程仓库地址后推送本地提交。按 [README](../README.md) 体验本地 MVP，根据反馈确定 V0.2 范围。
