import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { google } from "googleapis";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// ========== 環境變數定義 ==========

const PORT = process.env.PORT || 3000;
const SHEET_ID = process.env.SHEET_ID;

// ========== 分頁名稱定義 ==========

const SheetTabName = {
  maps: "maps",
  items: "items",
  objects: "objects",
  quests: "quests",
  questList: "questList",
  logs: "logs",
};

//════════════════════════════════════════════════════════════════
// 不同環境的認證方式
//════════════════════════════════════════════════════════════════

// ========== Google Sheets 認證 ==========

function getAuth() {
  // 處理 private key 換行符號（Vercel 環境變數會把 \n 變成字串）
  const raw = process.env.GOOGLE_PRIVATE_KEY;
  const privateKey = raw
    ? raw.includes("\n")
      ? raw.trim()
      : raw.replace(/\\n/g, "\n").trim()
    : undefined;

  return new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL?.trim(),
      private_key: privateKey,
    },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

const auth = getAuth();
const sheetsClient = google.sheets({ version: "v4", auth });

// ========== 本機開發時 listen ==========

if (!process.env.VERCEL) {
  app.listen(PORT, "localhost", () => {
    console.log(`Backend running on http://localhost:${PORT}`);
  });
}

//════════════════════════════════════════════════════════════════
// 路由與 API 說明
//════════════════════════════════════════════════════════════════

// ========== 根路徑：顯示 API 說明 ==========

app.get("/", (req, res) => {
  res.json({
    message: "PocketAlchemist Backend API",
    docs: {
      health: "/api/health",
      logs: `/api/${SheetTabName.logs}`,
      maps: `/api/${SheetTabName.maps}`,
      items: `/api/${SheetTabName.items}`,
      objects: `/api/${SheetTabName.objects}`,
      quests: `/api/${SheetTabName.quests}`,
      questList: `/api/${SheetTabName.questList}`,
      upload: {
        quests: `POST /api/${SheetTabName.quests}/upload`,
        questList: `POST /api/${SheetTabName.questList}/upload`,
      },
      update: {
        quest: `PUT /api/${SheetTabName.quests}/:questId`,
      },
    },
  });
});

// ========== 健康檢查 ==========

app.get("/api/health", (req, res) => {
  res.json({ ok: true, message: "Backend running" });
});

//════════════════════════════════════════════════════════════════
// 讀取與轉換資料
//════════════════════════════════════════════════════════════════
// 實際讀取資料的程式碼層級：
// 呼叫 API app.get 
// → 管理回應 createSheetHandler 
//  → 讀取分頁資料 readSheet 
//   → 逐欄位進行型別轉換 sheetToObjects 
//    → 解析值的正確型別 parseValue
//════════════════════════════════════════════════════════════════

// ========== 自動解析值的型別 ==========
// (數字、布林、物件、陣列或原字串)
const parseValue = (value) => {
  if (value === "" || value === null || value === undefined) return "";

  const trimmed = String(value).trim();

  // 1. 純數字（整數或小數）
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }

  // 2. 布林值
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;

  // 3. 嘗試解析 JSON 或 JS 物件/陣列語法
  if (/^[\[{]/.test(trimmed)) {
    try {
      return JSON.parse(trimmed);
    } catch {
      try {
        // 處理 JS 物件語法
        const normalized = trimmed
          // 1. 先把單引號換成雙引號
          .replace(/'/g, '"')
          // 2. 只對 { 或 , 或換行後面的 key 加引號（避免誤傷 URL 的 https:）
          .replace(/(^|[{,\n]\s*)(\w+)\s*:/g, '$1"$2":')
          // 3. 移除 trailing comma
          .replace(/,(\s*[}\]])/g, "$1");
        return JSON.parse(normalized);
      } catch {
        return value;
      }
    }
  }

  return value;
};

// ========== 將 Sheet 資料逐欄位轉為正確型別 ==========
const sheetToObjects = (rows) => {
  if (!rows || rows.length < 1) return [];
  const headers = rows[0];
  return rows.slice(1).map((row) => {
    const obj = {};
    headers.forEach((key, i) => {
      obj[key] = parseValue(row[i]);
    });
    return obj;
  });
};

// ========== 針對指定分頁，讀取分頁資料 ==========
const readSheet = async (range) => {
  if (!SHEET_ID) throw new Error("SHEET_ID 未設定");
  const res = await sheetsClient.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range,
    valueRenderOption: "FORMATTED_VALUE",
  });
  return res.data.values || [];
};

// ========== 實際取得資料，並回應處理結果 ==========
const createSheetHandler = (tabName) => async (req, res) => {
  try {
    if (!SHEET_ID) {
      return res.status(500).json({ error: "SHEET_ID 未設定" });
    }
    const raw = await readSheet(`'${tabName}'!A1:Z999`);
    const rows = sheetToObjects(raw);
    res.json(rows);
  } catch (err) {
    console.error(`讀取 ${tabName} 失敗:`, err);
    res.status(500).json({ error: "無法取得資料", details: err.message });
  }
};

// ========== 為每個分頁建立對應的 GET 路由 ==========
app.get(`/api/${SheetTabName.maps}`, createSheetHandler(SheetTabName.maps));
app.get(`/api/${SheetTabName.items}`, createSheetHandler(SheetTabName.items));
app.get(`/api/${SheetTabName.objects}`, createSheetHandler(SheetTabName.objects));
app.get(`/api/${SheetTabName.quests}`, createSheetHandler(SheetTabName.quests));
app.get(`/api/${SheetTabName.questList}`, createSheetHandler(SheetTabName.questList));
app.get(`/api/${SheetTabName.logs}`, createSheetHandler(SheetTabName.logs));

//════════════════════════════════════════════════════════════════
// 寫入資料（覆寫上傳）
//════════════════════════════════════════════════════════════════

// ========== 清空分頁再整批寫入（覆蓋，非 append）==========
const overwriteSheet = async (tabName, headers, rows) => {
  if (!SHEET_ID) throw new Error("SHEET_ID 未設定");

  // 1. 清空分頁所有內容
  await sheetsClient.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID,
    range: `'${tabName}'!A:Z`,
  });

  // 2. 寫入 header + 所有資料列
  await sheetsClient.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `'${tabName}'!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [headers, ...rows],
    },
  });
};

// ========== 通用批次上傳路由工廠 ==========
// 接收 { headers: string[], rows: string[][] }，覆寫指定分頁
const createUploadHandler = (tabName) => async (req, res) => {
  try {
    if (!SHEET_ID) {
      return res.status(500).json({ error: "SHEET_ID 未設定" });
    }
    const { headers, rows } = req.body;
    if (!Array.isArray(headers) || !Array.isArray(rows)) {
      return res.status(400).json({ error: "headers 和 rows 必須是陣列" });
    }
    await overwriteSheet(tabName, headers, rows);
    res.json({
      success: true,
      message: `已寫入 ${rows.length} 列到「${tabName}」`,
      count: rows.length,
    });
  } catch (err) {
    console.error(`寫入 ${tabName} 失敗:`, err);
    res.status(500).json({ error: "寫入失敗", details: err.message });
  }
};

// ========== 上傳路由 ==========
app.post(`/api/${SheetTabName.quests}/upload`, createUploadHandler(SheetTabName.quests));
app.post(`/api/${SheetTabName.questList}/upload`, createUploadHandler(SheetTabName.questList));

// ========== 序列化單一欄位值（用於寫回 Sheet）==========
const serializeSheetValue = (value) => {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
};

// ========== PUT /api/quests/:questId — 更新單筆任務 ==========
app.put(`/api/${SheetTabName.quests}/:questId`, async (req, res) => {
  try {
    if (!SHEET_ID) return res.status(500).json({ error: "SHEET_ID 未設定" });

    const { questId } = req.params;
    const questData = req.body;

    // 1. 讀取目前 sheet（取得表頭與所有資料列）
    const raw = await readSheet(`'${SheetTabName.quests}'!A1:Z999`);
    if (!raw || raw.length < 2) {
      return res.status(404).json({ error: "quests 分頁沒有資料" });
    }

    const headers = raw[0];
    const dataRows = raw.slice(1);

    // 2. 找到目標列的位置（依 id 欄比對）
    const idColIndex = headers.indexOf("id");
    if (idColIndex === -1) {
      return res.status(500).json({ error: "quests 分頁找不到 id 欄位" });
    }

    const rowIndex = dataRows.findIndex((row) => row[idColIndex] === questId);
    if (rowIndex === -1) {
      return res.status(404).json({ error: `找不到任務 ID：${questId}` });
    }

    // 3. 依表頭順序序列化 questData → 列陣列
    const newRow = headers.map((h) => serializeSheetValue(questData[h]));

    // 4. 更新指定列（sheet 第 1 列是表頭，資料從第 2 列起，故 rowIndex + 2）
    const sheetRowNumber = rowIndex + 2;
    await sheetsClient.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `'${SheetTabName.quests}'!A${sheetRowNumber}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [newRow] },
    });

    res.json({ success: true, message: `任務 ${questId} 已更新`, questId });
  } catch (err) {
    console.error("更新任務失敗:", err);
    res.status(500).json({ error: "更新失敗", details: err.message });
  }
});


//════════════════════════════════════════════════════════════════
// 遊戲測試回饋（log 分頁）
//════════════════════════════════════════════════════════════════


// ========== 取得當前時間字串（台灣時區）==========（還沒實際開發）
const nowString = () =>
  new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });


export default app;


//════════════════════════════════════════════════════════════════
// 以下暫存，待實際開發時再移除
//════════════════════════════════════════════════════════════════

/*
// POST /api/feedback — 提交一筆回饋（回報時間由後端產生；依 專案 寫入對應分頁）
app.post("/api/feedback", async (req, res) => {
  try {
    if (!SHEET_ID) {
      return res.status(500).json({ error: "SHEET_ID 未設定" });
    }
    const { 專案, 回報類型, 回報區塊, 回報內容, 開發版本號 } = req.body;
    const sheetName = toSheetTabName(專案);
    const feedback = {
      回報時間: nowString(),
      回報類型: String(回報類型 ?? ""),
      回報區塊: String(回報區塊 ?? ""),
      回報內容: String(回報內容 ?? ""),
      開發版本號: String(開發版本號 ?? ""),
    };
    const row = feedbackToRow(feedback);
    await appendFeedbackToSheet(row, sheetName);
    res.json({ success: true, message: `回饋已寫入分頁「${sheetName}」`, data: feedback });
  } catch (err) {
    console.error("寫入回饋失敗:", err);
    res.status(500).json({
      error: "寫入分頁失敗",
      details: err.message || "請確認試算表已有該分頁並已共用給服務帳號",
    });
  }
});
*/

/*
// 若指定分頁第一列為空，先寫入標題列 
const ensureHeader = async (sheetName) => {
  const tab = toSheetTabName(sheetName);
  const existing = await sheetsClient.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${tab}'!A1:E1`,
  });
  const rows = existing.data.values || [];
  if (rows.length === 0 || !rows[0] || !rows[0][0]) {
    await sheetsClient.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `'${tab}'!A1:E1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [FEEDBACK_HEADERS] },
    });
  }
};

// 寫入一筆回饋到指定分頁（必要時先寫入標題） 
const appendFeedbackToSheet = async (row, sheetName = "theDev") => {
  const tab = toSheetTabName(sheetName);
  await ensureHeader(tab);
  await sheetsClient.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `'${tab}'!A:E`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });
};

// 產生一筆模擬遊戲測試回饋 
const createMockFeedback = () => {
  const mockContents = [
    "進入選單時偶發閃退",
    "按鈕點擊反饋不明顯，建議加強動效",
    "完成關卡 3 後成就未解鎖",
    "設定頁面載入較慢",
    "戰鬥中技能冷卻數字不清楚",
  ];
  return {
    回報時間: nowString(),
    回報類型: REPORT_TYPES[Math.floor(Math.random() * REPORT_TYPES.length)],
    回報區塊: REPORT_BLOCKS[Math.floor(Math.random() * REPORT_BLOCKS.length)],
    回報內容:
      mockContents[Math.floor(Math.random() * mockContents.length)],
    開發版本號: "v0.1.0",
  };
};

// 回饋物件轉成 Sheet 一列（順序與 FEEDBACK_HEADERS 一致） 
const feedbackToRow = (fb) => [
  fb.回報時間,
  String(fb.回報類型 ?? ""),
  String(fb.回報區塊 ?? ""),
  String(fb.回報內容 ?? ""),
  String(fb.開發版本號 ?? ""),
];

// 寫入一筆模擬回饋的共用邏輯（固定寫入 theDev 分頁）
async function handleMockFeedback(req, res) {
  try {
    if (!SHEET_ID) {
      return res.status(500).json({ error: "SHEET_ID 未設定" });
    }
    const mock = createMockFeedback();
    const row = feedbackToRow(mock);
    await appendFeedbackToSheet(row, "theDev");
    res.json({ success: true, message: "已寫入模擬回饋到 theDev 分頁", data: mock });
  } catch (err) {
    console.error("寫入模擬回饋失敗:", err);
    res.status(500).json({
      error: "寫入 theDev 分頁失敗",
      details: err.message || "請確認試算表已有「theDev」分頁並已共用給服務帳號",
    });
  }
}

// GET /api/feedback/mock — 瀏覽器開網址即可寫入一筆模擬回饋
app.get("/api/feedback/mock", handleMockFeedback);
// POST /api/feedback/mock
app.post("/api/feedback/mock", handleMockFeedback);
*/



