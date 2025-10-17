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
  const copy = (s) => { try { navigator.clipboard?.writeText(s); } catch {} };
  const profileCache = new Map();

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
.vui-wrap{ --vui-bg:#0b0b0c; --vui-card:#111214; --vui-line:#1e1f22; --vui-text:#eaeaea; --vui-muted:#9aa1a7;
          --vui-accent:#ffd369; --vui-ok:#2ea043; --vui-info:#2f81f7; --vui-danger:#f85149; margin-top:12px; }
.vui-wrap *{ box-sizing:border-box; }
.vui-head{display:grid;grid-template-columns:1fr auto;gap:16px;align-items:center;padding:16px;border:1px solid var(--vui-line);border-radius:12px;background:var(--vui-card)}
.vui-head h1{margin:0;font-size:18px;color:var(--vui-text)}
.vui-chip{display:inline-block;padding:.2rem .5rem;border-radius:999px;background:#222;border:1px solid #333;font-weight:600;color:var(--vui-text)}
.vui-chip--success{background:rgba(46,160,67,.15);border-color:#295f36;color:#43d17a}
.vui-chip--info{background:rgba(47,129,247,.15);border-color:#2f81f7;color:#9ec3ff}
.vui-chip--warn{background:rgba(255,211,105,.15);border-color:#977f2d;color:#ffd369}
.vui-meta{display:flex;gap:10px;flex-wrap:wrap;color:var(--vui-muted)}
.vui-total{display:flex;gap:24px;color:var(--vui-text)}
.vui-total b{font-size:16px}
.vui-actions .vui-btn{margin-left:8px}

.vui-btn{padding:8px 12px;border-radius:10px;border:1px solid #2a2a2a;background:#1a1b1e;color:var(--vui-text);cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:6px;font:inherit;line-height:1.2}
.vui-btn--primary{background:var(--vui-accent);color:#111}
.vui-btn--danger{border-color:#4a2222;background:#2a1212}
.vui-btn--ghost{background:transparent}
.vui-btn--ghost:hover,.vui-btn.is-open{background:#1f2024}

.vui-grid{display:grid;grid-template-columns:repeat(12,1fr);gap:16px;margin-top:16px}
.vui-col-7{grid-column:span 7}
.vui-col-5{grid-column:span 5}
@media(max-width:1200px){.vui-col-7,.vui-col-5{grid-column:span 12}}

.vui-card,.vui-mini{border:1px solid var(--vui-line);border-radius:12px;background:var(--vui-card);margin-bottom:16px;color:var(--vui-text)}
.vui-card__head,.vui-mini__head{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px dashed #222}
.vui-card__body{padding:12px 14px}
.vui-title{font-weight:700}
.vui-line{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px dashed #1a1a1a}
.vui-line:last-child{border-bottom:0}
.vui-timeline{list-style:none;margin:0;padding:12px 14px}
.vui-timeline li{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px dashed #1a1a1a}
.vui-timeline li:last-child{border-bottom:0}
.vui-card--note{background:#1c170a;border-color:#3b2f16}

.vui-mini__head{gap:12px}
.vui-avatar{width:40px;height:40px;border-radius:10px;background:#222;display:grid;place-items:center;font-weight:800;color:var(--vui-text)}
.vui-metaBox{flex:1}
.vui-mini__actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.vui-mini__head{align-items:flex-start}
.vui-metaRow{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.vui-name{font-weight:700;color:var(--vui-text);text-decoration:none}
.vui-badge{padding:.15rem .4rem;border:1px solid #2a2a2a;border-radius:8px;color:var(--vui-text)}
.vui-badge.ip{cursor:pointer}
.vui-muted{opacity:.7;color:var(--vui-muted)}

.vui-profileDetails{display:none;padding:12px 14px;border-top:1px dashed #222;background:#0f1012;border-bottom-left-radius:12px;border-bottom-right-radius:12px}
.vui-profileDetails.open{display:block}
.vui-profileDetails .vui-empty{color:var(--vui-muted);font-size:13px}
.vui-detailGrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;margin-top:4px}
.vui-detailItem{padding:10px;border:1px solid #1f2023;border-radius:10px;background:rgba(255,255,255,.02);display:flex;flex-direction:column;gap:4px}
.vui-detailLabel{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--vui-muted)}
.vui-detailValue{font-weight:600;color:var(--vui-text);word-break:break-word}
.vui-relatedActions{margin-top:14px;display:flex;gap:8px;flex-wrap:wrap}

.vui-old-hidden{display:none!important}
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

    const relatedButtons = (profile.relatedLinks || [])
      .map(link => `<a class="vui-btn" href="${esc(link.href)}" target="_blank" rel="noopener noreferrer">${esc(link.label)}</a>`)
      .join('');

    const actionsBlock = (openProfileBtn || relatedButtons)
      ? `<div class="vui-relatedActions">${openProfileBtn}${relatedButtons}</div>`
      : '';

    return `${detailsBlock}${actionsBlock}`;
  }

  function applyProfileData(wrap, role, profile, fallbackUrl) {
    const panel = wrap?.querySelector(`.vui-profileDetails[data-role="${role}"]`);
    if (!panel) return;
    panel.innerHTML = renderProfileDetails(profile, fallbackUrl);

    const chatBtn = wrap.querySelector(`.vui-chatBtn[data-role="${role}"]`);
    if (chatBtn) {
      if (profile && !profile.error && profile.chatLink) {
        chatBtn.href = profile.chatLink;
        chatBtn.style.display = 'inline-flex';
      } else {
        chatBtn.style.display = 'none';
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

    const wrap = document.createElement('div');
    wrap.className = 'vui-wrap';

    wrap.innerHTML = `
      <section class="vui-head">
        <div>
          <h1>${data.order.number ? `Заказ №${data.order.number}` : 'Заказ'}</h1>
          <div class="vui-meta">
            ${safe(data.order.status) ? `<span class="${chip(data.order.status)}">${data.order.status}</span>` : ''}
            ${safe(data.order.paid_at) ? `<span>Оплата: <b>${data.order.paid_at}</b></span>` : ''}
            ${safe(data.order.created_at) ? `<span>Создан: <b>${data.order.created_at}</b></span>` : ''}
          </div>
        </div>
        <div>
          <div class="vui-total">
            ${safe(data.cost.total) ? `<div><span class="vui-muted">Итого</span><br><b>${data.cost.total}</b></div>` : ''}
            ${safe(data.cost.seller_reward) ? `<div><span class="vui-muted">Награда продавцу</span><br><b>${data.cost.seller_reward}</b></div>` : ''}
          </div>
          <div class="vui-actions" style="margin-top:8px;">
            ${data.actions.chat ? `<a class="vui-btn vui-btn--primary" href="${data.actions.chat}">Открыть диалог</a>` : ''}
            ${data.actions.close ? `<a class="vui-btn" href="${data.actions.close}">Закрыть</a>` : ''}
            ${data.actions.refund ? `<a class="vui-btn vui-btn--danger" href="${data.actions.refund}">Возврат</a>` : ''}
          </div>
        </div>
      </section>

      <section class="vui-grid">
        <div class="vui-col-7">
          <article class="vui-card">
            <header class="vui-card__head">
              <div class="vui-title">${safe(data.product.title)}</div>
              ${safe(data.product.status) ? `<span class="vui-chip vui-chip--info">${data.product.status}</span>` : ''}
            </header>
            <div class="vui-card__body">
              ${safe(data.product.category) ? `<div class="vui-line"><span>Категория</span><b>${data.product.category}</b></div>` : ''}
              ${safe(data.product.delivery_type) ? `<div class="vui-line"><span>Тип выдачи</span><b>${data.product.delivery_type}</b></div>` : ''}
              ${Array.isArray(data.product.options) && data.product.options.length ? `
                <details class="vui-acc"><summary>Выбранные опции</summary>
                  <ul style="margin:8px 0 0 18px;">
                    ${data.product.options.map(li => `<li>${li}</li>`).join('')}
                  </ul>
                </details>` : ''}
              <div class="vui-line" style="border-bottom:0;gap:8px;justify-content:flex-start;flex-wrap:wrap;margin-top:6px;">
                ${data.product.link_admin ? `<a class="vui-btn" href="${data.product.link_admin}">Открыть товар</a>` : ''}
                ${data.product.link_public ? `<a class="vui-btn" href="${data.product.link_public}" target="_blank">На GGSel</a>` : ''}
                ${data.product.link_category ? `<a class="vui-btn" href="${data.product.link_category}">Категория</a>` : ''}
              </div>
            </div>
          </article>

          <article class="vui-card">
            <header class="vui-card__head"><div class="vui-title">Оплата и комиссии</div></header>
            <div class="vui-card__body" style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;">
              ${safe(data.order.payment_system) ? `<div class="vui-line"><span>Платёжная система</span><b>${data.order.payment_system}</b></div>` : ''}
              ${safe(data.order.quantity) ? `<div class="vui-line"><span>Количество</span><b>${data.order.quantity}</b></div>` : ''}
              ${safe(data.cost.fee_cat) ? `<div class="vui-line"><span>Комиссия категории</span><b>${data.cost.fee_cat}${safe(data.cost.fee_cat_pct) ? ` (${data.cost.fee_cat_pct})` : ''}</b></div>` : ''}
              ${safe(data.cost.fee_ps) ? `<div class="vui-line"><span>Комиссия ПС</span><b>${data.cost.fee_ps}${safe(data.cost.fee_ps_pct) ? ` (${data.cost.fee_ps_pct})` : ''}</b></div>` : ''}
              ${safe(data.cost.total) ? `<div class="vui-line"><span>Итого</span><b>${data.cost.total}</b></div>` : ''}
              ${safe(data.cost.seller_reward) ? `<div class="vui-line"><span>Награда продавцу</span><b>${data.cost.seller_reward}</b></div>` : ''}
            </div>
          </article>

          <article class="vui-card">
            <header class="vui-card__head"><div class="vui-title">Хронология</div></header>
            <ul class="vui-timeline">
              ${safe(data.order.paid_at) ? `<li><span>Оплата</span><b>${data.order.paid_at}</b></li>` : ''}
              ${safe(data.order.confirmed_at) ? `<li><span>Подтверждение</span><b>${data.order.confirmed_at}</b></li>` : ''}
              ${safe(data.order.refunded_at) ? `<li><span>Возврат</span><b>${data.order.refunded_at}</b></li>` : ''}
              ${safe(data.order.archived_at) ? `<li><span>Архивирование</span><b>${data.order.archived_at}</b></li>` : ''}
              ${safe(data.order.updated_at) ? `<li><span>Обновление</span><b>${data.order.updated_at}</b></li>` : ''}
              ${safe(data.order.created_at) ? `<li><span>Создан</span><b>${data.order.created_at}</b></li>` : ''}
            </ul>
          </article>

          ${safe(data.order.admin_comment) ? `
          <article class="vui-card vui-card--note">
            <header class="vui-card__head"><div class="vui-title">Комментарий админа</div></header>
            <div class="vui-card__body"><p>${data.order.admin_comment}</p></div>
          </article>` : ''}
        </div>

        <div class="vui-col-5">
          <article class="vui-mini">
            <header class="vui-mini__head">
              <div class="vui-avatar">${(data.seller.name || 'U').slice(0,2).toUpperCase()}</div>
              <div class="vui-metaBox">
                <div class="vui-metaRow">
                  <a class="vui-name" href="${data.seller.profile || '#'}">${safe(data.seller.name)}</a>
                  ${rate(data.seller.rating) ? `<span class="vui-badge">${rate(data.seller.rating)}</span>` : ''}
                </div>
                ${safe(data.seller.email) ? `<div class="vui-metaRow"><span>${data.seller.email}</span></div>` : ''}
              </div>
              <div class="vui-mini__actions">
                <a class="vui-btn vui-btn--primary vui-chatBtn" data-role="seller" target="_blank" rel="noopener noreferrer" style="display:none;">Чат</a>
                ${data.seller.profile ? `<button class="vui-btn vui-btn--ghost vui-profileToggle" type="button" data-role="seller">Профиль</button>` : ''}
              </div>
            </header>
            <div class="vui-profileDetails" data-role="seller">
              ${data.seller.profile ? '<div class="vui-empty">Загрузка профиля…</div>' : '<div class="vui-empty">Ссылка на профиль не найдена.</div>'}
            </div>
          </article>

          <article class="vui-mini">
            <header class="vui-mini__head">
              <div class="vui-avatar">${(data.buyer.name || 'U').slice(0,2).toUpperCase()}</div>
              <div class="vui-metaBox">
                <div class="vui-metaRow">
                  <a class="vui-name" href="${data.buyer.profile || '#'}">${safe(data.buyer.name)}</a>
                  ${rate(data.buyer.rating) ? `<span class="vui-badge">${rate(data.buyer.rating)}</span>` : ''}
                </div>
                <div class="vui-metaRow">
                  ${safe(data.buyer.email) ? `<span>${data.buyer.email}</span>` : ''}
                  ${safe(data.buyer.ip) ? `<span class="vui-badge vui-badge ip" title="Клик — скопировать IP">${data.buyer.ip}</span>` : ''}
                </div>
              </div>
              <div class="vui-mini__actions">
                <a class="vui-btn vui-btn--primary vui-chatBtn" data-role="buyer" target="_blank" rel="noopener noreferrer" style="display:none;">Чат</a>
                ${data.buyer.profile ? `<button class="vui-btn vui-btn--ghost vui-profileToggle" type="button" data-role="buyer">Профиль</button>` : ''}
              </div>
            </header>
            <div class="vui-profileDetails" data-role="buyer">
              ${data.buyer.profile ? '<div class="vui-empty">Загрузка профиля…</div>' : '<div class="vui-empty">Ссылка на профиль не найдена.</div>'}
            </div>
          </article>

          ${data.reviewExists ? `
          <article class="vui-card">
            <header class="vui-card__head"><div class="vui-title">Отзыв покупателя</div></header>
            <div class="vui-card__body">
              ${safe(data.review.rating) ? `<div class="vui-line"><span>Оценка</span><b>${data.review.rating}★</b></div>` : ''}
              ${safe(data.review.text) ? `<p style="margin:6px 0 0">${data.review.text}</p>` : ''}
              ${safe(data.review.date) ? `<div class="vui-muted" style="margin-top:6px">${data.review.date}</div>` : ''}
            </div>
          </article>` : ''}

          <article class="vui-card">
            <header class="vui-card__head"><div class="vui-title">Техническое</div></header>
            <div class="vui-card__body">
              ${safe(data.order.uuid) ? `<div class="vui-line"><span>UUID</span><b class="vui-uuid" title="Клик — скопировать UUID">${data.order.uuid}</b></div>` : ''}
              ${safe(data.order.payment_system) ? `<div class="vui-line"><span>Платёжка</span><b>${data.order.payment_system}</b></div>` : ''}

              <div class="vui-line" style="border-bottom:0;gap:8px;justify-content:flex-start;flex-wrap:wrap;margin-top:6px;">
                ${data.actions.edit ? `<a class="vui-btn" href="${data.actions.edit}">Редактировать</a>` : ''}
                ${data.actions.refund ? `<a class="vui-btn" href="${data.actions.refund}">Посмотреть возвраты</a>` : ''}
                ${data.actions.ps ? `<a class="vui-btn" href="${data.actions.ps}">Открыть платёжную систему</a>` : ''}
                ${data.actions.reward ? `<a class="vui-btn" href="${data.actions.reward}">Открыть награду продавцу</a>` : ''}
              </div>
            </div>
          </article>
        </div>
      </section>
    `;

    const content = document.querySelector('section.content');
    content?.insertBefore(wrap, content.firstElementChild?.nextElementSibling || content.firstChild);

    setupProfileToggles(wrap);
    // copy handlers
    wrap.querySelector('.vui-badge.ip')?.addEventListener('click', () => copy(data.buyer.ip));
    wrap.querySelector('.vui-uuid')?.addEventListener('click', () => copy(data.order.uuid));
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
    log('Overlay ready (namespaced styles).');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
  } else {
    setTimeout(main, 50);
  }
})();
