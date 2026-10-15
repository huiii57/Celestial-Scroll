'use strict';
/**
 * GET /api/month?year=2026&month=10
 *
 * 回傳該月份「有寫日記的日子」清單（星圖月曆用）。
 * 每筆只含簡化後的屬性（日期、聊天/學習/運動勾選、飲料、TAG…），不含頁面內容，所以很快。
 */
const { notion, DATABASE_ID, PROP, HttpError, send, fail, guard, toEntry } = require('./_lib');

const pad = (n) => String(n).padStart(2, '0');

module.exports = async (req, res) => {
  if (!(await guard(req, res, ['GET']))) return;

  try {
    const year = parseInt(req.query.year, 10);
    const month = parseInt(req.query.month, 10);
    if (!(year >= 2000 && year <= 2100 && month >= 1 && month <= 12)) {
      throw new HttpError(400, 'bad_month');
    }

    // 查詢範圍：本月 1 號（含）～下個月 1 號（不含）
    const first = `${year}-${pad(month)}-01`;
    const nextYear = month === 12 ? year + 1 : year;
    const nextMonth = month === 12 ? 1 : month + 1;
    const next = `${nextYear}-${pad(nextMonth)}-01`;

    const entries = [];
    let cursor;
    do {
      const r = await notion.databases.query({
        database_id: DATABASE_ID,
        filter: {
          and: [
            { property: PROP.date, date: { on_or_after: first } },
            { property: PROP.date, date: { before: next } },
          ],
        },
        sorts: [{ property: PROP.date, direction: 'ascending' }],
        start_cursor: cursor,
        page_size: 100,
      });
      entries.push(...r.results.map(toEntry));
      cursor = r.has_more ? r.next_cursor : undefined;
    } while (cursor);

    send(res, 200, { year, month, entries });
  } catch (err) {
    fail(res, err);
  }
};
