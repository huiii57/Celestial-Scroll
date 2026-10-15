'use strict';
/**
 * api/_lib.js —— 後端共用工具（檔名開頭的底線＝Vercel 不會把它當成 API 端點）
 *
 * 這個檔案負責三件事：
 *   1. 以環境變數中的 Notion 金鑰建立連線（金鑰只存在伺服器，絕不會送到瀏覽器）
 *   2. 驗證「這支手機是不是我的」（ACCESS_KEY 裝置金鑰）
 *   3. 提供讀取 / 轉換 Notion 資料的小工具，並確保只能碰到「星辰卷軸」資料庫裡的頁面
 *
 * 需要的環境變數（在 Vercel 後台設定，見 README）：
 *   NOTION_TOKEN        Notion Integration 的 Internal Integration Secret
 *   NOTION_DATABASE_ID  「星辰卷軸」資料庫的 32 碼 ID
 *   ACCESS_KEY          你自己產生的一串長亂碼（裝置金鑰）
 *   ALLOW_OPEN_ACCESS   （選用，不建議）設成 yes 才允許不設 ACCESS_KEY 運作
 */

const crypto = require('crypto');
const { Client } = require('@notionhq/client');

/* ------------------------------------------------------------------ *
 * 基本設定
 * ------------------------------------------------------------------ */

/** Notion 的 ID 有時有 - 有時沒有，統一成「32 碼小寫、無橫線」方便比對 */
function normalizeId(id) {
  return String(id || '').replace(/-/g, '').toLowerCase();
}

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DATABASE_ID = normalizeId(process.env.NOTION_DATABASE_ID);

/**
 * 資料庫「屬性名稱」對照表。
 * ⚠ 這裡的中文必須和你 Notion 資料庫的屬性名稱「一字不差」。
 *   如果你日後改了屬性名，只要改這裡。
 */
const PROP = {
  date: '日期',
  archive: '典藏',
  chat: '聊天',
  study: '學習',
  sport: '運動',
  drink: '飲料',
  tag: 'TAG',
};

/** 兩個「選取」屬性的合法選項（後端會檢查，避免亂寫入新選項） */
const DRINK_OPTIONS = ['無糖', '沒喝', '含糖'];
const TAG_OPTIONS = ['價值觀', '想法', '心情'];

/** 允許從 App 修改文字內容的 block 類型 */
const EDITABLE_TYPES = new Set([
  'paragraph', 'heading_1', 'heading_2', 'heading_3',
  'bulleted_list_item', 'numbered_list_item', 'to_do',
  'quote', 'callout', 'toggle',
]);

/* ------------------------------------------------------------------ *
 * 錯誤與回應
 * ------------------------------------------------------------------ */

/** 我們自己丟出的、可以安全回報給前端的錯誤 */
class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function send(res, status, body) {
  res.status(status).json(body);
}

/**
 * 統一的錯誤出口。
 * 原則：對前端只回「簡短代碼」，詳細原因只寫進伺服器日誌（Vercel Logs），
 *       避免把 Notion 的內部訊息或 ID 洩漏出去。
 */
function fail(res, err) {
  if (err instanceof HttpError) return send(res, err.status, { error: err.code });

  const status = err && err.status;
  console.error('[notion]', err && err.code, status, err && err.message);

  if (status === 404 || (err && err.code === 'object_not_found')) {
    return send(res, 404, { error: 'not_found' });
  }
  if (status === 429) return send(res, 429, { error: 'rate_limited' });
  // 注意：Notion 回 401（金鑰錯誤）時，我們刻意回 502，
  // 因為前端看到 401 會以為是「裝置金鑰不對」而跳出配對畫面。
  return send(res, 502, { error: 'upstream_error' });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * 存取控制
 * ------------------------------------------------------------------ */

/** 以固定時間比較金鑰（避免被「計時攻擊」一個字一個字猜出來） */
function checkAccessKey(req) {
  const expected = process.env.ACCESS_KEY || '';
  if (!expected) {
    // 沒設 ACCESS_KEY：預設「關門」。除非你明確寫了 ALLOW_OPEN_ACCESS=yes
    return process.env.ALLOW_OPEN_ACCESS === 'yes';
  }
  const given = String(req.headers['x-access-key'] || '');
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * 每支 API 的第一道關卡：檢查 HTTP 方法、伺服器設定、裝置金鑰。
 * 通過回傳 true；沒通過會自己回應，並回傳 false（呼叫端直接 return）。
 */
async function guard(req, res, allowedMethods) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (!allowedMethods.includes(req.method)) {
    res.setHeader('Allow', allowedMethods.join(', '));
    send(res, 405, { error: 'method_not_allowed' });
    return false;
  }
  if (!process.env.NOTION_TOKEN || !/^[0-9a-f]{32}$/.test(DATABASE_ID)) {
    send(res, 500, { error: 'server_not_configured' });
    return false;
  }
  if (!checkAccessKey(req)) {
    await sleep(400); // 小小延遲，讓暴力猜測變慢
    send(res, 401, { error: 'unauthorized' });
    return false;
  }
  return true;
}

/** 讀取並檢查 JSON 請求內容 */
function readBody(req) {
  let b = req.body;
  if (typeof b === 'string') {
    try { b = JSON.parse(b); } catch { b = null; }
  }
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'bad_body');
  return b;
}

/* ------------------------------------------------------------------ *
 * Notion 資料讀取
 * ------------------------------------------------------------------ */

/**
 * 取得「這個資料庫的標題欄」名稱。
 * 每個 Notion 資料庫一定有一個標題欄（常叫「名稱」或 Name），
 * 你的屬性清單沒列出它，所以這裡自動偵測，建立新日記時才知道要把標題寫到哪。
 */
let titlePropName = null;
async function getTitlePropName() {
  if (titlePropName) return titlePropName;
  const db = await notion.databases.retrieve({ database_id: DATABASE_ID });
  for (const [name, def] of Object.entries(db.properties)) {
    if (def.type === 'title') { titlePropName = name; break; }
  }
  if (!titlePropName) throw new HttpError(500, 'no_title_property');
  return titlePropName;
}

/**
 * 取得一篇日記頁面，並【確認它真的屬於星辰卷軸資料庫】。
 * 這是重要的安全措施：即使 Integration 還連到你其他 Notion 頁面，
 * 這個 App 也無法被拿來讀寫那些頁面。
 */
async function loadEntryPage(id) {
  const pid = normalizeId(id);
  if (!/^[0-9a-f]{32}$/.test(pid)) throw new HttpError(400, 'bad_id');
  const page = await notion.pages.retrieve({ page_id: pid });
  const parentDb =
    page.parent && page.parent.type === 'database_id' ? normalizeId(page.parent.database_id) : null;
  if (parentDb !== DATABASE_ID || page.archived) throw new HttpError(404, 'not_found');
  return page;
}

/** 把 Notion 的 page 物件簡化成前端要用的欄位 */
function toEntry(page) {
  const p = page.properties || {};
  const start = p[PROP.date] && p[PROP.date].date && p[PROP.date].date.start;
  return {
    id: page.id,
    date: start ? start.slice(0, 10) : null,
    archive: !!(p[PROP.archive] && p[PROP.archive].checkbox),
    chat: !!(p[PROP.chat] && p[PROP.chat].checkbox),
    study: !!(p[PROP.study] && p[PROP.study].checkbox),
    sport: !!(p[PROP.sport] && p[PROP.sport].checkbox),
    drink: (p[PROP.drink] && p[PROP.drink].select && p[PROP.drink].select.name) || null,
        tag: (p[PROP.tag] && p[PROP.tag].multi_select && p[PROP.tag].multi_select[0] && p[PROP.tag].multi_select[0].name) || null,
    createdTime: page.created_time,
  };
}

/**
 * 遞迴讀取頁面所有內容。
 * Notion 的 blocks API 一次只回一層，toggle（摺疊）、縮排清單的內容
 * 要看 has_children 再往下挖，這就是「原汁原樣」的關鍵。
 * 挖到的子內容放在 block.children。
 */
async function getAllBlocks(blockId, depth = 0) {
  const list = [];
  let cursor;
  do {
    const r = await notion.blocks.children.list({
      block_id: blockId,
      start_cursor: cursor,
      page_size: 100,
    });
    list.push(...r.results);
    cursor = r.has_more ? r.next_cursor : undefined;
  } while (cursor);

  if (depth < 4) {
    const withKids = list.filter(
      (b) => b.has_children && b.type !== 'child_page' && b.type !== 'child_database'
    );
    await Promise.all(
      withKids.map(async (b) => {
        b.children = await getAllBlocks(b.id, depth + 1);
      })
    );
  }
  return list;
}

/** 把巢狀的 block 樹攤平成 Map（id → block），用來檢查「這個 block 真的在這頁裡」 */
function flattenBlocks(blocks, out = new Map()) {
  for (const b of blocks) {
    out.set(normalizeId(b.id), b);
    if (b.children) flattenBlocks(b.children, out);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 建立 / 寫入用的小工具
 * ------------------------------------------------------------------ */

/** 檢查 YYYY-MM-DD 是否為真實存在的日期（擋掉 2026-02-31 這種） */
function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** 新頁面的標題，例如「2026-10-15 週四」 */
function titleFor(date) {
  const w = ['日', '一', '二', '三', '四', '五', '六'][new Date(date + 'T00:00:00Z').getUTCDay()];
  return `${date} 週${w}`;
}

/**
 * 文字 → Notion rich_text。
 * Notion 規定單一段文字最多 2000 字元，所以長文要切段。
 * annotations 用來保留原本的粗體 / 顏色等樣式（編輯舊內容時沿用）。
 */
function toRichText(text, annotations) {
  const out = [];
  for (let i = 0; i < text.length; i += 2000) {
    const item = { type: 'text', text: { content: text.slice(i, i + 2000) } };
    if (annotations) item.annotations = annotations;
    out.push(item);
  }
  return out;
}

function paragraphBlock(text) {
  return { object: 'block', type: 'paragraph', paragraph: { rich_text: toRichText(text) } };
}

/**
 * 每天新建日記時自動帶入的頁面模板。
 * 想改排版就改這裡（標題2粗體、各項目、感恩三件事的數字清單、討論區）。
 */
function templateBlocks() {
  const h2 = (s) => ({
    object: 'block',
    type: 'heading_2',
    heading_2: {
      rich_text: [{ type: 'text', text: { content: s }, annotations: { bold: true } }],
    },
  });
  const h3 = (s) => ({
    object: 'block',
    type: 'heading_3',
    heading_3: { rich_text: [{ type: 'text', text: { content: s } }] },
  });
  const item = () => ({
    object: 'block',
    type: 'numbered_list_item',
    numbered_list_item: { rich_text: [] },
  });

  return [
    h2('紀錄'),
    paragraphBlock('聊天：'),
    paragraphBlock('學習：'),
    paragraphBlock('運動：'),
    paragraphBlock('飲料：'),
    h2('日記'),
    h3('今天感恩的三件事'),
    item(),
    item(),
    item(),
    h2('討論'),
    paragraphBlock(''), // 留一行空白，打開就能直接寫
  ];
}

module.exports = {
  notion, DATABASE_ID, PROP, DRINK_OPTIONS, TAG_OPTIONS, EDITABLE_TYPES,
  HttpError, send, fail, guard, readBody, normalizeId,
  getTitlePropName, loadEntryPage, toEntry, getAllBlocks, flattenBlocks,
  isValidDate, titleFor, toRichText, paragraphBlock, templateBlocks,
};
