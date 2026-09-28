# Local management Console / 本地管理界面

The Console is a separate management surface for your own DevSpace installation. It is intended for local access or an SSH port forward, **not** a public Tunnel route.

It provides:

- Service and connection health for DevSpace and the optional Tunnel.
- Local/public MCP address display and initial connection guidance.
- Allowed Roots and runtime configuration management.
- Project, Git and Review information.
- Job IDs, status, logs and command evidence.
- Version identity and supported recovery actions.

The actual running Runtime may differ from a configured upgrade candidate. Check the displayed process status before restarting or rolling back, and avoid interrupting active jobs.

Owner passwords and Tunnel tokens are secrets. Do not publish screenshots containing credentials, local project names, command logs or private endpoint addresses. Treat copying an Owner password as an explicit, sensitive action.

Windows users normally use the packaged desktop manager. Linux users can access the loopback-only Console shown by the installer; the default port depends on the installed MCP port and instance configuration. See the [installation guide](getting-started.md) for setup.

中文：管理页面只供本机使用，不通过公网 MCP Tunnel 暴露。可以检查服务、连接、目录权限、项目、任务和版本。操作前确认真实运行进程和活动任务，切勿把密码、Token、项目路径或日志发到公开页面。
