# Namica Nexus

> Different agents. Persistent identities. One home.

V0.1.0 是面向 Windows 的个人 AI Agent 宿主。在浏览器中创建多个身份、设定人格并与本机 Codex 对话。Host 将身份、历史消息、工具活动和任务状态保存在 SQLite；关闭网页后，已提交的任务仍由 Host 执行。模型推理使用 Codex 自己的服务和登录状态。

## 安装与运行

准备 Node.js 22.18 或更高的受支持版本、npm，以及可执行的官方 Codex CLI。用 `codex --version` 确认安装，然后从项目根目录执行以下命令。

```powershell
npm ci
npm run build
npm start
```

打开 [本地 Web Client](http://127.0.0.1:8080)。保持 Host 终端运行，按 Ctrl+C 关闭。SQLite 在部分 Node.js 版本中会输出实验性功能提示。

1. 打开**设置 → Runtime 配置**。如需代理，在**本地代理地址**填写自己的 HTTP(S) 代理（如 `http://127.0.0.1:7890`）并保存。如需指定二进制，使用 `Get-Command codex.exe` 定位原生可执行文件。
2. 首次使用时，在项目根目录的另一终端运行 `npm run codex:login`，按官方页面提示登录 Nexus 专用配置。回到设置页点击**检测可用性**。检测覆盖进程、协议和账户，模型连通性通过发消息验证。
3. 打开**身份**，创建身份，填写名称和基础人格。工作目录留空会沿用 Runtime 的独立工作目录，或填写自己的绝对路径。
4. 进入对话、新建会话并发送消息。试试在工作目录放一个小程序，让 Agent 解释它的输出。在消息旁查看工具及审批信息；核对操作内容后选择允许一次或拒绝。执行中可以停止任务。
5. 刷新或关闭页面，再次访问即可继续查看。修改名称、描述或人格后，新会话使用更新的人格版本。现有会话保留创建时的指令与工作目录。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 同时启动 Host 和支持热更新的 Web Client，浏览器打开 [开发页面](http://127.0.0.1:5173) |
| `npm run dev:host` | 单独开发 Host |
| `npm run codex:login -- status` | 查询 Nexus 专用目录的登录状态；设备码登录使用 `npm run codex:login -- --device-auth` |
| `npm run check` | 全工程 TypeScript 检查 |
| `npm test` | 自动化回归，使用临时目录与受控输入 |
| `npm run build` | 类型检查、编译 Host 并构建静态 Web Client |
| `npm start` | 运行已构建的 Host，同时提供页面和 API |
| `npm run test:live` | 构建后执行真实 Codex 验收，使用当前账户、临时独立目录和随机端口 |

真实云模型验收前应设置 `$env:NEXUS_TEST_CODEX_HOME = (Resolve-Path './data/codex-home').Path`，指向已独立登录的专用目录。可通过 `NEXUS_TEST_MODEL` 选择可用模型。测试读取合成文件、重启 Host 恢复线程并取消任务，遇到原生审批时按终端地址审核；测试线程会留在指定的 Codex 目录中。只验证本地线程隔离和跨进程续聊可运行 `npx tsx tests/native-isolation.ts`，使用真实 App Server 和本机合成模型服务。

## 本地数据与配置

从项目根目录启动时，默认数据目录是项目内的 `data/`，整个目录由 Git 忽略。

| 路径 | 内容 |
| --- | --- |
| `data/nexus.sqlite` | 身份、人格、消息、任务及 Host、Runtime 配置（包括代理地址） |
| `data/workspace/` | 新会话继承的默认工作目录 |
| `data/codex-home/` | Nexus 专用的 Codex 配置、登录状态、原生线程和日志 |

专用目录让新线程可在 Nexus 恢复，并与日常 Codex 的本机“最近”列表分开。旧版写入常规 Codex 的条目仍在原处，可以在 Codex 中手动归档；迁入旧库后可在 Nexus 阅读历史，为该身份新建会话即可开始隔离的对话。此隔离针对本机线程列表，云模型仍会收到提交的内容。备份请先关闭 Host，再妥善保存整个数据目录，其中可能含官方登录凭据。工作目录应与专用 Codex 目录分开。

升级旧版时，可在关闭旧 Host 后将 `%LOCALAPPDATA%\NamicaNexus` 的内容复制到一个空的 `data/` 中再启动。原库可留作备份；已配置的自定义绝对工作路径会保留，旧版生成的默认工作路径会随新数据目录解析。

设置页支持日志等级、执行超时、默认 Runtime，以及 Codex 的启用状态、可执行文件、默认工作目录和可选模型。日志等级立即生效；超时和模型在后续任务使用，默认 Runtime 用于创建身份。可执行文件和目录路径允许包含空格与中文。

端口和数据目录通过启动环境指定。例如在单独的 PowerShell 中运行以下命令即可启动一个独立实例。

```powershell
$env:NEXUS_PORT = '8081'
$env:NEXUS_DATA_DIR = Join-Path $PWD 'data/test-instance'
npm start
```

Host 绑定 IPv4 回环地址并校验 Host 和 Origin。个人电脑上的其他本地进程仍可以访问这些接口。Codex 使用工作目录沙箱及原生审批；不支持的审批类型会安全拒绝。在聊天中遇到 Runtime 错误时，失败原因及已收到的部分回复保留在会话中。若原生线程被移除，可以保留历史并新建会话继续工作。

保存的代理地址用于后续专用登录、Runtime 检测和聊天。支持主机与可选端口，保留进程的 `NO_PROXY`，地址中不能带账号密码、路径、查询参数或片段。清空并保存后会恢复环境变量及受支持的 Windows 系统代理设置。详细优先级见 [Runtime 实测](docs/runtime-verification.md)。

## 开发文档

- [架构师工作入口](docs/architect/working-guide.md) · [源码与验证基线](docs/architect/current-state.md) · [待负责人讨论的问题](docs/architect/open-questions.md)
- [实际架构与接口](docs/architecture.md)
- [本机 Codex 协议与验证记录](docs/runtime-verification.md)
- [进度和已知问题](docs/progress.md) · [开发交接报告](docs/handoff.md)
- [愿景](docs/vision.md) · [路线图](docs/roadmap.md) · [架构决策](docs/adr) · [协作约束](AGENTS.md)

当前实现一个真实 Codex Adapter；其他 Runtime、长期记忆、远程客户端与多 Agent 协作列入后续版本。项目许可证由负责人后续确定。
