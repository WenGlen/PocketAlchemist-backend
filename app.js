import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { google } from "googleapis";
import fs from "fs";
import path from "path";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const SHEET_ID = process.env.SHEET_ID;

// Google Sheets 認證（優先從金鑰 JSON 檔讀取，私鑰格式才不會出錯）
const KEY_FILE = process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.GOOGLE_KEY_FILE;

function getAuth() {
  if (KEY_FILE) {
    const keyPath = path.isAbsolute(KEY_FILE) ? KEY_FILE : path.resolve(process.cwd(), KEY_FILE);
    if (!fs.existsSync(keyPath)) {
      throw new Error(`金鑰檔案不存在: ${keyPath}`);
    }
    const keyJson = JSON.parse(fs.readFileSync(keyPath, "utf8"));
    return new google.auth.GoogleAuth({
      credentials: {
        client_email: keyJson.client_email,
        private_key: keyJson.private_key,
      },
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
  }
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

// 讀取分頁（同一份試算表內不同工作表，如 Course、Booking）
const readSheet = async (range) => {
  if (!SHEET_ID) throw new Error("SHEET_ID 未設定");
  const res = await sheetsClient.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range,
  });
  return res.data.values || [];
};


// 根路徑：顯示 API 說明
app.get("/", (req, res) => {
  res.json({
    message: "PocketAlchemist Backend API",
    docs: {
      health: "/api/health",
      maps: `/api/${SheetTabName.maps}`,
      items: `/api/${SheetTabName.items}`,
      objects: `/api/${SheetTabName.objects}`,
      quests: `/api/${SheetTabName.quests}`,
      logs: `/api/${SheetTabName.logs}`,
    },
  });
});


// ========== 取得資料 ==========
const SheetTabName = {
  maps: "maps",
  items: "items",
  objects: "objects",
  quests: "quests",
  logs: "logs",
};

// GET /api/分頁名稱 — 讀取分頁資料
app.get(`/api/${SheetTabName.maps}`, async (req, res) => {
  try {
    if (!SHEET_ID) {
      return res.status(500).json({ error: "SHEET_ID 未設定" });
    }
    const raw = await readSheet(`'${SheetTabName.maps}'!A1:E999`);
    if (!raw || raw.length < 1) return res.json([]);
    const headers = raw[0];
    const rows = raw.slice(1).map((row) => {
      const obj = {};
      headers.forEach((key, i) => (obj[key] = row[i] ?? ""));
      return obj;
    });
    res.json(rows);
  } catch (err) {
    console.error("讀取失敗:", err);
    res.status(500).json({ error: "無法取得資料", details: err.message });
  }
});

// ========== 寫入資料 ==========
// 將 Sheet 列 → 物件陣列
const sheetToObjects = (rows) => {
  if (!rows || rows.length < 2) return [];
  const header = rows[0];
  return rows.slice(1).map((row) => {
    const obj = {};
    header.forEach((key, i) => (obj[key] = row[i] ?? ""));
    return obj;
  });
};

// ========== 遊戲測試回饋（log 分頁）==========
/** 取得當前時間字串（台灣時區） */
const nowString = () =>
  new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });

// 健康檢查
app.get("/api/health", (req, res) => {
  res.json({ ok: true, message: "Backend running" });
});

// 僅在本機開發時 listen
// Vercel 會直接使用 export default app
if (!process.env.VERCEL) {
  app.listen(PORT, "localhost", () => {
    console.log(`Backend running on http://localhost:${PORT}`);
  });
}

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




export default app;
