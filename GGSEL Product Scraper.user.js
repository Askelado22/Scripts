// ==UserScript==
// @name         GGSEL Product Scraper • FAB Left + Copy All + CSV + ExtraPrice + Names&Mod (LabelFix)
// @namespace    vibe.ggsel.scraper.fab
// @version      1.3.2
// @description  Сбор названия, описаний, параметров и модификаторов. Поддержка скрытых описаний, ExtraPrice (+1% или минимум +1 ₽), Δmod. Кнопка «Скопировать названия и mod», CSV. Клик по чипам = копия. ФИКС: название блока берём строго из div[class^="ProductForm_label__"] (например, «Номинал»).
// @author       vibe
// @match        https://ggsel.net/catalog/product/*
// @icon         https://ggsel.net/favicon.ico
// @run-at       document-idle
// @grant        GM_addStyle
// @grant        GM_setClipboard
// ==/UserScript==

(function () {
  'use strict';

  /* =========================
   * УТИЛИТЫ
   * ========================= */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

  async function waitFor(selector, { root = document, timeout = 8000, poll = 120 } = {}) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const el = root.querySelector(selector);
      if (el) return el;
      await sleep(poll);
    }
    return null;
  }

  function parsePrice(text) {
    if (!text) return NaN;
    const cleaned = text.replace(/\s+/g, '').replace(/[^\d.,-]/g, '').replace(',', '.');
    const m = cleaned.match(/-?\d+(?:\.\d+)?$/);
    return m ? parseFloat(m[0]) : NaN;
  }

  function formatCurrency(num) {
    if (!isFinite(num)) return '—';
    const n = Math.round(num * 100) / 100;
    return (Number.isInteger(n) ? n.toString() : n.toString().replace('.', ',')) + ' ₽';
  }

  function copyToClipboard(text) {
    try {
      if (typeof GM_setClipboard === 'function') {
        GM_setClipboard(text, { type: 'text', mimetype: 'text/plain' });
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      toast('Скопировано');
    } catch (e) {
      console.warn('Copy failed', e);
    }
  }

  function toast(msg = 'OK') {
    const t = document.createElement('div');
    t.className = 'vibe-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.classList.add('show'), 10);
    setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => t.remove(), 220);
    }, 1500);
  }

  function escapeHtml(s) {
    return (s || '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  }

  function htmlToPlainText(html) {
    if (!html) return '';
    let s = String(html);
    s = s.replace(/<br\s*\/?>/gi, '\n');
    s = s.replace(/<\/p>/gi, '\n');
    s = s.replace(/<\s*\/?div[^>]*>/gi, '\n');
    s = s.replace(/<[^>]+>/g, '');
    const tmp = document.createElement('textarea');
    tmp.innerHTML = s;
    s = tmp.value;
    s = s.replace(/\r\n/g, '\n').replace(/\u00A0/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    return s;
    }

  // «Доп. цена» (+1% округлением до ₽, минимум +1 ₽)
  function applyExtraPrice(baseNum) {
    if (!isFinite(baseNum)) return NaN;
    const p1 = Math.round(baseNum * 1.01);
    const min = Math.ceil(baseNum + 1);
    return Math.max(p1, min);
  }

  // CSV
  function csvEscape(value) {
    const s = value == null ? '' : String(value);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }
  function rowsToCsv(rows) {
    return rows.map(r => r.map(csvEscape).join(',')).join('\n');
  }
  function downloadFile(filename, content, mime = 'text/plain;charset=utf-8') {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
  }
  function slugify(s) {
    return (s || '').toLowerCase()
      .replace(/[^a-z0-9а-яё\-._\s]/gi, '')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .substring(0, 80) || 'ggsel';
  }

  /* =========================
   * СТИЛИ (FAB слева)
   * ========================= */
  GM_addStyle(`
    .vibe-fab {
      position: fixed; left: 22px; bottom: 22px; z-index: 999999;
      width: 64px; height: 64px; border-radius: 50%;
      background: radial-gradient(circle at 30% 30%, #ffe37a, #f4c84a 60%, #9a7d2d);
      color: #111; font-weight: 700; font-family: ui-sans-serif, system-ui, -apple-system;
      border: none; box-shadow: 0 12px 24px rgba(0,0,0,.35);
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; transition: transform .15s ease, box-shadow .15s ease;
    }
    .vibe-fab:hover { transform: translateY(-2px); box-shadow: 0 16px 28px rgba(0,0,0,.45); }
    .vibe-fab:active { transform: translateY(0); }

    .vibe-panel {
      position: fixed; left: 22px; bottom: 96px; z-index: 999998;
      width: min(560px, 92vw); max-height: min(76vh, 900px);
      background: rgba(20,22,28,.97); color: #e5e7eb;
      border: 1px solid rgba(255,227,122,.25);
      border-radius: 18px; overflow: hidden; display: none;
      box-shadow: 0 24px 64px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.04);
      backdrop-filter: blur(6px);
    }
    .vibe-panel.show { display: flex; flex-direction: column; }

    .vibe-panel__head {
      display:flex; align-items:center; justify-content:space-between;
      padding: 12px 14px; background: linear-gradient(180deg, rgba(255,227,122,.08), rgba(255,227,122,0));
      border-bottom: 1px solid rgba(255,227,122,.15);
    }
    .vibe-title { font-weight: 700; font-size: 14px; letter-spacing:.2px; color:#ffe37a; }
    .vibe-actions { display:flex; gap:8px; flex-wrap: wrap; }
    .vibe-btn {
      height: 32px; padding: 0 12px; border-radius: 10px; border: 1px solid rgba(255,227,122,.25);
      background: rgba(255,227,122,.06); color: #ffe37a; font-weight:600; cursor:pointer;
    }
    .vibe-btn:hover { background: rgba(255,227,122,.12); }
    .vibe-btn.secondary { color:#cbd5e1; border-color: rgba(148,163,184,.35); background: rgba(148,163,184,.08); }
    .vibe-btn.secondary:hover { background: rgba(148,163,184,.15); }

    .vibe-panel__body { overflow:auto; padding: 10px 14px 14px; display:flex; flex-direction:column; gap:12px; }
    .vibe-card { border: 1px solid rgba(148,163,184,.25); border-radius: 14px; padding: 10px; background: rgba(2,6,23,.55); }
    .vibe-card h3 {
      margin: 0 0 8px; font-size: 13px; color:#93c5fd; font-weight:700; letter-spacing:.1px;
      display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap: wrap;
    }
    .vibe-copy { font-size: 12px; padding: 4px 8px; border-radius: 8px;
      background: rgba(147,197,253,.1); color:#93c5fd; border:1px solid rgba(147,197,253,.25); cursor:pointer; }
    .vibe-pre, .vibe-textarea {
      white-space: pre-wrap; font-family: ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
      background: rgba(15,23,42,.55); border: 1px solid rgba(148,163,184,.25);
      border-radius: 10px; padding: 10px; margin: 0; color: #e5e7eb; font-size: 12.5px; line-height: 1.4;
    }
    .vibe-textarea { width:100%; min-height: 52px; resize: vertical; }

    .vibe-group { display:flex; flex-direction:column; gap:8px; }
    .vibe-list { display:flex; flex-direction:column; gap:6px; }
    .vibe-row { display:flex; align-items: baseline; gap:8px; flex-wrap: wrap; }
    .vibe-pill {
      display:inline-flex; align-items:center; gap:10px; padding:6px 10px; border-radius: 999px;
      background: rgba(255,227,122,.08); color:#ffe37a; border: 1px solid rgba(255,227,122,.25);
      font-size: 12.5px; cursor: pointer; user-select: none;
    }
    .vibe-delta.plus { color:#4ade80; }
    .vibe-delta.minus { color:#f87171; }
    .vibe-delta.mod { color:#60a5fa; }
    .vibe-muted { color:#a3a3a3; }
    .vibe-small { font-size: 12px; }

    .vibe-toast {
      position: fixed; left: 50%; bottom: 30px; transform: translateX(-50%) translateY(8px);
      background: #111827; color:#e5e7eb; padding:8px 12px; border-radius: 10px;
      border: 1px solid rgba(255,255,255,.08); opacity: 0; transition: all .2s ease; z-index: 1000000;
    }
    .vibe-toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
    .vibe-kbd { font: 600 11px ui-monospace,SFMono-Regular; background:#111827; color:#e5e7eb; padding:2px 5px; border-radius:6px; border:1px solid rgba(255,255,255,.12); }
    .vibe-hint { color:#9ca3af; font-size:12px; }
  `);

  /* =========================
   * FAB + ПАНЕЛЬ
   * ========================= */
  let panel, bodyEl, btnScan, isScanning = false;

  function createFab() {
    const fab = document.createElement('button');
    fab.className = 'vibe-fab';
    fab.title = 'GGSEL Scraper — открыть/закрыть (Alt+S)';
    fab.innerHTML = 'SCR';
    fab.addEventListener('click', togglePanel);
    document.body.appendChild(fab);
    window.addEventListener('keydown', (e) => {
      if (e.altKey && (e.key.toLowerCase() === 's')) { e.preventDefault(); togglePanel(); }
    });
  }
  function togglePanel() { if (!panel) createPanel(); panel.classList.toggle('show'); }

  function createPanel() {
    panel = document.createElement('div');
    panel.className = 'vibe-panel';

    const head = document.createElement('div');
    head.className = 'vibe-panel__head';
    head.innerHTML = `
      <div class="vibe-title">GGSEL Product Scraper</div>
      <div class="vibe-actions">
        <button class="vibe-btn" id="vibe-btn-scan">Сканировать</button>
        <button class="vibe-btn secondary" id="vibe-btn-close">Закрыть</button>
      </div>
    `;

    bodyEl = document.createElement('div');
    bodyEl.className = 'vibe-panel__body';
    bodyEl.innerHTML = `
      <div class="vibe-card">
        <h3>Подсказка <span class="vibe-hint">Нажми <span class="vibe-kbd">Сканировать</span> для обновления данных</span></h3>
        <div class="vibe-small vibe-muted">Клик по «пилюле» копирует её текст. Скрипт кликает только опции, покупку не инициирует.</div>
      </div>
    `;
    panel.appendChild(head); panel.appendChild(bodyEl); document.body.appendChild(panel);

    btnScan = $('#vibe-btn-scan', panel);
    $('#vibe-btn-close', panel).addEventListener('click', togglePanel);
    btnScan.addEventListener('click', () => scanAll(true));
  }

  /* =========================
   * СБОР ДАННЫХ
   * ========================= */
  function getTitle() {
    const el = $('[data-test="productTitle"]')
            || $('h1[class*="BuyBoxV2_title"], h1[class*="Product_title"], h1');
    return el ? el.textContent.trim() : '';
  }

  function getDescriptions() {
    const blocks = [];
    const h2 = $('[data-test="productDescription"]') || $$('h2').find(h => /о товаре/i.test(h.textContent));
    if (h2 && h2.parentElement) {
      let n = h2.nextElementSibling;
      while (n && n.tagName !== 'H2') {
        if (n.matches('[data-sentry-component="SanitizeHtml"]')) {
          const txt = n.offsetParent ? n.innerText : htmlToPlainText(n.innerHTML);
          const norm = (txt || '').replace(/\r\n/g, '\n').replace(/\u00A0/g, ' ').trim();
          if (norm) blocks.push(norm);
        }
        n = n.nextElementSibling;
      }
    }
    if (blocks.length === 0) {
      $$('div[class^="ProductInfo_description__"][data-sentry-component="SanitizeHtml"]').forEach(d => {
        const txt = d.offsetParent ? d.innerText : htmlToPlainText(d.innerHTML);
        const norm = (txt || '').replace(/\r\n/g, '\n').replace(/\u00A0/g, ' ').trim();
        if (norm) blocks.push(norm);
      });
    }
    return blocks;
  }

  // ВАЖНО: берём название блока строго из div[class^="ProductForm_label__"]
  function extractLabelText(labelEl) {
    if (!labelEl) return '';
    const clone = labelEl.cloneNode(true);
    // Удаляем «красную звёздочку» и любые вложенные спаны
    clone.querySelectorAll('span').forEach(s => s.remove());
    return clone.textContent.replace(/\*/g, '').trim();
  }

  // Ищем ближайшую группу [role="group"] от лейбла:
  // 1) среди соседей, 2) внутри ближайших контейнеров, 3) небольшой просмотр следующих узлов.
  function findRoleGroupNear(labelEl) {
    if (!labelEl) return null;
    // 1) Прямо в родителе
    let container = labelEl.parentElement;
    if (container) {
      const g1 = container.querySelector('[role="group"]');
      if (g1) return g1;
    }
    // 2) Следующий элемент
    let sib = labelEl.nextElementSibling;
    if (sib) {
      const g2 = sib.matches('[role="group"]') ? sib : sib.querySelector('[role="group"]');
      if (g2) return g2;
    }
    // 3) Поднимаемся на уровень выше и ищем в пределах блока с переключателями
    if (container && container.parentElement) {
      const g3 = container.parentElement.querySelector('[role="group"]');
      if (g3) return g3;
    }
    // 4) Фолбэк: ближайший [role="group"] в документе после лейбла
    const allGroups = $$('[role="group"]');
    for (const g of allGroups) {
      if (g.compareDocumentPosition(labelEl) & Node.DOCUMENT_POSITION_FOLLOWING) {
        return g;
      }
    }
    return null;
  }

  function getToggleGroups() {
    // Ищем ЛЕЙБЛЫ по новому соглашению классов CSS-модулей
    const labelNodes = $$('div[class^="ProductForm_label__"]'); // например, .ProductForm_label__sekml
    const groups = [];

    // Собираем пары label -> role="group"
    labelNodes.forEach(label => {
      const labelText = extractLabelText(label);
      const roleGroup = findRoleGroupNear(label);
      if (roleGroup) {
        const buttons = $$('button', roleGroup).filter(b => b.type === 'button');
        if (buttons.length > 0) {
          groups.push({ labelEl: label, label: labelText, groupEl: roleGroup, buttons });
        }
      }
    });

    // Если не нашли по лейблам — фолбэк (безымянные группы)
    if (groups.length === 0) {
      $$('[role="group"]').forEach(g => {
        const buttons = $$('button', g).filter(b => b.type === 'button');
        if (buttons.length) groups.push({ labelEl: null, label: 'Параметры', groupEl: g, buttons });
      });
    }

    return groups;
  }

  function getSelectedButton(buttons) {
    return buttons.find(b => b.classList.contains('Mui-selected') || b.getAttribute('aria-pressed') === 'true') || null;
  }

  async function clickOptionAndWaitPrice(btn) {
    btn.scrollIntoView({ block: 'center' });
    btn.click();
    await sleep(120);
    const t0 = Date.now();
    let last = getPrice().num;
    while (Date.now() - t0 < 1200) {
      const now = getPrice().num;
      if (!Number.isNaN(now) && now !== last) break;
      await sleep(120);
      last = now;
    }
    return getPrice().num;
  }

  function getPrice() {
    const el = $('[data-test="productPrice"]')
           || $('[class*="ProductBuyBlock_amount"]')
           || $$('span').find(s => /₽|руб/i.test(s.textContent));
    return el ? { text: el.textContent.trim(), num: parsePrice(el.textContent) } : { text: '', num: NaN };
  }

  /* =========================
   * РЕНДЕР
   * ========================= */
  function renderTitle(title) {
    const card = document.createElement('div');
    card.className = 'vibe-card';
    card.innerHTML = `
      <h3>Название товара <button class="vibe-copy">Копировать</button></h3>
      <textarea class="vibe-textarea" readonly></textarea>
    `;
    const ta = $('textarea', card);
    ta.value = title || '';
    $('.vibe-copy', card).addEventListener('click', () => copyToClipboard(ta.value));
    bodyEl.appendChild(card);
  }

  function renderDescriptions(descBlocks, titleForCsv) {
    const card = document.createElement('div');
    card.className = 'vibe-card';
    card.innerHTML = `
      <h3>
        Описания (блоки)
        <span>
          <button class="vibe-copy" id="vibe-copy-all-desc">Копировать все описания</button>
          <button class="vibe-copy" id="vibe-csv-desc">Скачать описания (CSV)</button>
        </span>
      </h3>
    `;
    const wrap = document.createElement('div'); wrap.className = 'vibe-group'; card.appendChild(wrap);

    if (!descBlocks || descBlocks.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'vibe-muted vibe-small';
      empty.textContent = 'Не найдено описаний.';
      wrap.appendChild(empty);
    } else {
      descBlocks.forEach((txt, i) => {
        const row = document.createElement('div');
        row.className = 'vibe-group';
        row.innerHTML = `
          <div class="vibe-row" style="justify-content:space-between;">
            <div class="vibe-pill" title="Клик — копировать">Блок #${i + 1}</div>
            <button class="vibe-copy">Копировать</button>
          </div>
          <pre class="vibe-pre"></pre>
        `;
        const pill = $('.vibe-pill', row);
        pill.addEventListener('click', () => copyToClipboard(pill.textContent.trim()));
        $('.vibe-pre', row).textContent = txt;
        $('.vibe-copy', row).addEventListener('click', () => copyToClipboard(txt));
        wrap.appendChild(row);
      });
    }

    $('#vibe-copy-all-desc', card)?.addEventListener('click', () => {
      const all = (descBlocks || []).join('\n\n---\n\n');
      copyToClipboard(all);
    });

    $('#vibe-csv-desc', card)?.addEventListener('click', () => {
      const rows = [['productTitle', 'blockIndex', 'text']];
      (descBlocks || []).forEach((txt, i) => rows.push([titleForCsv, i + 1, txt]));
      const csv = rowsToCsv(rows);
      downloadFile(`ggsel_descriptions_${slugify(titleForCsv)}.csv`, csv, 'text/csv;charset=utf-8');
    });

    bodyEl.appendChild(card);
  }

  function renderParameters(groups, deltas, titleForCsv) {
    const card = document.createElement('div');
    card.className = 'vibe-card';
    card.innerHTML = `
      <h3>
        Параметры и модификаторы цены
        <span>
          <button class="vibe-copy" id="vibe-copy-names-mod">Скопировать названия и mod</button>
          <button class="vibe-copy" id="vibe-csv-names-mod">Скачать названия+mod (CSV)</button>
          <button class="vibe-copy" id="vibe-csv-params">Скачать параметры+модификаторы (CSV)</button>
        </span>
      </h3>
    `;
    const wrap = document.createElement('div'); wrap.className = 'vibe-group'; card.appendChild(wrap);

    if (groups.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'vibe-muted vibe-small';
      empty.textContent = 'Параметров не обнаружено.';
      wrap.appendChild(empty);
      bodyEl.appendChild(card);
      return;
    }

    groups.forEach((g, idx) => {
      const gD = deltas[idx];
      const gCard = document.createElement('div'); gCard.className = 'vibe-group';
      gCard.innerHTML = `
        <div class="vibe-row" style="justify-content:space-between;">
          <div class="vibe-pill" title="Клик — копировать название блока">${escapeHtml(g.label || 'Параметры')}</div>
          <button class="vibe-copy">Скопировать все названия</button>
        </div>
      `;
      const blockPill = $('.vibe-pill', gCard);
      blockPill.addEventListener('click', () => copyToClipboard((g.label || 'Параметры').trim()));

      const list = document.createElement('div'); list.className = 'vibe-list';

      if (gD && gD.base) {
        const rowBase = document.createElement('div');
        rowBase.className = 'vibe-row';
        rowBase.innerHTML = `
          <div class="vibe-pill" title="Клик — копировать название опции">Стандарт: ${escapeHtml(gD.base.name)}</div>
          <span class="vibe-muted vibe-small">Цена: ${gD.base.priceText || (isFinite(gD.base.price) ? formatCurrency(gD.base.price) : '—')}</span>
          <span class="vibe-delta mod">mod: ${formatCurrency(gD.base.priceNum_mod)}</span>
        `;
        $('.vibe-pill', rowBase).addEventListener('click', () => copyToClipboard(`Стандарт: ${gD.base.name}`));
        list.appendChild(rowBase);
      }

      if (gD && gD.options && gD.options.length) {
        gD.options.forEach(opt => {
          const cls = opt.deltaNum > 0 ? 'plus' : (opt.deltaNum < 0 ? 'minus' : '');
          const sign = opt.deltaNum > 0 ? '+' : '';
          const signMod = opt.deltaNum_mod > 0 ? '+' : '';
          const row = document.createElement('div');
          row.className = 'vibe-row';
          row.innerHTML = `
            <div class="vibe-pill" title="Клик — копировать название опции">${escapeHtml(opt.name)}</div>
            <span class="vibe-delta ${cls}">${sign}${formatCurrency(opt.deltaNum)}</span>
            <span class="vibe-muted vibe-small">(${opt.priceText || (isFinite(opt.priceNum) ? formatCurrency(opt.priceNum) : '—')})</span>
            <span class="vibe-delta mod">${signMod}${formatCurrency(opt.deltaNum_mod)} mod</span>
            <span class="vibe-muted vibe-small">(mod ${isFinite(opt.priceNum_mod) ? formatCurrency(opt.priceNum_mod) : '—'})</span>
          `;
          $('.vibe-pill', row).addEventListener('click', () => copyToClipboard(opt.name));
          list.appendChild(row);
        });
      }

      gCard.appendChild(list);

      // Копирование всех названий: включает корректный заголовок блока
      $('.vibe-copy', gCard).addEventListener('click', () => {
        const names = [];
        names.push((g.label || 'Параметры').trim());
        (g.buttons || []).forEach(b => { const t = b.innerText.trim(); if (t) names.push(t); });
        copyToClipboard(names.join('\n'));
      });

      wrap.appendChild(gCard);
    });

    // «Скопировать названия и mod»
    $('#vibe-copy-names-mod', card)?.addEventListener('click', () => {
      const lines = [];
      groups.forEach((g, idx) => {
        const gD = deltas[idx];
        const gLabel = (g.label || 'Параметры').trim();
        lines.push(gLabel);
        if (gD && gD.base) { lines.push(gD.base.name); lines.push('0'); }
        if (gD && gD.options) {
          gD.options.forEach(opt => {
            lines.push(opt.name);
            lines.push(String(isFinite(opt.deltaNum_mod) ? Math.round(opt.deltaNum_mod) : 0));
          });
        }
      });
      copyToClipboard(lines.join('\n'));
    });

    // CSV «названия+mod»
    $('#vibe-csv-names-mod', card)?.addEventListener('click', () => {
      const rows = [['groupLabel', 'optionName', 'deltaNum_mod']];
      groups.forEach((g, idx) => {
        const gD = deltas[idx];
        const gLabel = (g.label || 'Параметры').trim();
        if (gD && gD.base) rows.push([gLabel, gD.base.name, 0]);
        if (gD && gD.options) {
          gD.options.forEach(opt => rows.push([gLabel, opt.name, isFinite(opt.deltaNum_mod) ? Math.round(opt.deltaNum_mod) : 0]));
        }
      });
      downloadFile(`ggsel_names_mod_${slugify(titleForCsv)}.csv`, rowsToCsv(rows), 'text/csv;charset=utf-8');
    });

    // Полный CSV параметров
    $('#vibe-csv-params', card)?.addEventListener('click', () => {
      const rows = [['productTitle','groupIndex','groupLabel','isBase','optionName','priceText','priceNum','deltaNum','priceNum_mod','deltaNum_mod']];
      groups.forEach((g, idx) => {
        const gD = deltas[idx]; const gLabel = (g.label || 'Параметры').trim();
        if (gD && gD.base) {
          rows.push([titleForCsv, idx + 1, gLabel, 'yes', gD.base.name, gD.base.priceText || '',
                     isFinite(gD.base.price) ? gD.base.price : '', 0,
                     isFinite(gD.base.priceNum_mod) ? gD.base.priceNum_mod : '', 0]);
        }
        if (gD && gD.options) {
          gD.options.forEach(opt => {
            rows.push([titleForCsv, idx + 1, gLabel, 'no', opt.name, opt.priceText || '',
                       isFinite(opt.priceNum) ? opt.priceNum : '',
                       isFinite(opt.deltaNum) ? opt.deltaNum : '',
                       isFinite(opt.priceNum_mod) ? opt.priceNum_mod : '',
                       isFinite(opt.deltaNum_mod) ? opt.deltaNum_mod : ''
            ]);
          });
        }
      });
      downloadFile(`ggsel_params_${slugify(titleForCsv)}.csv`, rowsToCsv(rows), 'text/csv;charset=utf-8');
    });

    bodyEl.appendChild(card);
  }

  /* =========================
   * PIPELINE
   * ========================= */
  async function scanAll(interactive = false) {
    if (isScanning) return;
    isScanning = true;
    if (interactive && btnScan) { btnScan.disabled = true; btnScan.textContent = 'Сканирую…'; }

    if (!panel) createPanel();
    bodyEl.innerHTML = '';

    const title = getTitle();
    const descriptions = getDescriptions();
    const groups = getToggleGroups();

    const deltas = [];
    for (let gIdx = 0; gIdx < groups.length; gIdx++) {
      const g = groups[gIdx];
      const buttons = g.buttons;
      const selected = getSelectedButton(buttons);
      const baseBtn = selected || buttons[0];

      if (baseBtn) await clickOptionAndWaitPrice(baseBtn);
      const basePrice = getPrice();
      const baseName = baseBtn ? baseBtn.innerText.trim() : '—';
      const baseMod = applyExtraPrice(basePrice.num);

      const optRows = [];
      for (const btn of buttons) {
        const name = btn.innerText.trim();
        if (!name) continue;

        if (btn === baseBtn) {
          optRows.push({
            name, priceNum: basePrice.num, priceText: basePrice.text,
            deltaNum: 0, priceNum_mod: baseMod, deltaNum_mod: 0
          });
          continue;
        }

        const priceNum = await clickOptionAndWaitPrice(btn);
        const priceObj = getPrice();
        const delta = priceNum - basePrice.num;
        const optMod = applyExtraPrice(priceNum);
        const deltaMod = isFinite(optMod) && isFinite(baseMod) ? (optMod - baseMod) : NaN;

        optRows.push({
          name, priceNum, priceText: priceObj.text,
          deltaNum: isFinite(delta) ? delta : NaN,
          priceNum_mod: optMod,
          deltaNum_mod: isFinite(deltaMod) ? deltaMod : NaN
        });

        if (baseBtn) await clickOptionAndWaitPrice(baseBtn);
      }

      const baseRow = optRows.find(r => r.deltaNum === 0 && r.name === baseName) || {
        name: baseName, priceNum: basePrice.num, priceText: basePrice.text, deltaNum: 0,
        priceNum_mod: baseMod, deltaNum_mod: 0
      };

      deltas[gIdx] = {
        base: { name: baseRow.name, price: baseRow.priceNum, priceText: baseRow.priceText, priceNum_mod: baseRow.priceNum_mod, deltaNum_mod: 0 },
        options: optRows.filter(r => !(r.deltaNum === 0 && r.name === baseName))
      };
    }

    renderTitle(title);
    renderDescriptions(descriptions, title);
    renderParameters(groups, deltas, title);

    if (interactive && btnScan) { btnScan.disabled = false; btnScan.textContent = 'Сканировать'; }
    isScanning = false;
  }

  /* =========================
   * ИНИЦИАЛИЗАЦИЯ
   * ========================= */
  (async function init() {
    createFab();
    await waitFor('[data-test="productTitle"], h1[class*="Product_title"]', { timeout: 6000 });
    await waitFor('[data-test="productPrice"], [class*="ProductBuyBlock_amount"]', { timeout: 6000 });
    // Открой панель → «Сканировать»
  })();

})();
