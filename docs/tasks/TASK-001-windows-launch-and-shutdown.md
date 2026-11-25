# TASK-001 · Windows 双击启动与 Web Console 关停

业务源码基线 `43d2c17`。本轮从 `a1529a8` 接续。负责人已确认以本机 Web Console 代替原生管理窗口，启动时自动打开 Console。见 [ADR 004](../adr/004-windows-launch-and-shutdown.md)。

## 体验与接口约定

- 安装与构建后，双击 Namica Nexus 入口即可在后台启动 Host。就绪后用默认浏览器打开该实例的 `/console/`。正在启动或已经运行时复用目标实例，保留任务、会话和配置。网页标签页由默认浏览器管理。保留终端启动和开发模式。
- Console 复用现有 Host/Runtime 设置和状态，提供「打开 Client」和「停止服务」。Client 位于 `/`，保留身份、人格、聊天、审批和取消。关任一网页只断开连接。这一版全部监听回环地址，托盘、远程访问与新的管理能力留待以后讨论。
- 一个 Host 独占 Store 并持有 Tasks。管理路由放在 `/api/manage` 下：`GET /host/status` 返回现有 HostStatus 加 `service: "namica-nexus"` 和 `activeTurns: number`，配置与 Runtime 检测沿用现有相对路径。显式 `POST /api/manage/host/shutdown` 返回 202 后关闭。Client 使用现有业务路由与 `GET /api/runtime-options`（数组，每项仅 id、type、enabled、isDefault）。CLI 登录辅助命令随管理路由更新。Console 可通过本机请求刷新状态。
- 停止前显示当前活动任务数并允许取消。Host 受理后停止接纳新任务，保留部分回复与线程映射，活动 Turn 和未完成工具收为 interrupted，清空旧审批，释放端口、子进程与数据库。页面区分已受理与意外失联。
- 实例识别核对服务标识、端口与数据目录。处理双击并发、端口被占、路径含空格/中文与启动失败。失败时提供可读原因，不终止无关进程。保留 Host、Origin 及跨站校验。

## 验收

验证冷启动及复用、关闭网页后继续运行、空闲与执行中关停、随后重启可读历史、双击竞争和端口冲突。通过临时工作区及独立回环端口验证，不操作负责人桌面。交回范围、提交、测试、构建、未实测的交互及已知限制。
