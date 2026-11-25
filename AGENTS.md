# Namica Nexus 开发协作

- 新 Agent 先用 `git status --short --branch` 核对工作区。接手全项目、没有单独指定角色时，按 **Architect Agent** 身份从 [架构师接手指南](docs/architect/working-guide.md) 开始，核对工程基线并接续当前讨论。被指派实现具体开发任务时按 **Developer Agent** 身份工作，阅读任务文件、相关源码和任务引用的约束。安装与运行见 [README](README.md)。使用英文命名代码，讨论和阶段文档可用中文。
- Architect 在已确认的任务范围、已授权服务和预算内调度 Developer。派发 Codex Developer 时，请按任务显式选择可用模型与推理档位。Developer 只在分配的范围内工作，再委派须有 Architect 对该子任务和预算的明确授权。所有 Agent 默认用命令行或 Agent 接口，控制负责人的桌面前须说明窗口、动作与原因并取得同意。
- V0.1 的范围是 Windows 本地 Web Client、独立 Host、SQLite 和真实 Codex Runtime。Client 仅访问 Host。第三方协议的进程、消息和事件转换由 Adapter 处理，Identity 与 Session 使用平台自己的标识。
- 用户消息先持久化再提交。每个会话只运行一个 Turn。网页断开时任务继续运行，进程异常时保留部分回复及真实状态。变更这些行为时补回归测试。
- 使用仓库锁文件安装依赖。提交前执行 `npm test` 和 `npm run build`。涉及 Runtime 协议的变更还应以本机版本在源码目录外验证，记录实际版本及限制。Mock 仅用于自动化测试。
- Agent 独立完成并提交的变更，Git 作者和提交者均署实际 Agent 对应的 GitHub 身份。Codex 使用 [@codex](https://github.com/codex)，提交命令为 `git -c user.name=Codex -c user.email=codex@openai.com commit`（可追加 `-m` 等参数）。身份配置仅对该次命令生效。其他 Agent 使用各自经核实的账号与关联邮箱；多人共同完成的变更按实际贡献保留署名。推送使用当前仓库已有的授权。
- Git 中只保存源码、可分享的文档和合成测试数据。不要提交本地数据库、真实对话、认证资料或机器专属路径。Runtime 通过官方方式认证，保留原生沙箱与审批。
- Developer 返回修改范围、实测结果、失败或未运行的检查及设计差异。Architect 复核 Git Diff 和验收证据，在工程基线或对应任务中记录验收结论。
- 影响数据模型、技术路线或扩展边界的问题，由 Architect 记录现象、备选方案和建议，提交负责人讨论。负责人确认重要决策后更新 `docs/architecture.md` 与 `docs/adr/`。修改业务源码由 Developer 负责，Architect 如需改动应先征得负责人同意。
