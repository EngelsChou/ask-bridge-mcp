# ask-bridge-mcp

Local MCP server for using Microsoft 365 Copilot from VS Code Copilot Chat. It delegates requests to the existing `ask-bridge --provider copilot` browser automation.

## Setup

Requirements: Node.js 20.19 or newer, a built `ask-bridge` binary, Chrome, and an authenticated M365 Copilot session.

```powershell
npm install
npm run build
D:\EngelsSideProjects\ask-bridge\target\release\ask-bridge.exe --provider copilot login
```

Open this folder in VS Code. The included `.vscode/mcp.json` starts the server and points it at the local release binary. Accept VS Code's MCP trust prompt, then enable `ask_m365_copilot` under **Configure Tools** in Copilot Chat.

Example chat prompt:

```text
請使用 #ask_m365_copilot 分析這段程式碼，直接保留 Microsoft 365 Copilot 的回答。
```

To use the server from every workspace, run **MCP: Open User Configuration** and copy the `m365Copilot` server entry there. Replace `${workspaceFolder}/dist/index.js` with the absolute path `D:\\EngelsSideProjects\\ask-bridge-mcp\\dist\\index.js`.

## Configuration

`ASK_BRIDGE_PATH` can be either an absolute path to `ask-bridge.exe` or the command name when it is already on `PATH`. The MCP server writes no logs to stdout because stdout is reserved for the MCP protocol.
