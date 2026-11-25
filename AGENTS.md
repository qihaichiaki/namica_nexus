# Namica Nexus 开发协作

- 先用 `git status` 核对当前工作。Developer 阅读所派任务、相关源码及任务引用的约束；安装与运行见 `README.md`。Architect 从 `docs/architect/working-guide.md` 恢复背景。使用英文命名代码，讨论和阶段文档可用中文。
- V0.1 的范围是 Windows 本地 Web Client、独立 Host、SQLite 和真实 Codex Runtime。Client 仅访问 Host。第三方协议的进程、消息和事件转换由 Adapter 处理，Identity 与 Session 使用平台自己的标识。
- 用户消息先持久化再提交。每个会话只运行一个 Turn。网页断开时任务继续运行，进程异常时保留部分回复及真实状态。变更这些行为时补回归测试。
- 使用仓库锁文件安装依赖。提交前执行 `npm test` 和 `npm run build`。涉及 Runtime 协议的变更还应以本机版本在源码目录外验证，记录实际版本及限制。Mock 仅用于自动化测试。
- Git 中只保存源码、可分享的文档和合成测试数据。不要提交本地数据库、真实对话、认证资料或机器专属路径。Runtime 通过官方方式认证，保留原生沙箱与审批。
- Developer 返回修改范围、实测结果、失败或未运行的检查及设计差异。Architect 复核 Git Diff 和验收证据，维护架构知识库。`docs/progress.md`、`docs/handoff.md` 保存 V0.1 历史记录。
- 影响数据模型、技术路线或扩展边界的问题，由 Architect 记录现象、备选方案和建议，提交负责人讨论。负责人确认重要决策后更新 `docs/architecture.md` 与 `docs/adr/`。修改业务源码由 Developer 负责，Architect 如需改动应先征得负责人同意。
