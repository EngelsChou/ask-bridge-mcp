# ask-bridge-mcp

這是一個本機 MCP Server，讓你可以從 VS Code Copilot Chat 使用 Microsoft 365 Copilot。它會將請求交給既有的 `ask-bridge --provider copilot` 瀏覽器自動化功能處理。

## 一般使用者安裝

執行前請確認已經準備好：

- 已安裝 `ask-bridge`，且可從系統 `PATH` 執行
- Google Chrome
- 可使用 Microsoft 365 Copilot 的帳號

先確認獨立安裝的 `ask-bridge` 可以使用：

```powershell
where.exe ask-bridge
ask-bridge --provider copilot login
```

登入指令會開啟 Chrome，請在瀏覽器中完成 Microsoft 365 Copilot 登入。

接著執行發布頁提供的 `ask-bridge-mcp-install.exe`。安裝器會將程式安裝到：

```text
%LOCALAPPDATA%\Programs\ask-bridge-mcp
```

安裝器已經包含 Node.js、編譯後的 MCP Server 與所有執行階段 npm 相依套件。使用者的電腦不需要安裝 Node.js，也不需要連線執行 `npm install`。`ask-bridge` 維持為另一套獨立程式，可分別安裝、測試、升級及解除安裝。

解除安裝可從 Windows 的「已安裝的應用程式」、開始功能表，或直接執行下列檔案：

```text
%LOCALAPPDATA%\Programs\ask-bridge-mcp\uninstall.exe
```

## 在 VS Code 使用

安裝完成後，從命令選擇區執行 **MCP: Open User Configuration**，將安裝目錄中的 `vscode-mcp.json` 內容合併到使用者 MCP 設定。預設內容如下：

```json
{
  "servers": {
    "m365Copilot": {
      "type": "stdio",
      "command": "${env:LOCALAPPDATA}\\Programs\\ask-bridge-mcp\\runtime\\node.exe",
      "args": ["${env:LOCALAPPDATA}\\Programs\\ask-bridge-mcp\\app\\dist\\index.js"]
    }
  }
}
```

第一次啟動時，請接受 VS Code 顯示的 MCP Server 信任提示，然後在 Copilot Chat 的 **Configure Tools** 中啟用 `ask_m365_copilot`。

對話範例：

```text
請使用 #ask_m365_copilot 分析這段程式碼，並直接保留 Microsoft 365 Copilot 的回答。
```

## 開發者設定

只有修改或封裝本專案的電腦需要 Node.js 20.19 或更新版本與 npm。第一次下載原始碼後執行：

```powershell
npm ci
npm run build
```

使用 VS Code 開啟原始碼目錄時，專案內附的 `.vscode/mcp.json` 會直接啟動開發版本。

### 建立 Windows 離線安裝器

建置電腦需先安裝 [NSIS](https://nsis.sourceforge.io/)。執行：

```powershell
npm run package:win
```

建置流程只會在建置電腦執行 `npm ci`，並產生：

```text
release\ask-bridge-mcp-install.exe
```

若建置電腦的 npm cache 已經備妥，也可以完全離線封裝：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-windows-installer.ps1 -Offline
```

只建立並測試離線 payload、不呼叫 NSIS 時，可執行：

```powershell
npm run package:win:stage
npm run test:package
```

## 自訂 ask-bridge 路徑

MCP Server 預設會從系統 `PATH` 執行 `ask-bridge`。如果 `ask-bridge` 沒有加入 `PATH`，可以在 MCP Server 設定中加入 `env`，並將 `ASK_BRIDGE_PATH` 設為執行檔的絕對路徑：

```json
"env": {
  "ASK_BRIDGE_PATH": "C:\\path\\to\\ask-bridge.exe"
}
```

## 重新建置開發版本

修改 TypeScript 程式後，請重新執行：

```powershell
npm run build
```

然後在 VS Code 執行 **MCP: List Servers**，重新啟動 `m365Copilot` Server。

## 注意事項

- MCP Server 的標準輸出保留給 MCP 通訊協定使用，因此程式不會將偵錯訊息寫入 stdout。
- `ask-bridge-mcp-install.exe` 只安裝本專案；找不到 `ask-bridge.exe` 時會顯示警告，但不會替使用者安裝或修改 `ask-bridge`。
- 安裝器目前未加上程式碼簽章。公司環境若使用 SmartScreen、AppLocker 或其他應用程式管控，仍可能需要由 IT 簽章或加入允許清單。
- 使用工具時，Chrome 與 Microsoft 365 Copilot 的回應可能需要一段時間，預設逾時時間為 300 秒。
- Microsoft 365 Copilot 的網頁介面若改版，可能需要同步更新 `ask-bridge`。
