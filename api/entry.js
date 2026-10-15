'use strict';
/**
 * /api/entry —— 單篇日記的讀取、建立、儲存
 *
 *   GET   /api/entry?id=<pageId>
 *         讀取一篇日記：屬性 + 完整內容（含 toggle 裡面的巢狀內容）
 *
 *   POST  /api/entry   { "date": "2026-10-15" }
 *         建立那天的日記並帶入模板。如果那天已經有了，就回傳既有的（不會重複建立）
 *
 *   PATCH /api/entry   { "id": "...",
 *                        "props":  { "chat": true, "drink": "無糖", "tag": null, ... },
 *                        "blocks": [ { "id": "<blockId>", "text": "新的文字" } ],
 *                        "append": [ "要新增在最後面的段落", ... ] }
 *         三個欄位都是選填，可以一次送，也可以只送其中一個
 */
const {
  notion, DATABASE_ID, PROP, DRINK_OPTIONS, TAG_OPTIONS, EDITABLE_TYPES,
  HttpError, send, fail, guard, readBody, normalizeId,
  getTitlePropName, loadEntryPage, toEntry, getAllBlocks, flattenBlocks,
  isValidDate, titleFor, toRichText, paragraphBlock, templateBlocks,
} = require('./_lib');

module.exports = async (req, res) => {
  if (!(await guard(req, res, ['GET', 'POST', 'PATCH']))) return;
  try {
    if (req.method === 'GET') return await handleGet(req, res);
    if (req.method === 'POST') return await handleCreate(req, res);
    return await handleUpdate(req, res);
  } catch (err) {
    fail(res, err);
  }
};

/* ------------------------------ 讀取 ------------------------------ */
async function handleGet(req, res) {
  const page = await loadEntryPage(String(req.query.id || ''));
  const blocks = await getAllBlocks(page.id);
  send(res, 200, { entry: toEntry(page), blocks });
}

/* ------------------------------ 建立 ------------------------------ */
async function handleCreate(req, res) {
  const { date } = readBody(req);
  if (!isValidDate(date)) throw new HttpError(400, 'bad_date');

  // 先查那天是不是已經有日記（避免連點兩下產生兩篇）
  const found = await notion.databases.query({
    database_id: DATABASE_ID,
    filter: { property: PROP.date, date: { equals: date } },
    sorts: [{ timestamp: 'created_time', direction: 'ascending' }],
    page_size: 1,
  });
  if (found.results.length) {
    return send(res, 200, { entry: toEntry(found.results[0]), created: false });
  }

  // 沒有 → 建立新頁面：標題、日期屬性、頁面模板
  // 「建立時間」屬性是 Notion 自動產生的，不需要（也不能）自己填
  const titleProp = await getTitlePropName();
  const page = await notion.pages.create({
    parent: { database_id: DATABASE_ID },
    properties: {
      [titleProp]: { title: [{ type: 'text', text: { content: titleFor(date) } }] },
      [PROP.date]: { date: { start: date } },
    },
    children: templateBlocks(),
  });
  send(res, 200, { entry: toEntry(page), created: true });
}

/* ------------------------------ 儲存 ------------------------------ */
async function handleUpdate(req, res) {
  const body = readBody(req);
  const page = await loadEntryPage(String(body.id || '')); // 同時確認這頁屬於星辰卷軸

  /* 1) 屬性（勾選框、飲料、TAG）—— 逐項檢查再寫入 */
  if (body.props !== undefined) {
    const props = body.props;
    if (!props || typeof props !== 'object' || Array.isArray(props)) throw new HttpError(400, 'bad_props');
    const properties = {};

    for (const key of ['archive', 'chat', 'study', 'sport']) {
      if (key in props) {
        if (typeof props[key] !== 'boolean') throw new HttpError(400, 'bad_props');
        properties[PROP[key]] = { checkbox: props[key] };
      }
    }
    const selects = [['drink', DRINK_OPTIONS], ['tag', TAG_OPTIONS]];
    for (const [key, options] of selects) {
      if (key in props) {
        const v = props[key];
        if (v !== null && !options.includes(v)) throw new HttpError(400, 'bad_props');
        properties[PROP[key]] = { select: v === null ? null : { name: v } };
      }
    }
    if (Object.keys(properties).length) {
      await notion.pages.update({ page_id: page.id, properties });
    }
  }

  /* 2) 修改既有段落的文字 */
  if (body.blocks !== undefined) {
    const edits = body.blocks;
    if (!Array.isArray(edits) || edits.length > 100) throw new HttpError(400, 'bad_blocks');

    if (edits.length) {
      // 重新讀一次這頁的 block 樹，只允許修改「確實在這頁裡」且「類型允許」的 block
      const tree = flattenBlocks(await getAllBlocks(page.id));

      for (const e of edits) {
        if (!e || typeof e.id !== 'string' || typeof e.text !== 'string' || e.text.length > 20000) {
          throw new HttpError(400, 'bad_blocks');
        }
        const block = tree.get(normalizeId(e.id));
        if (!block || !EDITABLE_TYPES.has(block.type)) throw new HttpError(400, 'bad_blocks');

        // 沿用原本第一段文字的樣式（例如標題的粗體、顏色），其餘樣式會被統一
        const original = block[block.type].rich_text || [];
        const annotations = original[0] ? original[0].annotations : undefined;

        // 一個一個依序更新（Notion 有每秒請求次數限制，不要同時轟炸）
        await notion.blocks.update({
          block_id: block.id,
          [block.type]: { rich_text: toRichText(e.text, annotations) },
        });
      }
    }
  }

  /* 3) 在頁面最後面新增段落 */
  if (body.append !== undefined) {
    const items = body.append;
    if (!Array.isArray(items) || items.length > 20) throw new HttpError(400, 'bad_append');
    for (const t of items) {
      if (typeof t !== 'string' || t.length > 20000) throw new HttpError(400, 'bad_append');
    }
    if (items.length) {
      await notion.blocks.children.append({
        block_id: page.id,
        children: items.map(paragraphBlock),
      });
    }
  }

  send(res, 200, { ok: true });
}
