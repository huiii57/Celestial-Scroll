/* =====================================================================
   星辰卷軸 —— 前端程式
   純原生 JavaScript，不需要打包。所有資料都透過我們自己的 /api/* 取得，
   瀏覽器裡完全看不到 Notion 金鑰。

   檔案結構：
     1. 常數與小工具
     2. 呼叫後端（api）與裝置金鑰
     3. 星圖月曆
     4. 日記頁：Notion 內容 → 畫面
     5. 日記頁：書寫、自動儲存、翻頁
     6. 配對畫面、初始化
   ===================================================================== */
(() => {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 1. 常數與小工具
   * ------------------------------------------------------------------ */
  const KEY_STORE = 'starScroll.accessKey'; // 裝置金鑰存在這支手機的 localStorage
  const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
  const MONTH_ZH = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];
  const DRINKS = ['無糖', '沒喝', '含糖'];
  const TAGS = ['價值觀', '想法', '心情'];
  // 可以在 App 內改文字的 block 類型（要和後端 EDITABLE_TYPES 一致）
  const EDITABLE = new Set([
    'paragraph', 'heading_1', 'heading_2', 'heading_3', 'bulleted_list_item',
    'numbered_list_item', 'to_do', 'quote', 'callout', 'toggle',
  ]);

  const $ = (sel) => document.querySelector(sel);
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const monthKey = (y, m) => `${y}-${pad(m)}`;

  /** 建立元素的小幫手（一律用 textContent，不用 innerHTML，避免任何注入風險） */
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  const now = new Date();
  const state = {
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    months: new Map(),     // 'YYYY-MM' → 該月份的日記清單（快取）
    entry: null,           // 目前打開的日記（屬性）
    blocks: [],            // 目前日記的 Notion block 樹
    editing: false,        // 書寫模式？
    saved: new Map(),      // blockId → 已存到 Notion 的文字
    dirty: new Map(),      // blockId → 還沒存的新文字
    open: new Set(),       // 目前展開的 toggle
    sheetDate: null,
  };

  /* ---------- 畫面切換 / 提示 ---------- */
  function showView(name) {
    for (const v of ['calendar', 'entry', 'pair']) $('#view-' + v).hidden = v !== name;
    window.scrollTo(0, 0);
  }

  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }

  /* ------------------------------------------------------------------ *
   * 2. 呼叫後端與裝置金鑰
   * ------------------------------------------------------------------ */
  class ApiError extends Error {
    constructor(code, status) { super(code); this.code = code; this.status = status; }
  }

  /**
   * 呼叫 /api/xxx。自動帶上這支手機的裝置金鑰。
   *  · 401 → 金鑰沒設定或不對 → 顯示配對畫面
   *  · 網路不通 → 丟出 code 為 'offline' 的錯誤
   */
  async function api(path, { method = 'GET', body } = {}) {
    const headers = {};
    let key = null;
    try { key = localStorage.getItem(KEY_STORE); } catch { /* 隱私模式等情況 */ }
    if (key) headers['x-access-key'] = key;
    if (body) headers['content-type'] = 'application/json';

    let res;
    try {
      res = await fetch('/api/' + path, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        keepalive: method !== 'GET', // 讓「切到背景那一刻」的儲存也有機會送出
      });
    } catch {
      throw new ApiError('offline', 0);
    }
    if (res.status === 401) {
      showView('pair');
      throw new ApiError('unauthorized', 401);
    }
    let data = null;
    try { data = await res.json(); } catch { /* 沒有內容 */ }
    if (!res.ok) throw new ApiError((data && data.error) || 'error', res.status);
    return data;
  }

  /** 若網址帶有 #key=xxxx（Android 方便的一鍵配對），存起來並把網址清乾淨 */
  function grabKeyFromHash() {
    const m = location.hash.match(/[#&]key=([^&]+)/);
    if (!m) return;
    try { localStorage.setItem(KEY_STORE, decodeURIComponent(m[1])); } catch { /* ignore */ }
    history.replaceState(null, '', location.pathname + location.search);
  }

  /* ------------------------------------------------------------------ *
   * 3. 星圖月曆
   * ------------------------------------------------------------------ */
  async function loadMonth(y, m, force = false) {
    const k = monthKey(y, m);
    if (!force && state.months.has(k)) return state.months.get(k);
    const data = await api(`month?year=${y}&month=${m}`);
    state.months.set(k, data.entries);
    return data.entries;
  }

  /** 顯示首頁：先用快取立刻畫出來，再向 Notion 要最新的 */
  async function showCalendar() {
    showView('calendar');
    renderCalendar();
    try {
      await loadMonth(state.year, state.month, true);
      renderCalendar();
    } catch (e) {
      if (e.code === 'unauthorized') return;
      $('#cal-summary').textContent =
        e.code === 'offline' ? '目前離線，顯示上次看到的星圖' : '讀取失敗，請稍後再試';
    }
  }

  function renderCalendar() {
    const { year, month } = state;
    const k = monthKey(year, month);
    const loaded = state.months.has(k);
    const entries = state.months.get(k) || [];
    const byDate = new Map();
    for (const e of entries) if (e.date && !byDate.has(e.date)) byDate.set(e.date, e); // 同一天多篇只取第一篇

    $('#cal-month').textContent = MONTH_ZH[month - 1];
    $('#cal-year').textContent = String(year);

    const grid = $('#cal-grid');
    grid.replaceChildren();
    const today = ymd(new Date());
    const firstWeekday = new Date(year, month - 1, 1).getDay();
    const daysInMonth = new Date(year, month, 0).getDate();

    for (let i = 0; i < firstWeekday; i++) grid.append(el('div', 'day-blank'));

    let litCount = 0;
    for (let d = 1; d <= daysInMonth; d++) {
      const date = `${year}-${pad(month)}-${pad(d)}`;
      const entry = byDate.get(date);
      const btn = el('button', 'day');
      btn.type = 'button';
      btn.dataset.date = date;
      btn.append(el('span', 'num', String(d)));
      if (date === today) btn.classList.add('today');
      if (date > today) btn.classList.add('future');
      if (entry) {
        litCount++;
        btn.classList.add('lit');
        const dots = el('span', 'dots');
        for (const k2 of ['chat', 'study', 'sport']) dots.append(el('i', 'dot' + (entry[k2] ? ' on' : '')));
        btn.append(dots);
        btn.dataset.id = entry.id;
      }
      btn.setAttribute('aria-label', `${month}月${d}日 ${entry ? '已寫' : '還沒寫'}`);
      grid.append(btn);
    }

    // 本月統計：到今天為止應有幾天
    let denom = daysInMonth;
    const thisMonth = monthKey(now.getFullYear(), now.getMonth() + 1);
    if (k === thisMonth) denom = now.getDate();
    else if (k > thisMonth) denom = 0;
    $('#cal-summary').textContent = !loaded
      ? '星圖載入中…'
      : denom === 0 ? '還沒到的月份' : `本月點亮 ${litCount} / ${denom} 天`;

    requestAnimationFrame(drawConstellation);
  }

  /** 連續幾天都有寫、且在同一週（同一列）→ 用金線串起來，像星座 */
  function drawConstellation() {
    const svg = $('#constellation');
    if (!svg) return;
    svg.replaceChildren();
    const wrap = svg.parentElement.getBoundingClientRect();
    if (!wrap.width) return;
    svg.setAttribute('viewBox', `0 0 ${wrap.width} ${wrap.height}`);

    const lit = [...document.querySelectorAll('#cal-grid .day.lit')].map((b) => {
      const r = b.getBoundingClientRect();
      return { date: b.dataset.date, x: r.left - wrap.left + r.width / 2, y: r.top - wrap.top + r.height / 2 };
    });
    for (let i = 0; i < lit.length - 1; i++) {
      const a = lit[i], b = lit[i + 1];
      const consecutive = (new Date(b.date) - new Date(a.date)) / 86400000 === 1;
      if (!consecutive || Math.abs(a.y - b.y) > 2) continue;
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('class', 'link');
      line.setAttribute('x1', a.x); line.setAttribute('y1', a.y);
      line.setAttribute('x2', b.x); line.setAttribute('y2', b.y);
      svg.append(line);
    }
  }

  function changeMonth(delta) {
    let m = state.month + delta, y = state.year;
    if (m < 1) { m = 12; y--; }
    if (m > 12) { m = 1; y++; }
    state.year = y; state.month = m;
    showCalendar();
  }

  /** 點日期：寫過 → 直接打開；沒寫過 → 先跳確認卡 */
  function onDayClick(e) {
    const btn = e.target.closest('.day');
    if (!btn) return;
    if (btn.dataset.id) { openEntry(btn.dataset.id); return; }
    const [y, m, d] = btn.dataset.date.split('-').map(Number);
    state.sheetDate = btn.dataset.date;
    $('#sheet-title').textContent = `${m}月${d}日 週${WEEK[new Date(y, m - 1, d).getDay()]}`;
    $('#sheet').hidden = false;
  }

  /** 建立（或取得已存在的）某天日記，並直接進入書寫模式 */
  async function writeDate(date) {
    $('#sheet').hidden = true;
    const goBtns = [$('#fab-write'), $('#sheet-go')];
    goBtns.forEach((b) => { b.disabled = true; });
    try {
      const r = await api('entry', { method: 'POST', body: { date } });
      state.months.delete(date.slice(0, 7)); // 讓月曆下次重新抓
      await openEntry(r.entry.id, { edit: r.created });
    } catch (e) {
      if (e.code !== 'unauthorized') toast(e.code === 'offline' ? '離線中，無法建立日記' : '建立失敗，請稍後再試');
    } finally {
      goBtns.forEach((b) => { b.disabled = false; });
    }
  }

  /* ------------------------------------------------------------------ *
   * 4. 日記頁：Notion 內容 → 畫面
   * ------------------------------------------------------------------ */
  async function openEntry(id, { edit = false } = {}) {
    showView('entry');
    state.editing = false;
    $('#blocks').replaceChildren(el('p', 'loading', '翻開卷軸中…'));
    $('#props').replaceChildren();
    $('#btn-append').hidden = true;
    try {
      const data = await api(`entry?id=${encodeURIComponent(id)}`);
      state.entry = data.entry;
      state.blocks = data.blocks;
      state.editing = edit;
      state.dirty.clear();
      collectSaved();
      if (data.entry.date) {                       // 回到首頁時停在這篇所屬的月份
        const [y, m] = data.entry.date.split('-').map(Number);
        state.year = y; state.month = m;
      }
      renderEntry();
      const scroll = $('#scroll');                  // 重播「展開卷軸」動畫
      scroll.classList.remove('unroll');
      void scroll.offsetWidth;
      scroll.classList.add('unroll');
    } catch (e) {
      if (e.code === 'unauthorized') return;
      toast(e.code === 'offline' ? '離線中，這篇還沒存在手機裡' : '讀取失敗，請稍後再試');
      showCalendar();
    }
  }

  /** 記下每個可編輯 block「目前在 Notion 的文字」，之後才知道使用者有沒有改 */
  function collectSaved() {
    state.saved.clear();
    const walk = (list) => {
      for (const b of list) {
        if (EDITABLE.has(b.type)) state.saved.set(b.id, richPlain(b[b.type].rich_text));
        if (b.children) walk(b.children);
      }
    };
    walk(state.blocks);
  }

  const richPlain = (parts) => (parts || []).map((p) => p.plain_text).join('');

  function renderEntry() {
    const e = state.entry;
    if (e.date) {
      const [y, m, d] = e.date.split('-').map(Number);
      $('#entry-year').textContent = `${y} ・ 週${WEEK[new Date(y, m - 1, d).getDay()]}`;
      $('#entry-date').textContent = `${m}月${d}日`;
    }
    $('#btn-mode').textContent = state.editing ? '翻閱' : '寫';
    $('#btn-append').hidden = !state.editing;
    $('#pager').hidden = state.editing;
    setSaveState('idle');
    renderProps();

    const box = $('#blocks');
    box.replaceChildren();
    renderBlocks(state.blocks, box);
    autosizeAll(box);
  }

  /* ---------- 屬性列（聊天／學習／運動／典藏／飲料／TAG） ---------- */
  function renderProps() {
    const e = state.entry;
    const box = $('#props');
    box.replaceChildren();

    const row1 = el('div', 'prop-row');
    for (const [key, label] of [['chat', '聊天'], ['study', '學習'], ['sport', '運動'], ['archive', '典藏']]) {
      const b = el('button', 'chip' + (e[key] ? ' on' : ''), label);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(e[key]));
      b.addEventListener('click', () => setProp(key, !e[key]));
      row1.append(b);
    }
    box.append(row1);

    const segmented = (label, key, options) => {
      const row = el('div', 'prop-row');
      row.append(el('span', 'prop-label', label));
      for (const opt of options) {
        const b = el('button', 'seg-btn' + (e[key] === opt ? ' on' : ''), opt);
        b.type = 'button';
        b.setAttribute('aria-pressed', String(e[key] === opt));
        // 再點一次已選的選項 = 清空
        b.addEventListener('click', () => setProp(key, e[key] === opt ? null : opt));
        row.append(b);
      }
      box.append(row);
    };
    segmented('飲料', 'drink', DRINKS);
    segmented('TAG', 'tag', TAGS);
  }

  /** 改屬性：先改畫面（立即有感），再送給 Notion，失敗就復原 */
  async function setProp(key, value) {
    const e = state.entry;
    const prev = e[key];
    e[key] = value;
    renderProps();
    syncMonthCache(e);
    try {
      await api('entry', { method: 'PATCH', body: { id: e.id, props: { [key]: value } } });
      setSaveState('saved');
    } catch (err) {
      e[key] = prev;
      renderProps();
      syncMonthCache(e);
      if (err.code !== 'unauthorized') toast('沒有存成功，請確認網路');
    }
  }

  /** 讓月曆快取跟著更新（回到星圖時小圓點立刻正確） */
  function syncMonthCache(e) {
    for (const list of state.months.values()) {
      const hit = list.find((x) => x.id === e.id);
      if (hit) Object.assign(hit, { chat: e.chat, study: e.study, sport: e.sport, archive: e.archive, drink: e.drink, tag: e.tag });
    }
  }

  /* ---------- 文字樣式：rich_text → <span> ---------- */
  const SAFE_URL = /^(https?:|mailto:)/i;

  function renderRichText(parts, parent) {
    for (const t of parts || []) {
      const a = t.annotations || {};
      const isLink = t.href && SAFE_URL.test(t.href);
      const node = el(isLink ? 'a' : 'span');
      node.textContent = t.plain_text;
      if (isLink) { node.href = t.href; node.target = '_blank'; node.rel = 'noopener noreferrer'; }
      if (a.bold) node.classList.add('b');
      if (a.italic) node.classList.add('i');
      if (a.underline) node.classList.add('u');
      if (a.strikethrough) node.classList.add('s');
      if (a.code) node.classList.add('code');
      if (a.color && a.color !== 'default') node.classList.add('c-' + a.color); // 文字色或底色
      parent.append(node);
    }
  }

  /**
   * 一個 block 的「文字部分」：
   *  · 閱讀模式 → 帶樣式的文字
   *  · 書寫模式（且可編輯）→ 文字框；輸入時登記為「待儲存」
   */
  function textNode(b, tag, cls) {
    const data = b[b.type];
    if (state.editing && EDITABLE.has(b.type)) {
      const ta = el('textarea', 'edit edit-' + b.type);
      ta.rows = 1;
      ta.value = richPlain(data.rich_text);
      ta.placeholder = '…';
      ta.setAttribute('aria-label', '編輯文字');
      ta.addEventListener('input', () => {
        autosize(ta);
        if (ta.value === state.saved.get(b.id)) state.dirty.delete(b.id);
        else state.dirty.set(b.id, ta.value);
        scheduleSave();
      });
      return ta;
    }
    const node = el(tag, cls);
    renderRichText(data.rich_text, node);
    return node;
  }

  function autosize(ta) {
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  }
  function autosizeAll(root) {
    requestAnimationFrame(() => root.querySelectorAll('textarea.edit').forEach(autosize));
  }

  /* ---------- block 渲染 ---------- */

  /** 渲染一串 block；連續的項目符號 / 數字序號會合併成同一個清單 */
  function renderBlocks(blocks, container) {
    let i = 0;
    while (i < blocks.length) {
      const b = blocks[i];
      if (b.type === 'bulleted_list_item' || b.type === 'numbered_list_item') {
        const list = el(b.type === 'bulleted_list_item' ? 'ul' : 'ol', 'list');
        while (i < blocks.length && blocks[i].type === b.type) {
          list.append(renderListItem(blocks[i]));
          i++;
        }
        container.append(list);
        continue;
      }
      container.append(renderBlock(b));
      i++;
    }
  }

  function renderListItem(b) {
    const li = el('li', 'li');
    li.append(textNode(b, 'div', 'li-text'));
    if (b.children && b.children.length) {
      const kids = el('div', 'children');
      renderBlocks(b.children, kids);
      li.append(kids);
    }
    return li;
  }

  function renderToggle(b, tag) {
    const data = b[b.type];
    const open = state.open.has(b.id);
    const wrap = el('div', 'block toggle block-' + b.type);
    if (data.color && data.color !== 'default') wrap.classList.add('c-' + data.color);
    wrap.classList.toggle('open', open);

    const head = el('div', 'toggle-head');
    const arrow = el('button', 'toggle-arrow', '▸');
    arrow.type = 'button';
    arrow.setAttribute('aria-label', '展開或收合');
    arrow.setAttribute('aria-expanded', String(open));
    const title = textNode(b, tag, b.type === 'toggle' ? 'toggle-title' : 'toggle-title');
    head.append(arrow, title);

    const body = el('div', 'toggle-body');
    body.hidden = !open;
    if (b.children) renderBlocks(b.children, body);

    arrow.addEventListener('click', () => {
      const willOpen = body.hidden;
      body.hidden = !willOpen;
      wrap.classList.toggle('open', willOpen);
      arrow.setAttribute('aria-expanded', String(willOpen));
      if (willOpen) { state.open.add(b.id); autosizeAll(body); } else state.open.delete(b.id);
    });
    if (!state.editing) title.addEventListener('click', () => arrow.click()); // 閱讀時點標題也能開關

    wrap.append(head, body);
    return wrap;
  }

  function safeHttps(url) {
    return typeof url === 'string' && /^https:\/\//i.test(url) ? url : null;
  }

  function renderBlock(b) {
    const type = b.type;
    const data = b[type] || {};

    // 標題如果是「可摺疊標題」，和 toggle 同樣處理
    if (type === 'toggle') return renderToggle(b, 'div');
    if (type.startsWith('heading_') && data.is_toggleable) return renderToggle(b, 'h' + type.slice(-1));

    const wrap = el('div', 'block block-' + type);
    if (data.color && data.color !== 'default') wrap.classList.add('c-' + data.color); // 整段的顏色

    switch (type) {
      case 'paragraph':
        wrap.append(textNode(b, 'p', 'p'));
        break;
      case 'heading_1': case 'heading_2': case 'heading_3':
        wrap.append(textNode(b, 'h' + type.slice(-1), ''));
        break;
      case 'quote':
        wrap.append(textNode(b, 'blockquote', 'quote'));
        break;
      case 'callout': {
        const icon = data.icon && data.icon.type === 'emoji' ? data.icon.emoji : '✦';
        wrap.append(el('span', 'callout-icon', icon), textNode(b, 'div', 'callout-text'));
        break;
      }
      case 'to_do': {
        wrap.classList.add('todo');
        const cb = el('input', 'todo-box');
        cb.type = 'checkbox'; cb.checked = !!data.checked; cb.disabled = true;
        wrap.append(cb, textNode(b, 'div', data.checked ? 'todo-text done' : 'todo-text'));
        break;
      }
      case 'divider':
        wrap.append(el('hr', 'divider'));
        break;
      case 'code': {
        if (data.language && data.language !== 'plain text') wrap.append(el('div', 'code-lang', data.language));
        const pre = el('pre');
        pre.append(el('code', null, richPlain(data.rich_text)));
        wrap.append(pre);
        break;
      }
      case 'image': {
        const src = safeHttps(data.type === 'file' ? data.file && data.file.url : data.external && data.external.url);
        if (src) {
          const img = el('img');
          img.src = src; img.loading = 'lazy'; img.alt = richPlain(data.caption) || '';
          wrap.append(img);
          if (data.caption && data.caption.length) { const c = el('div', 'caption'); renderRichText(data.caption, c); wrap.append(c); }
        }
        break;
      }
      case 'bookmark': case 'link_preview': {
        const url = data.url;
        if (url && SAFE_URL.test(url)) {
          const a = el('a', null, url);
          a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
          wrap.append(a);
        }
        break;
      }
      default: // 還不支援的類型（表格、欄位排版…）：提示去 Notion 看
        wrap.append(el('div', 'unsupported', `（「${type}」區塊暫不支援顯示，請到 Notion 查看）`));
    }

    if (b.children && b.children.length) {
      const kids = el('div', 'children');
      renderBlocks(b.children, kids);
      wrap.append(kids);
    }
    return wrap;
  }

  /* ------------------------------------------------------------------ *
   * 5. 日記頁：書寫、自動儲存、翻頁
   * ------------------------------------------------------------------ */
  const SAVE_TEXT = {
    idle: '', editing: '輸入中…', saving: '儲存中…',
    saved: '已存到 Notion ✓', error: '尚未儲存・點此重試',
  };
  function setSaveState(s) {
    const n = $('#save-state');
    n.textContent = SAVE_TEXT[s];
    n.classList.toggle('error', s === 'error');
  }

  let saving = false;
  let saveTimer = null;
  let saveAgain = false;

  /** 停止打字 1.2 秒後自動儲存 */
  function scheduleSave() {
    setSaveState('editing');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 1200);
  }

  /** 把「待儲存」的段落一次送給後端（正在儲存時不重複送，結束後再補一次） */
  async function flushSave() {
    clearTimeout(saveTimer);
    if (saving) { saveAgain = true; return; }
    if (!state.dirty.size || !state.entry) return;

    const batch = [...state.dirty].map(([id, text]) => ({ id, text }));
    saving = true;
    setSaveState('saving');
    try {
      await api('entry', { method: 'PATCH', body: { id: state.entry.id, blocks: batch } });
      for (const s of batch) {
        state.saved.set(s.id, s.text);
        if (state.dirty.get(s.id) === s.text) state.dirty.delete(s.id); // 送出期間又打字的不要刪
      }
      setSaveState(state.dirty.size ? 'editing' : 'saved');
    } catch (e) {
      if (e.code !== 'unauthorized') setSaveState('error');
    } finally {
      saving = false;
      if (saveAgain) { saveAgain = false; if (state.dirty.size) scheduleSave(); }
    }
  }

  /** 「寫」⇄「翻閱」切換 */
  async function toggleMode() {
    if (!state.entry) return;
    if (!state.editing) { state.editing = true; renderEntry(); return; }

    await flushSave();
    if (state.dirty.size) { toast('還有內容沒存到 Notion，請確認網路'); return; }
    state.editing = false;
    try { // 回閱讀模式時重新抓，確保看到的就是 Notion 上的真實樣子
      const data = await api(`entry?id=${encodeURIComponent(state.entry.id)}`);
      state.entry = data.entry; state.blocks = data.blocks; collectSaved();
    } catch { /* 抓不到就沿用畫面上的資料 */ }
    renderEntry();
  }

  /** 在最後新增一個空白段落，並把游標放進去 */
  async function appendParagraph() {
    await flushSave();
    if (state.dirty.size) { toast('還有內容沒存到 Notion，請確認網路'); return; }
    try {
      await api('entry', { method: 'PATCH', body: { id: state.entry.id, append: [''] } });
      const data = await api(`entry?id=${encodeURIComponent(state.entry.id)}`);
      state.blocks = data.blocks; collectSaved(); renderEntry();
      const all = document.querySelectorAll('#blocks textarea.edit');
      if (all.length) all[all.length - 1].focus();
    } catch (e) {
      if (e.code !== 'unauthorized') toast('新增失敗，請確認網路');
    }
  }

  async function leaveEntry() {
    await flushSave();
    if (state.dirty.size && !confirm('還有內容沒存到 Notion，確定要離開嗎？')) return;
    state.dirty.clear();
    state.editing = false;
    showCalendar();
  }

  /** 翻頁：dir = -1 前一篇（較早）／ +1 後一篇（較晚），會自動往相鄰月份找 */
  async function goNeighbor(dir) {
    if (!state.entry || !state.entry.date || state.editing) return;
    const cur = state.entry.date;
    let [y, m] = cur.slice(0, 7).split('-').map(Number);
    try {
      for (let step = 0; step <= 2; step++) {
        if (step > 0) {
          m += dir;
          if (m < 1) { m = 12; y--; }
          if (m > 12) { m = 1; y++; }
        }
        const list = await loadMonth(y, m);
        const cands = list.filter((e) => e.date && (dir < 0 ? e.date < cur : e.date > cur));
        if (cands.length) {
          const pick = dir < 0 ? cands[cands.length - 1] : cands[0];
          return openEntry(pick.id);
        }
      }
      toast('附近沒有其他日記了');
    } catch (e) {
      if (e.code !== 'unauthorized') toast('翻頁失敗，請確認網路');
    }
  }

  /* ------------------------------------------------------------------ *
   * 6. 配對畫面、初始化
   * ------------------------------------------------------------------ */
  async function pair() {
    const input = $('#pair-input');
    const err = $('#pair-error');
    const v = input.value.trim();
    if (!v) return;
    err.hidden = true;
    try { localStorage.setItem(KEY_STORE, v); } catch { /* ignore */ }
    try {
      await loadMonth(state.year, state.month, true); // 用這把金鑰試著讀一次
      input.value = '';
      await showCalendar();
    } catch (e) {
      if (e.code === 'unauthorized') {
        try { localStorage.removeItem(KEY_STORE); } catch { /* ignore */ }
        err.textContent = '金鑰不正確，請再貼一次。';
      } else {
        err.textContent = e.code === 'offline' ? '目前沒有網路。' : '連線失敗，請檢查伺服器設定。';
      }
      err.hidden = false;
      showView('pair');
    }
  }

  function bindEvents() {
    $('#prev-month').addEventListener('click', () => changeMonth(-1));
    $('#next-month').addEventListener('click', () => changeMonth(1));
    $('#btn-this-month').addEventListener('click', () => {
      state.year = now.getFullYear(); state.month = now.getMonth() + 1; showCalendar();
    });
    $('#cal-grid').addEventListener('click', onDayClick);
    $('#fab-write').addEventListener('click', () => writeDate(ymd(new Date())));
    $('#sheet-go').addEventListener('click', () => writeDate(state.sheetDate));
    $('#sheet-cancel').addEventListener('click', () => { $('#sheet').hidden = true; });
    $('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') $('#sheet').hidden = true; });

    $('#btn-back').addEventListener('click', leaveEntry);
    $('#btn-mode').addEventListener('click', toggleMode);
    $('#btn-append').addEventListener('click', appendParagraph);
    $('#btn-prev').addEventListener('click', () => goNeighbor(-1));
    $('#btn-next').addEventListener('click', () => goNeighbor(1));
    $('#save-state').addEventListener('click', flushSave);

    $('#pair-save').addEventListener('click', pair);
    $('#pair-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') pair(); });

    // 閱讀模式下左右滑動翻頁
    let touch = null;
    const ev = $('#view-entry');
    ev.addEventListener('touchstart', (e) => {
      touch = state.editing || e.touches.length !== 1 ? null : { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }, { passive: true });
    ev.addEventListener('touchend', (e) => {
      if (!touch) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - touch.x, dy = t.clientY - touch.y;
      touch = null;
      if (Math.abs(dx) > 80 && Math.abs(dy) < 50) goNeighbor(dx > 0 ? -1 : 1);
    }, { passive: true });

    // 切到背景 / 離開 App 時，把還沒存的趕快送出
    document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });
    window.addEventListener('resize', () => { if (!$('#view-calendar').hidden) drawConstellation(); });
    window.addEventListener('offline', () => toast('目前離線'));
  }

  function init() {
    grabKeyFromHash();
    bindEvents();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    showCalendar();
  }

  init();
})();
