import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { google } from "googleapis";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SPREADSHEET_ID_CONTENT = process.env.SPREADSHEET_ID_CONTENT;
const SPREADSHEET_ID_BOOKING = process.env.SPREADSHEET_ID_BOOKING;

// CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  next();
});
app.use(cors({ origin: "*", methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["Content-Type", "Authorization"] }));
app.use(express.json());

// Google Sheets 認證（有設定時才使用）
let sheetsClient = null;
if (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  sheetsClient = google.sheets({ version: "v4", auth });
}

const readSheet = async (range, spreadsheetId = SPREADSHEET_ID_CONTENT) => {
  if (!sheetsClient) throw new Error("Google Sheets 未設定");
  const res = await sheetsClient.spreadsheets.values.get({ spreadsheetId, range });
  return res.data.values || [];
};

const readContentSheet = async (range) => {
  if (!SPREADSHEET_ID_CONTENT) throw new Error("SPREADSHEET_ID_CONTENT 未設定");
  return readSheet(range, SPREADSHEET_ID_CONTENT);
};

const readBookingSheet = async (range) => {
  if (!SPREADSHEET_ID_BOOKING) throw new Error("SPREADSHEET_ID_BOOKING 未設定");
  return readSheet(range, SPREADSHEET_ID_BOOKING);
};

const sheetToObjects = (rows) => {
  if (!rows || rows.length < 2) return [];
  const header = rows[0];
  return rows.slice(1).map((row) => {
    const obj = {};
    header.forEach((key, i) => (obj[key] = row[i] ?? ""));
    return obj;
  });
};

// 健康檢查
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.options("/api/*", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.status(200).end();
});

// Google Sheet：讀取課程
app.get("/api/courses", async (req, res) => {
  try {
    const raw = await readContentSheet("Course!A1:ZZ999");
    if (!raw || raw.length < 3) return res.json([]);
    const headers = raw[0];
    const dataRows = raw.slice(2);
    const rows = dataRows.map((row) => {
      const obj = {};
      headers.forEach((key, i) => (obj[key] = row[i] ?? ""));
      return obj;
    });
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "無法取得資料" });
  }
});

// Google Sheet：寫入報名
app.post("/api/booking", async (req, res) => {
  try {
    if (!SPREADSHEET_ID_BOOKING) {
      return res.status(500).json({ error: "SPREADSHEET_ID_BOOKING 未設定" });
    }
    const { sessionID, studentName, studentEmail, studentContact, studentNumber, cost, bookingNote } = req.body;
    if (!sessionID || !studentName || !studentEmail || !studentContact) {
      return res.status(400).json({ error: "缺少必要欄位", details: "請填寫：課程ID、姓名、Email、聯絡方式" });
    }
    let nextId = 1;
    try {
      const idColumn = await readBookingSheet("Booking!A:A");
      if (idColumn && idColumn.length > 1) {
        const ids = idColumn
          .slice(1)
          .map((row) => (row && row[0] ? Number(row[0]) : null))
          .filter((id) => id != null && !isNaN(id) && id > 0);
        if (ids.length > 0) nextId = Math.max(...ids) + 1;
      }
    } catch (e) {
      console.error("讀取 ID 失敗:", e);
    }
    const bookingTime = new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });
    const newRow = [
      nextId,
      sessionID,
      studentName,
      studentEmail,
      studentContact,
      studentNumber ?? 1,
      cost ?? 0,
      bookingNote ?? "",
      bookingTime,
    ];
    await sheetsClient.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID_BOOKING,
      range: "'Booking'!A:I",
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [newRow] },
    });
    res.json({ success: true, bookingID: nextId, message: "新增報名成功", bookingTime });
  } catch (err) {
    console.error("寫入失敗:", err);
    res.status(500).json({
      error: "寫入 Google Sheet 失敗",
      details: err.message || "請檢查權限與環境變數",
    });
  }
});

// Gemini 代理
app.post("/api/gemini-chat", async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.status(500).json({
      error: "Gemini API Key 未設定，請在環境變數中設定 GEMINI_API_KEY",
    });
  }
  try {
    const { contents, systemInstruction, generationConfig } = req.body;
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents,
          systemInstruction,
          generationConfig: generationConfig || { response_mime_type: "application/json" },
        }),
      }
    );
    if (!response.ok) {
      const errorText = await response.text();
      let errorData;
      try {
        errorData = JSON.parse(errorText);
      } catch {
        errorData = { message: errorText };
      }
      return res.status(response.status).json(errorData);
    }
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error("Gemini API 錯誤:", error);
    res.status(500).json({ error: "伺服器錯誤", message: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
  console.log(`Gemini API Key: ${GEMINI_API_KEY ? "已設定" : "未設定"}`);
  console.log(`Google Sheet: ${sheetsClient ? "已設定" : "未設定"}`);
});
