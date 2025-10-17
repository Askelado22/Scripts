// ==UserScript==
// @name         Gsellers Back Office — Order Overlay (smart UI, emails, tech buttons, namespaced)
// @namespace    vibe.gsellers.order.overlay
// @version      1.1.0
// @description  Прячет старые таблицы, вытягивает данные и рисует компактный «умный» интерфейс. Email сразу виден. Технический блок с кнопками. Все стили изолированы (префикс vui-).
// @author       vibe
// @match        *://back-office.ggsel.net/admin/orders/*
// @match        *://*/admin/orders/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';
  const log = (...a) => console.log('[VIBE-UI]', ...a);

  // ---------- helpers ----------
  const txt = n => (n ? n.textContent.trim() : '');
  const norm = s => (s || '').replace(/\s+/g, ' ').trim();
  const cleanMultiline = (value) => {
    if (!value) return '';
    return value
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .split('\n')
      .map(line => line.trimEnd())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  };
  const isEmptyVal = v => !v || v === '-' || v === '—' || v === 'null' || v === 'undefined';
  const esc = (str) => {
    if (str === null || str === undefined) return '';
    return String(str).replace(/[&<>"']/g, ch => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[ch] || ch));
  };
  const copy = (value, target) => {
    if (!value) return;
    try { navigator.clipboard?.writeText(value); } catch {}
    if (target) {
      target.classList.remove('vui-isCopied');
      // force reflow to restart animation
      void target.offsetWidth; // eslint-disable-line no-void
      target.classList.add('vui-isCopied');
      setTimeout(() => target.classList.remove('vui-isCopied'), 900);
    }
  };
  const profileCache = new Map();
  const chatCache = new Map();
  const productCache = new Map();

  function findH(selector, text) {
    return Array.from(document.querySelectorAll(selector))
      .find(h => norm(h.textContent).toLowerCase().includes(text.toLowerCase()));
  }
  function nearest(el, sel) {
    let n = el;
    while (n && n !== document.body) {
      const q = n.querySelector(sel);
      if (q) return q;
      n = n.parentElement;
    }
    return null;
  }
  function rowValueByLabel(table, label) {
    if (!table) return '';
    for (const tr of table.querySelectorAll('tr')) {
      const th = tr.querySelector('th');
      const td = tr.querySelector('td');
      if (!th || !td) continue;
      if (norm(txt(th)).replace(/:$/, '') === label) return norm(txt(td));
    }
    return '';
  }
  function firstLinkWithin(el, labelPart) {
    if (!el) return '';
    const a = Array.from(el.querySelectorAll('a')).find(x => norm(x.textContent).toLowerCase().includes(labelPart.toLowerCase()));
    return a ? a.href : '';
  }

  function toDateObj(raw) {
    if (!raw) return null;
    const value = raw.trim();
    if (!value) return null;
    const m = value.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}(?::\d{2})?)(?:\s+([+-]\d{4}))?/);
    if (m) {
      const time = m[2].length === 5 ? `${m[2]}:00` : m[2];
      const tz = m[3] ? m[3].replace(/([+-]\d{2})(\d{2})/, '$1:$2') : '';
      const iso = `${m[1]}T${time}${tz}`;
      const d = new Date(iso);
      if (!Number.isNaN(d.getTime())) return d;
    }
    const fallback = new Date(value.replace(' ', 'T'));
    return Number.isNaN(fallback.getTime()) ? null : fallback;
  }

  function stripTimezoneSuffix(value) {
    return (value || '').replace(/\s*[+-]\d{2}:?\d{2}$/, '').trim();
  }

  function splitDateParts(raw) {
    const original = (raw || '').trim();
    if (!original) return { time: '', date: '' };
    const match = original.match(/(\d{2}:\d{2}(?::\d{2})?)/);
    if (!match) {
      return { time: '', date: stripTimezoneSuffix(original) };
    }
    const time = match[1];
    const before = original.slice(0, match.index).trim();
    const after = original.slice(match.index + time.length).trim();
    const date = [before, after].filter(Boolean).join(' ').trim();
    return { time, date: stripTimezoneSuffix(date) };
  }

  async function fetchProfileData(url) {
    if (!url) return null;
    try {
      const absolute = new URL(url, location.origin).href;
      if (profileCache.has(absolute)) return profileCache.get(absolute);
      const res = await fetch(absolute, { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      const data = parseProfileHtml(html, absolute);
      profileCache.set(absolute, data);
      return data;
    } catch (e) {
      log('Failed to load profile', url, e);
      return { error: true, url };
    }
  }

  async function fetchChatData(url) {
    if (!url) return null;
    try {
      const absolute = new URL(url, location.origin).href;
      if (chatCache.has(absolute)) return chatCache.get(absolute);
      const res = await fetch(absolute, { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      const data = parseChatHtml(html, absolute);
      chatCache.set(absolute, data);
      return data;
    } catch (e) {
      log('Failed to load chat', url, e);
      return { error: true, url };
    }
  }

  async function fetchProductData(url) {
    if (!url) return null;
    try {
      const absolute = new URL(url, location.origin).href;
      if (productCache.has(absolute)) return productCache.get(absolute);
      const res = await fetch(absolute, { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      const data = parseProductHtml(html, absolute);
      productCache.set(absolute, data);
      return data;
    } catch (e) {
      log('Failed to load product', url, e);
      return { error: true, url };
    }
  }

  function parseProfileHtml(html, url) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const firstBox = doc.querySelector('.content .box');
    const title = norm(txt(firstBox?.querySelector('.box-title')));
    const dl = firstBox?.querySelector('dl');
    const fields = [];
    if (dl) {
      const dts = Array.from(dl.querySelectorAll('dt'));
      const seen = new Set();
      for (const dt of dts) {
        const label = norm(txt(dt));
        const dd = dt.nextElementSibling;
        if (!label || !dd) continue;
        const value = norm(txt(dd));
        if (isEmptyVal(value) || seen.has(label)) continue;
        seen.add(label);
        fields.push({ label, value });
      }
    }

    const chatLinkEl = Array.from(doc.querySelectorAll('a')).find(a => norm(txt(a)).toLowerCase().includes('написать в лс'));
    const relatedDropdown = Array.from(doc.querySelectorAll('.dropdown')).find(drop => {
      const btn = drop.querySelector('button');
      return btn && norm(txt(btn)).toLowerCase().includes('просмотр связанных данных');
    });
    const relatedLinks = relatedDropdown
      ? Array.from(relatedDropdown.querySelectorAll('ul li a')).map(a => ({
        label: norm(txt(a)),
        href: new URL(a.getAttribute('href') || a.href, url).href,
      })).filter(link => link.label && link.href)
      : [];

    const chatLink = chatLinkEl ? new URL(chatLinkEl.getAttribute('href') || chatLinkEl.href, url).href : '';

    return { title, fields, chatLink, relatedLinks, url };
  }

  function parseProductHtml(html, url) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    const boxes = Array.from(doc.querySelectorAll('.box'));
    const descriptionBox = boxes.find(box => {
      const title = norm(txt(box.querySelector('.box-title, h3'))).toLowerCase();
      return title.includes('описание') || title.includes('контент');
    });

    let description = '';
    if (descriptionBox) {
      const body = descriptionBox.querySelector('.box-body');
      description = cleanMultiline(body?.textContent || '');
    }

    if (!description) {
      const descRow = Array.from(doc.querySelectorAll('tr')).find(tr => {
        const label = norm(txt(tr.querySelector('th'))).toLowerCase();
        return label.includes('описание');
      });
      if (descRow) {
        description = cleanMultiline(descRow.querySelector('td')?.textContent || '');
      }
    }

    return { description, url };
  }

  function parseChatHtml(html, url) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const chatBox = doc.querySelector('#chat-box');
    if (!chatBox) return { messages: [], url };

    const messages = Array.from(chatBox.querySelectorAll('.item')).map(item => {
      const avatar = item.querySelector('img')?.getAttribute('src') || '';
      const messageEl = item.querySelector('.message');
      const nameAnchor = messageEl?.querySelector('.name') || null;
      const timeEl = nameAnchor?.querySelector('.text-muted');
      const statusEl = timeEl?.querySelector('.bold');
      const author = norm(Array.from((nameAnchor?.childNodes || [])).filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join(' '));
      const timeParts = [];
      if (timeEl) {
        Array.from(timeEl.childNodes).forEach(node => {
          if (node.nodeType === Node.TEXT_NODE) {
            const t = norm(node.textContent);
            if (t) timeParts.push(t);
          }
        });
      }
      const timestamp = timeParts.join(' ');
      const status = norm(statusEl?.textContent || '');
      const text = norm(messageEl?.querySelector('p')?.textContent || '');

      return {
        author,
        avatar: avatar ? new URL(avatar, url).href : '',
        timestamp,
        status,
        text,
      };
    });

    return { messages, url };
  }

  // ---------- collect ----------
  function collectData() {
    const boxHeader = document.querySelector('.box-header .box-title');
    const orderTitle = txt(boxHeader);
    const orderNumber = (orderTitle.match(/№\s*(\d+)/) || [])[1] || '';

    const mainBox = findH('.box-header h3', 'Заказ №')?.closest('.box');
    const footer = mainBox?.querySelector('.box-footer');

    const actions = {
      edit: firstLinkWithin(footer, 'Редактировать'),
      chat: firstLinkWithin(footer, 'Открыть диалог'),
      close: firstLinkWithin(footer, 'Закрыть сделку'),
      refund: firstLinkWithin(footer, 'Оформить возврат'), // используем и для «Посмотреть возвраты»
      ps: firstLinkWithin(footer, 'платежную систему'),
      reward: firstLinkWithin(footer, 'награду продавцу'),
    };

    const hInfoOrder = findH('h4', 'Информация по заказу');
    const tblOrder = hInfoOrder ? nearest(hInfoOrder.parentElement, 'table') : null;

    const order = {
      number: orderNumber,
      status: rowValueByLabel(tblOrder, 'Статус'),
      payment_system: rowValueByLabel(tblOrder, 'Платежная система'),
      quantity: rowValueByLabel(tblOrder, 'Количество'),
      uuid: rowValueByLabel(tblOrder, 'Uuid'),
      paid_at: rowValueByLabel(tblOrder, 'Дата платежа'),
      admin_confirmed: rowValueByLabel(tblOrder, 'Платеж подтвержден админом'),
      admin_comment: rowValueByLabel(tblOrder, 'Комментарий админа'),
      canceled_at: rowValueByLabel(tblOrder, 'Дата отмены'),
      confirmed_at: rowValueByLabel(tblOrder, 'Дата подтверждения'),
      refunded_at: rowValueByLabel(tblOrder, 'Дата возврата'),
      archived_at: rowValueByLabel(tblOrder, 'Дата архивирования'),
      created_at: rowValueByLabel(tblOrder, 'Дата создания'),
      updated_at: rowValueByLabel(tblOrder, 'Дата обновления'),
    };

    const hSeller = findH('h4', 'Продавец');
    const sellerWrap = hSeller?.closest('.col-sm-3');
    const tblSeller = hSeller ? nearest(hSeller.parentElement, 'table') : null;
    const seller = {
      name: rowValueByLabel(tblSeller, 'Имя пользователя'),
      email: rowValueByLabel(tblSeller, 'Email'),
      rating: rowValueByLabel(tblSeller, 'Рейтинг'),
      profile: (hSeller?.querySelector('a') || {}).href || ''
    };

    const hBuyer = findH('h4', 'Покупатель');
    const buyerWrap = hBuyer?.closest('.col-sm-3');
    const tblBuyer = hBuyer ? nearest(hBuyer.parentElement, 'table') : null;
    const buyer = {
      name: rowValueByLabel(tblBuyer, 'Имя пользователя'),
      email: rowValueByLabel(tblBuyer, 'Email'),
      rating: rowValueByLabel(tblBuyer, 'Рейтинг'),
      ip: rowValueByLabel(tblBuyer, 'IP адрес'),
      profile: (hBuyer?.querySelector('a') || {}).href || ''
    };

    const hRev = findH('h4', 'Отзыв покупателя');
    const tblRev = hRev ? nearest(hRev.parentElement, 'table') : null;
    const review = {
      text: rowValueByLabel(tblRev, 'Текст отзыва'),
      rating: rowValueByLabel(tblRev, 'Оценка'),
      date: rowValueByLabel(tblRev, 'Дата отзыва'),
    };
    const reviewExists = !isEmptyVal(review.text) || !isEmptyVal(review.rating) || !isEmptyVal(review.date);

    const hCost = findH('.box .box-header .box-title, .box .box-header h3', 'Информация о стоимости')?.closest('.box');
    const tblCost = hCost ? hCost.querySelector('table') : null;
    const cost = {
      price_no_opts: rowValueByLabel(tblCost, 'Стоимость товара (без учета опций)'),
      price_with_opts: rowValueByLabel(tblCost, 'Стоимость товара (с учетом опций)'),
      fee_cat_pct: rowValueByLabel(tblCost, 'Комиссия категории (%)'),
      fee_cat: rowValueByLabel(tblCost, 'Комиссия категории'),
      fee_ps_pct: rowValueByLabel(tblCost, 'Комиссия платежной системы (%)'),
      fee_ps_fixed_pct: rowValueByLabel(tblCost, 'Фикс. комиссия платежной системы (%)'),
      fee_ps: rowValueByLabel(tblCost, 'Комиссия платежной системы'),
      total: rowValueByLabel(tblCost, 'Итого'),
      seller_reward: rowValueByLabel(tblCost, 'Награда продавцу'),
    };

    const hProdBox = findH('.box .box-header .box-title, .box .box-header h3', 'Информация о выбранном товаре')?.closest('.box');
    const tblProd = hProdBox ? hProdBox.querySelector('table') : null;
    const prodFooter = hProdBox?.querySelector('.box-footer');
    const product = {
      title: rowValueByLabel(tblProd, 'Название товара'),
      status: rowValueByLabel(tblProd, 'Статус'),
      category: rowValueByLabel(tblProd, 'Категория'),
      delivery_type: rowValueByLabel(tblProd, 'Тип выдачи'),
      qty_available: rowValueByLabel(tblProd, 'Количество'),
      optionsRaw: rowValueByLabel(tblProd, 'Выбранные опции'),
      created_at: rowValueByLabel(tblProd, 'Дата создания'),
      link_admin: firstLinkWithin(prodFooter, 'Открыть товар'),
      link_public: firstLinkWithin(prodFooter, 'на GGSel'),
      link_category: firstLinkWithin(prodFooter, 'Категорию'),
    };
    product.options = product.optionsRaw
      ? product.optionsRaw.split(/<br\s*\/?>/i).map(s => norm(s)).filter(Boolean)
      : [];

    return {
      order, seller, buyer, review, reviewExists, cost, product, actions,
      domRefs: { mainBox, sellerWrap, buyerWrap, revWrap: hRev?.closest('.col-sm-3') || null, hCost, hProdBox }
    };
  }

  // ---------- hide old (not remove) ----------
  function hideOld(domRefs) {
    const blocks = [
      domRefs.mainBox,
      domRefs.sellerWrap?.closest('.box'),
      domRefs.buyerWrap?.closest('.box'),
      domRefs.revWrap?.closest('.box'),
      domRefs.hCost,
      domRefs.hProdBox,
    ].filter(Boolean);
    for (const b of blocks) {
      b.classList.add('vui-old-hidden');
      b.style.display = 'none';
    }
  }

  // ---------- styles (fully namespaced) ----------
  function injectStyles() {
    const css = `
:root{
  --vui-bg:#050506;
  --vui-card:#111214;
  --vui-line:#1e1f22;
  --vui-text:#eaeaea;
  --vui-muted:#9aa1a7;
  --vui-accent:#4c9bff;
  --vui-ok:#2ea043;
  --vui-info:#2f81f7;
  --vui-danger:#f85149;
}
body, .skin-blue .wrapper, .content-wrapper{
  background:var(--vui-bg)!important;
  color:var(--vui-text);
}
body{color-scheme:dark;}
.content{background:transparent;}
.content-header{display:none!important;}
.vui-wrap{
  margin-top:0;
  display:flex;
  flex-direction:column;
  gap:20px;
  padding:0 16px 32px;
}
.vui-wrap *{box-sizing:border-box;}
.vui-layout{display:grid;gap:16px;margin-top:16px;grid-template-columns:minmax(0,7fr) minmax(0,5fr);align-items:flex-start;}
.vui-layoutMain,.vui-layoutSide{display:flex;flex-direction:column;gap:16px;}
.vui-head{background:var(--vui-card);border:1px solid var(--vui-line);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:14px;}
.vui-headTitle{display:flex;align-items:center;gap:12px;flex-wrap:wrap;}
.vui-headLine{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;}
.vui-head h1{margin:0;font-size:20px;color:var(--vui-text);}
.vui-headStatus{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
.vui-headStats{display:flex;gap:16px;flex-wrap:wrap;}
.vui-headStat{display:flex;flex-direction:column;gap:2px;color:var(--vui-text);font-size:13px;}
.vui-headStat b{font-size:15px;}
.vui-headFooter{display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;}
.vui-headActions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;margin-left:auto;}
.vui-orderNumber{border:none;background:transparent;color:var(--vui-text);font:inherit;padding:0 6px;cursor:pointer;border-radius:6px;transition:background .2s ease,color .2s ease;position:relative;}
.vui-orderNumber::after{content:'копировать';position:absolute;left:50%;bottom:-18px;transform:translateX(-50%);font-size:11px;color:var(--vui-muted);opacity:0;pointer-events:none;transition:opacity .2s ease;}
.vui-orderNumber:hover{color:var(--vui-accent);background:rgba(76,155,255,.08);}
.vui-orderNumber:hover::after{opacity:1;}
.vui-orderNumber:focus-visible{outline:2px solid var(--vui-accent);outline-offset:2px;}
.vui-isCopied{animation:vuiCopyPulse .9s ease-out;}
.vui-chip{display:inline-block;padding:.2rem .5rem;border-radius:999px;background:#222;border:1px solid #333;font-weight:600;color:var(--vui-text);}
.vui-chip--success{background:rgba(46,160,67,.15);border-color:#295f36;color:#43d17a;}
.vui-chip--info{background:rgba(47,129,247,.15);border-color:#2f81f7;color:#9ec3ff;}
.vui-chip--warn{background:rgba(255,211,105,.15);border-color:#977f2d;color:#ffd369;}
.vui-chrono{display:flex;flex-wrap:wrap;gap:20px;padding-top:12px;border-top:1px dashed #1f2023;margin-top:4px;}
.vui-chronoItem{min-width:160px;display:flex;flex-direction:column;gap:4px;}
.vui-chronoLabel{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--vui-muted);}
.vui-chronoMoment{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-weight:600;color:var(--vui-text);}
.vui-chronoTime{font-size:13px;}
.vui-chronoDate{font-size:12px;color:var(--vui-muted);}
.vui-btn{padding:8px 12px;border-radius:10px;border:1px solid #2a2a2a;background:#1a1b1e;color:var(--vui-text);cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:6px;font:inherit;line-height:1.2;}
.vui-btn--primary{background:var(--vui-accent);color:#0b1526;}
.vui-btn--danger{border-color:#4a2222;background:#2a1212;}
.vui-btn--ghost{background:transparent;}
.vui-btn--ghost:hover,.vui-btn.is-open{background:#1f2024;}
.vui-layoutSide{min-width:280px;}
.vui-card,.vui-mini{border:1px solid var(--vui-line);border-radius:12px;background:var(--vui-card);color:var(--vui-text);}
.vui-card__head,.vui-mini__head{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px dashed #222;}
.vui-card__body{padding:12px 14px;}
.vui-title{font-weight:700;}
.vui-line{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px dashed #1a1a1a;}
.vui-line:last-child{border-bottom:0;}
.vui-card--note{background:#1c170a;border-color:#3b2f16;}
.vui-mini__head{gap:12px;align-items:flex-start;}
.vui-mini--seller{border-color:rgba(76,155,255,.6);box-shadow:0 0 0 1px rgba(76,155,255,.35);
}
.vui-avatar{width:40px;height:40px;border-radius:10px;background:#222;display:grid;place-items:center;font-weight:800;color:var(--vui-text);letter-spacing:.04em;}
.vui-avatar--seller{background:rgba(76,155,255,.18);color:var(--vui-accent);}
.vui-avatar--client{background:rgba(255,255,255,.05);}
.vui-metaBox{flex:1;}
.vui-mini__actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;}
.vui-metaRow{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
.vui-name{font-weight:700;color:var(--vui-text);text-decoration:none;}
.vui-productTitle{color:var(--vui-text);text-decoration:none;border-bottom:1px dashed transparent;padding-bottom:2px;transition:color .2s ease,border-color .2s ease;display:inline-flex;align-items:center;gap:6px;}
.vui-productTitle:hover{color:var(--vui-accent);border-color:var(--vui-accent);}
.vui-productTitle:focus-visible{outline:2px solid var(--vui-accent);outline-offset:2px;}
.vui-linkAction{cursor:pointer;color:inherit;text-decoration:none;position:relative;display:inline-flex;align-items:center;gap:4px;padding-bottom:2px;}
.vui-linkAction::after{content:'';position:absolute;left:0;right:0;bottom:0;height:1px;background:transparent;transition:background .2s ease;}
.vui-linkAction:hover{color:var(--vui-accent);}
.vui-linkAction:hover::after{background:var(--vui-accent);}
.vui-linkAction:focus-visible{outline:2px solid var(--vui-accent);outline-offset:2px;}
.vui-badge{padding:.15rem .4rem;border:1px solid #2a2a2a;border-radius:8px;color:var(--vui-text);}
.vui-badge.ip{cursor:pointer;}
.vui-muted{opacity:.7;color:var(--vui-muted);}
.vui-profileDetails{display:none;padding:12px 14px;border-top:1px dashed #222;background:#0f1012;border-bottom-left-radius:12px;border-bottom-right-radius:12px;}
.vui-profileDetails.open{display:block;}
.vui-profileDetails .vui-empty{color:var(--vui-muted);font-size:13px;}
.vui-detailGrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;margin-top:4px;}
.vui-detailItem{padding:10px;border:1px solid #1f2023;border-radius:10px;background:rgba(255,255,255,.02);display:flex;flex-direction:column;gap:4px;}
.vui-detailLabel{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--vui-muted);}
.vui-detailValue{font-weight:600;color:var(--vui-text);word-break:break-word;}
.vui-relatedActions{margin-top:14px;display:flex;gap:8px;flex-wrap:wrap;}
.vui-card--chat{display:flex;flex-direction:column;}
.vui-card--chat .vui-card__body{padding:0;}
.vui-chatBox{max-height:70vh;overflow:auto;padding:12px 14px;display:flex;flex-direction:column;gap:12px;}
.vui-chatBox .vui-empty{margin:auto;color:var(--vui-muted);text-align:center;}
.vui-chatMsg{display:grid;grid-template-columns:40px 1fr;gap:12px;padding:12px;border:1px solid #1f2023;border-radius:12px;background:rgba(255,255,255,.02);}
.vui-chatMsg--seller{background:rgba(76,123,255,.16);border-color:rgba(76,123,255,.4);}
.vui-chatAvatar{width:40px;height:40px;border-radius:10px;background:#1f2023;display:grid;place-items:center;font-weight:700;color:var(--vui-text);overflow:hidden;}
.vui-chatAvatar img{width:100%;height:100%;object-fit:cover;border-radius:10px;}
.vui-chatHead{display:flex;justify-content:space-between;align-items:center;gap:10px;}
.vui-chatAuthor{font-weight:600;color:var(--vui-text);}
.vui-chatMeta{display:flex;flex-direction:column;align-items:flex-end;font-size:12px;color:var(--vui-muted);gap:2px;}
.vui-chatStatus{font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--vui-muted);}
.vui-chatText{margin-top:6px;color:var(--vui-text);white-space:pre-wrap;word-break:break-word;}
.vui-productDescription{margin-top:12px;border:1px dashed #1f2023;border-radius:10px;background:rgba(255,255,255,.02);font-size:13px;color:var(--vui-text);}
.vui-desc{margin:0;display:flex;flex-direction:column;}
.vui-descToggle{appearance:none;border:none;background:none;color:inherit;text-align:left;display:flex;flex-direction:column;align-items:flex-start;gap:8px;font-weight:600;padding:12px 14px;cursor:pointer;transition:color .2s ease;}
.vui-descToggle[disabled]{cursor:default;}
.vui-descToggle[disabled]:hover{color:inherit;}
.vui-descToggle:focus-visible{outline:2px solid var(--vui-accent);outline-offset:2px;}
.vui-descToggle:hover{color:var(--vui-accent);}
.vui-descToggleText{font-size:12px;color:var(--vui-accent);letter-spacing:.04em;text-transform:uppercase;}
.vui-desc[data-collapsible="false"] .vui-descToggle{cursor:default;}
.vui-desc[data-collapsible="false"] .vui-descToggle:hover{color:inherit;}
.vui-desc[data-collapsible="false"] .vui-descToggleText{color:var(--vui-muted);}
.vui-desc[data-empty="true"] .vui-descToggleText{display:none;}
.vui-desc[data-collapsible="true"] .vui-descToggle{border-bottom:1px dashed #1f2023;}
.vui-descBody{padding:12px 14px;border-top:1px dashed #1f2023;line-height:1.5;display:flex;flex-direction:column;gap:8px;}
.vui-descBody p{margin:0;line-height:1.5;}
.vui-descBody p+p{margin-top:4px;}
.vui-desc[data-collapsible="true"][data-expanded="false"] .vui-descBody{max-height:7.2em;overflow:hidden;position:relative;}
.vui-desc[data-collapsible="true"][data-expanded="false"] .vui-descBody::after{content:'';position:absolute;left:0;right:0;bottom:0;height:48px;background:linear-gradient(0deg,var(--vui-card) 0%,rgba(17,18,20,0) 70%);pointer-events:none;}
.vui-badge.ip.vui-isCopied,.vui-orderNumber.vui-isCopied{box-shadow:0 0 0 0 rgba(76,155,255,.4);}
@keyframes vuiCopyPulse{0%{box-shadow:0 0 0 0 rgba(76,155,255,.5);background:rgba(76,155,255,.2);}100%{box-shadow:0 0 0 36px rgba(76,155,255,0);background:transparent;}}
.vui-old-hidden{display:none!important;}
@media(max-width:1200px){
  .vui-layout{grid-template-columns:1fr;}
}
@media(max-width:1024px){
  .vui-chrono{padding-top:8px;}
  .vui-chronoItem{min-width:140px;}
}
`;
    const s = document.createElement('style');
    s.textContent = css;
    document.head.appendChild(s);
  }

  function renderProfileDetails(profile, fallbackUrl) {
    if (!profile || profile.error) {
      const openBtn = fallbackUrl
        ? `<div class="vui-relatedActions"><a class="vui-btn vui-btn--ghost" href="${esc(fallbackUrl)}" target="_blank" rel="noopener noreferrer">Открыть профиль</a></div>`
        : '';
      return `<div class="vui-empty">Не удалось загрузить данные профиля.</div>${openBtn}`;
    }

    const detailItems = (profile.fields || []).map(field => `
      <div class="vui-detailItem">
        <div class="vui-detailLabel">${esc(field.label)}</div>
        <div class="vui-detailValue">${esc(field.value)}</div>
      </div>
    `).join('');

    const detailsBlock = detailItems
      ? `<div class="vui-detailGrid">${detailItems}</div>`
      : '<div class="vui-empty">Нет данных профиля.</div>';

    const openProfileBtn = fallbackUrl
      ? `<a class="vui-btn vui-btn--ghost" href="${esc(fallbackUrl)}" target="_blank" rel="noopener noreferrer">Открыть профиль</a>`
      : '';

    const chatBtn = profile.chatLink
      ? `<a class="vui-btn vui-btn--ghost" href="${esc(profile.chatLink)}" target="_blank" rel="noopener noreferrer">Чат</a>`
      : '';

    const relatedButtons = (profile.relatedLinks || [])
      .map(link => `<a class="vui-btn" href="${esc(link.href)}" target="_blank" rel="noopener noreferrer">${esc(link.label)}</a>`)
      .join('');

    const actionsBlock = (chatBtn || openProfileBtn || relatedButtons)
      ? `<div class="vui-relatedActions">${chatBtn}${openProfileBtn}${relatedButtons}</div>`
      : '';

    return `${detailsBlock}${actionsBlock}`;
  }

  function applyProfileData(wrap, role, profile, fallbackUrl) {
    const panel = wrap?.querySelector(`.vui-profileDetails[data-role="${role}"]`);
    if (!panel) return;
    panel.innerHTML = renderProfileDetails(profile, fallbackUrl);

    const chatButton = wrap?.querySelector(`[data-chat-role="${role}"]`);
    if (chatButton) {
      if (profile && profile.chatLink) {
        chatButton.setAttribute('href', profile.chatLink);
        chatButton.style.display = '';
        chatButton.setAttribute('target', '_blank');
        chatButton.setAttribute('rel', 'noopener noreferrer');
      } else {
        chatButton.removeAttribute('href');
        chatButton.style.display = 'none';
        chatButton.removeAttribute('target');
        chatButton.removeAttribute('rel');
      }
    }

  }

  function setupProfileToggles(wrap) {
    wrap?.querySelectorAll('.vui-profileToggle').forEach(btn => {
      btn.addEventListener('click', () => {
        const role = btn.dataset.role;
        const panel = wrap.querySelector(`.vui-profileDetails[data-role="${role}"]`);
        if (!panel) return;
        const open = !panel.classList.contains('open');
        panel.classList.toggle('open', open);
        btn.classList.toggle('is-open', open);
      });
    });
  }

  function loadProfileSections(data, wrap) {
    const jobs = [];
    if (data.seller.profile) {
      jobs.push(fetchProfileData(data.seller.profile)
        .then(profile => applyProfileData(wrap, 'seller', profile, data.seller.profile))
        .catch(() => applyProfileData(wrap, 'seller', { error: true }, data.seller.profile)));
    }
    if (data.buyer.profile) {
      jobs.push(fetchProfileData(data.buyer.profile)
        .then(profile => applyProfileData(wrap, 'buyer', profile, data.buyer.profile))
        .catch(() => applyProfileData(wrap, 'buyer', { error: true }, data.buyer.profile)));
    }

    if (jobs.length) {
      Promise.allSettled(jobs).then(() => log('Profile panels updated.'));
    }
  }

  function renderChatContent(chat, context = {}) {
    if (!chat || chat.error) {
      return `<div class="vui-empty">Не удалось загрузить диалог.</div>`;
    }

    if (!chat.messages || !chat.messages.length) {
      return `<div class="vui-empty">Диалог пуст.</div>`;
    }

    const normalizeName = (value) => norm(value || '').toLowerCase();
    const sellerNames = Array.isArray(context.sellerNames) && context.sellerNames.length
      ? context.sellerNames
      : [context.sellerName];
    const sellerSet = new Set(sellerNames.filter(Boolean).map(normalizeName));

    const items = chat.messages.map(msg => {
      const avatar = msg.avatar
        ? `<div class="vui-chatAvatar"><img src="${esc(msg.avatar)}" alt="" /></div>`
        : `<div class="vui-chatAvatar">${esc((msg.author || 'U').slice(0, 2).toUpperCase())}</div>`;
      const status = msg.status ? `<div class="vui-chatStatus">${esc(msg.status)}</div>` : '';
      const timestamp = msg.timestamp ? `<div>${esc(msg.timestamp)}</div>` : '';
      const isSeller = sellerSet.size ? sellerSet.has(normalizeName(msg.author)) : false;
      const msgClass = isSeller ? 'vui-chatMsg vui-chatMsg--seller' : 'vui-chatMsg';
      return `
        <div class="${msgClass}">
          ${avatar}
          <div>
            <div class="vui-chatHead">
              <div class="vui-chatAuthor">${esc(msg.author)}</div>
              <div class="vui-chatMeta">${timestamp}${status}</div>
            </div>
            <div class="vui-chatText">${esc(msg.text)}</div>
          </div>
        </div>
      `;
    }).join('');

    return `${items}`;
  }

  function loadChatSection(data, wrap) {
    const panel = wrap?.querySelector('[data-chat-panel]');
    if (!panel || !data.actions.chat) return;

    panel.innerHTML = '<div class="vui-empty">Загрузка диалога…</div>';

    const context = {
      sellerNames: [data.seller?.name].filter(Boolean),
      sellerName: data.seller?.name,
    };

    fetchChatData(data.actions.chat)
      .then(chat => {
        panel.innerHTML = renderChatContent(chat, context);
      })
      .catch(() => {
        panel.innerHTML = renderChatContent({ error: true });
      });
  }

  function renderProductDescription(productData) {
    const errorState = {
      html: '<div class="vui-empty">Не удалось загрузить описание товара.</div>',
      collapsible: false,
      isEmpty: true,
    };

    if (!productData || productData.error) {
      return errorState;
    }

    const plain = cleanMultiline(productData.description || '');
    if (!plain) {
      return {
        html: '<div class="vui-empty">Описание товара отсутствует.</div>',
        collapsible: false,
        isEmpty: true,
      };
    }

    const blocks = plain
      .split(/\n{2,}/)
      .map(chunk => chunk.trim())
      .filter(Boolean);

    const html = blocks.map(block => {
      const lines = block.split(/\n+/).map(line => esc(line)).join('<br>');
      return `<p>${lines}</p>`;
    }).join('');

    const approxLines = plain.split('\n').length;
    const collapsible = approxLines > 4 || plain.length > 480;

    return {
      html,
      collapsible,
      isEmpty: false,
    };
  }

  function loadProductSection(data, wrap) {
    if (!data.product.link_admin) return;
    const container = wrap?.querySelector('[data-product-description]');
    if (!container) return;

    const descEl = container.querySelector('.vui-desc');
    const bodyEl = container.querySelector('[data-desc-body]');
    if (bodyEl) bodyEl.innerHTML = '<p class="vui-muted">Загрузка описания…</p>';
    const toggleEl = container.querySelector('[data-desc-toggle]');
    const toggleTextEl = container.querySelector('[data-desc-toggle-text]');
    if (toggleEl) {
      toggleEl.disabled = true;
      toggleEl.addEventListener('click', () => {
        if (toggleEl.disabled || !descEl) return;
        const expanded = descEl.getAttribute('data-expanded') === 'true';
        const nextExpanded = !expanded;
        descEl.setAttribute('data-expanded', nextExpanded ? 'true' : 'false');
        toggleEl.setAttribute('aria-expanded', nextExpanded ? 'true' : 'false');
        if (toggleTextEl) toggleTextEl.textContent = nextExpanded ? 'Свернуть' : 'Развернуть';
      });
    }
    if (descEl) {
      descEl.setAttribute('data-collapsible', 'false');
      descEl.setAttribute('data-expanded', 'true');
      descEl.removeAttribute('data-empty');
    }
    if (toggleEl) toggleEl.setAttribute('aria-expanded', 'true');
    if (toggleTextEl) toggleTextEl.textContent = '';

    fetchProductData(data.product.link_admin)
      .then(productData => {
        const rendered = renderProductDescription(productData);
        if (bodyEl) bodyEl.innerHTML = rendered.html;
        if (descEl) {
          if (rendered.isEmpty) {
            descEl.setAttribute('data-empty', 'true');
            descEl.setAttribute('data-expanded', 'true');
          } else {
            descEl.removeAttribute('data-empty');
          }
          if (rendered.collapsible) {
            descEl.setAttribute('data-collapsible', 'true');
            descEl.setAttribute('data-expanded', 'false');
            if (toggleEl) toggleEl.setAttribute('aria-expanded', 'false');
            if (toggleTextEl) toggleTextEl.textContent = 'Развернуть';
          } else {
            descEl.setAttribute('data-collapsible', 'false');
            descEl.setAttribute('data-expanded', 'true');
            if (toggleEl) toggleEl.setAttribute('aria-expanded', 'true');
            if (toggleTextEl) toggleTextEl.textContent = '';
          }
        }
        if (descEl && rendered.collapsible && toggleEl) {
          toggleEl.disabled = false;
        } else if (toggleEl) {
          toggleEl.disabled = true;
        }
      })
      .catch(() => {
        const rendered = renderProductDescription({ error: true });
        if (bodyEl) bodyEl.innerHTML = rendered.html;
        if (descEl) {
          descEl.setAttribute('data-empty', 'true');
          descEl.setAttribute('data-collapsible', 'false');
          descEl.setAttribute('data-expanded', 'true');
        }
        if (toggleEl) {
          toggleEl.setAttribute('aria-expanded', 'true');
          toggleEl.disabled = true;
        }
        if (toggleTextEl) toggleTextEl.textContent = '';
      });
  }

  // ---------- build ----------
  function buildUI(data) {
    const chip = (s) => {
      const v = (s || '').toLowerCase();
      if (v.includes('оплачен')) return 'vui-chip vui-chip--success';
      if (v.includes('progress') || v.includes('в процессе')) return 'vui-chip vui-chip--info';
      return 'vui-chip vui-chip--warn';
    };
    const rate = (r) => isEmptyVal(r) ? '' : `${r}★`;
    const safe = (v) => isEmptyVal(v) ? '' : v;

    const chronologyOrder = [
      { key: 'created_at', label: 'Создан' },
      { key: 'paid_at', label: 'Оплата' },
      { key: 'confirmed_at', label: 'Подтверждение' },
      { key: 'refunded_at', label: 'Возврат' },
      { key: 'archived_at', label: 'Архивирование' },
      { key: 'updated_at', label: 'Обновление' },
      { key: 'canceled_at', label: 'Отмена' },
    ];
    const chronology = chronologyOrder
      .map(item => {
        const raw = data.order[item.key];
        if (isEmptyVal(raw)) return null;
        const parts = splitDateParts(raw);
        const hasTime = Boolean(parts.time);
        let rest = raw;
        if (hasTime) {
          const idx = raw.indexOf(parts.time);
          if (idx >= 0) {
            const before = raw.slice(0, idx).trimEnd();
            const after = raw.slice(idx + parts.time.length).trimStart();
            rest = [before, after].filter(Boolean).join(' ').trim();
          } else {
            rest = raw.replace(parts.time, '').trim();
          }
        }
        const dateValue = stripTimezoneSuffix(parts.date || rest || (hasTime ? '' : raw));
        return {
          ...item,
          raw,
          time: hasTime ? parts.time : '',
          date: dateValue || '',
          dateObj: toDateObj(raw),
        };
      })
      .filter(Boolean)
      .sort((a, b) => {
        if (a.dateObj && b.dateObj) return a.dateObj - b.dateObj;
        if (a.dateObj) return -1;
        if (b.dateObj) return 1;
        return String(a.raw).localeCompare(String(b.raw));
      });
    const chronologyMarkup = chronology.length
      ? `<div class="vui-chrono">${chronology.map(item => `
          <div class="vui-chronoItem">
            <div class="vui-chronoLabel">${esc(item.label)}</div>
            <div class="vui-chronoMoment">
              ${item.time ? `<span class="vui-chronoTime">${esc(item.time)}</span>` : ''}
              ${item.date ? `<span class="vui-chronoDate">${esc(item.date)}</span>` : ''}
            </div>
          </div>
        `).join('')}</div>`
      : '';

    const orderNumberValue = safe(data.order.number);
    const orderUuidValue = safe(data.order.uuid);

    const statusChip = safe(data.order.status)
      ? `<span class="${chip(data.order.status)}">${esc(data.order.status)}</span>`
      : '';
    const statusBlock = statusChip ? `<div class="vui-headStatus">${statusChip}</div>` : '';
    const totalBlock = safe(data.cost.total)
      ? `<div class="vui-headStat"><span class="vui-muted">Итого</span><b>${esc(data.cost.total)}</b></div>`
      : '';
    const rewardLabelTop = data.actions.reward
      ? `<a class="vui-muted vui-linkAction" href="${esc(data.actions.reward)}">Награда продавцу</a>`
      : '<span class="vui-muted">Награда продавцу</span>';
    const paymentLabel = data.actions.ps
      ? `<a class="vui-linkAction" href="${esc(data.actions.ps)}">Платёжная система</a>`
      : 'Платёжная система';
    const rewardLabelPayment = data.actions.reward
      ? `<a class="vui-linkAction" href="${esc(data.actions.reward)}">Награда продавцу</a>`
      : 'Награда продавцу';
    const rewardBlock = safe(data.cost.seller_reward)
      ? `<div class="vui-headStat">${rewardLabelTop}<b>${esc(data.cost.seller_reward)}</b></div>`
      : '';
    const bottomButtons = [
      data.actions.close ? `<a class="vui-btn" href="${esc(data.actions.close)}">Закрыть сделку</a>` : '',
      data.actions.refund ? `<a class="vui-btn vui-btn--danger" href="${esc(data.actions.refund)}">Возврат</a>` : '',
      data.actions.edit ? `<a class="vui-btn" href="${esc(data.actions.edit)}">Редактировать</a>` : '',
    ].filter(Boolean).join('');

    const statsSection = (totalBlock || rewardBlock)
      ? `<div class="vui-headStats">${totalBlock}${rewardBlock}</div>`
      : '';
    const headActions = bottomButtons
      ? `<div class="vui-headActions">${bottomButtons}</div>`
      : '';
    const headFooter = (statsSection || headActions)
      ? `<div class="vui-headFooter">${statsSection}${headActions}</div>`
      : '';

    const wrap = document.createElement('div');
    wrap.className = 'vui-wrap';
    const categoryLine = safe(data.product.category)
      ? `<div class="vui-line"><span>${data.product.link_category ? `<a class="vui-linkAction" href="${esc(data.product.link_category)}">Категория</a>` : 'Категория'}</span><b>${esc(data.product.category)}</b></div>`
      : '';

    const productDescriptionBlock = data.product.link_admin
      ? `<div class="vui-productDescription" data-product-description>
          <div class="vui-desc" data-collapsible="false" data-expanded="true">
            <button class="vui-descToggle" type="button" data-desc-toggle aria-expanded="true">
              <span>Описание товара</span>
              <span class="vui-descToggleText" data-desc-toggle-text></span>
            </button>
            <div class="vui-descBody" data-desc-body><p class="vui-muted">Загрузка описания…</p></div>
          </div>
        </div>`
      : '';

    const productTitleValue = safe(data.product.title);
    const productTitleMarkup = productTitleValue
      ? (data.product.link_admin
        ? `<a class="vui-productTitle" data-product-title data-public-link="${esc(data.product.link_public || '')}" href="${esc(data.product.link_admin)}" title="Клик — открыть товар, Alt+клик — на GGSel">${esc(productTitleValue)}</a>`
        : esc(productTitleValue))
      : 'Товар';

    const orderUuidAttr = orderUuidValue ? ` data-uuid="${esc(orderUuidValue)}"` : '';
    const orderTitleMarkup = orderNumberValue
      ? `Заказ №<button class="vui-orderNumber" type="button" data-order-number${orderUuidAttr} title="Клик — скопировать номер, Alt+клик — UUID">${esc(orderNumberValue)}</button>`
      : 'Заказ';

    wrap.innerHTML = `
      <section class="vui-layout">
        <div class="vui-layoutMain">
          <article class="vui-head">
            <div class="vui-headLine">
              <div class="vui-headTitle">
                <h1>${orderTitleMarkup}</h1>
              </div>
              ${statusBlock}
            </div>
            ${headFooter}
            ${chronologyMarkup}
          </article>

          <article class="vui-card">
            <header class="vui-card__head">
              <div class="vui-title">${productTitleMarkup}</div>
              ${safe(data.product.status) ? `<span class="vui-chip vui-chip--info">${data.product.status}</span>` : ''}
            </header>
            <div class="vui-card__body">
              ${categoryLine}
              ${safe(data.product.delivery_type) ? `<div class="vui-line"><span>Тип выдачи</span><b>${data.product.delivery_type}</b></div>` : ''}
              ${Array.isArray(data.product.options) && data.product.options.length ? `
                <details class="vui-acc"><summary>Выбранные опции</summary>
                  <ul style="margin:8px 0 0 18px;">
                    ${data.product.options.map(li => `<li>${li}</li>`).join('')}
                  </ul>
                </details>` : ''}
              ${productDescriptionBlock}
            </div>
          </article>

          <article class="vui-card">
            <header class="vui-card__head"><div class="vui-title">Оплата и комиссии</div></header>
            <div class="vui-card__body" style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;">
              ${safe(data.order.payment_system) ? `<div class="vui-line"><span>${paymentLabel}</span><b>${data.order.payment_system}</b></div>` : ''}
              ${safe(data.order.quantity) ? `<div class="vui-line"><span>Количество</span><b>${data.order.quantity}</b></div>` : ''}
              ${safe(data.cost.fee_cat) ? `<div class="vui-line"><span>Комиссия категории</span><b>${data.cost.fee_cat}${safe(data.cost.fee_cat_pct) ? ` (${data.cost.fee_cat_pct})` : ''}</b></div>` : ''}
              ${safe(data.cost.fee_ps) ? `<div class="vui-line"><span>Комиссия ПС</span><b>${data.cost.fee_ps}${safe(data.cost.fee_ps_pct) ? ` (${data.cost.fee_ps_pct})` : ''}</b></div>` : ''}
              ${safe(data.cost.total) ? `<div class="vui-line"><span>Итого</span><b>${data.cost.total}</b></div>` : ''}
              ${safe(data.cost.seller_reward) ? `<div class="vui-line"><span>${rewardLabelPayment}</span><b>${data.cost.seller_reward}</b></div>` : ''}
            </div>
          </article>

          ${safe(data.order.admin_comment) ? `
          <article class="vui-card vui-card--note">
            <header class="vui-card__head"><div class="vui-title">Комментарий админа</div></header>
            <div class="vui-card__body"><p>${data.order.admin_comment}</p></div>
          </article>` : ''}
        </div>

        <div class="vui-layoutSide">
          <article class="vui-mini vui-mini--seller">
            <header class="vui-mini__head">
              <div class="vui-avatar vui-avatar--seller">SEL</div>
              <div class="vui-metaBox">
                <div class="vui-metaRow">
                  <a class="vui-name" href="${data.seller.profile || '#'}">${safe(data.seller.name)}</a>
                  ${rate(data.seller.rating) ? `<span class="vui-badge">${rate(data.seller.rating)}</span>` : ''}
                </div>
                ${safe(data.seller.email) ? `<div class="vui-metaRow"><span>${data.seller.email}</span></div>` : ''}
              </div>
              <div class="vui-mini__actions">
                ${data.seller.profile ? `<a class="vui-btn vui-btn--ghost" data-chat-role="seller" style="display:none;">Чат</a>` : ''}
                ${data.seller.profile ? `<button class="vui-btn vui-btn--ghost vui-profileToggle" type="button" data-role="seller">Профиль</button>` : ''}
              </div>
            </header>
            <div class="vui-profileDetails" data-role="seller">
              ${data.seller.profile ? '<div class="vui-empty">Загрузка профиля…</div>' : '<div class="vui-empty">Ссылка на профиль не найдена.</div>'}
            </div>
          </article>

          <article class="vui-mini">
            <header class="vui-mini__head">
              <div class="vui-avatar vui-avatar--client">CLI</div>
              <div class="vui-metaBox">
                <div class="vui-metaRow">
                  <a class="vui-name" href="${data.buyer.profile || '#'}">${safe(data.buyer.name)}</a>
                </div>
                <div class="vui-metaRow">
                  ${safe(data.buyer.email) ? `<span>${data.buyer.email}</span>` : ''}
                  ${safe(data.buyer.ip) ? `<span class="vui-badge vui-badge ip" title="Клик — скопировать IP">${data.buyer.ip}</span>` : ''}
                </div>
              </div>
              <div class="vui-mini__actions">
                ${data.buyer.profile ? `<a class="vui-btn vui-btn--ghost" data-chat-role="buyer" style="display:none;">Чат</a>` : ''}
                ${data.buyer.profile ? `<button class="vui-btn vui-btn--ghost vui-profileToggle" type="button" data-role="buyer">Профиль</button>` : ''}
              </div>
            </header>
            <div class="vui-profileDetails" data-role="buyer">
              ${data.buyer.profile ? '<div class="vui-empty">Загрузка профиля…</div>' : '<div class="vui-empty">Ссылка на профиль не найдена.</div>'}
            </div>
          </article>

          ${data.actions.chat ? `
          <article class="vui-card vui-card--chat">
            <header class="vui-card__head">
              <div class="vui-title">${data.actions.chat ? `<a class="vui-linkAction" href="${data.actions.chat}" target="_blank" rel="noopener noreferrer">Диалог</a>` : 'Диалог'}</div>
            </header>
            <div class="vui-card__body">
              <div class="vui-chatBox" data-chat-panel>
                <div class="vui-empty">Загрузка диалога…</div>
              </div>
            </div>
          </article>` : ''}

          ${data.reviewExists ? `
          <article class="vui-card">
            <header class="vui-card__head"><div class="vui-title">Отзыв покупателя</div></header>
            <div class="vui-card__body">
              ${safe(data.review.rating) ? `<div class="vui-line"><span>Оценка</span><b>${data.review.rating}★</b></div>` : ''}
              ${safe(data.review.text) ? `<p style="margin:6px 0 0">${data.review.text}</p>` : ''}
              ${safe(data.review.date) ? `<div class="vui-muted" style="margin-top:6px">${data.review.date}</div>` : ''}
            </div>
          </article>` : ''}
        </div>
      </section>
    `;

    const content = document.querySelector('section.content');
    content?.insertBefore(wrap, content.firstElementChild?.nextElementSibling || content.firstChild);

    setupProfileToggles(wrap);
    // copy handlers
    const ipBadge = wrap.querySelector('.vui-badge.ip');
    if (ipBadge) {
      ipBadge.addEventListener('click', () => copy(data.buyer.ip, ipBadge));
    }
    const orderNumberEl = wrap.querySelector('[data-order-number]');
    if (orderNumberEl) {
      orderNumberEl.addEventListener('click', (event) => {
        const useUuid = event.altKey && orderUuidValue;
        const targetValue = useUuid ? orderUuidValue : orderNumberValue;
        if (!targetValue) return;
        event.preventDefault();
        copy(targetValue, orderNumberEl);
      });
      orderNumberEl.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        const useUuid = event.altKey && orderUuidValue;
        const targetValue = useUuid ? orderUuidValue : orderNumberValue;
        if (targetValue) copy(targetValue, orderNumberEl);
      });
    }

    const productTitleEl = wrap.querySelector('[data-product-title]');
    if (productTitleEl) {
      productTitleEl.addEventListener('click', (event) => {
        const publicLink = productTitleEl.getAttribute('data-public-link');
        if (event.altKey && publicLink) {
          event.preventDefault();
          window.open(publicLink, '_blank', 'noopener,noreferrer');
        }
      });
    }
    return wrap;
  }

  // ---------- main ----------
  function main() {
    const isOrderPage = /\/admin\/orders\/\d+($|[?#])/.test(location.pathname);
    if (!isOrderPage) return;

    injectStyles();
    const data = collectData();
    log('Collected:', data);

    hideOld(data.domRefs);
    const wrap = buildUI(data);
    loadProfileSections(data, wrap);
    loadChatSection(data, wrap);
    loadProductSection(data, wrap);
    log('Overlay ready (namespaced styles).');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
  } else {
    setTimeout(main, 50);
  }
})();
