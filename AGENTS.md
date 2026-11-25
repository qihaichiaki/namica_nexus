# Namica Nexus 开发协作

- 先阅读 `README.md`、`docs/architecture.md` 和 `docs/handoff.md`，通过 `git status` 核对当前工作。使用英文命名代码，讨论和阶段文档可用中文。
- V0.1 的范围是 Windows 本地 Web Client、独立 Host、SQLite 和真实 Codex Runtime。Client 仅访问 Host。第三方协议的进程、消息和事件转换由 Adapter 处理，Identity 与 Session 使用平台自己的标识。
- 用户消息先持久化再提交。每个会话只运行一个 Turn。网页断开时任务继续运行，进程异常时保留部分回复及真实状态。变更这些行为时补回归测试。
- 使用仓库锁文件安装依赖。提交前执行 `npm test` 和 `npm run build`。涉及 Runtime 协议的变更还应以本机版本在源码目录外验证，记录实际版本及限制。Mock 仅用于自动化测试。
- Git 中只保存源码、可分享的文档和合成测试数据。不要提交本地数据库、真实对话、认证资料或机器专属路径。Runtime 通过官方方式认证，保留原生沙箱与审批。
- 阶段完成、重要重构或发现架构问题时更新 `docs/progress.md` 及 `docs/handoff.md`。交接报告按基础信息、目标、实际成果、架构、关键文件、实测、设计调整、风险、讨论项、后续计划组织。标明未通过和未执行的检查。
- 重要决策更新 `docs/architecture.md` 与 `docs/adr/`。影响数据模型、技术路线或扩展边界的新问题应记录现象、备选方案和建议，提交负责人及云端 ChatGPT 讨论。普通工程问题直接解决。
