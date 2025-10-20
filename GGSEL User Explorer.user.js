// ==UserScript==
// @name         GGSEL User Explorer
// @description  Быстрый поиск и просмотр данных пользователей в админке GGSEL
// @version      1.0.0
// @match        https://back-office.ggsel.net/admin/users*
// @grant        GM_addStyle
// ==/UserScript==

(function() {
    'use strict';

    const STORAGE_KEY = 'ggsel-user-explorer:last-query';
    const PANEL_STATE_KEY = 'ggsel-user-explorer:panel-open';
    const DEBOUNCE_MS = 600;
    const BASE_URL = window.location.origin;
    const USERS_URL = `${BASE_URL}/admin/users`;
    const LOAD_MORE_LABEL = 'Загрузить ещё';
    const DETAIL_PREFETCH_CONCURRENCY = 3;
    const FIELD_ALIASES = {
        id: 'search[id]',
        user: 'search[username_like]',
        username: 'search[username_like]',
        name: 'search[username_like]',
        email: 'search[email_like]',
        mail: 'search[email_like]',
        ggsel: 'search[ggsel_id_seller]',
        seller: 'search[ggsel_id_seller]',
        ggsel_id: 'search[ggsel_id_seller]',
        amount: 'search[amount__gt]',
        balance: 'search[amount__gt]',
        min_balance: 'search[amount__gt]',
        status: 'search[status]',
        created_from: 'search[created_at][from]',
        created_to: 'search[created_at][to]',
        created_at_from: 'search[created_at][from]',
        created_at_to: 'search[created_at][to]',
        last_login_from: 'search[last_sign_in_at][from]',
        last_login_to: 'search[last_sign_in_at][to]',
        last_sign_in_from: 'search[last_sign_in_at][from]',
        last_sign_in_to: 'search[last_sign_in_at][to]',
        ip: 'search[ip_ilike]',
        wallet: 'search[wallet_number_ilike]',
        phone: 'search[payments_phone_number_ilike]',
        tel: 'search[payments_phone_number_ilike]'
    };

    const DEFAULT_PARAMS = {
        'search[id]': '',
        'search[ggsel_id_seller]': '',
        'search[username_like]': '',
        'search[email_like]': '',
        'search[amount__gt]': '',
        'search[status]': '',
        'search[created_at][from]': '',
        'search[created_at][to]': '',
        'search[last_sign_in_at][from]': '',
        'search[last_sign_in_at][to]': '',
        'search[ip_ilike]': '',
        'search[payments_phone_number_ilike]': '',
        'search[wallet_number_ilike]': '',
        commit: 'Фильтровать'
    };

    const state = {
        open: false,
        loading: false,
        query: '',
        params: { ...DEFAULT_PARAMS },
        page: 1,
        hasMore: false,
        results: [],
        lastToken: 0,
        detailCache: new Map(),
        contextMenu: {
            element: null,
            visible: false,
            userId: null,
            card: null,
            lastPosition: null
        }
    };

    const collapseSpaces = (value) => (value || '').replace(/\s+/g, ' ').trim();

    const copyToClipboard = async (text) => {
        if (text == null) return false;
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(String(text));
                return true;
            }
        } catch (error) {
            console.warn('Clipboard API недоступен', error);
        }
        const textarea = document.createElement('textarea');
        textarea.value = String(text);
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        textarea.style.pointerEvents = 'none';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        let success = false;
        try {
            success = document.execCommand('copy');
        } catch (err) {
            success = false;
        }
        document.body.removeChild(textarea);
        return success;
    };

    const injectStyles = () => {
        const css = `
            .ggsel-user-explorer-button {
                position: fixed;
                bottom: 24px;
                right: 24px;
                width: 56px;
                height: 56px;
                border-radius: 50%;
                background: linear-gradient(135deg, #2563eb, #7c3aed);
                color: #fff;
                box-shadow: 0 10px 25px rgba(37, 99, 235, 0.35);
                border: none;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 24px;
                z-index: 9999;
                transition: transform 0.2s ease, box-shadow 0.2s ease;
            }
            .ggsel-user-explorer-button:hover {
                transform: scale(1.05);
                box-shadow: 0 12px 30px rgba(124, 58, 237, 0.35);
            }
            .ggsel-user-explorer-button:active {
                transform: scale(0.96);
            }
            .ggsel-user-explorer-panel {
                position: fixed;
                bottom: 96px;
                right: 24px;
                width: min(640px, calc(100vw - 48px));
                max-height: min(80vh, 720px);
                background: #0f172a;
                color: #e2e8f0;
                border-radius: 16px;
                box-shadow: 0 20px 60px rgba(15, 23, 42, 0.45);
                display: flex;
                flex-direction: column;
                overflow: hidden;
                z-index: 9999;
                position: fixed;
            }
            .ggsel-user-explorer-panel[hidden] {
                display: none !important;
            }
            .ggsel-user-explorer-close {
                border: none;
                background: rgba(15,23,42,0.6);
                color: #fff;
                width: 32px;
                height: 32px;
                border-radius: 12px;
                font-size: 18px;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                position: absolute;
                top: 14px;
                right: 14px;
                z-index: 1;
            }
            .ggsel-user-explorer-body {
                padding: 24px 20px 20px 20px;
                display: flex;
                flex-direction: column;
                gap: 14px;
                overflow-y: auto;
            }
            .ggsel-user-explorer-input {
                width: 100%;
                padding: 12px 16px;
                border-radius: 12px;
                border: 1px solid rgba(148,163,184,0.35);
                background: rgba(15,23,42,0.65);
                color: #f8fafc;
                font-size: 14px;
            }
            .ggsel-user-explorer-input:focus {
                outline: 2px solid rgba(59,130,246,0.6);
                border-color: transparent;
            }
            .ggsel-user-explorer-hints {
                font-size: 12px;
                color: rgba(148,163,184,0.85);
                line-height: 1.4;
            }
            .ggsel-user-explorer-results {
                display: flex;
                flex-direction: column;
                gap: 12px;
            }
            .ggsel-user-explorer-placeholder {
                padding: 48px 0;
                text-align: center;
                font-size: 14px;
                color: rgba(148,163,184,0.8);
            }
            .ggsel-user-card {
                background: rgba(15,23,42,0.75);
                border-radius: 14px;
                border: 1px solid rgba(59,130,246,0.25);
                overflow: hidden;
                transition: border-color 0.2s ease, box-shadow 0.2s ease;
            }
            .ggsel-user-card:hover {
                border-color: rgba(59,130,246,0.6);
                box-shadow: 0 12px 30px rgba(37,99,235,0.15);
            }
            .ggsel-user-card-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 14px 16px;
                cursor: pointer;
                gap: 12px;
            }
            .ggsel-user-card-meta {
                display: flex;
                flex-direction: column;
                gap: 4px;
            }
            .ggsel-user-card-name {
                font-size: 15px;
                font-weight: 600;
                color: #f8fafc;
            }
            .ggsel-user-card-line {
                font-size: 12px;
                color: rgba(148,163,184,0.9);
                display: flex;
                flex-wrap: wrap;
                gap: 10px;
            }
            .ggsel-user-card-line span {
                display: inline-flex;
                align-items: center;
                gap: 4px;
            }
            .ggsel-user-card-toggle {
                border: none;
                background: rgba(59,130,246,0.18);
                color: #60a5fa;
                border-radius: 10px;
                width: 32px;
                height: 32px;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 16px;
                cursor: pointer;
                flex-shrink: 0;
            }
            .ggsel-user-card-body {
                display: none;
                padding: 0 16px 16px 16px;
                border-top: 1px solid rgba(59,130,246,0.2);
            }
            .ggsel-user-card.open .ggsel-user-card-body {
                display: flex;
                flex-direction: column;
                gap: 12px;
            }
            .ggsel-user-card-actions {
                display: flex;
                flex-wrap: wrap;
                gap: 8px;
            }
            .ggsel-user-action {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                padding: 8px 12px;
                border-radius: 10px;
                border: 1px solid rgba(94,234,212,0.4);
                background: rgba(15,118,110,0.25);
                color: #5eead4;
                text-decoration: none;
                font-size: 12px;
                transition: background 0.2s ease, transform 0.2s ease;
            }
            .ggsel-user-action:hover {
                background: rgba(13,148,136,0.45);
                transform: translateY(-1px);
            }
            .ggsel-user-detail-list {
                display: grid;
                grid-template-columns: minmax(200px, 240px) 1fr;
                gap: 4px 12px;
                font-size: 12px;
                color: rgba(226,232,240,0.95);
            }
            .ggsel-user-detail-list dt {
                font-weight: 600;
                color: rgba(148,163,184,0.9);
            }
            .ggsel-user-detail-list dd {
                margin: 0;
                color: rgba(226,232,240,0.95);
                word-break: break-word;
            }
            .ggsel-user-detail-empty {
                color: rgba(148,163,184,0.7);
                font-style: italic;
            }
            .ggsel-user-card-loader,
            .ggsel-user-loader {
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 10px;
                color: rgba(148,163,184,0.85);
                font-size: 13px;
                padding: 24px 0;
            }
            .ggsel-user-loader-dot {
                width: 8px;
                height: 8px;
                border-radius: 50%;
                background: rgba(148,163,184,0.7);
                animation: ggsel-bounce 1.2s infinite ease-in-out;
            }
            .ggsel-user-loader-dot:nth-child(2) {
                animation-delay: 0.15s;
            }
            .ggsel-user-loader-dot:nth-child(3) {
                animation-delay: 0.3s;
            }
            @keyframes ggsel-bounce {
                0%, 80%, 100% { transform: scale(0); }
                40% { transform: scale(1); }
            }
            .ggsel-user-load-more {
                align-self: center;
                margin-top: 4px;
                padding: 10px 18px;
                border-radius: 12px;
                border: 1px solid rgba(96,165,250,0.45);
                background: rgba(37,99,235,0.18);
                color: #bfdbfe;
                cursor: pointer;
                font-size: 13px;
            }
            .ggsel-user-load-more[disabled] {
                opacity: 0.6;
                cursor: default;
            }
            .ggsel-user-error {
                border-radius: 12px;
                border: 1px solid rgba(248,113,113,0.45);
                background: rgba(220,38,38,0.18);
                padding: 12px;
                font-size: 13px;
                color: #fecaca;
            }
            .ggsel-user-context-menu {
                position: fixed;
                z-index: 10000;
                background: linear-gradient(160deg, rgba(15,23,42,0.96), rgba(30,41,59,0.94));
                color: rgba(226,232,240,0.95);
                border-radius: 12px;
                border: 1px solid rgba(59,130,246,0.32);
                min-width: 180px;
                max-width: calc(100vw - 32px);
                box-shadow: 0 18px 40px rgba(15,23,42,0.45);
                padding: 6px 0;
                display: none;
                font-size: 13px;
                backdrop-filter: blur(12px) saturate(140%);
            }
            .ggsel-user-context-menu.open {
                display: block;
            }
            .ggsel-user-context-menu__item {
                width: 100%;
                border: none;
                background: transparent;
                color: inherit;
                text-align: left;
                padding: 8px 14px;
                cursor: pointer;
                font: inherit;
                line-height: 1.45;
                white-space: nowrap;
                display: flex;
                align-items: center;
                gap: 8px;
            }
            .ggsel-user-context-menu__item:hover,
            .ggsel-user-context-menu__item:focus-visible {
                background: rgba(59,130,246,0.22);
                color: #f8fafc;
                outline: none;
            }
            .ggsel-user-context-menu__item[disabled] {
                opacity: 0.6;
                cursor: default;
            }
            .ggsel-user-context-menu__separator {
                height: 1px;
                margin: 4px 0;
                background: rgba(148,163,184,0.18);
            }
        `;
        if (typeof GM_addStyle === 'function') {
            GM_addStyle(css);
        } else {
            const style = document.createElement('style');
            style.textContent = css;
            document.head.appendChild(style);
        }
    };

    const debounce = (fn, wait = 0) => {
        let timeout;
        let lastArgs;
        const debounced = (...args) => {
            lastArgs = args;
            clearTimeout(timeout);
            timeout = setTimeout(() => {
                timeout = null;
                fn.apply(null, lastArgs);
            }, wait);
        };
        debounced.flush = () => {
            if (!timeout) return;
            clearTimeout(timeout);
            timeout = null;
            if (lastArgs) {
                fn.apply(null, lastArgs);
            }
        };
        debounced.cancel = () => {
            clearTimeout(timeout);
            timeout = null;
        };
        return debounced;
    };

    const parseSearchInput = (rawInput) => {
        const params = { ...DEFAULT_PARAMS };
        const summary = [];
        const input = (rawInput || '').trim();
        if (!input) {
            return { params, summary: 'Введите запрос или используйте фильтры' };
        }

        const tokens = [];
        const tokenRe = /(\w+)(?::|=)("[^"]*"|'[^']*'|[^\s]+)/g;
        let match;
        while ((match = tokenRe.exec(input)) !== null) {
            const [, key, rawValue] = match;
            const value = rawValue.replace(/^['"]|['"]$/g, '');
            tokens.push({ key: key.toLowerCase(), value: value.trim(), raw: match[0] });
        }

        tokens.forEach(({ key, value }) => {
            const mapped = FIELD_ALIASES[key];
            if (mapped) {
                params[mapped] = value;
                summary.push(`${key}: ${value || '—'}`);
            }
        });

        let remainder = input;
        tokens.forEach(({ raw }) => {
            remainder = remainder.replace(raw, ' ');
        });

        // free text (parts not covered by explicit tokens)
        const freeParts = remainder
            .split(/\s+/)
            .map(part => part.replace(/^['"]|['"]$/g, ''))
            .filter(part => part.length);

        if (freeParts.length) {
            const freeText = freeParts.join(' ');
            params['search[username_like]'] = freeText;
            summary.push(`username: ${freeText}`);
        }

        // fallbacks if only number provided (no tokens)
        if (!tokens.length && /^\d+$/.test(input)) {
            params['search[id]'] = input;
            summary.push(`id: ${input}`);
        }

        return {
            params,
            summary: summary.length ? summary.join(' · ') : 'username: ' + input
        };
    };

    const createLoader = (text = 'Загрузка...') => {
        const loader = document.createElement('div');
        loader.className = 'ggsel-user-loader';
        loader.innerHTML = `
            <span class="ggsel-user-loader-dot"></span>
            <span class="ggsel-user-loader-dot"></span>
            <span class="ggsel-user-loader-dot"></span>
            <span>${text}</span>
        `;
        return loader;
    };

    const fetchDocument = async (url) => {
        const response = await fetch(url, {
            credentials: 'include',
            headers: {
                'X-Requested-With': 'XMLHttpRequest'
            }
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const text = await response.text();
        const parser = new DOMParser();
        return parser.parseFromString(text, 'text/html');
    };

    const parseListFromDocument = (doc) => {
        const rows = Array.from(doc.querySelectorAll('table tbody tr'));
        const items = [];
        for (const row of rows) {
            const cells = Array.from(row.children);
            if (!cells.length) {
                continue;
            }
            if (cells[0].tagName === 'TH') {
                continue;
            }
            if (!cells[0].querySelector('a')) {
                continue;
            }
            const idLink = cells[0].querySelector('a');
            const id = collapseSpaces(idLink.textContent);
            const profileUrl = new URL(idLink.getAttribute('href'), BASE_URL).href;
            const username = collapseSpaces(cells[1] ? cells[1].textContent : '');
            const email = collapseSpaces(cells[2] ? cells[2].textContent : '');
            const status = collapseSpaces(cells[3] ? cells[3].textContent : '');
            const balance = collapseSpaces(cells[4] ? cells[4].textContent : '');
            const withdrawals = collapseSpaces(cells[5] ? cells[5].textContent : '');
            const ggselId = collapseSpaces(cells[6] ? cells[6].textContent : '');
            const locale = collapseSpaces(cells[7] ? cells[7].textContent : '');

            items.push({
                id,
                profileUrl,
                username,
                email,
                status,
                balance,
                withdrawals,
                ggselId,
                locale
            });
        }
        return items;
    };

    const hasNextPage = (doc) => {
        const next = doc.querySelector('.pagination li.next:not(.disabled) a');
        return Boolean(next);
    };

    const parseUserDetails = (doc) => {
        const box = doc.querySelector('.box');
        if (!box) {
            throw new Error('Страница пользователя не содержит ожидаемый блок');
        }
        const title = collapseSpaces(box.querySelector('.box-header .box-title')?.textContent || '');
        const dl = box.querySelector('.box-body dl.dl-horizontal');
        const entries = [];
        if (dl) {
            for (let node = dl.firstElementChild; node; node = node.nextElementSibling) {
                if (node.tagName === 'DT') {
                    const label = collapseSpaces(node.textContent);
                    let valueNode = node.nextElementSibling;
                    while (valueNode && valueNode.tagName !== 'DD') {
                        valueNode = valueNode.nextElementSibling;
                    }
                    const valueHtml = valueNode ? valueNode.innerHTML.trim() : '';
                    entries.push({ label, valueHtml });
                }
            }
        }
        const actions = [];
        const actionRoot = box.querySelector('.box-header .pull-right');
        if (actionRoot) {
            const links = Array.from(actionRoot.querySelectorAll('a'));
            const used = new Set();
            for (const link of links) {
                const text = collapseSpaces(link.textContent);
                if (!text) continue;
                const href = link.getAttribute('href');
                if (!href) continue;
                const key = `${text}|${href}`;
                if (used.has(key)) continue;
                used.add(key);
                actions.push({
                    text,
                    href: new URL(href, BASE_URL).href,
                    attributes: {
                        target: link.getAttribute('target') || '',
                        rel: link.getAttribute('rel') || '',
                        dataset: {
                            method: link.dataset.method || '',
                            confirm: link.dataset.confirm || ''
                        }
                    }
                });
            }
        }
        return { title, entries, actions };
    };

    function renderUserDetails(container, details) {
        container.innerHTML = '';
        const title = document.createElement('div');
        title.className = 'ggsel-user-card-name';
        title.textContent = details?.title || 'Профиль пользователя';
        container.appendChild(title);

        if (details && details.actions && details.actions.length) {
            const actionsWrap = document.createElement('div');
            actionsWrap.className = 'ggsel-user-card-actions';
            details.actions.forEach((action) => {
                const link = document.createElement('a');
                link.className = 'ggsel-user-action';
                link.textContent = action.text;
                link.href = action.href;
                if (action.attributes.target) {
                    link.setAttribute('target', action.attributes.target);
                }
                if (action.attributes.rel) {
                    link.setAttribute('rel', action.attributes.rel);
                }
                if (action.attributes.dataset.method) {
                    link.dataset.method = action.attributes.dataset.method;
                }
                if (action.attributes.dataset.confirm) {
                    link.dataset.confirm = action.attributes.dataset.confirm;
                }
                actionsWrap.appendChild(link);
            });
            container.appendChild(actionsWrap);
        }

        if (details && details.entries && details.entries.length) {
            const list = document.createElement('dl');
            list.className = 'ggsel-user-detail-list';
            details.entries.forEach(({ label, valueHtml }) => {
                const dt = document.createElement('dt');
                dt.textContent = label || '';
                const dd = document.createElement('dd');
                dd.innerHTML = valueHtml || '<span class="ggsel-user-detail-empty">—</span>';
                if (!valueHtml) {
                    dd.classList.add('ggsel-user-detail-empty');
                }
                list.appendChild(dt);
                list.appendChild(dd);
            });
            container.appendChild(list);
        } else {
            const empty = document.createElement('div');
            empty.className = 'ggsel-user-detail-empty';
            empty.textContent = 'Данные пользователя не найдены';
            container.appendChild(empty);
        }
    }

    const ensureUserDetails = (user) => {
        const id = user.id;
        const cached = state.detailCache.get(id);
        if (cached) {
            if (cached.status === 'ready') {
                return Promise.resolve(cached.data);
            }
            if (cached.status === 'pending' && cached.promise) {
                return cached.promise;
            }
        }
        const promise = (async () => {
            const doc = await fetchDocument(user.profileUrl);
            const details = parseUserDetails(doc);
            state.detailCache.set(id, { status: 'ready', data: details });
            if (state.resultsContainer) {
                const card = state.resultsContainer.querySelector(`.ggsel-user-card[data-user-id="${id}"]`);
                if (card && card.classList.contains('open')) {
                    const body = card.querySelector('.ggsel-user-card-body');
                    if (body) {
                        renderUserDetails(body, details);
                    }
                }
            }
            updateContextMenuForUser(user, details);
            return details;
        })().catch((error) => {
            state.detailCache.set(id, { status: 'error', error });
            throw error;
        });
        state.detailCache.set(id, { status: 'pending', promise });
        return promise;
    };

    const prefetchUserDetails = async (items) => {
        const queue = items.filter((item) => {
            const cached = state.detailCache.get(item.id);
            return !cached || cached.status === 'error';
        });
        if (!queue.length) {
            return;
        }
        let index = 0;
        const workers = [];
        const workerCount = Math.min(DETAIL_PREFETCH_CONCURRENCY, queue.length);
        for (let i = 0; i < workerCount; i += 1) {
            workers.push((async () => {
                while (index < queue.length) {
                    const currentIndex = index;
                    index += 1;
                    const current = queue[currentIndex];
                    if (!current) {
                        continue;
                    }
                    try {
                        await ensureUserDetails(current);
                    } catch (error) {
                        console.warn('Не удалось предварительно загрузить пользователя', current?.id, error);
                    }
                }
            })());
        }
        await Promise.all(workers);
    };

    const renderUserCard = (user) => {
        const card = document.createElement('div');
        card.className = 'ggsel-user-card';
        card.dataset.userId = user.id;
        card.__userData = user;

        const header = document.createElement('div');
        header.className = 'ggsel-user-card-header';

        const meta = document.createElement('div');
        meta.className = 'ggsel-user-card-meta';

        const name = document.createElement('div');
        name.className = 'ggsel-user-card-name';
        name.textContent = user.username || '(без имени)';

        const line = document.createElement('div');
        line.className = 'ggsel-user-card-line';
        line.innerHTML = `
            <span>#${user.id}</span>
            <span>Почта: ${user.email || '—'}</span>
            <span>Статус: ${user.status || '—'}</span>
            <span>Баланс: ${user.balance || '—'}</span>
        `;

        const line2 = document.createElement('div');
        line2.className = 'ggsel-user-card-line';
        line2.innerHTML = `
            <span>GGSEL ID: ${user.ggselId || '—'}</span>
            <span>Locale: ${user.locale || '—'}</span>
            <span>Вывод: ${user.withdrawals || '—'}</span>
        `;

        meta.appendChild(name);
        meta.appendChild(line);
        meta.appendChild(line2);

        const toggle = document.createElement('button');
        toggle.className = 'ggsel-user-card-toggle';
        toggle.type = 'button';
        toggle.textContent = '+';

        header.appendChild(meta);
        header.appendChild(toggle);

        const body = document.createElement('div');
        body.className = 'ggsel-user-card-body';

        card.appendChild(header);
        card.appendChild(body);

        const toggleCard = async () => {
            const isOpen = card.classList.contains('open');
            if (isOpen) {
                card.classList.remove('open');
                toggle.textContent = '+';
                return;
            }
            card.classList.add('open');
            toggle.textContent = '−';
            const cached = state.detailCache.get(user.id);
            if (cached && cached.status === 'ready') {
                renderUserDetails(body, cached.data);
                return;
            }
            body.innerHTML = '';
            body.appendChild(createLoader('Получаем детали...'));
            try {
                const details = await ensureUserDetails(user);
                if (card.classList.contains('open')) {
                    renderUserDetails(body, details);
                }
            } catch (error) {
                body.innerHTML = '';
                const errorEl = document.createElement('div');
                errorEl.className = 'ggsel-user-error';
                errorEl.textContent = `Не удалось загрузить карточку пользователя: ${error.message}`;
                body.appendChild(errorEl);
            }
        };

        card.toggleCard = toggleCard;

        header.addEventListener('click', toggleCard);
        toggle.addEventListener('click', (event) => {
            event.stopPropagation();
            toggleCard();
        });
        card.addEventListener('contextmenu', (event) => {
            openContextMenu(event, user, card);
        });

        return card;
    };

    function ensureContextMenuElement() {
        if (state.contextMenu.element) {
            return state.contextMenu.element;
        }
        const menu = document.createElement('div');
        menu.className = 'ggsel-user-context-menu';
        menu.style.left = '-9999px';
        menu.style.top = '-9999px';
        menu.tabIndex = -1;
        document.body.appendChild(menu);
        state.contextMenu.element = menu;

        document.addEventListener('click', (event) => {
            if (!state.contextMenu.visible) return;
            if (menu.contains(event.target)) return;
            closeContextMenu();
        });

        document.addEventListener('contextmenu', (event) => {
            if (!state.contextMenu.visible) return;
            if (menu.contains(event.target)) return;
            closeContextMenu();
        });

        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && state.contextMenu.visible) {
                closeContextMenu();
            }
        });

        window.addEventListener('blur', () => {
            if (state.contextMenu.visible) {
                closeContextMenu();
            }
        });

        window.addEventListener('resize', () => {
            if (!state.contextMenu.visible) return;
            const position = state.contextMenu.lastPosition;
            const userId = state.contextMenu.userId;
            const card = state.contextMenu.card;
            const userData = card ? card.__userData : null;
            if (!position || !userId || !userData) {
                closeContextMenu();
                return;
            }
            const cached = state.detailCache.get(userId);
            const payload = {
                details: cached && cached.status === 'ready' ? cached.data : null,
                loading: cached && cached.status === 'pending'
            };
            renderContextMenu({
                user: userData,
                payload,
                position,
                card,
                keepOpen: true
            });
        });

        return menu;
    }

    function closeContextMenu() {
        const menu = state.contextMenu.element;
        if (!menu) return;
        menu.classList.remove('open');
        menu.style.left = '-9999px';
        menu.style.top = '-9999px';
        menu.innerHTML = '';
        state.contextMenu.visible = false;
        state.contextMenu.userId = null;
        state.contextMenu.card = null;
        state.contextMenu.lastPosition = null;
    }

    function executeRemoteAction(action) {
        if (!action || !action.href) {
            return;
        }
        const attributes = action.attributes || {};
        const dataset = attributes.dataset || {};
        if (dataset.confirm) {
            const confirmed = window.confirm(dataset.confirm);
            if (!confirmed) {
                return;
            }
        }
        const method = (dataset.method || '').toUpperCase();
        if (method && method !== 'GET') {
            const form = document.createElement('form');
            form.method = method === 'GET' ? 'get' : 'post';
            form.action = action.href;
            form.style.display = 'none';
            const token = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content');
            if (token) {
                const tokenInput = document.createElement('input');
                tokenInput.type = 'hidden';
                tokenInput.name = 'authenticity_token';
                tokenInput.value = token;
                form.appendChild(tokenInput);
            }
            if (method && method !== 'GET' && method !== 'POST') {
                const methodInput = document.createElement('input');
                methodInput.type = 'hidden';
                methodInput.name = '_method';
                methodInput.value = method;
                form.appendChild(methodInput);
            }
            document.body.appendChild(form);
            form.submit();
            return;
        }
        const target = attributes.target || '_blank';
        if (target === '_self') {
            window.location.href = action.href;
        } else {
            window.open(action.href, target);
        }
    }

    function buildContextMenuItems(user, payload, card) {
        const items = [];
        const loading = payload?.loading;
        const details = payload?.details;

        items.push({
            type: 'action',
            label: card && card.classList.contains('open') ? 'Скрыть подробности' : 'Показать подробности',
            handler: () => {
                if (card && typeof card.toggleCard === 'function') {
                    card.toggleCard();
                }
            }
        });

        items.push({
            type: 'action',
            label: 'Открыть профиль в новой вкладке',
            handler: () => {
                window.open(user.profileUrl, '_blank');
            }
        });

        items.push({ type: 'separator' });

        items.push({
            type: 'action',
            label: 'Скопировать ID',
            handler: () => copyToClipboard(user.id)
        });

        if (user.username) {
            items.push({
                type: 'action',
                label: 'Скопировать username',
                handler: () => copyToClipboard(user.username)
            });
        }

        if (user.email) {
            items.push({
                type: 'action',
                label: 'Скопировать email',
                handler: () => copyToClipboard(user.email)
            });
        }

        if (loading) {
            items.push({ type: 'separator' });
            items.push({ type: 'info', label: 'Загружаем дополнительные действия…' });
        } else if (details && details.actions && details.actions.length) {
            items.push({ type: 'separator' });
            details.actions.forEach((action) => {
                items.push({
                    type: 'remote',
                    label: action.text,
                    action
                });
            });
        }

        // remove duplicate separators
        return items.filter((item, index, array) => {
            if (item.type !== 'separator') return true;
            if (index === 0 || index === array.length - 1) return false;
            const prev = array[index - 1];
            const next = array[index + 1];
            return prev.type !== 'separator' && next.type !== 'separator';
        });
    }

    function renderContextMenu({ user, payload, position, card, keepOpen = false }) {
        const menu = ensureContextMenuElement();
        menu.innerHTML = '';

        const items = buildContextMenuItems(user, payload, card);
        if (!items.length) {
            const emptyButton = document.createElement('button');
            emptyButton.type = 'button';
            emptyButton.className = 'ggsel-user-context-menu__item';
            emptyButton.textContent = 'Нет действий';
            emptyButton.disabled = true;
            menu.appendChild(emptyButton);
        } else {
            const fragment = document.createDocumentFragment();
            items.forEach((item) => {
                if (item.type === 'separator') {
                    const separator = document.createElement('div');
                    separator.className = 'ggsel-user-context-menu__separator';
                    fragment.appendChild(separator);
                    return;
                }
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'ggsel-user-context-menu__item';
                button.textContent = item.label;
                if (item.type === 'info') {
                    button.disabled = true;
                } else {
                    button.addEventListener('click', async () => {
                        try {
                            if (item.type === 'remote') {
                                executeRemoteAction(item.action);
                            } else if (typeof item.handler === 'function') {
                                await item.handler();
                            }
                        } finally {
                            closeContextMenu();
                        }
                    });
                }
                fragment.appendChild(button);
            });
            menu.appendChild(fragment);
        }

        const rawPosition = position || { x: window.innerWidth / 2, y: window.innerHeight / 2 };
        state.contextMenu.visible = true;
        state.contextMenu.userId = user.id;
        state.contextMenu.card = card || null;
        state.contextMenu.lastPosition = { x: rawPosition.x, y: rawPosition.y };

        menu.classList.add('open');
        menu.style.visibility = 'hidden';
        menu.style.left = '0px';
        menu.style.top = '0px';

        const padding = 12;
        const { offsetWidth, offsetHeight } = menu;
        let left = rawPosition.x;
        let top = rawPosition.y;

        if (left + offsetWidth + padding > window.innerWidth) {
            left = window.innerWidth - offsetWidth - padding;
        }
        if (top + offsetHeight + padding > window.innerHeight) {
            top = window.innerHeight - offsetHeight - padding;
        }
        left = Math.max(padding, left);
        top = Math.max(padding, top);

        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;
        menu.style.visibility = '';

        if (!keepOpen) {
            try {
                menu.focus({ preventScroll: true });
            } catch (err) {
                menu.focus();
            }
        }
    }

    function updateContextMenuForUser(user, details) {
        if (!state.contextMenu.visible || state.contextMenu.userId !== user.id) {
            return;
        }
        const position = state.contextMenu.lastPosition || { x: window.innerWidth / 2, y: window.innerHeight / 2 };
        renderContextMenu({
            user,
            payload: { details, loading: false },
            position,
            card: state.contextMenu.card,
            keepOpen: true
        });
    }

    function openContextMenu(event, user, card) {
        event.preventDefault();
        const cached = state.detailCache.get(user.id);
        const payload = {
            details: cached && cached.status === 'ready' ? cached.data : null,
            loading: !cached || cached.status === 'pending'
        };
        renderContextMenu({
            user,
            payload,
            position: { x: event.clientX, y: event.clientY },
            card
        });
        if (!cached || cached.status !== 'ready') {
            ensureUserDetails(user).catch(() => {});
        }
    }

    const updateResults = (items, append = false) => {
        if (!append) {
            state.resultsContainer.innerHTML = '';
        }
        if (!items.length && !append) {
            const placeholder = document.createElement('div');
            placeholder.className = 'ggsel-user-explorer-placeholder';
            placeholder.textContent = 'По вашему запросу ничего не найдено';
            state.resultsContainer.appendChild(placeholder);
            return;
        }
        items.forEach((item) => {
            const card = renderUserCard(item);
            state.resultsContainer.appendChild(card);
        });
    };

    const buildUrlWithParams = (params, page) => {
        const url = new URL(USERS_URL);
        Object.entries(params).forEach(([key, value]) => {
            if (value !== undefined && value !== null && value !== '') {
                url.searchParams.set(key, value);
            }
        });
        if (page && page > 1) {
            url.searchParams.set('page', String(page));
        }
        return url.toString();
    };

    const performSearch = async ({ append = false } = {}) => {
        if (!state.query) {
            state.resultsContainer.innerHTML = '';
            const placeholder = document.createElement('div');
            placeholder.className = 'ggsel-user-explorer-placeholder';
            placeholder.textContent = 'Введите запрос для поиска пользователей';
            state.resultsContainer.appendChild(placeholder);
            state.loadMoreButton.hidden = true;
            return;
        }
        const token = ++state.lastToken;
        state.loading = true;
        const loader = createLoader('Выполняем поиск...');
        if (!append) {
            state.resultsContainer.innerHTML = '';
            state.resultsContainer.appendChild(loader);
        } else {
            state.loadMoreButton.disabled = true;
            state.loadMoreButton.textContent = 'Загружаем...';
        }
        const page = append ? state.page + 1 : 1;
        try {
            const url = buildUrlWithParams(state.params, page);
            const doc = await fetchDocument(url);
            if (token !== state.lastToken) {
                return;
            }
            const items = parseListFromDocument(doc);
            state.page = page;
            state.hasMore = hasNextPage(doc);
            state.results = append ? state.results.concat(items) : items;
            if (!append) {
                updateResults(state.results, false);
            } else {
                updateResults(items, true);
            }
            await prefetchUserDetails(append ? items : state.results);
            if (token !== state.lastToken) {
                return;
            }
            state.loadMoreButton.hidden = !state.hasMore;
            state.loadMoreButton.disabled = false;
            state.loadMoreButton.textContent = LOAD_MORE_LABEL;
            if (!items.length && append) {
                state.loadMoreButton.hidden = true;
            }
        } catch (error) {
            if (!append) {
                state.resultsContainer.innerHTML = '';
                const errorEl = document.createElement('div');
                errorEl.className = 'ggsel-user-error';
                errorEl.textContent = `Ошибка при поиске пользователей: ${error.message}`;
                state.resultsContainer.appendChild(errorEl);
                state.loadMoreButton.hidden = true;
            } else {
                state.loadMoreButton.hidden = false;
                state.loadMoreButton.disabled = false;
                state.loadMoreButton.textContent = 'Ошибка загрузки';
                setTimeout(() => {
                    if (state.hasMore) {
                        state.loadMoreButton.textContent = LOAD_MORE_LABEL;
                        state.loadMoreButton.disabled = false;
                    } else {
                        state.loadMoreButton.hidden = true;
                    }
                }, 2000);
            }
        } finally {
            state.loading = false;
        }
    };

    const onQueryChange = debounce((value) => {
        state.query = value.trim();
        const { params, summary } = parseSearchInput(state.query);
        state.params = params;
        state.summary.textContent = summary;
        localStorage.setItem(STORAGE_KEY, state.query);
        state.page = 1;
        state.hasMore = false;
        state.detailCache.clear();
        closeContextMenu();
        performSearch({ append: false });
    }, DEBOUNCE_MS);

    const restoreState = () => {
        try {
            const savedQuery = localStorage.getItem(STORAGE_KEY);
            if (savedQuery) {
                state.input.value = savedQuery;
                state.query = savedQuery;
                const { params, summary } = parseSearchInput(savedQuery);
                state.params = params;
                state.summary.textContent = summary;
                performSearch({ append: false });
            }
            const openState = localStorage.getItem(PANEL_STATE_KEY);
            if (openState === '1') {
                openPanel();
            }
        } catch (error) {
            console.warn('[GGSEL User Explorer] Не удалось восстановить состояние', error);
        }
    };

    const openPanel = () => {
        state.panel.hidden = false;
        state.button.setAttribute('aria-pressed', 'true');
        state.open = true;
        localStorage.setItem(PANEL_STATE_KEY, '1');
        setTimeout(() => state.input.focus(), 50);
    };

    const closePanel = () => {
        state.panel.hidden = true;
        state.button.setAttribute('aria-pressed', 'false');
        state.open = false;
        localStorage.setItem(PANEL_STATE_KEY, '0');
        closeContextMenu();
    };

    const togglePanel = () => {
        if (state.open) {
            closePanel();
        } else {
            openPanel();
        }
    };

    const init = () => {
        injectStyles();

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'ggsel-user-explorer-button';
        button.title = 'Открыть поиск пользователей';
        button.innerHTML = '🔍';
        button.addEventListener('click', togglePanel);

        const panel = document.createElement('div');
        panel.className = 'ggsel-user-explorer-panel';
        panel.hidden = true;

        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'ggsel-user-explorer-close';
        closeBtn.innerHTML = '&times;';
        closeBtn.addEventListener('click', closePanel);

        const body = document.createElement('div');
        body.className = 'ggsel-user-explorer-body';

        const input = document.createElement('input');
        input.type = 'search';
        input.placeholder = 'Например: username:soda status:seller или 1271';
        input.className = 'ggsel-user-explorer-input';
        input.addEventListener('input', (event) => onQueryChange(event.target.value));
        input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                onQueryChange.flush?.();
            }
        });

        const hints = document.createElement('div');
        hints.className = 'ggsel-user-explorer-hints';
        hints.innerHTML = 'Доступные фильтры: <code>id</code>, <code>username</code>, <code>email</code>, <code>ggsel</code>, <code>status</code>, <code>amount</code>, <code>created_from</code>, <code>created_to</code>, <code>last_login_from</code>, <code>last_login_to</code>, <code>ip</code>, <code>wallet</code>, <code>phone</code>. Используйте <code>ключ:значение</code> или свободный текст.';

        const summary = document.createElement('div');
        summary.className = 'ggsel-user-explorer-hints';
        summary.textContent = 'Введите запрос или используйте фильтры';

        const resultsContainer = document.createElement('div');
        resultsContainer.className = 'ggsel-user-explorer-results';

        const loadMoreButton = document.createElement('button');
        loadMoreButton.type = 'button';
        loadMoreButton.className = 'ggsel-user-load-more';
        loadMoreButton.textContent = LOAD_MORE_LABEL;
        loadMoreButton.hidden = true;
        loadMoreButton.addEventListener('click', () => {
            if (state.loading || !state.hasMore) return;
            performSearch({ append: true });
        });

        body.appendChild(input);
        body.appendChild(hints);
        body.appendChild(summary);
        body.appendChild(resultsContainer);
        body.appendChild(loadMoreButton);

        panel.appendChild(closeBtn);
        panel.appendChild(body);

        document.body.appendChild(button);
        document.body.appendChild(panel);

        state.button = button;
        state.panel = panel;
        state.input = input;
        state.summary = summary;
        state.resultsContainer = resultsContainer;
        state.loadMoreButton = loadMoreButton;

        restoreState();
    };

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        init();
    } else {
        document.addEventListener('DOMContentLoaded', init);
    }
})();

