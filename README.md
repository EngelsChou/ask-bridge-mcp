# ask-bridge-mcp

這是一個本機 MCP Server，讓你可以從 VS Code Copilot Chat 使用 Microsoft 365 Copilot。它會將請求交給既有的 `ask-bridge --provider copilot` 瀏覽器自動化功能處理。

## 一般使用者安裝

執行前請確認已經準備好：

- Google Chrome
- 可使用 Microsoft 365 Copilot 的帳號

完整版 `install.exe` 已內含 `ask-bridge 0.3.11`、Node.js、`chrome-devtools-mcp 1.5.0` 與 MCP Server，不需要另外安裝 `ask-bridge`、Node.js、npm 或 npx。封裝來源與 SHA-256 固定在 `installer/components.json`，建置時若二進位不符會直接失敗。

安裝後如需核對內附版本，可執行：

```powershell
& "$env:LOCALAPPDATA\Programs\ask-bridge-mcp\bridge\ask-bridge.exe" --version
```

安裝程式會把自己的 `bin` 目錄加入目前使用者的 PATH。安裝完成後請關閉並重新開啟 Terminal，即可直接使用：

```powershell
ask-bridge --version
ask-bridge --provider copilot login
ask-bridge --provider copilot "請用繁體中文回答：MCP 與 Skill 有什麼差別？"
```

也可使用較短的等效指令 `ask`。這兩個命令只會啟動完整安裝包內固定版本的 `ask-bridge.exe`，不依賴電腦上另行安裝 Node.js、npm、npx 或其他 ask-bridge。

第一次從 VS Code 呼叫 `ask_m365_copilot` 時，如果專用 Chrome profile 尚未登入，MCP Server 會自動關閉原本隱藏的背景 Chrome、開啟可見的登入視窗，並在登入完成後重送原問題。登入資料保存在 `%USERPROFILE%\.config\ask-bridge\chrome-profile`，升級或解除安裝程式不會刪除它。

接著從 GitHub Releases 下載並執行 `install.exe`。安裝器會將程式安裝到：

```text
%LOCALAPPDATA%\Programs\ask-bridge-mcp
```

這是一個單一、完整且可離線執行的安裝包；使用者電腦在安裝或執行時都不需要呼叫 `npm install` 或 `npx` 下載套件。內附的 `npx.cmd` 僅允許啟動固定版本 `chrome-devtools-mcp@1.5.0`，不會變成通用套件下載器。日後要升級內附元件時，安裝新版 `ask-bridge-mcp install.exe` 即可。

解除安裝可從 Windows 的「已安裝的應用程式」、開始功能表，或直接執行下列檔案：

```text
%LOCALAPPDATA%\Programs\ask-bridge-mcp\uninstall.exe
```

GitHub Release 也會另外提供可下載的 `uninstall.exe`。它會尋找預設位置中的安裝內容並啟動獨立解除安裝流程；即使安裝目錄內原本的解除安裝程式遺失，也能使用。

## 在 VS Code 使用

安裝完成後，從命令選擇區執行 **MCP: Open User Configuration**，將安裝目錄中的 `vscode-mcp.json` 內容合併到使用者 MCP 設定。預設內容如下：

```json
{
  "servers": {
    "m365Copilot": {
      "type": "stdio",
      "command": "${env:LOCALAPPDATA}\\Programs\\ask-bridge-mcp\\runtime\\node.exe",
      "args": ["${env:LOCALAPPDATA}\\Programs\\ask-bridge-mcp\\app\\dist\\index.js"],
      "env": {
        "ASK_BRIDGE_PATH": "${env:LOCALAPPDATA}\\Programs\\ask-bridge-mcp\\bridge\\ask-bridge.exe",
        "ASK_BRIDGE_ALLOWED_ROOTS": "${workspaceFolder}"
      }
    }
  }
}
```

`${workspaceFolder}` 會由 VS Code 在啟動 stdio MCP Server 時展開；預設只允許傳送目前工作區內的路徑附件。若要另外允許已存檔的截圖資料夾，Windows 使用分號分隔多個根目錄，例如：

```json
"env": {
  "ASK_BRIDGE_ALLOWED_ROOTS": "${workspaceFolder};C:\\Users\\User\\Pictures\\Screenshots"
}
```

每個根目錄都必須是已存在的絕對目錄。未設定 `ASK_BRIDGE_ALLOWED_ROOTS` 時，`imagePaths`／`filePaths` 會 fail closed；若是 multi-root workspace，可明確加入 `${workspaceFolder:FolderName}`。VS Code 的 stdio MCP 設定正式支援 `env`、`cwd` 與 `${workspaceFolder}` 等預定義變數，詳見 [MCP configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration)。VS Code 的 MCP sandbox [目前不支援 Windows](https://code.visualstudio.com/docs/agent-customization/mcp-servers#_sandbox-mcp-servers)，因此 Windows 仍必須依靠本 Server 的 allow-root、敏感檔案拒絕與明確同意檢查，不能只依賴編輯器 sandbox。

第一次啟動時，請接受 VS Code 顯示的 MCP Server 信任提示，然後在 Copilot Chat 的 **Configure Tools** 中啟用 `ask_m365_copilot`。

工具的 `prompt` 會透過 stdin 串流給 `ask-bridge`，不會放進 Windows 命令列，因此不受 Windows 約 32K 字元的命令列長度限制。請注意 `prompt` 本身仍會離開本機並送到 M365；除非使用者明確要求傳送該段內容，Agent 不得把自行從 workspace 讀到的檔案內容或 secrets 塞進 prompt。Server 無法機械式辨識或遮蔽任意 prompt 文字。附件則以獨立的 `--image <path>`／`--file <path>` 參數傳遞；即使路徑含空白，也不會經過 shell 字串拼接。

對話範例：

```text
請使用 #ask_m365_copilot 分析這段程式碼，並直接保留 Microsoft 365 Copilot 的回答。
```

### 選擇 Microsoft 365 Copilot 模式／模型

VS Code Chat 頂端的模型選擇器只決定哪個模型負責規劃並呼叫 MCP 工具，不會切換 Microsoft 365 Copilot 網頁中的模型。若要指定下游 M365 模式或模型，請在 `ask_m365_copilot` 工具呼叫使用 `model`：

```json
{
  "prompt": "請仔細分析這個架構決策。",
  "model": "GPT 5.5 Think deeper",
  "newConversation": true
}
```

Microsoft 公開且相對穩定的模式名稱為 `Auto`、`Quick response`、`Think deeper`；也可填入 M365 的 GPT／More 子選單中當下可見的完整名稱，例如 `GPT 5.5 Think deeper`、`GPT 5.5 快速回應` 或 `Claude`。選項依租戶、授權、管理原則與 Microsoft 上線進度而異；找不到指定項目時，請求會在送出 prompt 前停止。

### 程式碼、檔案與截圖

`ask_m365_copilot` 保留既有的 `prompt`、`newConversation`、`timeoutSeconds`，並提供下列可選欄位：

| 欄位 | 用途 |
|---|---|
| `model` | M365 網頁中可見的模式或模型名稱；與 VS Code Chat 模型選擇器分開 |
| `imagePaths` | 要上傳的本機圖片「絕對路徑」陣列 |
| `filePaths` | 要上傳的程式碼或一般文件「絕對路徑」陣列 |
| `inlineImages` | `{ data, name?, mimeType? }`；`data` 可為嚴格 base64 或 `data:image/...;base64,...` |
| `includeClipboardImage` | Windows 專用；將目前剪貼簿圖片以隱藏的 STA PowerShell 精確存成 PNG 後上傳 |
| `attachmentConsent` | 只在使用者明確要求把本次列出的每一個附件傳到 M365 時設為 `true`；任何附件都必須有此值 |

例如要讓 M365 Copilot 參考畫面與程式碼，工具呼叫的資料會類似：

```json
{
  "prompt": "Order Header 的 Country 下拉選單要加入 TW。請參考截圖與現有程式碼提出修改方式及測試案例。",
  "imagePaths": ["C:\\work\\OrderApp\\screenshots\\country-dropdown.png"],
  "filePaths": [
    "C:\\work\\OrderApp\\src\\OrderHeader.cs",
    "C:\\work\\OrderApp\\src\\CountryOptions.ts"
  ],
  "attachmentConsent": true,
  "newConversation": true
}
```

若剛使用 `Win+Shift+S` 截圖，或剛把圖片貼進 VS Code Chat，且圖片仍在 Windows 剪貼簿，可以要求 Agent 呼叫工具時設定：

```json
{
  "prompt": "請依照剪貼簿中的畫面分析 Country 下拉選單。",
  "includeClipboardImage": true,
  "attachmentConsent": true
}
```

需要特別區分兩件事：

- 貼在 VS Code Chat 的圖片是 Copilot Vision 的聊天脈絡，MCP Server 無權自行讀取該聊天附件，也不會自動收到圖片位元組。
- `includeClipboardImage` 讀的是「呼叫工具當下」的 Windows 剪貼簿。若之後又複製了文字，請重新複製／截取圖片；若圖片已存檔，優先使用 `imagePaths`，結果最穩定。
- VS Code 的目前檔案、選取範圍與 `#file` 也不會自動變成 M365 附件。只有在使用者明確指定該路徑、明確指示「傳送目前檔案」，或明確同意把內容放入外部 prompt 時，Agent 才能把它傳給 M365；不得自行挑選「相關檔案」。
- `imagePaths`／`filePaths` 會操作 M365 的「新增內容」→「上傳影像和檔案」。Microsoft 說明指出，本機上傳的檔案會在 OneDrive 建立一份複本；若不希望建立雲端複本，請勿使用附件欄位，改由使用者明確同意後把必要片段放進 `prompt`。

安全限制如下：

- 任何 `imagePaths`、`filePaths`、`inlineImages` 或剪貼簿圖片都要求 `attachmentConsent=true`；這只代表使用者同意本次明確列出的附件，不授權 Agent 再挑其他檔案。
- 路徑會先 canonicalize，再確認位於 `ASK_BRIDGE_ALLOWED_ROOTS` 其中一個 canonical 根目錄內；比較可防 sibling-prefix traversal，Windows 不分大小寫，父目錄 symlink／junction 逃逸也會被拒絕。inline／剪貼簿不受根目錄限制，但仍須明確同意。
- 即使位於允許根目錄，仍拒絕 `.git`、`.ssh`、`.gnupg`、`.aws`、`.azure` 等敏感目錄，以及 `.env`／`.env.*`、SSH 私鑰、credentials、`.pem`、`.key`、`.pfx`、`.p12`、`.jks`、`.keystore` 等常見機密檔。錯誤訊息不會回傳檔案內容。
- 附件總數最多 10 個、單一附件最多 20 MiB、合計最多 50 MiB；路徑必須為絕對路徑且指向一般檔案，目錄與 leaf symbolic link 都會拒絕。
- inline 圖片支援並驗證 PNG、JPEG、GIF、BMP、TIFF 的 MIME type、base64 格式與檔頭。路徑附件最終能否上傳仍以 Microsoft 365 Copilot 官方帳號、介面及格式清單為準。
- inline／剪貼簿暫存檔會放在每次呼叫獨立的 `%TEMP%\ask-bridge-mcp-*`，成功、失敗、登入重試結束或取消後會重試清除；若防毒軟體持續鎖定檔案，會在 MCP log 警告，但不會把已成功的 M365 回答改成失敗。

M365 的「新增內容」與多檔上傳方式可參考 [Microsoft 官方說明](https://support.microsoft.com/en-us/microsoft-365-copilot/add-content-to-microsoft-365-copilot-chat-prompts)，實際支援格式以 [Microsoft 365 Copilot 檔案格式清單](https://support.microsoft.com/en-us/microsoft-365-copilot/file-formats-supported-by-microsoft-365-copilot) 為準。

### VS Code custom agent 與 subagent

安裝包內含兩份範本：

```text
%LOCALAPPDATA%\Programs\ask-bridge-mcp\examples\m365-advisor.agent.md
%LOCALAPPDATA%\Programs\ask-bridge-mcp\examples\m365-coordinator.agent.md
```

將它們複製到專案的 `.github\agents\`（團隊共用）或 `%USERPROFILE%\.copilot\agents\`（個人共用），然後在 VS Code 執行 **Chat: Open Customizations** 確認已載入。範本指定的 MCP server 名稱是 `m365Copilot`，必須與 `mcp.json` 一致。

主 Agent 要委派給 subagent 時，請在 Copilot Chat 的 **Configure Tools** 確認 `agent/runSubagent` 已啟用。Coordinator 範本的 `tools: ['agent', ...]` 允許委派，`agents: ['M365 Advisor']` 則限制只能選這個顧問；Advisor 只啟用 `m365Copilot/*`，沒有 `read`／`search`，不能自行探索本機檔案。可對照 VS Code 官方的 [Subagents](https://code.visualstudio.com/docs/agents/subagents) 與 [Custom agents](https://code.visualstudio.com/docs/agent-customization/custom-agents) 說明。

- `M365 Advisor` 是只負責呼叫 `m365Copilot/*`、整理 M365 建議的專門 agent。
- `M365 Coordinator` 可在本機檢查程式碼，但只有使用者明確要求 M365 且明確列出檔案、指定目前檔案／剪貼簿或同意外傳內容時，才能把那一部分交給 `M365 Advisor`；不得自行挑附件或把檔案內容塞進 prompt。若 VS Code 版本尚未啟用 subagent，仍可直接切換至 `M365 Advisor` 使用。

對話可寫成：

```text
使用 M365 Advisor subagent 協助修改 Order Header Country 下拉選單並加入 TW。
我明確同意把 C:\work\OrderApp\src\OrderHeader.cs 與目前 Windows 剪貼簿圖片傳給 M365；請只傳這兩個附件。
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

EXE 的檔案版本資訊與「應用程式與功能」發行者會顯示 `Engels Chou`。Windows SmartScreen 顯示的發行者則來自 Authenticode 數位簽章；若要讓安裝程式不再顯示「不明的發行者」，建置機必須具備受 Windows 信任、主體為 Engels Chou 的程式碼簽章憑證，並使用下列其中一種方式封裝：

```powershell
# 使用 CurrentUser\My 憑證存放區中的憑證
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-windows-installer.ps1 `
  -CertificateThumbprint "<SHA1 thumbprint>" -RequireSignature

# 或使用 PFX；密碼也可放在 ASK_BRIDGE_SIGNING_CERTIFICATE_PASSWORD
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-windows-installer.ps1 `
  -CertificatePath "C:\secure\engels-chou-code-signing.pfx" -CertificatePassword "<password>" -RequireSignature
```

GitHub hosted runner 預設沒有簽章憑證。Release workflow 支援 repository secrets `WINDOWS_SIGNING_CERTIFICATE_BASE64`（PFX 的 base64）與 `WINDOWS_SIGNING_CERTIFICATE_PASSWORD`；前者存在時會以 `-RequireSignature` 建置並在完成後刪除暫存 PFX。憑證必須受 Windows 信任且主體為 Engels Chou；未提供 secrets 時仍可產出安裝程式，但 SmartScreen 會繼續標示為未簽章。

建置流程只會在建置電腦執行 `npm ci`，並產生安裝／解除安裝程式與各自的 SHA-256 校驗檔：

```text
release\install.exe
release\uninstall.exe
release\install.exe.sha256
release\uninstall.exe.sha256
```

推送與 `package.json` 版本相同的 tag（例如 `v0.2.6`）時，`.github/workflows/release.yml` 會在 GitHub 的 Windows runner 重新建置，並將兩個 EXE 與兩個 SHA-256 檔上傳為 GitHub Release assets。二進位檔不會寫入 Git commit 歷史。

若建置電腦的 npm cache 已經備妥，也可以完全離線封裝：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-windows-installer.ps1 `
  -Offline -AskBridgeArchive C:\cache\ask-bridge-x86_64-pc-windows-msvc.zip
```

只建立並測試離線 payload、不呼叫 NSIS 時，可執行：

```powershell
npm run package:win:stage
npm run test:package
```

## 自訂 ask-bridge 路徑

完整版安裝設定已將 `ASK_BRIDGE_PATH` 指向同一安裝目錄內的固定版本。即使沿用舊版 VS Code MCP 設定、沒有這個環境變數，MCP 也會依照內附 Node.js 的位置自動找到相鄰的 `bridge\ask-bridge.exe`。開發或除錯時若要暫時改用其他建置，可以在 MCP Server 設定中覆寫為執行檔的絕對路徑：

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

## 診斷紀錄

每次工具呼叫都會產生不含 prompt／回覆本文的 `request_id`，用來串起 VS Code MCP、`ask-bridge` 子程序與回傳結果。MCP 的結構化 JSONL 會寫入 stderr（可在 VS Code 的 MCP Server log 查看），並保留在：

```text
%USERPROFILE%\.config\ask-bridge\mcp-diagnostics.jsonl
```

底層瀏覽器自動化紀錄位於同一目錄的 `copilot-diagnostics.jsonl`。兩份紀錄都只保存字元數、換行數、DOM 計數、階段、耗時、exit code 等 metadata；不保存問題或回答本文，超過 2 MiB 時會輪替。

可用 `ASK_BRIDGE_MCP_DIAGNOSTICS_PATH` 指定 MCP log 的絕對路徑；設為 `off` 可停用檔案紀錄（stderr 仍保留）。

## 注意事項

- MCP Server 的標準輸出保留給 MCP 通訊協定使用，因此程式不會將偵錯訊息寫入 stdout。
- `install.exe` 只安裝本專案；找不到 `ask-bridge.exe` 時會顯示警告，但不會替使用者安裝或修改 `ask-bridge`。
- 未提供受信任的程式碼簽章憑證時，封裝出的安裝器仍是未簽章狀態。公司環境若使用 SmartScreen、AppLocker 或其他應用程式管控，需使用上述簽章參數或由 IT 加入允許清單。
- 使用工具時，Chrome 與 Microsoft 365 Copilot 的回應可能需要一段時間，預設逾時時間為 300 秒。
- Microsoft 365 Copilot 的網頁介面若改版，可能需要同步更新 `ask-bridge`。
