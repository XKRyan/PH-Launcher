# Security Policy

## Supported version

当前只为最新稳定的 Windows 版本提供安全修复。macOS 版本仍在开发中，不应把未签名测试包用于正式分发。

## Reporting a vulnerability

优先使用本仓库的 GitHub “Report a vulnerability” 私密报告入口。若该入口暂不可用，可以创建一个不含利用细节和敏感数据的普通 issue，请维护者建立私密沟通渠道。

请提供受影响版本、可复现条件、可能影响和建议缓解方式。不要公开账号、密码、Cookie、验证码、API Key、学生信息、私钥或可直接利用的完整攻击步骤。

## Security boundaries

- 学校网站在隔离会话中运行，远程页面无 Node.js 权限。
- AI 默认关闭，启动器操作权限需要单独授权。
- AI 数据更改先预览、后确认；密码、Cookie、验证码和 API Key 不提供给 AI。
- 本地 AI 安装只接受明确白名单的模型，并验证官方 Ollama 安装程序签名。
- 项目不会要求用户关闭 Windows SmartScreen、macOS Gatekeeper、TLS、CSP 或浏览器安全隔离。

公开披露时间应在修复和用户迁移窗口确定后与维护者协调。

