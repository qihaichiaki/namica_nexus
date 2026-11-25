# Namica Nexus

> Different agents. Persistent identities. One home.

V0.1.0 是面向 Windows 的个人 AI Agent 宿主。在浏览器中创建多个身份、设定人格并与本机 Codex 对话。Host 将身份、历史消息、工具活动和任务状态保存在 SQLite；关闭网页后，已提交的任务仍由 Host 执行。模型推理使用 Codex 自己的服务和登录状态。

## 安装与运行

准备 Node.js 22.18 或更高的受支持版本、npm，以及可执行的官方 Codex CLI。先在普通终端确认 `codex --version` 和 `codex login status`，需要时运行 `codex login`。从项目根目录执行以下命令。

```powershell
npm ci
npm run build
npm start
```

打开 [本地 Web Client](http://127.0.0.1:8080)。保持 Host 终端运行，按 Ctrl+C 关闭。SQLite 在部分 Node.js 版本中会输出实验性功能提示。

1. 打开**设置**，点击**检测可用性**。若找不到 Codex，设置其原生可执行文件的完整路径，保存后再次检测。Windows 可用 `Get-Command codex.exe` 定位二进制。如使用 npm 安装的 CLI，选择实际的 `codex.exe`，避免填写 PowerShell 或 CMD 包装脚本。检测覆盖进程、协议握手及账户状态，模型连通性通过发消息验证。
2. 打开**身份**，创建身份，填写名称和基础人格。工作目录留空会沿用 Runtime 的独立工作目录，或填写自己的绝对路径。
3. 进入对话、新建会话并发送消息。试试在工作目录放一个小程序，让 Agent 解释它的输出。在消息旁查看工具及审批信息；核对操作内容后选择允许一次或拒绝。执行中可以停止任务。
4. 刷新或关闭页面，再次访问即可继续查看。修改名称、描述或人格后，新会话使用更新的人格版本。现有会话保留创建时的指令与工作目录。需要停止运行中的任务时使用聊天页停止按钮。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 同时启动 Host 和支持热更新的 Web Client，浏览器打开 [开发页面](http://127.0.0.1:5173) |
| `npm run dev:host` | 单独开发 Host |
| `npm run check` | 全工程 TypeScript 检查 |
| `npm test` | 自动化回归，使用临时目录与受控输入 |
| `npm run build` | 类型检查、编译 Host 并构建静态 Web Client |
| `npm start` | 运行已构建的 Host，同时提供页面和 API |
| `npm run test:live` | 构建后执行真实 Codex 验收，使用当前账户、临时独立目录和随机端口 |

真实验收会调用模型、读取合成代码文件、重启 Host 恢复线程并取消任务。默认使用 Codex 当前模型，可通过 `NEXUS_TEST_MODEL` 选择本机账户可用的模型。若 Windows 原生沙箱要求审批，按终端提供的本地地址进入该会话，逐项审核命令。测试使用的 Nexus 数据在结束时清理，Codex 创建的原生线程遵循 Codex 自己的存储策略。

## 本地数据与配置

Windows 默认数据目录为 `%LOCALAPPDATA%\NamicaNexus`，其中 `nexus.sqlite` 存放业务数据，`workspace\` 是独立工作目录。要备份 Nexus 数据，先正常关闭 Host，再复制整个数据目录。恢复原生线程还需要原有的 Codex 账户和本地线程存储。

设置页支持日志等级、执行超时、默认 Runtime，以及 Codex 的启用状态、可执行文件、默认工作目录和可选模型。日志等级立即生效；超时和模型在后续任务使用，默认 Runtime 用于创建身份。可执行文件和目录路径允许包含空格与中文。

端口和数据目录通过启动环境指定。例如在单独的 PowerShell 中运行以下命令即可启动一个独立实例。

```powershell
$env:NEXUS_PORT = '8081'
$env:NEXUS_DATA_DIR = Join-Path $env:LOCALAPPDATA 'NamicaNexus-Test'
npm start
```

Host 绑定 IPv4 回环地址并校验 Host 和 Origin。个人电脑上的其他本地进程仍可以访问这些接口。Codex 使用工作目录沙箱及原生审批；不支持的审批类型会安全拒绝。在聊天中遇到 Runtime 错误时，失败原因及已收到的部分回复保留在会话中。若原生线程被移除，可以保留历史并新建会话继续工作。

若可用性检测成功但聊天连接超时，请检查 Codex 到模型服务的网络连接。需要显式代理时，在启动 Host 的同一个 PowerShell 中配置环境变量，保留自己的直连例外。下列地址仅为格式示例，请替换为自己的代理端口。适配器对 Windows 系统代理的支持范围见 [Runtime 实测](docs/runtime-verification.md)。

```powershell
$env:HTTPS_PROXY = 'http://127.0.0.1:7890'
$env:HTTP_PROXY = $env:HTTPS_PROXY
# 按本机网络策略补充需要直连的域名或地址
$env:NO_PROXY = ('127.0.0.1,localhost,' + $env:NO_PROXY).TrimEnd(',')
npm start
```

## 开发文档

- [实际架构与接口](docs/architecture.md)
- [本机 Codex 协议与验证记录](docs/runtime-verification.md)
- [进度和已知问题](docs/progress.md) · [开发交接报告](docs/handoff.md)
- [愿景](docs/vision.md) · [路线图](docs/roadmap.md) · [架构决策](docs/adr) · [协作约束](AGENTS.md)

当前实现一个真实 Codex Adapter；其他 Runtime、长期记忆、远程客户端与多 Agent 协作列入后续版本。项目许可证由负责人后续确定。
