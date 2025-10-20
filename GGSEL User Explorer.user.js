// ==UserScript==
// @name         GGSEL User Explorer
// @description  Быстрый поиск и просмотр информации о пользователях на странице админки GGSEL
// @version      1.0.0
// @match        https://back-office.ggsel.net/admin/users*
// @grant        GM_addStyle
// ==/UserScript==

(function() {
    'use strict';

    const SCRIPT_ID = 'ggsel-user-explorer';
    const STORAGE_KEY = `${SCRIPT_ID}:last-state`;
    const LOG_PREFIX = '[GGSEL User Explorer]';
    const BASE_URL = location.origin;
    const LOAD_MORE_LABEL = 'Загрузить ещё';
    const REQUEST_TIMEOUT_MS = 15000;

    const FIELDS = [
        { name: 'search[id]', label: 'ID пользователя', type: 'text', placeholder: 'Например, 12345' },
        { name: 'search[ggsel_id_seller]', label: 'ID продавца в GGSEL', type: 'text', placeholder: 'Например, 1093090' },
        { name: 'search[username_like]', label: 'Имя пользователя', type: 'text', placeholder: 'Фрагмент имени' },
        { name: 'search[email_like]', label: 'Email', type: 'text', placeholder: 'Фрагмент email' },
        { name: 'search[amount__gt]', label: 'Минимальный баланс', type: 'number', step: 'any', placeholder: 'Минимальное значение' },
        { name: 'search[status]', label: 'Статус', type: 'select', cloneSelector: 'select[name="search[status]"]' },
        { name: 'search[created_at][from]', label: 'Дата создания от', type: 'date' },
        { name: 'search[created_at][to]', label: 'Дата создания до', type: 'date' },
        { name: 'search[last_sign_in_at][from]', label: 'Последняя авторизация от', type: 'date' },
        { name: 'search[last_sign_in_at][to]', label: 'Последняя авторизация до', type: 'date' },
        { name: 'search[ip_ilike]', label: 'IP адрес', type: 'text', placeholder: 'Фрагмент IP' },
        { name: 'search[payments_phone_number_ilike]', label: 'Номер телефона', type: 'text', placeholder: 'Фрагмент номера' },
        { name: 'search[wallet_number_ilike]', label: 'Номер кошелька', type: 'text', placeholder: 'Фрагмент номера' },
    ];

    const stateStorage = {
        load() {
            try {
                const raw = localStorage.getItem(STORAGE_KEY);
                if (!raw) return null;
                const parsed = JSON.parse(raw);
                if (!parsed || typeof parsed !== 'object') return null;
                return parsed;
            } catch (error) {
                console.warn(LOG_PREFIX, 'Не удалось прочитать состояние', error);
                return null;
            }
        },
        save(payload) {
            try {
                localStorage.setItem(STORAGE_KEY, JSON.stringify(payload || {}));
            } catch (error) {
                console.warn(LOG_PREFIX, 'Не удалось сохранить состояние', error);
            }
        },
        clear() {
            try {
                localStorage.removeItem(STORAGE_KEY);
            } catch (error) {
                console.warn(LOG_PREFIX, 'Не удалось очистить состояние', error);
            }
        },
    };

    function withTimeout(promise, timeout = REQUEST_TIMEOUT_MS, message = 'Превышено время ожидания запроса') {
        let timer;
        return Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(message)), timeout);
            }),
        ]).finally(() => clearTimeout(timer));
    }

    function absoluteUrl(url) {
        if (!url) return null;
        try {
            return new URL(url, BASE_URL).toString();
        } catch (error) {
            console.warn(LOG_PREFIX, 'Не удалось собрать URL', url, error);
            return null;
        }
    }

    function parseHTML(html) {
        return new DOMParser().parseFromString(html, 'text/html');
    }

    function textContent(node) {
        if (!node) return '';
        return node.textContent.trim();
    }

    function createElement(tag, className, options = {}) {
        const el = document.createElement(tag);
        if (className) {
            el.className = className;
        }
        if (options.attrs) {
            Object.entries(options.attrs).forEach(([name, value]) => {
                if (value !== undefined && value !== null) {
                    el.setAttribute(name, value);
                }
            });
        }
        if (options.text) {
            el.textContent = options.text;
        }
        if (options.html) {
            el.innerHTML = options.html;
        }
        return el;
    }

    function buildStyles() {
        const styles = `
            .gux-fab {
                position: fixed;
                bottom: 24px;
                right: 24px;
                width: 56px;
                height: 56px;
                border-radius: 50%;
                background: #2563eb;
                color: #fff;
                border: none;
                box-shadow: 0 10px 30px rgba(37, 99, 235, 0.35);
                cursor: pointer;
                z-index: 9998;
                font-size: 24px;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: transform 0.2s ease, box-shadow 0.2s ease;
            }
            .gux-fab:hover {
                transform: translateY(-2px);
                box-shadow: 0 16px 40px rgba(37, 99, 235, 0.45);
            }
            .gux-panel {
                position: fixed;
                inset: 0;
                background: rgba(15, 23, 42, 0.45);
                display: none;
                align-items: flex-end;
                justify-content: flex-end;
                z-index: 9999;
            }
            .gux-panel.gux-panel--visible {
                display: flex;
            }
            .gux-panel__container {
                width: min(700px, 96vw);
                max-height: 92vh;
                background: #fff;
                border-radius: 18px 18px 0 0;
                box-shadow: 0 32px 60px rgba(15, 23, 42, 0.25);
                display: flex;
                flex-direction: column;
                overflow: hidden;
            }
            .gux-panel__header {
                padding: 20px 24px 12px;
                display: flex;
                align-items: center;
                justify-content: space-between;
                border-bottom: 1px solid #e2e8f0;
                background: linear-gradient(120deg, rgba(37, 99, 235, 0.08), rgba(59, 130, 246, 0.05));
            }
            .gux-panel__title {
                font-size: 18px;
                font-weight: 600;
                color: #0f172a;
            }
            .gux-panel__close {
                background: none;
                border: none;
                font-size: 20px;
                cursor: pointer;
                color: #475569;
            }
            .gux-panel__body {
                padding: 16px 24px 24px;
                overflow-y: auto;
            }
            .gux-form {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
                gap: 12px 16px;
                margin-bottom: 16px;
            }
            .gux-field {
                display: flex;
                flex-direction: column;
                gap: 6px;
            }
            .gux-field label {
                font-weight: 600;
                font-size: 13px;
                color: #1e293b;
            }
            .gux-field input,
            .gux-field select {
                padding: 8px 10px;
                border-radius: 8px;
                border: 1px solid #cbd5f5;
                font-size: 13px;
                color: #0f172a;
                transition: border-color 0.2s ease, box-shadow 0.2s ease;
            }
            .gux-field input:focus,
            .gux-field select:focus {
                outline: none;
                border-color: #2563eb;
                box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.2);
            }
            .gux-actions {
                display: flex;
                gap: 12px;
                margin-bottom: 12px;
                flex-wrap: wrap;
            }
            .gux-results {
                display: flex;
                flex-direction: column;
                gap: 12px;
            }
            .gux-button {
                padding: 10px 16px;
                border-radius: 9999px;
                border: none;
                cursor: pointer;
                font-weight: 600;
                font-size: 14px;
                transition: transform 0.2s ease, box-shadow 0.2s ease;
            }
            .gux-button--primary {
                background: #2563eb;
                color: #fff;
                box-shadow: 0 10px 20px rgba(37, 99, 235, 0.25);
            }
            .gux-button--primary:hover {
                transform: translateY(-1px);
                box-shadow: 0 16px 30px rgba(37, 99, 235, 0.35);
            }
            .gux-button--secondary {
                background: #e2e8f0;
                color: #1e293b;
            }
            .gux-results-empty {
                padding: 32px 16px;
                text-align: center;
                color: #64748b;
                font-size: 14px;
                background: rgba(148, 163, 184, 0.08);
                border-radius: 14px;
            }
            .gux-result {
                border: 1px solid rgba(148, 163, 184, 0.35);
                border-radius: 16px;
                padding: 14px 16px;
                margin-bottom: 12px;
                display: flex;
                flex-direction: column;
                gap: 10px;
                background: #fff;
                box-shadow: 0 6px 20px rgba(15, 23, 42, 0.06);
            }
            .gux-result__header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
            }
            .gux-result__title {
                font-weight: 600;
                font-size: 15px;
                color: #0f172a;
            }
            .gux-result__meta {
                font-size: 12px;
                color: #475569;
            }
            .gux-expand-btn {
                border: none;
                background: #2563eb;
                color: #fff;
                border-radius: 999px;
                padding: 6px 12px;
                cursor: pointer;
                font-size: 12px;
                display: flex;
                align-items: center;
                gap: 4px;
            }
            .gux-expand-btn[disabled] {
                opacity: 0.6;
                cursor: progress;
            }
            .gux-result__body {
                display: none;
                flex-direction: column;
                gap: 12px;
                border-top: 1px solid rgba(148, 163, 184, 0.25);
                padding-top: 12px;
                font-size: 13px;
                color: #0f172a;
            }
            .gux-result__body--visible {
                display: flex;
            }
            .gux-result__body h4 {
                margin: 4px 0;
                font-size: 14px;
                font-weight: 600;
                color: #1f2937;
            }
            .gux-info-grid {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
                gap: 8px 16px;
            }
            .gux-info-item {
                display: flex;
                flex-direction: column;
                gap: 4px;
                background: rgba(226, 232, 240, 0.45);
                border-radius: 10px;
                padding: 8px 10px;
            }
            .gux-info-item__label {
                font-size: 11px;
                text-transform: uppercase;
                letter-spacing: 0.05em;
                color: #475569;
            }
            .gux-info-item__value {
                font-size: 13px;
                color: #0f172a;
                word-break: break-word;
            }
            .gux-empty-text {
                font-size: 13px;
                color: #64748b;
            }
            .gux-actions-list {
                display: flex;
                flex-direction: column;
                gap: 10px;
            }
            .gux-actions-row {
                display: flex;
                flex-wrap: wrap;
                gap: 8px;
            }
            .gux-action-link {
                border-radius: 8px;
                padding: 6px 10px;
                font-size: 12px;
                font-weight: 600;
                text-decoration: none;
                background: rgba(59, 130, 246, 0.12);
                color: #1d4ed8;
                border: 1px solid rgba(37, 99, 235, 0.2);
            }
            .gux-action-link:hover {
                background: rgba(59, 130, 246, 0.22);
            }
            .gux-dropdown {
                border-radius: 12px;
                border: 1px solid rgba(148, 163, 184, 0.35);
                padding: 10px;
                display: flex;
                flex-direction: column;
                gap: 6px;
                background: rgba(248, 250, 252, 0.85);
            }
            .gux-dropdown__title {
                font-weight: 600;
                font-size: 13px;
                color: #0f172a;
            }
            .gux-loading {
                padding: 18px 14px;
                text-align: center;
                font-size: 13px;
                color: #475569;
            }
            .gux-error {
                background: rgba(248, 113, 113, 0.18);
                color: #b91c1c;
                border: 1px solid rgba(248, 113, 113, 0.4);
                border-radius: 12px;
                padding: 12px 14px;
                margin-bottom: 12px;
                font-size: 13px;
            }
            .gux-load-more {
                display: flex;
                justify-content: center;
                margin-top: 16px;
            }
        `;
        GM_addStyle(styles);
    }

    function extractFieldValue(input) {
        if (!input) return '';
        if (input.type === 'checkbox') {
            return input.checked ? input.value || '1' : '';
        }
        return input.value.trim();
    }

    function renderInfoItems(container, pairs) {
        container.innerHTML = '';
        if (!pairs || !pairs.length) {
            container.appendChild(createElement('div', 'gux-info-item', {
                text: 'Нет данных для отображения',
            }));
            return;
        }
        pairs.forEach(({ label, value }) => {
            const item = createElement('div', 'gux-info-item');
            item.appendChild(createElement('div', 'gux-info-item__label', { text: label }));
            item.appendChild(createElement('div', 'gux-info-item__value', { text: value || '—' }));
            container.appendChild(item);
        });
    }

    function renderActionGroups(container, actions) {
        container.innerHTML = '';
        if (!actions || (!actions.primary.length && !actions.groups.length)) {
            container.appendChild(createElement('div', 'gux-empty-text', { text: 'Нет доступных действий' }));
            return;
        }
        if (actions.primary.length) {
            const row = createElement('div', 'gux-actions-row');
            actions.primary.forEach(({ label, href, attributes }) => {
                const link = createElement('a', 'gux-action-link', { text: label, attrs: { href } });
                if (attributes) {
                    Object.entries(attributes).forEach(([name, value]) => {
                        if (value !== undefined && value !== null) {
                            link.setAttribute(name, value);
                        }
                    });
                }
                row.appendChild(link);
            });
            container.appendChild(row);
        }
        actions.groups.forEach(({ title, items }) => {
            const block = createElement('div', 'gux-dropdown');
            block.appendChild(createElement('div', 'gux-dropdown__title', { text: title }));
            if (!items.length) {
                block.appendChild(createElement('div', 'gux-empty-text', { text: 'Нет доступных действий' }));
            } else {
                const list = createElement('div', 'gux-actions-row');
                items.forEach(({ label, href, attributes }) => {
                    const link = createElement('a', 'gux-action-link', { text: label, attrs: { href } });
                    if (attributes) {
                        Object.entries(attributes).forEach(([name, value]) => {
                            if (value !== undefined && value !== null) {
                                link.setAttribute(name, value);
                            }
                        });
                    }
                    list.appendChild(link);
                });
                block.appendChild(list);
            }
            container.appendChild(block);
        });
    }

    function parseActions(container) {
        const actions = { primary: [], groups: [] };
        if (!container) return actions;
        Array.from(container.children).forEach((child) => {
            if (!child) return;
            if (child.matches('a')) {
                const href = absoluteUrl(child.getAttribute('href'));
                const label = textContent(child);
                const attrs = {};
                Array.from(child.attributes).forEach((attr) => {
                    if (attr.name === 'href' || attr.name === 'class') return;
                    attrs[attr.name] = attr.value;
                });
                actions.primary.push({ label, href, attributes: attrs });
            } else if (child.classList.contains('dropdown')) {
                const titleBtn = child.querySelector('button');
                const title = titleBtn ? textContent(titleBtn) : 'Дополнительно';
                const items = [];
                child.querySelectorAll('ul li a').forEach((link) => {
                    const href = absoluteUrl(link.getAttribute('href'));
                    const label = textContent(link);
                    const attrs = {};
                    Array.from(link.attributes).forEach((attr) => {
                        if (attr.name === 'href' || attr.name === 'class') return;
                        attrs[attr.name] = attr.value;
                    });
                    items.push({ label, href, attributes: attrs });
                });
                actions.groups.push({ title, items });
            }
        });
        return actions;
    }

    function parseUserDetails(html) {
        const doc = parseHTML(html);
        const box = doc.querySelector('.box');
        if (!box) {
            return { info: [], actions: { primary: [], groups: [] } };
        }
        const infoPairs = [];
        const dl = box.querySelector('dl');
        if (dl) {
            const children = Array.from(dl.children);
            for (let i = 0; i < children.length; i += 2) {
                const dt = children[i];
                const dd = children[i + 1];
                if (!dt || !dd) continue;
                infoPairs.push({ label: textContent(dt), value: textContent(dd) });
            }
        }
        const actionsContainer = box.querySelector('.box-header .pull-right');
        const actions = parseActions(actionsContainer);
        return { info: infoPairs, actions };
    }

    function parseSearchResults(html) {
        const doc = parseHTML(html);
        const rows = Array.from(doc.querySelectorAll('table tbody tr'));
        const items = [];
        rows.forEach((row) => {
            const cells = Array.from(row.querySelectorAll('td'));
            if (!cells.length) return;
            const idLink = cells[0].querySelector('a');
            const id = idLink ? textContent(idLink) : textContent(cells[0]);
            const detailUrl = idLink ? absoluteUrl(idLink.getAttribute('href')) : null;
            const username = textContent(cells[1]);
            const email = textContent(cells[2]);
            const status = textContent(cells[3]);
            const balance = textContent(cells[4]);
            const withdrawalsEnabled = textContent(cells[5]);
            const ggselId = textContent(cells[6]);
            const locale = textContent(cells[7]);
            items.push({
                id,
                detailUrl,
                username,
                email,
                status,
                balance,
                withdrawalsEnabled,
                ggselId,
                locale,
            });
        });
        let nextPageUrl = null;
        const nextLink = doc.querySelector('.pagination a[rel="next"], .pagination li.next a, .pagination .next a');
        if (nextLink) {
            nextPageUrl = absoluteUrl(nextLink.getAttribute('href'));
        }
        return { items, nextPageUrl };
    }

    async function fetchText(url) {
        return withTimeout(fetch(url, { credentials: 'include' }).then((response) => {
            if (!response.ok) {
                throw new Error(`Ошибка ${response.status}`);
            }
            return response.text();
        }));
    }

    function buildField(field, savedState = {}) {
        const fieldWrapper = createElement('div', 'gux-field');
        fieldWrapper.appendChild(createElement('label', null, { text: field.label }));
        let control;
        if (field.type === 'select') {
            control = createElement('select');
            control.name = field.name;
            if (field.cloneSelector) {
                const original = document.querySelector(field.cloneSelector);
                if (original && original.tagName === 'SELECT') {
                    Array.from(original.options).forEach((option) => {
                        const copy = option.cloneNode(true);
                        control.appendChild(copy);
                    });
                }
            }
            if (!control.options.length) {
                const option = createElement('option');
                option.value = '';
                option.textContent = 'Любой статус';
                control.appendChild(option);
            }
        } else {
            control = createElement('input');
            control.type = field.type || 'text';
            if (field.placeholder) {
                control.placeholder = field.placeholder;
            }
            if (field.step) {
                control.step = field.step;
            }
            control.name = field.name;
        }
        const savedValue = savedState[field.name];
        if (savedValue !== undefined && savedValue !== null) {
            control.value = savedValue;
        }
        fieldWrapper.appendChild(control);
        return { wrapper: fieldWrapper, control };
    }

    function collectFormValues(form) {
        const result = {};
        FIELDS.forEach((field) => {
            const input = form.querySelector(`[name="${field.name}"]`);
            if (!input) return;
            const value = extractFieldValue(input);
            if (value) {
                result[field.name] = value;
            }
        });
        return result;
    }

    function buildSearchUrl(values, pageUrl = null) {
        if (pageUrl) return pageUrl;
        const url = new URL('/admin/users', BASE_URL);
        Object.entries(values).forEach(([key, value]) => {
            url.searchParams.set(key, value);
        });
        url.searchParams.set('commit', 'Фильтровать');
        return url.toString();
    }

    function toggleLoading(container, isLoading, message = 'Загрузка...') {
        let loadingNode = container.querySelector('.gux-loading');
        if (isLoading) {
            if (!loadingNode) {
                loadingNode = createElement('div', 'gux-loading', { text: message });
                container.appendChild(loadingNode);
            }
        } else if (loadingNode) {
            loadingNode.remove();
        }
    }

    function createResultNode(item, detailLoader) {
        const wrapper = createElement('div', 'gux-result');
        const header = createElement('div', 'gux-result__header');
        const title = createElement('div', 'gux-result__title', { text: item.username || '(без имени)' });
        const meta = createElement('div', 'gux-result__meta', {
            text: [`ID: ${item.id || '—'}`, item.email ? `Email: ${item.email}` : null, item.status ? `Статус: ${item.status}` : null]
                .filter(Boolean)
                .join(' · '),
        });
        const expand = createElement('button', 'gux-expand-btn', { text: 'Подробнее' });
        header.appendChild(title);
        header.appendChild(meta);
        header.appendChild(expand);
        const body = createElement('div', 'gux-result__body');
        const summaryGrid = createElement('div', 'gux-info-grid');
        [
            { label: 'Баланс', value: item.balance },
            { label: 'Разрешён вывод средств', value: item.withdrawalsEnabled },
            { label: 'GGSEL ID продавца', value: item.ggselId },
            { label: 'Локаль', value: item.locale },
        ].forEach(({ label, value }) => {
            if (!label) return;
            const infoItem = createElement('div', 'gux-info-item');
            infoItem.appendChild(createElement('div', 'gux-info-item__label', { text: label }));
            infoItem.appendChild(createElement('div', 'gux-info-item__value', { text: value || '—' }));
            summaryGrid.appendChild(infoItem);
        });
        const detailsInfo = createElement('div', 'gux-info-grid');
        const actionsContainer = createElement('div', 'gux-actions-list');
        body.appendChild(summaryGrid);
        body.appendChild(createElement('h4', null, { text: 'Карточка пользователя' }));
        body.appendChild(detailsInfo);
        body.appendChild(createElement('h4', null, { text: 'Действия' }));
        body.appendChild(actionsContainer);
        wrapper.appendChild(header);
        wrapper.appendChild(body);

        let isExpanded = false;
        let isLoaded = false;
        expand.addEventListener('click', async () => {
            if (isExpanded) {
                body.classList.remove('gux-result__body--visible');
                expand.textContent = 'Подробнее';
                isExpanded = false;
                return;
            }
            body.classList.add('gux-result__body--visible');
            expand.textContent = 'Скрыть';
            isExpanded = true;
            if (isLoaded || !item.detailUrl) return;
            expand.disabled = true;
            try {
                detailsInfo.innerHTML = '';
                const loading = createElement('div', 'gux-loading', { text: 'Загрузка карточки...' });
                detailsInfo.appendChild(loading);
                const details = await detailLoader(item.detailUrl);
                renderInfoItems(detailsInfo, details.info);
                renderActionGroups(actionsContainer, details.actions);
                isLoaded = true;
            } catch (error) {
                detailsInfo.innerHTML = '';
                detailsInfo.appendChild(createElement('div', 'gux-error', { text: `Не удалось загрузить карточку: ${error.message}` }));
            } finally {
                expand.disabled = false;
            }
        });

        return wrapper;
    }

    function init() {
        if (document.getElementById(`${SCRIPT_ID}-fab`)) {
            return;
        }
        buildStyles();
        const savedState = stateStorage.load() || {};
        const fab = createElement('button', 'gux-fab', { text: '🔍', attrs: { id: `${SCRIPT_ID}-fab`, title: 'Открыть поиск пользователей' } });
        const panel = createElement('div', 'gux-panel', { attrs: { id: `${SCRIPT_ID}-panel` } });
        const container = createElement('div', 'gux-panel__container');
        const header = createElement('div', 'gux-panel__header');
        header.appendChild(createElement('div', 'gux-panel__title', { text: 'Поиск пользователей' }));
        const closeBtn = createElement('button', 'gux-panel__close', { text: '×', attrs: { title: 'Закрыть' } });
        header.appendChild(closeBtn);
        const body = createElement('div', 'gux-panel__body');
        const form = createElement('form', 'gux-form');
        const controls = {};
        FIELDS.forEach((field) => {
            const { wrapper, control } = buildField(field, savedState.values || {});
            controls[field.name] = control;
            form.appendChild(wrapper);
        });
        const actionsBar = createElement('div', 'gux-actions');
        const searchBtn = createElement('button', 'gux-button gux-button--primary', { text: 'Найти' });
        searchBtn.type = 'submit';
        const resetBtn = createElement('button', 'gux-button gux-button--secondary', { text: 'Сбросить' });
        resetBtn.type = 'button';
        actionsBar.appendChild(searchBtn);
        actionsBar.appendChild(resetBtn);
        const messages = createElement('div');
        const resultsContainer = createElement('div');
        resultsContainer.className = 'gux-results';
        const loadMoreWrapper = createElement('div', 'gux-load-more');
        const loadMoreBtn = createElement('button', 'gux-button gux-button--secondary', { text: LOAD_MORE_LABEL });
        loadMoreBtn.type = 'button';
        loadMoreWrapper.appendChild(loadMoreBtn);
        loadMoreWrapper.style.display = 'none';

        body.appendChild(form);
        body.appendChild(actionsBar);
        body.appendChild(messages);
        body.appendChild(resultsContainer);
        body.appendChild(loadMoreWrapper);

        container.appendChild(header);
        container.appendChild(body);
        panel.appendChild(container);
        document.body.appendChild(fab);
        document.body.appendChild(panel);

        let lastQueryValues = savedState.values || {};
        let nextPageUrl = null;
        let isLoading = false;

        function openPanel() {
            panel.classList.add('gux-panel--visible');
        }

        function closePanel() {
            panel.classList.remove('gux-panel--visible');
        }

        function renderEmptyState() {
            resultsContainer.innerHTML = '';
            resultsContainer.appendChild(createElement('div', 'gux-results-empty', {
                text: 'Начните поиск, чтобы увидеть пользователей.',
            }));
        }

        function showError(message) {
            messages.innerHTML = '';
            messages.appendChild(createElement('div', 'gux-error', { text: message }));
        }

        function clearError() {
            messages.innerHTML = '';
        }

        async function performSearch(urlOverride = null, append = false) {
            if (isLoading) return;
            clearError();
            if (!append) {
                resultsContainer.innerHTML = '';
                renderEmptyState();
            }
            const values = append ? lastQueryValues : collectFormValues(form);
            if (!append) {
                lastQueryValues = values;
                stateStorage.save({ values });
            }
            const url = buildSearchUrl(values, urlOverride);
            isLoading = true;
            toggleLoading(resultsContainer, true);
            loadMoreWrapper.style.display = 'none';
            try {
                const html = await fetchText(url);
                const { items, nextPageUrl: nextUrl } = parseSearchResults(html);
                if (!append) {
                    resultsContainer.innerHTML = '';
                }
                if (!items.length) {
                    renderEmptyState();
                } else {
                    items.forEach((item) => {
                        const node = createResultNode(item, async (detailUrl) => {
                            const detailHtml = await fetchText(detailUrl);
                            return parseUserDetails(detailHtml);
                        });
                        resultsContainer.appendChild(node);
                    });
                }
                nextPageUrl = nextUrl;
                if (nextPageUrl) {
                    loadMoreWrapper.style.display = 'flex';
                }
            } catch (error) {
                if (!append) {
                    resultsContainer.innerHTML = '';
                }
                showError(`Ошибка загрузки: ${error.message}`);
            } finally {
                toggleLoading(resultsContainer, false);
                isLoading = false;
            }
        }

        fab.addEventListener('click', () => {
            if (panel.classList.contains('gux-panel--visible')) {
                closePanel();
            } else {
                openPanel();
            }
        });

        closeBtn.addEventListener('click', closePanel);
        panel.addEventListener('click', (event) => {
            if (event.target === panel) {
                closePanel();
            }
        });

        form.addEventListener('submit', (event) => {
            event.preventDefault();
            performSearch();
        });

        resetBtn.addEventListener('click', () => {
            Object.values(controls).forEach((control) => {
                if (control.type === 'select-one') {
                    control.selectedIndex = 0;
                } else {
                    control.value = '';
                }
            });
            resultsContainer.innerHTML = '';
            renderEmptyState();
            loadMoreWrapper.style.display = 'none';
            nextPageUrl = null;
            stateStorage.clear();
        });

        loadMoreBtn.addEventListener('click', () => {
            if (!nextPageUrl) return;
            performSearch(nextPageUrl, true);
        });

        if (savedState.values) {
            renderEmptyState();
            performSearch(buildSearchUrl(savedState.values));
        } else {
            renderEmptyState();
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
