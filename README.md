# Namica Nexus

> Different agents. Persistent identities. One home.

V0.1.0 是面向 Windows 的个人 AI Agent 宿主。在浏览器中创建多个身份、设定人格并与本机 Codex 对话。Host 将身份、历史消息、工具活动和任务状态保存在 SQLite；关闭网页后，已提交的任务仍由 Host 执行。模型推理使用 Codex 自己的服务和登录状态。

## 安装与运行

准备 Node.js 22.18 或更高的受支持版本、npm，以及可执行的官方 Codex CLI。Windows 构建启动器使用系统 .NET Framework 的 C# 编译器。用 `codex --version` 确认 Codex 安装，然后从项目根目录执行以下命令。

```powershell
npm ci
npm run build
```

**日常启动**　在 Windows 资源管理器中双击项目根目录的 `Namica Nexus.exe`。启动器在后台运行 Host，就绪后用默认浏览器打开 [Nexus Console](http://127.0.0.1:8080/console/)。再次双击会进入同一实例，已有任务和会话继续运行。默认浏览器可能打开新的标签页。Console 中的「打开 Client」进入[聊天与身份管理](http://127.0.0.1:8080/)。

**停止服务**　在 Console 选择「停止服务」，查看活动任务数后确认。正在执行的任务会中断，已收到的回复和历史保留。关闭网页后 Host 继续运行。服务停止后可再次双击启动。

命令行仍可运行 `npm start`，从终端查看启动诊断，用 Ctrl+C 或 Console 停止服务。若端口已由其他服务使用，启动器会报告冲突。可改用独立端口并设置对应数据目录，见下文。SQLite 在部分 Node.js 版本中会输出实验性功能提示。

1. 打开 **Console → Runtime 配置**。「可执行文件」保留默认值 `codex` 即可自动查找。Windows 会先查 Host 的 PATH，再尝试当前用户已安装的官方 Codex 桌面应用。使用自定义安装时也可以指定 `codex.exe` 的绝对路径。如需代理，在「本地代理地址」填写自己的 HTTP(S) 代理（如 `http://127.0.0.1:7890`）并保存。
2. 在 **Console → Codex 独立登录** 选择「通过 OpenAI 登录」，打开官方页面并完成授权。回到 Console 可以查看状态、取消待完成的授权、更换账号或退出。浏览器回调不可用时可选择设备码，账号须开启该方式。每个新数据目录首次使用时授权一次，以后重启复用 Nexus 自己的授权。在 Runtime 卡片中点击**检测可用性**可检查进程、协议和账户，实际模型响应可用一条聊天消息验证。[官方登录说明](https://learn.chatgpt.com/docs/auth#login-on-headless-devices)
3. 在 **Client → 身份** 创建身份，填写名称和基础人格。工作目录留空会沿用 Runtime 的独立工作目录，或填写自己的绝对路径。
4. 进入对话、新建会话并发送消息。试试在工作目录放一个小程序，让 Agent 解释它的输出。在消息旁查看工具及审批信息；核对操作内容后选择允许一次或拒绝。执行中可以停止任务。
5. 刷新或关闭页面，再次访问即可继续查看。修改名称、描述或人格后，新会话使用更新的人格版本。现有会话保留创建时的指令与工作目录。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 同时启动 Host 与 Vite，可打开开发版 [Client](http://127.0.0.1:5173/) 和 [Console](http://127.0.0.1:5173/console/) |
| `npm run dev:host` | 单独开发 Host |
| `npm run codex:login -- status` | 查询 Nexus 专用目录的登录状态；设备码登录使用 `npm run codex:login -- --device-auth` |
| `npm run check` | 全工程 TypeScript 检查 |
| `npm test` | 自动化回归，使用临时目录与受控输入 |
| `npm run test:launcher` | 在 Windows 临时目录验证并发启动、实例复用、端口冲突和失败提示 |
| `npm run build` | 类型检查、编译 Host、构建两个 Web 入口，在 Windows 上生成双击启动器 |
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

**Host 配置**中的日志等级决定从现在起记录哪些事件。「Host 日志」可按级别筛选当前实例最近的 200 条事件。执行超时按每轮任务计时，默认 600 秒即 10 分钟，到时会中断该轮并保留已收到的回复。默认 Runtime 用在新建身份时，当前内置 Codex 一种。以上三项均可在运行期间保存。

**启动设置**显示当前生效的地址、端口和数据目录。选择本机 IPv4 或 IPv6 回环地址，填写端口，通过「浏览」选择数据目录或直接输入绝对路径。保存后可继续使用当前实例，也可立即重启。重启前请核对活动任务数。监听地址变化时，Console 会显示新入口。更新程序本身后，请停止服务，再双击启动器加载新代码。

**迁移数据**时，选择一个空的本机目录或输入尚未创建的目录。下一次启动时，Host 关闭原数据的写入，将身份、聊天、工作区和专用 Codex 数据迁至新位置，保留旧目录作备份。显式指定在数据目录外的工作区仍使用原路径。两个目录中都可能含登录资料。迁移遇到目录冲突或不支持的存储格式时，请查看启动设置中的失败原因。

启动环境也可用于选择独立实例。以下命令会使用单独的初始端口和数据目录；后续使用相同启动环境时，会接续这个实例在 Console 保存的设置。

```powershell
$env:NEXUS_PORT = '8081'
$env:NEXUS_DATA_DIR = Join-Path $env:LOCALAPPDATA 'NamicaNexus-Test/data'
npm start
```

Host 默认绑定 `127.0.0.1`，也可选择 IPv6 回环地址 `::1`，两者都仅供本机访问。Host 校验请求的 Host 和 Origin。个人电脑上的其他本地进程仍可以访问这些接口。Codex 使用工作目录沙箱及原生审批；不支持的审批类型会安全拒绝。在聊天中遇到 Runtime 错误时，失败原因及已收到的部分回复保留在会话中。若原生线程被移除，可以保留历史并新建会话继续工作。

保存的代理地址用于后续专用登录、Runtime 检测和聊天。支持主机与可选端口，保留进程的 `NO_PROXY`，地址中不能带账号密码、路径、查询参数或片段。清空并保存后会恢复环境变量及受支持的 Windows 系统代理设置。详细优先级见 [Runtime 实测](docs/runtime-verification.md)。

## 开发文档

- [架构师工作入口](docs/architect/working-guide.md) · [源码与验证基线](docs/architect/current-state.md) · [待负责人讨论的问题](docs/architect/open-questions.md)
- [实际架构与接口](docs/architecture.md)
- [本机 Codex 协议与验证记录](docs/runtime-verification.md)
- [愿景](docs/vision.md) · [路线图](docs/roadmap.md) · [架构决策](docs/adr) · [协作约束](AGENTS.md)

当前实现一个真实 Codex Adapter；其他 Runtime、长期记忆、远程客户端与多 Agent 协作列入后续版本。项目许可证由负责人后续确定。
