# ask-bridge-mcp

這是一個本機 MCP Server，讓你可以從 VS Code Copilot Chat 使用 Microsoft 365 Copilot。它會將請求交給既有的 `ask-bridge --provider copilot` 瀏覽器自動化功能處理。

## 安裝

執行前請確認已經準備好：

- Node.js 20.19 或更新版本
- 已安裝 `ask-bridge`，且可從系統 `PATH` 執行
- Google Chrome
- 可使用 Microsoft 365 Copilot 的帳號

下載此專案後，在專案目錄執行：

```powershell
npm install
npm run build
ask-bridge --provider copilot login
```

登入指令會開啟 Chrome，請在瀏覽器中完成 Microsoft 365 Copilot 登入。

## 在 VS Code 使用

使用 VS Code 開啟此專案。專案內附的 `.vscode/mcp.json` 會啟動 MCP Server，並從系統 `PATH` 尋找 `ask-bridge`，因此不會受到專案存放位置影響。

第一次啟動時，請接受 VS Code 顯示的 MCP Server 信任提示，然後在 Copilot Chat 的 **Configure Tools** 中啟用 `ask_m365_copilot`。

對話範例：

```text
請使用 #ask_m365_copilot 分析這段程式碼，並直接保留 Microsoft 365 Copilot 的回答。
```

## 設定為所有專案共用

若希望在每個 VS Code workspace 中使用此 MCP Server：

1. 從命令選擇區執行 **MCP: Open User Configuration**。
2. 將 `.vscode/mcp.json` 中的 `m365Copilot` Server 設定複製到使用者設定。
3. 將 `${workspaceFolder}/dist/index.js` 改成這個專案內 `dist/index.js` 的絕對路徑。

Windows JSON 路徑中的反斜線必須跳脫，例如：

```json
"C:\\path\\to\\ask-bridge-mcp\\dist\\index.js"
```

## 自訂 ask-bridge 路徑

MCP Server 預設會從系統 `PATH` 執行 `ask-bridge`。如果 `ask-bridge` 沒有加入 `PATH`，可以在 MCP Server 設定中加入 `env`，並將 `ASK_BRIDGE_PATH` 設為執行檔的絕對路徑：

```json
"env": {
  "ASK_BRIDGE_PATH": "C:\\path\\to\\ask-bridge.exe"
}
```

## 重新建置

修改 TypeScript 程式後，請重新執行：

```powershell
npm run build
```

然後在 VS Code 執行 **MCP: List Servers**，重新啟動 `m365Copilot` Server。

## 注意事項

- MCP Server 的標準輸出保留給 MCP 通訊協定使用，因此程式不會將偵錯訊息寫入 stdout。
- 使用工具時，Chrome 與 Microsoft 365 Copilot 的回應可能需要一段時間，預設逾時時間為 300 秒。
- Microsoft 365 Copilot 的網頁介面若改版，可能需要同步更新 `ask-bridge`。
