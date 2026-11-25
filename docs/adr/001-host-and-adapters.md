# ADR 001 · Host 与第三方 Runtime 的边界

**状态**　V0.1 已采纳

**背景**　第一版只有本机浏览器与 Codex，未来需要替换 Runtime 并增加 Client。让浏览器直接连接子进程会把任务生命周期绑定到页面。

**方案**　比较浏览器直连 Runtime、模块化单体 Host 和独立进程的服务集群。

**决定与理由**　采用独立的 Node.js Host，Agent 接口表达平台需要的会话与 Turn 操作。Codex Adapter 独占 stdio 协议。浏览器用 HTTP 发命令，SSE 接收变化。请求与后台任务具有独立生命周期，一个 Host 即可在 PC 上部署。

**影响**　关闭页面可以继续任务，Host 可以用替身 Adapter 验证错误路径。Host 退出时需主动收尾或在启动时修复执行状态。第二种 Agent 接入时需根据其实际能力复核抽象。
