// ==UserScript==
// @name         Gsellers Back Office — Order Overlay (smart UI, emails, tech buttons, namespaced)
// @namespace    vibe.gsellers.order.overlay
// @version      1.2.0
// @description  Скрывает старый интерфейс заказа, собирает данные и рисует компактный «умный» оверлей. Общий флоу: прячем старые блоки, собираем и кэшируем данные, строим адаптивный интерфейс и даём быстрые действия. Последние изменения: авто-сворачивание в FAB, кэш поиска между страницами, редактирование отзыва и обновлённые акценты.
// @author       vibe
// @match        *://back-office.ggsel.net/admin/orders/*
// @match        *://*/admin/orders/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';
  const log = (...a) => console.log('[VIBE-UI]', ...a);

  const PREHIDE_CLASS = 'vui-prehide';
  let prehideTimer = null;
  let prehideReleased = false;
  const prehideStyle = document.createElement('style');
  prehideStyle.textContent = `
html.${PREHIDE_CLASS} body{background:#0f1115!important;}
html.${PREHIDE_CLASS} .wrapper{opacity:0!important;}
`;
  document.documentElement.classList.add(PREHIDE_CLASS);
  document.documentElement.appendChild(prehideStyle);
  const releasePrehide = () => {
    if (prehideReleased) return;
    prehideReleased = true;
    if (prehideTimer) {
      clearTimeout(prehideTimer);
      prehideTimer = null;
    }
    document.documentElement.classList.remove(PREHIDE_CLASS);
    if (prehideStyle.parentNode) prehideStyle.parentNode.removeChild(prehideStyle);
  };
  prehideTimer = setTimeout(releasePrehide, 4000);

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
  const formatProductDate = (raw) => {
    const value = (raw || '').trim();
    if (!value) return '';
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
    if (match) {
      const [, y, m, d, hh, mm] = match;
      return `${d}.${m}.${y} ${hh}:${mm}`;
    }
    return stripTimezoneSuffix(value);
  };
  const normalizeCategoryPath = (value) => {
    if (!value) return '';
    return value
      .replace(/\s*>/g, '›')
      .replace(/›\s*/g, ' › ')
      .replace(/\s{2,}/g, ' ')
      .trim();
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
  const refundCache = new Map();
  const refundDetailCache = new Map();
  const reviewDetailCache = new Map();

  const PREFS_KEY = 'vuiOrderOverlayPrefs_v2';
  const STATE_KEY = 'vuiOrderOverlayState_v1';
  const CACHE_KEY = 'vuiOrderOverlayCache_v1';

  const defaultPrefs = {
    autoCollapseOnOpen: false,
    parallelSearch: true,
    fabPosition: { x: 0.92, y: 0.82 },
  };

  function normalizeFabPosition(raw) {
    const fallback = { x: 0.92, y: 0.82 };
    if (!raw || typeof raw !== 'object') return { ...fallback };
    const x = Number.isFinite(raw.x) ? raw.x : fallback.x;
    const y = Number.isFinite(raw.y) ? raw.y : fallback.y;
    return {
      x: Math.min(0.96, Math.max(0.04, x)),
      y: Math.min(0.96, Math.max(0.04, y)),
    };
  }

  function loadPrefs() {
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      if (!raw) return { ...defaultPrefs, fabPosition: { ...defaultPrefs.fabPosition } };
      const parsed = JSON.parse(raw);
      return {
        ...defaultPrefs,
        ...(parsed && typeof parsed === 'object' ? parsed : {}),
        fabPosition: normalizeFabPosition(parsed?.fabPosition),
      };
    } catch (e) {
      console.warn('[VIBE-UI] Failed to load prefs', e);
      return { ...defaultPrefs, fabPosition: { ...defaultPrefs.fabPosition } };
    }
  }

  function savePrefs(next) {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(next));
    } catch (e) {
      console.warn('[VIBE-UI] Failed to save prefs', e);
    }
  }

  let prefs = loadPrefs();

  function updatePrefs(partial) {
    const next = {
      ...prefs,
      ...(partial && typeof partial === 'object' ? partial : {}),
    };
    if (partial?.fabPosition) {
      next.fabPosition = normalizeFabPosition(partial.fabPosition);
    }
    prefs = next;
    savePrefs(next);
    return prefs;
  }

  function getPrefs() {
    return { ...prefs, fabPosition: { ...prefs.fabPosition } };
  }

  function loadState() {
    try {
      const raw = sessionStorage.getItem(STATE_KEY);
      if (!raw) return { collapsed: false };
      const parsed = JSON.parse(raw);
      return {
        collapsed: Boolean(parsed?.collapsed),
      };
    } catch (e) {
      console.warn('[VIBE-UI] Failed to load state', e);
      return { collapsed: false };
    }
  }

  function saveState(next) {
    try {
      sessionStorage.setItem(STATE_KEY, JSON.stringify(next));
    } catch (e) {
      console.warn('[VIBE-UI] Failed to save state', e);
    }
  }

  let overlayState = loadState();

  function setCollapsedState(value) {
    overlayState = { collapsed: Boolean(value) };
    saveState(overlayState);
  }

  function createPersistentCache() {
    const memory = new Map();
    let store;

    const loadStore = () => {
      if (store) return store;
      try {
        const raw = sessionStorage.getItem(CACHE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') {
            const fabPos = prefs.fabPosition;
            store = {
              orderId: parsed.orderId || null,
              data: parsed.data && typeof parsed.data === 'object' ? parsed.data : {},
            };
            prefs = { ...prefs, fabPosition: fabPos };
            return store;
          }
        }
      } catch (e) {
        console.warn('[VIBE-UI] Failed to parse cache', e);
      }
      store = { orderId: null, data: {} };
      return store;
    };

    const persist = () => {
      try {
        sessionStorage.setItem(CACHE_KEY, JSON.stringify(store));
      } catch (e) {
        console.warn('[VIBE-UI] Failed to persist cache', e);
      }
    };

    const ensureBucket = (type) => {
      const current = loadStore();
      if (!current.data[type]) current.data[type] = {};
      return current.data[type];
    };

    return {
      prepare(orderId) {
        const current = loadStore();
        if (!orderId) {
          current.orderId = null;
          current.data = {};
          memory.clear();
          persist();
          return;
        }
        if (current.orderId !== orderId) {
          current.orderId = orderId;
          current.data = {};
          memory.clear();
          persist();
        }
      },
      get(type, key) {
        if (!key) return null;
        const memoryKey = `${type}::${key}`;
        if (memory.has(memoryKey)) {
          return memory.get(memoryKey);
        }
        const bucket = ensureBucket(type);
        if (Object.prototype.hasOwnProperty.call(bucket, key)) {
          const value = bucket[key];
          memory.set(memoryKey, value);
          return value;
        }
        return null;
      },
      set(type, key, value) {
        if (!key) return;
        const bucket = ensureBucket(type);
        bucket[key] = value;
        memory.set(`${type}::${key}`, value);
        persist();
      },
    };
  }

  const persistentCache = createPersistentCache();

  // ---------- review helpers ----------
  function getCsrfFromMeta() {
    const m = document.querySelector('meta[name="csrf-token"]');
    return m ? m.getAttribute('content') : null;
  }

  function getCsrfFromAnyForm() {
    const i = document.querySelector('input[name="authenticity_token"]');
    return i ? i.value : null;
  }

  async function fetchCsrfFromEditPage(userId, reviewId) {
    const url = `/admin/users/${encodeURIComponent(userId)}/reviews/${encodeURIComponent(reviewId)}/edit`;
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`CSRF fetch failed: ${res.status} ${res.statusText}`);
    const html = await res.text();
    const m = html.match(/name="authenticity_token"\s+value="([^"]+)"/);
    return m ? m[1] : null;
  }

  async function getCsrfToken({ userId, reviewId } = {}) {
    return (
      getCsrfFromMeta()
      || getCsrfFromAnyForm()
      || (userId && reviewId ? await fetchCsrfFromEditPage(userId, reviewId) : null)
    );
  }

  async function patchReview({ userId, reviewId, text, score, status }) {
    if (!userId || !reviewId) throw new Error('userId и reviewId обязательны');

    const csrf = await getCsrfToken({ userId, reviewId });
    if (!csrf) throw new Error('CSRF token not found');

    const url = `/admin/users/${encodeURIComponent(userId)}/reviews/${encodeURIComponent(reviewId)}`;
    const params = new URLSearchParams();
    params.set('authenticity_token', csrf);
    params.set('_method', 'patch');

    if (typeof text === 'string') params.set('resource[text]', text);
    if (typeof score !== 'undefined') params.set('resource[score]', String(score));
    if (typeof status !== 'undefined') params.set('resource[status]', status);

    const res = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'X-CSRF-Token': csrf,
      },
      body: params.toString(),
      redirect: 'manual',
    });

    if (res.status === 302 || res.status === 200) {
      log('[ReviewPatcher] OK', res.status);
      return true;
    }
    const body = await res.text().catch(() => '');
    console.error('[ReviewPatcher] FAIL', res.status, body.slice(0, 800));
    throw new Error(`Patch failed: HTTP ${res.status}`);
  }

  let confirmModalInstance = null;
  let imageLightboxInstance = null;

  function ensureConfirmModal() {
    if (confirmModalInstance) return confirmModalInstance;

    const overlay = document.createElement('div');
    overlay.className = 'vui-modalOverlay';
    overlay.setAttribute('role', 'presentation');
    overlay.setAttribute('aria-hidden', 'true');
    overlay.innerHTML = `
      <div class="vui-modal" role="dialog" aria-modal="true">
        <div class="vui-modalText" data-confirm-text></div>
        <div class="vui-modalButtons">
          <button type="button" class="vui-btn vui-btn--ghost" data-confirm-cancel>Отмена</button>
          <button type="button" class="vui-btn vui-btn--primary" data-confirm-accept>Продолжить</button>
        </div>
      </div>
    `;

    const appendOverlay = () => {
      if (overlay.isConnected) return;
      if (document.body) {
        document.body.appendChild(overlay);
      }
    };
    if (document.body) appendOverlay();
    else document.addEventListener('DOMContentLoaded', appendOverlay, { once: true });

    const textEl = overlay.querySelector('[data-confirm-text]');
    const cancelBtn = overlay.querySelector('[data-confirm-cancel]');
    const acceptBtn = overlay.querySelector('[data-confirm-accept]');
    let confirmHandler = null;
    let previousActive = null;

    const close = () => {
      overlay.classList.remove('is-visible');
      overlay.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('vui-modalOpen');
      const toFocus = previousActive;
      previousActive = null;
      confirmHandler = null;
      if (toFocus && typeof toFocus.focus === 'function') {
        try { toFocus.focus(); } catch {}
      }
    };

    const open = ({ message, confirmLabel, onConfirm }) => {
      textEl.textContent = message || '';
      acceptBtn.textContent = confirmLabel || 'Продолжить';
      previousActive = document.activeElement;
      confirmHandler = typeof onConfirm === 'function' ? onConfirm : null;
      overlay.classList.add('is-visible');
      overlay.setAttribute('aria-hidden', 'false');
      document.body.classList.add('vui-modalOpen');
      requestAnimationFrame(() => {
        acceptBtn.focus();
      });
    };

    cancelBtn.addEventListener('click', () => {
      close();
    });

    acceptBtn.addEventListener('click', () => {
      const handler = confirmHandler;
      close();
      if (handler) handler();
    });

    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) {
        close();
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && overlay.classList.contains('is-visible')) {
        event.preventDefault();
        close();
      }
    });

    confirmModalInstance = { open, close };
    return confirmModalInstance;
  }

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
      const cached = persistentCache.get('profile', absolute);
      if (cached) {
        profileCache.set(absolute, cached);
        return cached;
      }
      const res = await fetch(absolute, { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      const data = parseProfileHtml(html, absolute);
      profileCache.set(absolute, data);
      persistentCache.set('profile', absolute, data);
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
      const cached = persistentCache.get('chat', absolute);
      if (cached) {
        chatCache.set(absolute, cached);
        return cached;
      }
      const res = await fetch(absolute, { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      const data = parseChatHtml(html, absolute);
      chatCache.set(absolute, data);
      persistentCache.set('chat', absolute, data);
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
      const cached = persistentCache.get('product', absolute);
      if (cached) {
        productCache.set(absolute, cached);
        return cached;
      }
      const res = await fetch(absolute, { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      const data = parseProductHtml(html, absolute);
      productCache.set(absolute, data);
      persistentCache.set('product', absolute, data);
      return data;
    } catch (e) {
      log('Failed to load product', url, e);
      return { error: true, url };
    }
  }

  async function fetchRefundData(url) {
    if (!url) return null;
    try {
      const absolute = new URL(url, location.origin).href;
      if (refundCache.has(absolute)) return refundCache.get(absolute);
      const cached = persistentCache.get('refund', absolute);
      if (cached) {
        refundCache.set(absolute, cached);
        return cached;
      }
      const res = await fetch(absolute, { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      const data = parseRefundHtml(html, absolute);
      if (data.entries?.length) {
        const enriched = await Promise.all(data.entries.map(async (entry) => {
          if (entry.detail && entry.detail.href) {
            const details = await fetchRefundDetail(entry.detail.href);
            return { ...entry, detail: { ...entry.detail, ...details } };
          }
          return entry;
        }));
        data.entries = enriched;
      }
      refundCache.set(absolute, data);
      persistentCache.set('refund', absolute, data);
      return data;
    } catch (e) {
      log('Failed to load refund list', url, e);
      return { error: true, url };
    }
  }

  async function fetchRefundDetail(url) {
    if (!url) return null;
    try {
      const absolute = new URL(url, location.origin).href;
      if (refundDetailCache.has(absolute)) return refundDetailCache.get(absolute);
      const cached = persistentCache.get('refundDetail', absolute);
      if (cached) {
        refundDetailCache.set(absolute, cached);
        return cached;
      }
      const res = await fetch(absolute, { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      const data = parseRefundDetailHtml(html, absolute);
      refundDetailCache.set(absolute, data);
      persistentCache.set('refundDetail', absolute, data);
      return data;
    } catch (e) {
      log('Failed to load refund detail', url, e);
      return { error: true, url };
    }
  }

  function parseReviewDetailHtml(html, url) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const table = doc.querySelector('table');
    const result = { url };
    if (table) {
      const rows = Array.from(table.querySelectorAll('tr'));
      rows.forEach((tr) => {
        const th = norm(txt(tr.querySelector('th')));
        const td = norm(txt(tr.querySelector('td')));
        if (!th) return;
        const label = th.toLowerCase();
        if (label.includes('статус')) {
          result.status = td;
        } else if (label.includes('оценка')) {
          result.score = td ? Number(td.replace(/[^0-9.-]/g, '')) || null : null;
        } else if (label.includes('текст')) {
          result.text = td;
        }
      });
    }
    if (!result.status) {
      const statusRow = Array.from(doc.querySelectorAll('tr')).find(tr => norm(txt(tr.querySelector('th'))).toLowerCase().includes('статус'));
      if (statusRow) {
        result.status = norm(txt(statusRow.querySelector('td')));
      }
    }
    const textarea = doc.querySelector('textarea[name="resource[text]"]');
    if (textarea) {
      result.text = cleanMultiline(textarea.value || textarea.textContent || result.text || '');
    }
    const scoreInput = doc.querySelector('input[name="resource[score]"]');
    if (scoreInput && scoreInput.value) {
      const parsedScore = Number(scoreInput.value);
      if (!Number.isNaN(parsedScore)) result.score = parsedScore;
    }
    return result;
  }

  async function fetchReviewDetail(url) {
    if (!url) return null;
    try {
      const absolute = new URL(url, location.origin).href;
      if (reviewDetailCache.has(absolute)) return reviewDetailCache.get(absolute);
      const cached = persistentCache.get('reviewDetail', absolute);
      if (cached) {
        reviewDetailCache.set(absolute, cached);
        return cached;
      }
      const res = await fetch(absolute, { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      const data = parseReviewDetailHtml(html, absolute);
      reviewDetailCache.set(absolute, data);
      persistentCache.set('reviewDetail', absolute, data);
      return data;
    } catch (e) {
      log('Failed to load review detail', url, e);
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

    const rows = Array.from(doc.querySelectorAll('tr'));
    const findRow = (matcher) => {
      const list = Array.isArray(matcher) ? matcher : [matcher];
      return rows.find((tr) => {
        const label = norm(txt(tr.querySelector('th'))).toLowerCase();
        return list.some(item => label.includes(item.toLowerCase()));
      });
    };

    const titleRow = findRow(['название', 'наименование']);
    const categoryRow = findRow(['путь размещения', 'катег']);
    const createdRow = findRow(['дата создания']);

    const title = norm(txt(titleRow?.querySelector('td')));

    let category = '';
    let categoryLink = '';
    if (categoryRow) {
      const td = categoryRow.querySelector('td');
      const anchors = Array.from(td?.querySelectorAll('a') || []);
      if (anchors.length) {
        const last = anchors[anchors.length - 1];
        const href = last.getAttribute('href') || last.href || '';
        if (href) categoryLink = new URL(href, url).href;
      }
      const raw = td ? td.textContent || '' : '';
      category = normalizeCategoryPath(raw);
    }

    const createdRaw = norm(txt(createdRow?.querySelector('td')));
    const created_at = formatProductDate(createdRaw);

    return { description, title, category, category_link: categoryLink, created_at, url };
  }

  function parseRefundHtml(html, url) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const table = doc.querySelector('.box-body table');
    if (!table) return { url, entries: [] };

    const rows = Array.from(table.querySelectorAll('tr'));
    const dataRow = rows.find(row => row.querySelectorAll('td').length);
    if (!dataRow) return { url, entries: [] };

    const cells = Array.from(dataRow.querySelectorAll('td'));
    if (cells.length < 7) {
      return { url, entries: [] };
    }

    const detailAnchor = cells[0]?.querySelector('a');
    const initiatorAnchor = cells[2]?.querySelector('a');
    const paymentAnchor = cells[6]?.querySelector('a');

    const entry = {
      detail: detailAnchor
        ? {
            label: norm(txt(detailAnchor)),
            href: new URL(detailAnchor.getAttribute('href') || detailAnchor.href || '', url).href,
          }
        : null,
      initiator: {
        label: norm(txt(initiatorAnchor || cells[2] || null)),
        href: initiatorAnchor ? new URL(initiatorAnchor.getAttribute('href') || initiatorAnchor.href || '', url).href : '',
      },
      amount: norm(txt(cells[3])),
      currency: norm(txt(cells[4])),
      status: norm(txt(cells[5])),
      paymentSystem: {
        label: norm(txt(paymentAnchor || cells[6] || null)),
        href: paymentAnchor ? new URL(paymentAnchor.getAttribute('href') || paymentAnchor.href || '', url).href : '',
      },
    };

    return { url, entries: [entry] };
  }

  function parseRefundDetailHtml(html, url) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const dl = doc.querySelector('.box-body dl, .box dl, dl');
    if (!dl) return { url };

    const dts = Array.from(dl.querySelectorAll('dt'));
    for (const dt of dts) {
      const label = norm(txt(dt)).toLowerCase();
      if (!label) continue;
      if (label.includes('refund type')) {
        const dd = dt.nextElementSibling;
        const value = norm(txt(dd));
        if (value) {
          return { url, refundType: value };
        }
      }
    }

    return { url };
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
      const attachments = Array.from(messageEl?.querySelectorAll('img.img-thumbnail') || [])
        .map(img => {
          const src = img.getAttribute('src') || '';
          return {
            src: src ? new URL(src, url).href : '',
            alt: norm(img.getAttribute('alt') || ''),
          };
        })
        .filter(att => att.src);

      return {
        author,
        avatar: avatar ? new URL(avatar, url).href : '',
        timestamp,
        status,
        text,
        attachments,
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

    const refundCreate = firstLinkWithin(footer, 'Оформить возврат');
    const refundView = firstLinkWithin(footer, 'Посмотреть возвраты');
    const actions = {
      edit: firstLinkWithin(footer, 'Редактировать'),
      chat: firstLinkWithin(footer, 'Открыть диалог'),
      close: firstLinkWithin(footer, 'Закрыть сделку'),
      refundCreate,
      refundView,
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
    const reviewLinkEl = hRev
      ? hRev.querySelector('a')
        || hRev.parentElement?.querySelector('a')
        || hRev.closest('.col-sm-3')?.querySelector('a')
      : null;
    const reviewLink = reviewLinkEl
      ? new URL(reviewLinkEl.getAttribute('href') || reviewLinkEl.href, location.origin).href
      : '';

    let reviewUserId = '';
    let reviewId = '';
    if (reviewLink) {
      const match = reviewLink.match(/\/admin\/users\/(\d+)\/reviews\/(\d+)/);
      if (match) {
        reviewUserId = match[1];
        reviewId = match[2];
      }
    }

    const review = {
      text: rowValueByLabel(tblRev, 'Текст отзыва'),
      rating: rowValueByLabel(tblRev, 'Оценка'),
      date: rowValueByLabel(tblRev, 'Дата отзыва'),
      link: reviewLink,
      userId: reviewUserId,
      reviewId,
      status: '',
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
      issued_item: rowValueByLabel(tblProd, 'Выданный товар'),
      link_admin: firstLinkWithin(prodFooter, 'Открыть товар'),
      link_public: firstLinkWithin(prodFooter, 'на GGSel'),
      link_category: firstLinkWithin(prodFooter, 'Категорию'),
    };
    product.category = normalizeCategoryPath(product.category);
    product.created_at = formatProductDate(product.created_at);
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
  --vui-bg:#13141a;
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
.main-footer{display:none!important;}
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
.vui-refundInfo{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12px;color:var(--vui-muted);}
.vui-refundInfo__part{display:flex;align-items:center;gap:4px;white-space:nowrap;}
.vui-refundInfo__separator{color:rgba(255,255,255,.25);}
.vui-headStats{display:flex;gap:16px;flex-wrap:wrap;}
.vui-headStat{display:flex;flex-direction:column;gap:2px;color:var(--vui-text);font-size:13px;}
.vui-headStat b{font-size:15px;}
.vui-headFooter{display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;}
.vui-headActions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;margin-left:auto;}
.vui-headControls{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-left:auto;margin-top:6px;}
.vui-headControl{padding:6px 10px;font-size:13px;}
.vui-orderNumber{border:none;background:transparent;color:var(--vui-text);font:inherit;padding:0 6px;cursor:pointer;border-radius:6px;transition:background .2s ease,color .2s ease;}
.vui-orderNumber:hover{color:var(--vui-accent);background:rgba(76,155,255,.08);}
.vui-orderNumber:focus-visible{outline:2px solid var(--vui-accent);outline-offset:2px;}
.vui-isCopied{animation:vuiCopyPulse .9s ease-out;}
.vui-chip{display:inline-block;padding:.2rem .5rem;border-radius:999px;background:#222;border:1px solid #333;font-weight:600;color:var(--vui-text);}
.vui-chip--success{background:rgba(46,160,67,.15);border-color:#295f36;color:#43d17a;}
.vui-chip--info{background:rgba(47,129,247,.15);border-color:#2f81f7;color:#9ec3ff;}
.vui-chip--warn{background:rgba(255,211,105,.15);border-color:#977f2d;color:#ffd369;}
.vui-chip--match-generic{background:rgba(148,148,148,.18);border-color:rgba(148,148,148,.45);color:#e2e2e2;}
.vui-chip--match-email{background:rgba(76,155,255,.2);border-color:rgba(76,155,255,.5);color:#bcd5ff;}
.vui-chip--match-ip{background:rgba(176,97,255,.18);border-color:rgba(176,97,255,.45);color:#e1c8ff;}
.vui-chip--match-user{background:rgba(56,176,115,.2);border-color:rgba(56,176,115,.5);color:#b7f7d4;}
.vui-chip--match-order{background:rgba(255,148,86,.2);border-color:rgba(255,148,86,.5);color:#ffe0c8;}
.vui-chip--match-phone{background:rgba(255,97,170,.18);border-color:rgba(255,97,170,.45);color:#ffd1e8;}
.vui-card[data-match-accent="vui-chip--match-email"],.vui-card[data-match-accent="vui-chip--match-ip"],.vui-card[data-match-accent="vui-chip--match-user"],.vui-card[data-match-accent="vui-chip--match-order"],.vui-card[data-match-accent="vui-chip--match-phone"],.vui-card[data-match-accent="vui-chip--match-generic"]{box-shadow:0 0 0 1px rgba(76,155,255,.2);}
.vui-card[data-match-accent="vui-chip--match-email"]{border-color:rgba(76,155,255,.45);box-shadow:0 0 0 1px rgba(76,155,255,.35),0 0 18px rgba(76,155,255,.18);}
.vui-card[data-match-accent="vui-chip--match-ip"]{border-color:rgba(176,97,255,.45);box-shadow:0 0 0 1px rgba(176,97,255,.35),0 0 18px rgba(176,97,255,.16);}
.vui-card[data-match-accent="vui-chip--match-user"]{border-color:rgba(56,176,115,.45);box-shadow:0 0 0 1px rgba(56,176,115,.35),0 0 18px rgba(56,176,115,.16);}
.vui-card[data-match-accent="vui-chip--match-order"]{border-color:rgba(255,148,86,.45);box-shadow:0 0 0 1px rgba(255,148,86,.35),0 0 18px rgba(255,148,86,.16);}
.vui-card[data-match-accent="vui-chip--match-phone"]{border-color:rgba(255,97,170,.45);box-shadow:0 0 0 1px rgba(255,97,170,.35),0 0 18px rgba(255,97,170,.16);}
.vui-card[data-match-accent="vui-chip--match-generic"]{border-color:rgba(148,148,148,.35);box-shadow:0 0 0 1px rgba(148,148,148,.3),0 0 18px rgba(148,148,148,.12);}
.vui-chrono{display:flex;flex-wrap:wrap;gap:20px;padding-top:12px;border-top:1px dashed #1f2023;margin-top:4px;}
.vui-chronoItem{min-width:160px;display:flex;flex-direction:column;gap:4px;}
.vui-chronoLabel{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--vui-muted);}
.vui-chronoMoment{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-weight:600;color:var(--vui-text);}
.vui-chronoTime{font-size:13px;}
.vui-chronoDate{font-size:12px;color:var(--vui-muted);}
.vui-btn{padding:8px 12px;border-radius:10px;border:1px solid #2a2a2a;background:#1a1b1e;color:var(--vui-text);cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:6px;font:inherit;line-height:1.2;}
.vui-btn--primary{background:var(--vui-accent);color:#0b1526;}
.vui-btn--danger{border-color:#4a2222;background:#2a1212;}
.vui-btn--alert{border-color:rgba(248,81,73,.7);background:rgba(248,81,73,.18);color:#ffb3ad;}
.vui-btn--alert:hover{background:rgba(248,81,73,.28);}
.vui-btn--ghost{background:transparent;}
.vui-btn--ghost:hover,.vui-btn.is-open{background:#1f2024;}
body.vui-modalOpen{overflow:hidden;}
body.vui-lightboxOpen{overflow:hidden;}
.vui-modalOverlay{position:fixed;inset:0;background:rgba(8,10,15,.76);display:flex;align-items:center;justify-content:center;padding:24px;z-index:99999;opacity:0;pointer-events:none;transition:opacity .2s ease;}
.vui-modalOverlay.is-visible{opacity:1;pointer-events:auto;}
.vui-modal{background:var(--vui-card);border:1px solid var(--vui-line);border-radius:14px;box-shadow:0 24px 50px rgba(0,0,0,.45);padding:20px;max-width:360px;width:100%;display:flex;flex-direction:column;gap:18px;}
.vui-modalText{font-size:14px;line-height:1.5;color:var(--vui-text);}
.vui-modalButtons{display:flex;justify-content:flex-end;gap:10px;}
.vui-layoutSide{min-width:280px;}
.vui-card,.vui-mini{border:1px solid var(--vui-line);border-radius:12px;background:var(--vui-card);color:var(--vui-text);}
.vui-card__head,.vui-mini__head{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px dashed #222;}
.vui-card__body{padding:12px 14px;}
.vui-card__actions{display:flex;gap:8px;align-items:center;}
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
.vui-copyable{border:none;background:transparent;color:inherit;font:inherit;padding:0;cursor:pointer;text-align:left;position:relative;transition:color .2s ease;}
.vui-copyable:hover{color:var(--vui-accent);}
.vui-copyable:focus-visible{outline:2px solid var(--vui-accent);outline-offset:2px;}
.vui-productTitle{color:var(--vui-text);text-decoration:none;border-bottom:1px solid transparent;padding:2px 6px;transition:color .2s ease,border-color .2s ease,box-shadow .2s ease;background:rgba(76,155,255,.05);border-radius:8px;display:inline-flex;align-items:center;gap:6px;font-size:18px;font-weight:700;box-shadow:0 0 0 1px rgba(76,155,255,.2);}
.vui-productTitleText{color:var(--vui-text);display:inline-flex;align-items:center;gap:6px;font-weight:700;font-size:18px;}
.vui-productTitle:hover{color:var(--vui-accent);border-color:var(--vui-accent);}
.vui-productTitle:focus-visible{outline:2px solid var(--vui-accent);outline-offset:2px;}
.vui-linkAction{cursor:pointer;color:rgba(158,195,255,.95);text-decoration:none;position:relative;display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:8px;background:rgba(76,155,255,.1);box-shadow:0 0 0 1px rgba(76,155,255,.3),0 0 14px rgba(76,155,255,.12);transition:color .2s ease,box-shadow .2s ease,background .2s ease;}
.vui-linkAction::after{content:'';position:absolute;left:8px;right:8px;bottom:2px;height:1px;background:rgba(158,195,255,.35);transition:background .2s ease,transform .2s ease;transform-origin:center;}
.vui-linkAction:hover{color:#e5f0ff;background:rgba(76,155,255,.18);box-shadow:0 0 0 1px rgba(76,155,255,.55),0 0 20px rgba(76,155,255,.2);}
.vui-linkAction:hover::after{background:#e5f0ff;}
.vui-linkAction:focus-visible{outline:2px solid var(--vui-accent);outline-offset:2px;}
.vui-badge{padding:.15rem .4rem;border:1px solid #2a2a2a;border-radius:8px;color:var(--vui-text);}
.vui-badge.ip{cursor:pointer;}
.vui-copyable.vui-isCopied{color:var(--vui-accent);text-shadow:0 0 10px rgba(76,155,255,.4);}
.vui-muted{opacity:.7;color:var(--vui-muted);}
.vui-profileDetails{display:none;padding:12px 14px;border-top:1px dashed #222;background:#0f1012;border-bottom-left-radius:12px;border-bottom-right-radius:12px;}
.vui-profileDetails.open{display:block;}
.vui-profileDetails .vui-empty{color:var(--vui-muted);font-size:13px;}
.vui-detailGrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;margin-top:4px;}
.vui-detailItem{padding:10px;border:1px solid #1f2023;border-radius:10px;background:rgba(255,255,255,.02);display:flex;flex-direction:column;gap:4px;}
.vui-detailLabel{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--vui-muted);}
.vui-detailValue{font-weight:600;color:var(--vui-text);word-break:break-word;}
.vui-relatedActions{margin-top:14px;display:flex;gap:8px;flex-wrap:wrap;}
.vui-reviewDetails{display:flex;flex-direction:column;gap:8px;}
.vui-reviewText{margin:6px 0 0;color:var(--vui-text);white-space:pre-wrap;}
.vui-reviewDate{margin-top:4px;}
.vui-reviewEditor{margin-top:12px;padding:12px;border:1px dashed rgba(76,155,255,.35);border-radius:10px;background:rgba(76,155,255,.08);display:flex;flex-direction:column;gap:12px;}
.vui-reviewEditor textarea{resize:vertical;min-height:120px;background:#111214;border:1px solid #2a2d33;border-radius:8px;color:var(--vui-text);padding:8px;font:inherit;}
.vui-reviewEditor input,.vui-reviewEditor select{background:#111214;border:1px solid #2a2d33;border-radius:8px;color:var(--vui-text);padding:8px;font:inherit;}
.vui-field{display:flex;flex-direction:column;gap:6px;flex:1;}
.vui-fieldRow{display:flex;gap:12px;flex-wrap:wrap;}
.vui-fieldLabel{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--vui-muted);}
.vui-reviewButtons{display:flex;justify-content:flex-end;gap:8px;}
.vui-reviewMessage{font-size:13px;color:var(--vui-muted);min-height:18px;}
.vui-reviewMessage.is-success{color:#63d28e;}
.vui-reviewMessage.is-error{color:#ff8a80;}
.vui-reviewMessage.is-progress{color:var(--vui-accent);}
.vui-card.is-editing{box-shadow:0 0 0 1px rgba(76,155,255,.35),0 0 20px rgba(76,155,255,.15);}
.vui-card--chat{display:flex;flex-direction:column;}
.vui-card--chat .vui-card__body{padding:0;}
.vui-chatBox{max-height:70vh;overflow:auto;padding:12px 14px;display:flex;flex-direction:column;gap:12px;overscroll-behavior:contain;}
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
.vui-chatAttachments{margin-top:10px;display:flex;flex-wrap:wrap;gap:10px;}
.vui-attachmentThumb{border:1px solid #1f2023;border-radius:10px;background:#101114;padding:0;overflow:hidden;cursor:pointer;transition:border-color .2s ease,transform .2s ease;}
.vui-attachmentThumb:hover{border-color:var(--vui-accent);transform:translateY(-1px);}
.vui-attachmentThumb:focus-visible{outline:2px solid var(--vui-accent);outline-offset:2px;}
.vui-attachmentThumb img{display:block;width:120px;height:120px;object-fit:cover;}
.vui-productDescription{margin-top:12px;border:1px dashed #1f2023;border-radius:10px;background:rgba(255,255,255,.02);font-size:13px;color:var(--vui-text);}
.vui-desc{margin:0;display:flex;flex-direction:column;}
.vui-descToggle{appearance:none;border:none;background:none;color:inherit;text-align:left;display:flex;flex-direction:row;align-items:center;gap:12px;font-weight:600;padding:12px 14px;cursor:pointer;transition:color .2s ease;}
.vui-descToggle[disabled]{cursor:default;}
.vui-descToggle[disabled]:hover{color:inherit;}
.vui-descToggle:focus-visible{outline:2px solid var(--vui-accent);outline-offset:2px;}
.vui-descToggle:hover{color:var(--vui-accent);}
.vui-descToggleText{font-size:12px;color:var(--vui-accent);letter-spacing:.04em;text-transform:uppercase;margin-left:auto;}
.vui-desc[data-collapsible="false"] .vui-descToggle{cursor:default;}
.vui-desc[data-collapsible="false"] .vui-descToggle:hover{color:inherit;}
.vui-desc[data-collapsible="false"] .vui-descToggleText{color:var(--vui-muted);}
.vui-desc[data-empty="true"] .vui-descToggleText{display:none;}
.vui-desc[data-collapsible="true"] .vui-descToggle{border-bottom:1px dashed #1f2023;}
.vui-descBody{padding:12px 14px;border-top:1px dashed #1f2023;line-height:1.5;display:flex;flex-direction:column;gap:8px;}
.vui-descBody p{margin:0;line-height:1.5;}
.vui-descBody p+p{margin-top:4px;}
.vui-footerNote{margin-top:0;padding:12px 0 24px;color:var(--vui-muted);font-size:12px;text-align:center;border-top:1px solid var(--vui-line);}
.vui-acc>summary{cursor:pointer;display:flex;align-items:center;gap:8px;font-weight:600;list-style:none;color:inherit;transition:color .2s ease;}
.vui-acc>summary::-webkit-details-marker{display:none;}
.vui-acc>summary::after{content:'▾';margin-left:auto;font-size:12px;color:var(--vui-muted);transition:transform .2s ease,color .2s ease;}
.vui-acc[open]>summary::after{transform:rotate(180deg);}
.vui-acc>summary:hover{color:var(--vui-accent);}
.vui-acc>summary:hover::after{color:var(--vui-accent);}
.vui-desc[data-collapsible="true"][data-expanded="false"] .vui-descBody{max-height:7.2em;overflow:hidden;position:relative;}
.vui-desc[data-collapsible="true"][data-expanded="false"] .vui-descBody::after{content:'';position:absolute;left:0;right:0;bottom:0;height:48px;background:linear-gradient(0deg,var(--vui-card) 0%,rgba(17,18,20,0) 70%);pointer-events:none;}
.vui-badge.ip.vui-isCopied,.vui-orderNumber.vui-isCopied{box-shadow:0 0 0 0 rgba(76,155,255,.4);}
.vui-lightboxOverlay{position:fixed;inset:0;background:rgba(8,10,15,.86);display:flex;align-items:center;justify-content:center;padding:24px;z-index:100000;opacity:0;pointer-events:none;transition:opacity .2s ease;}
.vui-lightboxOverlay.is-visible{opacity:1;pointer-events:auto;}
.vui-lightbox{position:relative;max-width:90vw;max-height:90vh;display:flex;align-items:center;justify-content:center;}
.vui-lightboxImage{max-width:90vw;max-height:90vh;border-radius:12px;box-shadow:0 20px 45px rgba(0,0,0,.5);}
.vui-lightboxClose{position:absolute;top:-16px;right:-16px;width:36px;height:36px;border-radius:50%;border:1px solid rgba(255,255,255,.3);background:rgba(12,14,20,.92);color:var(--vui-text);cursor:pointer;font-size:20px;line-height:1;display:grid;place-items:center;}
.vui-lightboxClose:hover{color:var(--vui-accent);border-color:var(--vui-accent);}
.vui-lightboxClose:focus-visible{outline:2px solid var(--vui-accent);outline-offset:2px;}
.vui-settingsPanel{position:fixed;top:var(--vui-settings-anchor-top,110px);right:var(--vui-settings-anchor-right,24px);min-width:260px;max-width:320px;background:var(--vui-card);border:1px solid var(--vui-line);border-radius:12px;box-shadow:0 22px 48px rgba(0,0,0,.46);padding:16px;z-index:9980;opacity:0;pointer-events:none;transform:translateY(-6px);transition:opacity .2s ease,transform .2s ease;}
.vui-settingsPanel.is-open{opacity:1;pointer-events:auto;transform:translateY(0);}
.vui-settingsPanel__head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;}
.vui-settingsPanel__title{font-weight:700;font-size:15px;}
.vui-settingsPanel__close{border:none;background:transparent;color:var(--vui-text);cursor:pointer;font-size:20px;line-height:1;padding:2px 6px;border-radius:6px;transition:color .2s ease,background .2s ease;}
.vui-settingsPanel__close:hover{color:var(--vui-accent);background:rgba(76,155,255,.12);}
.vui-settingsPanel__close:focus-visible{outline:2px solid var(--vui-accent);outline-offset:2px;}
.vui-settingsPanel__body{display:flex;flex-direction:column;gap:8px;}
.vui-settingsRow{display:flex;align-items:center;gap:10px;font-size:14px;}
.vui-settingsRow input{width:16px;height:16px;cursor:pointer;}
.vui-settingsHint{margin:0;font-size:12px;color:var(--vui-muted);}
.vui-settingsHint+ .vui-settingsHint{margin-top:-2px;}
.vui-fabButton{position:fixed;left:92%;top:82%;transform:translate(-50%,-50%);display:inline-flex;align-items:center;gap:8px;padding:12px 18px;border-radius:999px;border:none;background:linear-gradient(135deg,rgba(76,155,255,.85),rgba(34,92,210,.92));color:#f5f7ff;font:inherit;font-weight:600;box-shadow:0 18px 44px rgba(0,0,0,.45),0 0 0 1px rgba(76,155,255,.5);cursor:pointer;opacity:0;pointer-events:none;transition:opacity .2s ease,box-shadow .2s ease,transform .2s ease;z-index:9999;}
.vui-fabButton.is-visible{opacity:1;pointer-events:auto;}
.vui-fabButton:hover{box-shadow:0 20px 50px rgba(0,0,0,.5),0 0 0 1px rgba(130,183,255,.7);}
.vui-fabButton:active{transform:translate(-50%,-50%) scale(.97);}
.vui-fabButton:focus-visible{outline:2px solid #fff;outline-offset:2px;}
.vui-fabIcon{font-size:18px;}
.vui-fabLabel{font-size:14px;}
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

  function setupChatScrollLock(wrap) {
    const box = wrap?.querySelector('.vui-chatBox');
    if (!box) return;
    const wheelHandler = (event) => {
      const el = box;
      const deltaY = event.deltaY;
      const atTop = el.scrollTop <= 0;
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
      if ((deltaY < 0 && atTop) || (deltaY > 0 && atBottom)) {
        event.preventDefault();
      }
      event.stopPropagation();
    };
    box.addEventListener('wheel', wheelHandler, { passive: false });

    const touchHandler = (event) => {
      event.stopPropagation();
    };
    box.addEventListener('touchmove', touchHandler, { passive: false });
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

    if (!jobs.length) return Promise.resolve();
    return Promise.allSettled(jobs).then(() => {
      log('Profile panels updated.');
    });
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
      const attachments = Array.isArray(msg.attachments) && msg.attachments.length
        ? `<div class="vui-chatAttachments">${msg.attachments.map((att, idx) => {
            const label = att.alt || `Изображение ${idx + 1}`;
            return `<button type="button" class="vui-attachmentThumb" data-chat-image="${esc(att.src)}" data-chat-alt="${esc(att.alt || '')}" aria-label="${esc(label)}"><img src="${esc(att.src)}" alt="${esc(att.alt || '')}"></button>`;
          }).join('')}</div>`
        : '';
      return `
        <div class="${msgClass}">
          ${avatar}
          <div>
            <div class="vui-chatHead">
              <div class="vui-chatAuthor">${esc(msg.author)}</div>
              <div class="vui-chatMeta">${timestamp}${status}</div>
            </div>
            <div class="vui-chatText">${esc(msg.text)}</div>
            ${attachments}
          </div>
        </div>
      `;
    }).join('');

    return `${items}`;
  }

  function loadChatSection(data, wrap) {
    const panel = wrap?.querySelector('[data-chat-panel]');
    if (!panel || !data.actions.chat) return Promise.resolve();

    panel.innerHTML = '<div class="vui-empty">Загрузка диалога…</div>';

    const context = {
      sellerNames: [data.seller?.name].filter(Boolean),
      sellerName: data.seller?.name,
    };

    return fetchChatData(data.actions.chat)
      .then(chat => {
        panel.innerHTML = renderChatContent(chat, context);
        bindChatMedia(panel);
      })
      .catch(() => {
        panel.innerHTML = renderChatContent({ error: true });
      });
  }

  function ensureImageLightbox() {
    if (imageLightboxInstance) return imageLightboxInstance;

    const overlay = document.createElement('div');
    overlay.className = 'vui-lightboxOverlay';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.innerHTML = `
      <div class="vui-lightbox" role="dialog" aria-modal="true">
        <button type="button" class="vui-lightboxClose" aria-label="Закрыть изображение">×</button>
        <img class="vui-lightboxImage" alt="" />
      </div>
    `;

    const appendOverlay = () => {
      if (overlay.isConnected) return;
      if (document.body) {
        document.body.appendChild(overlay);
      }
    };
    if (document.body) appendOverlay();
    else document.addEventListener('DOMContentLoaded', appendOverlay, { once: true });

    const closeBtn = overlay.querySelector('.vui-lightboxClose');
    const imageEl = overlay.querySelector('.vui-lightboxImage');

    const close = () => {
      overlay.classList.remove('is-visible');
      overlay.setAttribute('aria-hidden', 'true');
      imageEl.removeAttribute('src');
      imageEl.removeAttribute('alt');
      document.body.classList.remove('vui-lightboxOpen');
    };

    const open = ({ src, alt }) => {
      if (!src) return;
      appendOverlay();
      imageEl.setAttribute('src', src);
      if (alt) imageEl.setAttribute('alt', alt);
      else imageEl.removeAttribute('alt');
      overlay.classList.add('is-visible');
      overlay.setAttribute('aria-hidden', 'false');
      document.body.classList.add('vui-lightboxOpen');
      try {
        closeBtn.focus({ preventScroll: true });
      } catch (e) {
        try { closeBtn.focus(); } catch {}
      }
    };

    closeBtn.addEventListener('click', () => {
      close();
    });

    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) {
        close();
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && overlay.classList.contains('is-visible')) {
        event.preventDefault();
        close();
      }
    });

    imageLightboxInstance = { open, close, overlay };
    return imageLightboxInstance;
  }

  function bindChatMedia(container) {
    if (!container) return;
    container.querySelectorAll('[data-chat-image]').forEach(btn => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        const src = btn.getAttribute('data-chat-image');
        if (!src) return;
        const lightbox = ensureImageLightbox();
        lightbox.open({ src, alt: btn.getAttribute('data-chat-alt') || '' });
      });
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
    if (!data.product.link_admin) return Promise.resolve();
    const container = wrap?.querySelector('[data-product-description]');
    if (!container) return Promise.resolve();

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

    return fetchProductData(data.product.link_admin)
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
        if (productData && !productData.error) {
          const titleValue = productData.title && productData.title.trim();
          if (titleValue && isEmptyVal(data.product.title)) {
            data.product.title = titleValue;
            const titleLink = wrap?.querySelector('[data-product-title]');
            const titleText = wrap?.querySelector('[data-product-title-text]');
            if (titleLink) titleLink.textContent = titleValue;
            if (titleText) titleText.textContent = titleValue;
          }

          const categoryValue = productData.category && productData.category.trim();
          if (categoryValue && isEmptyVal(data.product.category)) {
            data.product.category = categoryValue;
            const categoryLine = wrap?.querySelector('[data-product-category]');
            if (categoryLine) {
              categoryLine.style.display = '';
              const categoryTextEl = categoryLine.querySelector('[data-product-category-value]');
              if (categoryTextEl) categoryTextEl.textContent = categoryValue;
            }
          }
          if (productData.category_link && !data.product.link_category) {
            data.product.link_category = productData.category_link;
            const categoryLine = wrap?.querySelector('[data-product-category]');
            const labelEl = categoryLine?.querySelector('[data-product-category-label]');
            if (labelEl) {
              labelEl.innerHTML = `<a class="vui-linkAction" href="${esc(productData.category_link)}">Категория</a>`;
            }
          }

          const createdValue = productData.created_at && productData.created_at.trim();
          if (createdValue && isEmptyVal(data.product.created_at)) {
            data.product.created_at = createdValue;
            const createdLine = wrap?.querySelector('[data-product-created]');
            if (createdLine) {
              createdLine.style.display = '';
              const createdTextEl = createdLine.querySelector('[data-product-created-value]');
              if (createdTextEl) createdTextEl.textContent = createdValue;
            }
          }
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

  function loadRefundSummary(data, wrap) {
    const summaryEl = wrap?.querySelector('[data-refund-summary]');
    if (!summaryEl) return Promise.resolve();
    const status = (data.order.status || '').toLowerCase();
    if (!status.includes('оформлен возврат')) {
      summaryEl.remove();
      return Promise.resolve();
    }
    const listLink = data.actions.refundView;
    if (!listLink) {
      summaryEl.remove();
      return Promise.resolve();
    }

    summaryEl.textContent = 'Загрузка возврата…';

    return fetchRefundData(listLink)
      .then((refundData) => {
        const entry = refundData?.entries?.[0];
        if (!entry) {
          summaryEl.remove();
          return;
        }

        const parts = [];
        const initiatorLabel = entry.initiator?.label ? entry.initiator.label.trim() : '';
        if (initiatorLabel) {
          const initiatorLink = entry.initiator?.href;
          const initiatorMarkup = initiatorLink
            ? `<a class="vui-linkAction" href="${esc(initiatorLink)}">${esc(initiatorLabel)}</a>`
            : esc(initiatorLabel);
          parts.push(`<span class="vui-refundInfo__part">${initiatorMarkup}</span>`);
        }

        const amountLabel = entry.amount ? entry.amount.trim() : '';
        if (amountLabel) {
          const currencyLabel = entry.currency ? ` ${entry.currency.trim()}` : '';
          parts.push(`<span class="vui-refundInfo__part">${esc(amountLabel + currencyLabel)}</span>`);
        }

        const refundType = entry.detail?.refundType ? entry.detail.refundType.trim() : '';
        if (refundType) {
          parts.push(`<span class="vui-refundInfo__part">${esc(`Тип: ${refundType}`)}</span>`);
        }

        const statusLabel = entry.status ? entry.status.trim() : '';
        if (statusLabel) {
          parts.push(`<span class="vui-refundInfo__part">${esc(statusLabel)}</span>`);
        }

        const paymentLabel = entry.paymentSystem?.label ? entry.paymentSystem.label.trim() : '';
        if (paymentLabel) {
          const paymentLink = entry.paymentSystem?.href;
          const paymentMarkup = paymentLink
            ? `<a class="vui-linkAction" href="${esc(paymentLink)}">${esc(paymentLabel)}</a>`
            : esc(paymentLabel);
          parts.push(`<span class="vui-refundInfo__part">${paymentMarkup}</span>`);
        }

        if (!parts.length) {
          summaryEl.remove();
          return;
        }

        summaryEl.innerHTML = parts.join('<span class="vui-refundInfo__separator">•</span>');
      })
      .catch(() => {
        summaryEl.remove();
      });
  }

  function loadAdditionalSections(data, wrap) {
    const preferParallel = Boolean(prefs.parallelSearch);
    const jobs = [
      () => loadProfileSections(data, wrap),
      () => loadProductSection(data, wrap),
      () => loadChatSection(data, wrap),
      () => loadRefundSummary(data, wrap),
    ];
    if (preferParallel) {
      jobs.forEach(fn => fn());
      return Promise.resolve();
    }
    return jobs.reduce((promise, fn) => promise.then(() => fn()), Promise.resolve());
  }

  // ---------- ui controls ----------
  let currentWrap = null;
  let fabButton = null;
  let fabDragging = false;
  let settingsPanel = null;
  let settingsOpen = false;
  let settingsAnchor = null;
  let reviewLoadInProgress = false;

  function applyFabPosition(button, position) {
    if (!button || !position) return;
    const pos = normalizeFabPosition(position);
    button.style.left = `${(pos.x * 100).toFixed(2)}%`;
    button.style.top = `${(pos.y * 100).toFixed(2)}%`;
  }

  function ensureFabButton() {
    if (fabButton && fabButton.isConnected) return fabButton;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'vui-fabButton';
    btn.innerHTML = '<span class="vui-fabIcon">🗂️</span><span class="vui-fabLabel">Показать заказ</span>';
    btn.setAttribute('aria-label', 'Показать панель заказа');
    btn.setAttribute('aria-hidden', 'true');
    btn.tabIndex = -1;
    btn.addEventListener('click', () => {
      if (fabDragging) return;
      setOverlayCollapsed(false, { reason: 'fab' });
    });
    enableFabDragging(btn);
    applyFabPosition(btn, prefs.fabPosition);
    document.body.appendChild(btn);
    fabButton = btn;
    return btn;
  }

  function enableFabDragging(button) {
    if (!button) return;
    let pointerId = null;
    let lastPos = { ...prefs.fabPosition };
    let moved = false;

    const commitPosition = () => {
      updatePrefs({ fabPosition: lastPos });
    };

    const updateFromClient = (clientX, clientY) => {
      const vw = window.innerWidth || document.documentElement.clientWidth || 1;
      const vh = window.innerHeight || document.documentElement.clientHeight || 1;
      const x = Math.min(0.96, Math.max(0.04, clientX / vw));
      const y = Math.min(0.96, Math.max(0.04, clientY / vh));
      lastPos = { x, y };
      applyFabPosition(button, lastPos);
    };

    button.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      pointerId = event.pointerId;
      moved = false;
      fabDragging = false;
      button.setPointerCapture(pointerId);
      event.preventDefault();
    });

    button.addEventListener('pointermove', (event) => {
      if (pointerId === null || event.pointerId !== pointerId) return;
      moved = true;
      fabDragging = true;
      updateFromClient(event.clientX, event.clientY);
    });

    const finish = (event) => {
      if (pointerId === null || (event && event.pointerId !== pointerId)) return;
      try { button.releasePointerCapture(pointerId); } catch {}
      pointerId = null;
      if (moved) {
        commitPosition();
        setTimeout(() => { fabDragging = false; }, 0);
      } else {
        fabDragging = false;
      }
    };

    button.addEventListener('pointerup', finish);
    button.addEventListener('pointercancel', finish);

    button.addEventListener('click', (event) => {
      if (moved) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      moved = false;
    });

    window.addEventListener('resize', () => {
      applyFabPosition(button, getPrefs().fabPosition);
    });
  }

  function setOverlayCollapsed(collapsed, { reason } = {}) {
    const wrap = currentWrap;
    if (!wrap) return;
    const value = Boolean(collapsed);
    wrap.setAttribute('data-overlay-collapsed', value ? 'true' : 'false');
    wrap.style.display = value ? 'none' : '';
    wrap.setAttribute('aria-hidden', value ? 'true' : 'false');
    if (!value) {
      wrap.classList.remove('vui-wrap--hidden');
    } else {
      wrap.classList.add('vui-wrap--hidden');
    }
    const fab = ensureFabButton();
    fab.classList.toggle('is-visible', value);
    fab.setAttribute('aria-hidden', value ? 'false' : 'true');
    fab.tabIndex = value ? 0 : -1;
    if (!value) {
      fab.blur();
      closeSettingsPanel();
    }
    setCollapsedState(value);
    log('Overlay collapse state:', value, reason || 'manual');
  }

  function toggleSettingsPanel(force) {
    if (!settingsPanel) return;
    const shouldOpen = typeof force === 'boolean' ? force : !settingsOpen;
    if (shouldOpen) {
      settingsPanel.classList.add('is-open');
      settingsOpen = true;
      if (settingsAnchor) {
        settingsPanel.style.setProperty('--vui-settings-anchor-top', `${settingsAnchor.getBoundingClientRect().bottom + window.scrollY}px`);
        settingsPanel.style.setProperty('--vui-settings-anchor-right', `${document.documentElement.clientWidth - settingsAnchor.getBoundingClientRect().right - window.scrollX}px`);
      }
    } else {
      settingsPanel.classList.remove('is-open');
      settingsOpen = false;
    }
  }

  function closeSettingsPanel() {
    if (!settingsOpen) return;
    toggleSettingsPanel(false);
  }

  function updateSettingsPanelUI() {
    if (!settingsPanel) return;
    const autoEl = settingsPanel.querySelector('[data-settings-autocollapse]');
    const parallelEl = settingsPanel.querySelector('[data-settings-parallel]');
    if (autoEl) autoEl.checked = Boolean(prefs.autoCollapseOnOpen);
    if (parallelEl) parallelEl.checked = Boolean(prefs.parallelSearch);
  }

  function setupSettingsPanel(wrap, anchorBtn) {
    if (settingsPanel) settingsPanel.remove();
    settingsPanel = document.createElement('div');
    settingsPanel.className = 'vui-settingsPanel';
    settingsPanel.innerHTML = `
      <header class="vui-settingsPanel__head">
        <div class="vui-settingsPanel__title">Настройки</div>
        <button type="button" class="vui-settingsPanel__close" data-settings-close aria-label="Закрыть настройки">×</button>
      </header>
      <div class="vui-settingsPanel__body">
        <label class="vui-settingsRow">
          <input type="checkbox" data-settings-autocollapse />
          <span>Авто-сворачивание после открытия заказа</span>
        </label>
        <label class="vui-settingsRow">
          <input type="checkbox" data-settings-parallel />
          <span>Параллельный поиск по ID пользователя и ID заказа</span>
        </label>
        <p class="vui-settingsHint">FAB можно перетащить — позиция сохраняется пропорционально окну.</p>
        <p class="vui-settingsHint">Перезагрузите страницу заказа, чтобы убедиться, что кэш обновлён.</p>
      </div>
    `;
    wrap.appendChild(settingsPanel);
    settingsAnchor = anchorBtn || null;
    updateSettingsPanelUI();

    const closeBtn = settingsPanel.querySelector('[data-settings-close]');
    closeBtn?.addEventListener('click', () => closeSettingsPanel());

    const autoCheckbox = settingsPanel.querySelector('[data-settings-autocollapse]');
    autoCheckbox?.addEventListener('change', () => {
      const checked = Boolean(autoCheckbox.checked);
      updatePrefs({ autoCollapseOnOpen: checked });
      if (checked) {
        setOverlayCollapsed(true, { reason: 'auto-setting' });
      }
    });

    const parallelCheckbox = settingsPanel.querySelector('[data-settings-parallel]');
    parallelCheckbox?.addEventListener('change', () => {
      const checked = Boolean(parallelCheckbox.checked);
      updatePrefs({ parallelSearch: checked });
    });

    document.addEventListener('click', (event) => {
      if (!settingsOpen) return;
      if (!settingsPanel.contains(event.target) && event.target !== settingsAnchor) {
        closeSettingsPanel();
      }
    });
  }

  function setupOverlayControls(wrap) {
    currentWrap = wrap;
    const head = wrap?.querySelector('.vui-head');
    if (!head) return;
    const controlsRow = document.createElement('div');
    controlsRow.className = 'vui-headControls';

    const collapseBtn = document.createElement('button');
    collapseBtn.type = 'button';
    collapseBtn.className = 'vui-btn vui-btn--ghost vui-headControl';
    collapseBtn.textContent = 'Свернуть';
    collapseBtn.addEventListener('click', () => setOverlayCollapsed(true, { reason: 'button' }));
    controlsRow.appendChild(collapseBtn);

    const settingsBtn = document.createElement('button');
    settingsBtn.type = 'button';
    settingsBtn.className = 'vui-btn vui-btn--ghost vui-headControl';
    settingsBtn.textContent = 'Настройки';
    settingsBtn.addEventListener('click', () => {
      if (!settingsPanel) setupSettingsPanel(wrap, settingsBtn);
      updateSettingsPanelUI();
      toggleSettingsPanel();
    });
    controlsRow.appendChild(settingsBtn);

    const referenceNode = head.querySelector('.vui-headLine')?.nextElementSibling || head.firstElementChild?.nextElementSibling || null;
    head.insertBefore(controlsRow, referenceNode);

    setupSettingsPanel(wrap, settingsBtn);
  }

  function renderReviewText(el, value) {
    if (!el) return;
    const text = value ? String(value) : '';
    if (!text) {
      el.style.display = 'none';
      el.innerHTML = '';
      return;
    }
    el.style.display = '';
    el.innerHTML = esc(text).replace(/\n/g, '<br>');
  }

  function extractScore(raw) {
    if (!raw) return null;
    const num = Number(String(raw).replace(/[^0-9.-]/g, ''));
    return Number.isNaN(num) ? null : num;
  }

  function setupReviewSection(data, wrap) {
    if (!data.review) return;
    const card = wrap?.querySelector('[data-review-card]');
    if (!card) return;

    const statusLine = card.querySelector('[data-review-status-line]');
    const statusValueEl = card.querySelector('[data-review-status-text]');
    const ratingLine = card.querySelector('[data-review-rating-line]');
    const ratingValueEl = card.querySelector('[data-review-rating]');
    const textEl = card.querySelector('[data-review-text]');
    const dateEl = card.querySelector('[data-review-date]');
    const editBtn = card.querySelector('[data-review-edit]');
    const editor = card.querySelector('[data-review-editor]');
    const form = editor?.querySelector('[data-review-form]');
    const textInput = form?.querySelector('[data-review-text-input]');
    const scoreInput = form?.querySelector('[data-review-score-input]');
    const statusInput = form?.querySelector('[data-review-status-input]');
    const cancelBtn = form?.querySelector('[data-review-cancel]');
    const messageEl = form?.querySelector('[data-review-message]');

    if (dateEl && isEmptyVal(data.review.date)) {
      dateEl.style.display = 'none';
    }

    renderReviewText(textEl, data.review.text);
    if (ratingValueEl) {
      const scoreValue = extractScore(data.review.rating);
      if (scoreValue !== null) {
        ratingValueEl.textContent = `${scoreValue}★`;
        ratingLine?.setAttribute('data-visible', 'true');
      } else if (ratingLine) {
        ratingLine.style.display = 'none';
      }
    }

    if (statusLine) statusLine.style.display = 'none';

    const hasReviewLink = Boolean(data.review.link);
    if (hasReviewLink && statusLine && statusValueEl && !reviewLoadInProgress) {
      reviewLoadInProgress = true;
      statusValueEl.textContent = 'Загрузка…';
      statusLine.style.display = '';
      fetchReviewDetail(data.review.link)
        .then((details) => {
          if (!details || details.error) {
            statusValueEl.textContent = 'Не удалось загрузить';
            return;
          }
          if (details.status) {
            data.review.status = details.status;
            statusLine.style.display = '';
            statusValueEl.textContent = details.status;
          } else {
            statusLine.style.display = 'none';
            statusValueEl.textContent = '';
          }
          if (typeof details.text === 'string' && details.text) {
            data.review.text = details.text;
            renderReviewText(textEl, details.text);
          }
          if (typeof details.score !== 'undefined' && details.score !== null) {
            const numericScore = extractScore(details.score);
            if (numericScore !== null && ratingValueEl) {
              ratingValueEl.textContent = `${numericScore}★`;
              ratingLine?.setAttribute('data-visible', 'true');
            }
            if (scoreInput && numericScore !== null) {
              scoreInput.value = String(numericScore);
            }
          }
          if (textInput && typeof data.review.text === 'string') {
            textInput.value = data.review.text;
          }
          if (statusInput && data.review.status) {
            statusInput.value = data.review.status;
          }
        })
        .catch(() => {
          statusValueEl.textContent = 'Не удалось загрузить';
        })
        .finally(() => {
          reviewLoadInProgress = false;
        });
    }

    if (editBtn && editor && form && data.review.userId && data.review.reviewId) {
      editBtn.addEventListener('click', () => {
        if (editor.hidden) {
          if (textInput && typeof data.review.text === 'string') {
            textInput.value = data.review.text;
          }
          if (scoreInput) {
            const scoreValue = extractScore(data.review.rating);
            scoreInput.value = scoreValue !== null ? String(scoreValue) : '';
          }
          if (statusInput) {
            statusInput.value = data.review.status || '';
          }
          editor.hidden = false;
          card.classList.add('is-editing');
          editBtn.disabled = true;
          setTimeout(() => {
            try { textInput?.focus(); } catch {}
          }, 50);
        }
      });

      cancelBtn?.addEventListener('click', () => {
        editor.hidden = true;
        card.classList.remove('is-editing');
        editBtn.disabled = false;
        if (messageEl) {
          messageEl.textContent = '';
          messageEl.className = 'vui-reviewMessage';
        }
      });

      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const payload = {
          userId: data.review.userId,
          reviewId: data.review.reviewId,
        };
        const textValue = textInput ? textInput.value.trim() : '';
        payload.text = textValue;
        const scoreRaw = scoreInput ? scoreInput.value.trim() : '';
        const scoreValue = scoreRaw ? Number(scoreRaw) : null;
        if (scoreRaw && !Number.isNaN(scoreValue)) {
          payload.score = scoreValue;
        }
        const statusValue = statusInput ? statusInput.value : '';
        if (statusValue !== undefined) {
          payload.status = statusValue;
        }
        if (messageEl) {
          messageEl.textContent = 'Сохраняем…';
          messageEl.className = 'vui-reviewMessage is-progress';
        }
        try {
          await patchReview(payload);
          if (messageEl) {
            messageEl.textContent = 'Изменения сохранены';
            messageEl.className = 'vui-reviewMessage is-success';
          }
          data.review.text = textValue;
          if (typeof payload.score !== 'undefined') {
            data.review.rating = String(payload.score);
            if (ratingValueEl) {
              ratingValueEl.textContent = `${payload.score}★`;
              ratingLine?.setAttribute('data-visible', 'true');
              ratingLine.style.display = '';
            }
          } else if (scoreInput && !scoreInput.value) {
            data.review.rating = '';
            if (ratingLine) ratingLine.style.display = 'none';
          }
          data.review.status = statusValue || '';
          if (statusLine && statusValueEl) {
            if (data.review.status) {
              statusLine.style.display = '';
              statusValueEl.textContent = data.review.status;
            } else {
              statusLine.style.display = 'none';
              statusValueEl.textContent = '';
            }
          }
          renderReviewText(textEl, textValue);
          setTimeout(() => {
            if (messageEl) {
              messageEl.textContent = '';
              messageEl.className = 'vui-reviewMessage';
            }
            editor.hidden = true;
            card.classList.remove('is-editing');
            editBtn.disabled = false;
          }, 1200);
        } catch (error) {
          console.error(error);
          if (messageEl) {
            messageEl.textContent = error && error.message ? error.message : 'Не удалось сохранить изменения';
            messageEl.className = 'vui-reviewMessage is-error';
          }
        }
      });
    } else if (editBtn) {
      editBtn.remove();
    }
  }

  function colorizeMatchChips(wrap) {
    if (!wrap) return;
    wrap.querySelectorAll('.vui-chip').forEach((chipEl) => {
      const text = norm(chipEl.textContent || '').toLowerCase();
      if (!text || !text.includes('совпадение')) return;
      let className = 'vui-chip--match-generic';
      if (text.includes('email') || text.includes('почт')) className = 'vui-chip--match-email';
      else if (text.includes('ip')) className = 'vui-chip--match-ip';
      else if (text.includes('id') && text.includes('польз')) className = 'vui-chip--match-user';
      else if (text.includes('id') && text.includes('заказ')) className = 'vui-chip--match-order';
      else if (text.includes('тел') || text.includes('phone')) className = 'vui-chip--match-phone';
      chipEl.classList.add(className);
      const card = chipEl.closest('.vui-card');
      if (card) {
        card.setAttribute('data-match-accent', className);
      }
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
    const formatIssuedItem = (value) => {
      const raw = value || '';
      const match = raw.match(/https?:\/\/\S+/);
      if (!match) return esc(raw);
      const url = match[0];
      const before = raw.slice(0, match.index).replace(/[;,\s]+$/,'').trim();
      const after = raw.slice(match.index + url.length).replace(/^[;,\s]+/,'').trim();
      const parts = [];
      if (before) parts.push(`<span>${esc(before)}</span>`);
      parts.push(`<a class="vui-linkAction" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>`);
      if (after) parts.push(`<span>${esc(after)}</span>`);
      return parts.join('<br>');
    };

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

    const orderStatusValue = safe(data.order.status);
    const statusChip = orderStatusValue
      ? `<span class="${chip(orderStatusValue)}">${esc(orderStatusValue)}</span>`
      : '';
    const isRefundStatus = (orderStatusValue || '').toLowerCase().includes('оформлен возврат');
    const refundSummaryPlaceholder = (isRefundStatus && (data.actions.refundView || data.actions.refundCreate))
      ? '<div class="vui-refundInfo" data-refund-summary></div>'
      : '';
    const statusBlock = (statusChip || refundSummaryPlaceholder)
      ? `<div class="vui-headStatus">${refundSummaryPlaceholder}${statusChip}</div>`
      : '';
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
    const refundLink = data.actions.refundCreate || data.actions.refundView;
    const refundIsView = !data.actions.refundCreate && Boolean(data.actions.refundView);
    const refundLabel = refundIsView ? 'Возвраты' : 'Возврат';
    const refundConfirm = refundIsView ? 'Открыть список возвратов?' : 'Перейти к оформлению возврата?';

    const bottomButtons = [
      data.actions.edit ? `<a class="vui-btn" data-confirm-message="Открыть редактирование заказа?" href="${esc(data.actions.edit)}">Редактировать</a>` : '',
      refundLink ? `<a class="vui-btn vui-btn--danger" data-confirm-message="${esc(refundConfirm)}" href="${esc(refundLink)}">${refundLabel}</a>` : '',
      data.actions.close ? `<a class="vui-btn vui-btn--alert" href="${esc(data.actions.close)}">Закрыть сделку</a>` : '',
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
    const hasCategory = !isEmptyVal(data.product.category);
    const categoryLabelMarkup = data.product.link_category
      ? `<a class="vui-linkAction" data-product-category-anchor href="${esc(data.product.link_category)}">Категория</a>`
      : 'Категория';
    const categoryLine = `
      <div class="vui-line" data-product-category style="${hasCategory ? '' : 'display:none;'}">
        <span data-product-category-label>${categoryLabelMarkup}</span>
        <b data-product-category-value>${hasCategory ? esc(data.product.category) : ''}</b>
      </div>`;

    const hasCreated = !isEmptyVal(data.product.created_at);
    const createdLine = `
      <div class="vui-line" data-product-created style="${hasCreated ? '' : 'display:none;'}">
        <span>Создан</span>
        <b data-product-created-value>${hasCreated ? esc(data.product.created_at) : ''}</b>
      </div>`;

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

    const issuedItemBlock = safe(data.product.issued_item)
      ? `<div class="vui-line"><span>Выданный товар</span><b>${formatIssuedItem(data.product.issued_item)}</b></div>`
      : '';

    const productTitleValue = safe(data.product.title);
    const productTitleText = productTitleValue || 'Товар';
    const productTitleMarkup = data.product.link_admin
      ? `<a class="vui-productTitle" data-product-title data-public-link="${esc(data.product.link_public || '')}" href="${esc(data.product.link_admin)}" title="Клик — открыть товар, Alt+клик — на GGSel">${esc(productTitleText)}</a>`
      : `<span class="vui-productTitleText" data-product-title-text>${esc(productTitleText)}</span>`;

    const orderUuidAttr = orderUuidValue ? ` data-uuid="${esc(orderUuidValue)}"` : '';
    const orderTitleMarkup = orderNumberValue
      ? `Заказ №<button class="vui-orderNumber" type="button" data-order-number${orderUuidAttr} title="Клик — скопировать номер, Alt+клик — UUID">${esc(orderNumberValue)}</button>`
      : 'Заказ';

    const hasReviewLink = data.review && !isEmptyVal(data.review.link);
    const reviewTitleMarkup = hasReviewLink
      ? `<a class="vui-linkAction" href="${esc(data.review.link)}" target="_blank" rel="noopener noreferrer">Отзывы</a>`
      : 'Отзывы';
    const reviewScoreValue = extractScore(data.review?.rating);
    const reviewTextValue = safe(data.review?.text);
    const reviewTextHtml = reviewTextValue ? esc(reviewTextValue).replace(/\n/g, '<br>') : '';
    const reviewDateValue = safe(data.review?.date);
    const canEditReview = Boolean(data.reviewExists && hasReviewLink && data.review.userId && data.review.reviewId);
    const reviewDetailsMarkup = `
      <div class="vui-reviewDetails" data-review-details>
        <div class="vui-line" data-review-rating-line style="${reviewScoreValue !== null ? '' : 'display:none;'}"><span>Оценка</span><b data-review-rating>${reviewScoreValue !== null ? `${reviewScoreValue}★` : ''}</b></div>
        <div class="vui-line" data-review-status-line style="display:none;"><span>Статус</span><b data-review-status-text></b></div>
        <p class="vui-reviewText" data-review-text style="${reviewTextHtml ? '' : 'display:none;'}">${reviewTextHtml}</p>
        <div class="vui-muted vui-reviewDate" data-review-date style="${reviewDateValue ? '' : 'display:none;'}">${reviewDateValue ? esc(reviewDateValue) : ''}</div>
      </div>`;
    const reviewEditorMarkup = canEditReview
      ? `
        <div class="vui-reviewEditor" data-review-editor hidden>
          <form data-review-form>
            <label class="vui-field">
              <span class="vui-fieldLabel">Текст отзыва</span>
              <textarea rows="4" data-review-text-input placeholder="Введите текст отзыва"></textarea>
            </label>
            <div class="vui-fieldRow">
              <label class="vui-field">
                <span class="vui-fieldLabel">Оценка</span>
                <input type="number" min="1" max="5" step="1" data-review-score-input />
              </label>
              <label class="vui-field">
                <span class="vui-fieldLabel">Статус</span>
                <select data-review-status-input>
                  <option value="">По умолчанию</option>
                  <option value="hidden">hidden</option>
                  <option value="published">published</option>
                </select>
              </label>
            </div>
            <div class="vui-reviewButtons">
              <button type="button" class="vui-btn vui-btn--ghost" data-review-cancel>Отмена</button>
              <button type="submit" class="vui-btn vui-btn--primary" data-review-save>Сохранить</button>
            </div>
            <div class="vui-reviewMessage" data-review-message></div>
          </form>
        </div>`
      : '';
    const reviewBodyParts = [];
    if (hasReviewLink || data.reviewExists) reviewBodyParts.push(reviewDetailsMarkup);
    if (!data.reviewExists) reviewBodyParts.push('<div class="vui-empty">Отзыв отсутствует.</div>');
    if (reviewEditorMarkup) reviewBodyParts.push(reviewEditorMarkup);
    const reviewBodyMarkup = reviewBodyParts.join('');
    const reviewActionsMarkup = canEditReview
      ? `<div class="vui-card__actions"><button type="button" class="vui-btn vui-btn--ghost" data-review-edit>Редактировать</button></div>`
      : '';
    const reviewCardMarkup = (data.reviewExists || hasReviewLink)
      ? `
          <article class="vui-card" data-review-card>
            <header class="vui-card__head">
              <div class="vui-title">${reviewTitleMarkup}</div>
              ${reviewActionsMarkup}
            </header>
            <div class="vui-card__body">${reviewBodyMarkup}</div>
          </article>`
      : '';

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
              ${createdLine}
              ${safe(data.product.delivery_type) ? `<div class="vui-line"><span>Тип выдачи</span><b>${data.product.delivery_type}</b></div>` : ''}
              ${issuedItemBlock}
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
                ${safe(data.seller.email) ? `<div class="vui-metaRow"><button class="vui-copyable" type="button" data-copy-value="${esc(data.seller.email)}" title="Клик — скопировать email">${esc(data.seller.email)}</button></div>` : ''}
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
                  ${safe(data.buyer.email) ? `<button class="vui-copyable" type="button" data-copy-value="${esc(data.buyer.email)}" title="Клик — скопировать email">${esc(data.buyer.email)}</button>` : ''}
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

          ${reviewCardMarkup}
        </div>
      </section>
      <div class="vui-footerNote">GsellersBackOffice © 2025 | SERVER TIMEZONE: Moscow</div>
    `;

    const content = document.querySelector('section.content');
    content?.insertBefore(wrap, content.firstElementChild?.nextElementSibling || content.firstChild);

    setupOverlayControls(wrap);
    setupReviewSection(data, wrap);
    colorizeMatchChips(wrap);
    setupProfileToggles(wrap);
    setupChatScrollLock(wrap);
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

    wrap.querySelectorAll('[data-copy-value]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        const value = btn.getAttribute('data-copy-value');
        if (!value) return;
        event.preventDefault();
        copy(value, btn);
      });
    });

    wrap.querySelectorAll('[data-confirm-message]').forEach((link) => {
      link.addEventListener('click', (event) => {
        const message = link.getAttribute('data-confirm-message');
        if (!message) return;
        event.preventDefault();
        const modal = ensureConfirmModal();
        const confirmLabel = link.getAttribute('data-confirm-label') || norm(link.textContent) || 'Продолжить';
        modal.open({
          message,
          confirmLabel,
          onConfirm: () => {
            const attrValue = message;
            link.removeAttribute('data-confirm-message');
            setTimeout(() => {
              if (link.isConnected && attrValue) {
                link.setAttribute('data-confirm-message', attrValue);
              }
            }, 0);
            if (typeof link.click === 'function') {
              link.click();
            } else {
              const href = link.getAttribute('href');
              if (href) {
                const target = link.getAttribute('target') || '_self';
                window.open(href, target);
              }
            }
          },
        });
      });
    });

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
    if (!isOrderPage) {
      releasePrehide();
      return;
    }

    try {
      injectStyles();
      const data = collectData();
      log('Collected:', data);

      hideOld(data.domRefs);
      const wrap = buildUI(data);
      releasePrehide();
      const cacheKey = data.order?.number || data.order?.uuid || location.pathname;
      persistentCache.prepare(cacheKey);
      if (prefs.autoCollapseOnOpen) {
        setOverlayCollapsed(true, { reason: 'auto-open' });
      } else {
        setOverlayCollapsed(overlayState.collapsed, { reason: 'restore' });
      }
      loadAdditionalSections(data, wrap).catch((error) => {
        console.error('[VIBE-UI] Failed to load supplementary sections', error);
      });
      log('Overlay ready (namespaced styles).');
    } catch (error) {
      console.error('[VIBE-UI] Failed to initialize overlay', error);
      releasePrehide();
      throw error;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
  } else {
    setTimeout(main, 50);
  }
})();
