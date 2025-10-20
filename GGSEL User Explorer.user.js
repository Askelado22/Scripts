// ==UserScript==
// @name         GGSEL User Explorer
// @description  Быстрый поиск и просмотр данных пользователей в админке GGSEL
// @version      1.2.0
// @match        https://back-office.ggsel.net/admin/users*
// @grant        GM_addStyle
// ==/UserScript==

(function() {
    'use strict';

    const STORAGE_KEY = 'ggsel-user-explorer:last-query';
    const PANEL_STATE_KEY = 'ggsel-user-explorer:panel-open';
    const SETTINGS_KEY = 'ggsel-user-explorer:settings';
    const DEBOUNCE_MS = 600;
    const BASE_URL = window.location.origin;
    const USERS_URL = `${BASE_URL}/admin/users`;
    const LOAD_MORE_LABEL = 'Загрузить ещё';
    const DETAIL_PREFETCH_CONCURRENCY = 3;
    const HINTS_HTML = 'Доступные фильтры: <code>id</code>, <code>username</code>, <code>email</code>, <code>ggsel</code>, <code>status</code>, <code>amount</code>, <code>created_from</code>, <code>created_to</code>, <code>last_login_from</code>, <code>last_login_to</code>, <code>ip</code>, <code>wallet</code>, <code>phone</code>. Используйте <code>ключ:значение</code> или свободный текст.';
    const DEFAULT_SETTINGS = Object.freeze({
        extraActions: true
    });
    const EXCLUDED_ACTION_LABELS = new Set(['Назад к списку']);
    const OPTIONAL_ACTION_LABELS = new Set([
        'Отключить все товары от GGSel',
        'Включить все товары для GGSel',
        'Импортировать все товары из GGSel',
        'Редактирование',
        'Заблокировать'
    ]);
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
        searchPlan: null,
        settings: { ...DEFAULT_SETTINGS },
        windows: {
            help: null,
            settings: null
        },
        contextMenu: {
            element: null,
            visible: false,
            userId: null,
            card: null,
            lastPosition: null,
            mode: null
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

    const loadSettings = () => {
        try {
            const raw = localStorage.getItem(SETTINGS_KEY);
            if (!raw) {
                state.settings = { ...DEFAULT_SETTINGS };
                return;
            }
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') {
                state.settings = { ...DEFAULT_SETTINGS, ...parsed };
            } else {
                state.settings = { ...DEFAULT_SETTINGS };
            }
        } catch (error) {
            console.warn('Не удалось загрузить настройки GGSEL User Explorer', error);
            state.settings = { ...DEFAULT_SETTINGS };
        }
    };

    const saveSettings = () => {
        try {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
        } catch (error) {
            console.warn('Не удалось сохранить настройки GGSEL User Explorer', error);
        }
    };

    const ensureWindow = (type, title) => {
        let win = state.windows[type];
        if (win && win.element) {
            win.title.textContent = title;
            return win;
        }
        const element = document.createElement('div');
        element.className = 'ggsel-user-window';
        element.setAttribute('data-window', type);
        element.hidden = true;
        element.tabIndex = -1;

        const header = document.createElement('div');
        header.className = 'ggsel-user-window__header';

        const titleEl = document.createElement('div');
        titleEl.className = 'ggsel-user-window__title';
        titleEl.textContent = title;

        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'ggsel-user-window__close';
        closeBtn.innerHTML = '&#x2715;';
        closeBtn.addEventListener('click', () => closeWindow(type));

        header.appendChild(titleEl);
        header.appendChild(closeBtn);

        const content = document.createElement('div');
        content.className = 'ggsel-user-window__content';

        element.appendChild(header);
        element.appendChild(content);

        document.body.appendChild(element);

        win = {
            element,
            title: titleEl,
            content,
            close: () => closeWindow(type)
        };
        state.windows[type] = win;
        return win;
    };

    const closeWindow = (type) => {
        const win = state.windows[type];
        if (!win || !win.element || win.element.hidden) {
            return;
        }
        win.element.hidden = true;
    };

    const closeAllWindows = () => {
        Object.keys(state.windows).forEach((key) => closeWindow(key));
    };

    const getOpenWindow = () => {
        for (const key of Object.keys(state.windows)) {
            const win = state.windows[key];
            if (win && win.element && !win.element.hidden) {
                return { key, window: win };
            }
        }
        return null;
    };

    const openHelpWindow = () => {
        const win = ensureWindow('help', 'Справка');
        win.content.innerHTML = `<div class="ggsel-user-explorer-hints">${HINTS_HTML}</div>`;
        win.element.hidden = false;
        requestAnimationFrame(() => {
            try {
                win.element.focus({ preventScroll: true });
            } catch (error) {
                win.element.focus();
            }
        });
    };

    const openSettingsWindow = () => {
        const win = ensureWindow('settings', 'Настройки');
        if (!win.initialized) {
            const options = document.createElement('div');
            options.className = 'ggsel-user-window__options';

            const label = document.createElement('label');
            label.className = 'ggsel-user-window__option';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.name = 'extraActions';

            const textWrap = document.createElement('div');
            textWrap.className = 'ggsel-user-window__option-label';

            const title = document.createElement('span');
            title.className = 'ggsel-user-window__option-title';
            title.textContent = 'Доп. действия в контекстное меню';

            const desc = document.createElement('span');
            desc.className = 'ggsel-user-window__option-desc';
            desc.textContent = 'Показывать дополнительные действия из карточки пользователя.';

            textWrap.appendChild(title);
            textWrap.appendChild(desc);

            label.appendChild(checkbox);
            label.appendChild(textWrap);
            options.appendChild(label);
            win.content.appendChild(options);

            checkbox.addEventListener('change', () => {
                state.settings.extraActions = checkbox.checked;
                saveSettings();
                closeContextMenu();
            });

            win.initialized = true;
            win.controls = { checkbox };
        }

        if (win.controls?.checkbox) {
            win.controls.checkbox.checked = Boolean(state.settings.extraActions);
        }

        win.element.hidden = false;
        requestAnimationFrame(() => {
            try {
                win.element.focus({ preventScroll: true });
            } catch (error) {
                win.element.focus();
            }
        });
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
                background: radial-gradient(circle at 30% 30%, #2a2a2a 0%, #161616 70%);
                border: 1px solid #343434;
                color: #8ab4ff;
                box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 24px;
                z-index: 9999;
                transition: transform 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease;
            }
            .ggsel-user-explorer-button:hover {
                transform: translateY(-2px);
                border-color: #8ab4ff;
                box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
            }
            .ggsel-user-explorer-button:active {
                transform: scale(0.95);
            }
            .ggsel-user-explorer-panel {
                position: fixed;
                bottom: 96px;
                right: 24px;
                width: min(640px, calc(100vw - 48px));
                max-height: min(80vh, 720px);
                background: rgba(16, 16, 16, 0.92);
                border: 1px solid #2f2f2f;
                border-radius: 14px;
                color: #eaeaea;
                box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
                display: flex;
                flex-direction: column;
                overflow: hidden;
                z-index: 9999;
                backdrop-filter: blur(6px);
            }
            .ggsel-user-explorer-panel[hidden] {
                display: none !important;
            }
            .ggsel-user-explorer-body {
                padding: 20px 18px 18px 18px;
                display: flex;
                flex-direction: column;
                gap: 12px;
                overflow-y: auto;
            }
            .ggsel-user-explorer-input {
                width: 100%;
                padding: 10px 14px;
                border-radius: 12px;
                border: 1px solid #333;
                background: #0f0f0f;
                color: #eaeaea;
                font-size: 13px;
                outline: none;
                transition: border-color 0.2s ease;
            }
            .ggsel-user-explorer-input:focus {
                border-color: #8ab4ff;
            }
            .ggsel-user-explorer-hints {
                font-size: 11px;
                color: #bbbbbb;
                line-height: 1.4;
            }
            .ggsel-user-explorer-results {
                display: flex;
                flex-direction: column;
                gap: 10px;
                max-height: 60vh;
                overflow-y: auto;
                padding-right: 4px;
            }
            .ggsel-user-window {
                position: fixed;
                top: 80px;
                right: 24px;
                width: min(360px, calc(100vw - 48px));
                background: rgba(16, 16, 16, 0.94);
                border: 1px solid #2f2f2f;
                border-radius: 14px;
                color: #eaeaea;
                box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
                backdrop-filter: blur(6px);
                z-index: 10001;
                display: flex;
                flex-direction: column;
                pointer-events: auto;
            }
            .ggsel-user-window[hidden] {
                display: none;
            }
            .ggsel-user-window__header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 10px 14px 6px;
                gap: 12px;
            }
            .ggsel-user-window__title {
                font-size: 13px;
                font-weight: 700;
                letter-spacing: 0.2px;
                color: #8ab4ff;
            }
            .ggsel-user-window__close {
                background: #1e1e1e;
                border: 1px solid #444;
                color: #eaeaea;
                border-radius: 999px;
                width: 28px;
                height: 28px;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                font-size: 16px;
                line-height: 1;
                padding: 0;
            }
            .ggsel-user-window__close:hover {
                border-color: #8ab4ff;
            }
            .ggsel-user-window__content {
                padding: 0 14px 14px;
                font-size: 12px;
                color: #d5d5d5;
            }
            .ggsel-user-window__options {
                display: flex;
                flex-direction: column;
                gap: 10px;
                margin-top: 6px;
            }
            .ggsel-user-window__option {
                display: flex;
                align-items: center;
                gap: 10px;
                background: #121212;
                border: 1px solid #2f2f2f;
                border-radius: 10px;
                padding: 8px 10px;
            }
            .ggsel-user-window__option input[type="checkbox"] {
                width: 18px;
                height: 18px;
                accent-color: #8ab4ff;
            }
            .ggsel-user-window__option-label {
                display: flex;
                flex-direction: column;
                gap: 2px;
            }
            .ggsel-user-window__option-title {
                font-size: 12px;
                font-weight: 600;
                color: #eaeaea;
            }
            .ggsel-user-window__option-desc {
                font-size: 11px;
                color: #a8a8a8;
            }
            .ggsel-user-explorer-results::-webkit-scrollbar {
                width: 6px;
            }
            .ggsel-user-explorer-results::-webkit-scrollbar-thumb {
                background: #333;
                border-radius: 999px;
            }
            .ggsel-user-explorer-placeholder {
                padding: 32px 0;
                text-align: center;
                font-size: 13px;
                color: #a5a5a5;
            }
            .ggsel-user-card {
                background: #121212;
                border-radius: 12px;
                border: 1px solid #2f2f2f;
                overflow: visible;
                transition: border-color 0.2s ease, box-shadow 0.2s ease;
            }
            .ggsel-user-card:hover {
                border-color: #8ab4ff;
                box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
            }
            .ggsel-user-card-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 12px 14px;
                cursor: pointer;
                gap: 12px;
            }
            .ggsel-user-card-meta {
                display: flex;
                flex-direction: column;
                gap: 4px;
            }
            .ggsel-user-card-title-row {
                display: flex;
                align-items: center;
                flex-wrap: wrap;
                gap: 8px;
            }
            .ggsel-user-card-name {
                font-size: 13px;
                font-weight: 600;
                color: #8ab4ff;
            }
            .ggsel-user-card-badge {
                padding: 2px 8px;
                border-radius: 999px;
                font-size: 10.5px;
                letter-spacing: 0.2px;
                border: 1px solid rgba(138, 180, 255, 0.4);
                background: rgba(138, 180, 255, 0.12);
                color: #8ab4ff;
                text-transform: uppercase;
                font-weight: 600;
            }
            .ggsel-user-card-badge--id {
                border-color: rgba(138, 180, 255, 0.45);
                background: rgba(138, 180, 255, 0.18);
            }
            .ggsel-user-card-badge--ggsel {
                border-color: rgba(255, 210, 102, 0.45);
                background: rgba(255, 210, 102, 0.18);
                color: #f3d37a;
            }
            .ggsel-user-card-badge--both {
                border-color: rgba(138, 180, 255, 0.45);
                background: linear-gradient(135deg, rgba(138, 180, 255, 0.18), rgba(255, 210, 102, 0.22));
                color: #f0f6ff;
            }
            .ggsel-user-card-line {
                font-size: 11px;
                color: #a8a8a8;
                display: flex;
                flex-wrap: wrap;
                gap: 8px;
            }
            .ggsel-user-card-line span {
                display: inline-flex;
                align-items: center;
                gap: 4px;
            }
            .ggsel-user-card-toggle {
                border: 1px solid #444;
                background: #1e1e1e;
                color: #8ab4ff;
                border-radius: 999px;
                width: 32px;
                height: 32px;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 16px;
                cursor: pointer;
                flex-shrink: 0;
                transition: border-color 0.2s ease;
            }
            .ggsel-user-card-toggle:hover {
                border-color: #8ab4ff;
            }
            .ggsel-user-card-body {
                display: none;
                padding: 12px 14px 14px 14px;
                border-top: 1px solid #2f2f2f;
            }
            .ggsel-user-card.open .ggsel-user-card-body {
                display: flex;
                flex-direction: column;
                gap: 12px;
            }
            .ggsel-user-card.match-id {
                border-color: rgba(138, 180, 255, 0.85);
                box-shadow: 0 0 0 1px rgba(138, 180, 255, 0.35), 0 10px 28px rgba(0, 0, 0, 0.35);
            }
            .ggsel-user-card.match-id:hover {
                border-color: rgba(138, 180, 255, 0.95);
            }
            .ggsel-user-card.match-ggsel {
                border-color: rgba(255, 210, 102, 0.85);
                box-shadow: 0 0 0 1px rgba(255, 210, 102, 0.28), 0 10px 28px rgba(0, 0, 0, 0.35);
            }
            .ggsel-user-card.match-ggsel:hover {
                border-color: rgba(255, 220, 140, 0.95);
            }
            .ggsel-user-card.match-id.match-ggsel,
            .ggsel-user-card.match-both {
                border-color: rgba(168, 205, 255, 0.9);
                box-shadow: 0 0 0 1px rgba(138, 180, 255, 0.32), 0 0 0 3px rgba(255, 210, 102, 0.15), 0 12px 32px rgba(0, 0, 0, 0.38);
            }
            .ggsel-user-card.match-both:hover,
            .ggsel-user-card.match-id.match-ggsel:hover {
                border-color: rgba(188, 220, 255, 0.98);
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
                padding: 7px 12px;
                border-radius: 12px;
                border: 1px solid #444;
                background: #1e1e1e;
                color: #eaeaea;
                text-decoration: none;
                font-size: 11px;
                transition: border-color 0.2s ease, color 0.2s ease;
            }
            .ggsel-user-action:hover {
                border-color: #8ab4ff;
                color: #8ab4ff;
            }
            .ggsel-user-detail-list {
                display: grid;
                grid-template-columns: minmax(180px, 220px) 1fr;
                gap: 4px 12px;
                font-size: 11.5px;
                color: #d9d9d9;
            }
            .ggsel-user-detail-list dt {
                font-weight: 600;
                color: #a8a8a8;
            }
            .ggsel-user-detail-list dd {
                margin: 0;
                color: #eaeaea;
                word-break: break-word;
            }
            .ggsel-user-detail-empty {
                color: #7f7f7f;
                font-style: italic;
            }
            .ggsel-user-card-loader,
            .ggsel-user-loader {
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 10px;
                color: #bcbcbc;
                font-size: 12px;
                padding: 20px 0;
            }
            .ggsel-user-loader-dot {
                width: 8px;
                height: 8px;
                border-radius: 50%;
                background: #8ab4ff;
                opacity: 0.7;
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
                padding: 9px 18px;
                border-radius: 12px;
                border: 1px solid #444;
                background: #1e1e1e;
                color: #eaeaea;
                cursor: pointer;
                font-size: 12px;
                transition: border-color 0.2s ease, color 0.2s ease;
            }
            .ggsel-user-load-more:hover {
                border-color: #8ab4ff;
                color: #8ab4ff;
            }
            .ggsel-user-load-more[disabled] {
                opacity: 0.6;
                cursor: default;
            }
            .ggsel-user-error {
                border-radius: 12px;
                border: 1px solid rgba(220, 53, 69, 0.6);
                background: rgba(220, 53, 69, 0.15);
                padding: 12px;
                font-size: 12px;
                color: #ffb3b8;
            }
            .ggsel-user-context-menu {
                position: fixed;
                z-index: 10000;
                background: rgba(16, 16, 16, 0.95);
                color: #eaeaea;
                border-radius: 12px;
                border: 1px solid #2f2f2f;
                min-width: 190px;
                max-width: calc(100vw - 32px);
                box-shadow: 0 18px 40px rgba(0, 0, 0, 0.45);
                padding: 6px 0;
                display: none;
                font-size: 12.5px;
                backdrop-filter: blur(12px);
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
                transition: background 0.2s ease, color 0.2s ease;
            }
            .ggsel-user-context-menu__item:hover,
            .ggsel-user-context-menu__item:focus-visible {
                background: rgba(138, 180, 255, 0.15);
                color: #8ab4ff;
                outline: none;
            }
            .ggsel-user-context-menu__item[disabled] {
                opacity: 0.5;
                cursor: default;
            }
            .ggsel-user-context-menu__separator {
                height: 1px;
                margin: 4px 0;
                background: #2f2f2f;
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
        let params = { ...DEFAULT_PARAMS };
        const summary = [];
        const input = (rawInput || '').trim();
        if (!input) {
            return {
                params,
                summary: 'Фильтры не применены',
                plan: {
                    type: 'single',
                    queries: [{ key: 'default', params, highlight: null }]
                }
            };
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
        const looksLikeEmail = (value) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/i.test(value);
        const looksLikeIp = (value) => /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value);
        const looksLikeDigits = (value) => /^\d+$/.test(value);

        const freeParts = remainder
            .split(/\s+/)
            .map(part => part.replace(/^['"]|['"]$/g, ''))
            .filter(part => part.length);

        let emailCandidate = '';
        let ipCandidate = '';
        let digitsCandidate = '';
        const residualParts = [];
        for (const part of freeParts) {
            const cleaned = part.replace(/[.,;]+$/g, '');
            if (!params['search[email_like]'] && looksLikeEmail(cleaned)) {
                if (!emailCandidate) {
                    emailCandidate = cleaned;
                }
            } else if (!params['search[ip_ilike]'] && looksLikeIp(cleaned)) {
                if (!ipCandidate) {
                    ipCandidate = cleaned;
                }
            } else if (!digitsCandidate && looksLikeDigits(cleaned)) {
                digitsCandidate = cleaned;
            } else {
                residualParts.push(part);
            }
        }

        if (emailCandidate) {
            params['search[email_like]'] = emailCandidate;
            summary.push(`email: ${emailCandidate}`);
        }

        if (!emailCandidate && ipCandidate) {
            params['search[ip_ilike]'] = ipCandidate;
            summary.push(`ip: ${ipCandidate}`);
        }

        let numericPlan = null;
        if (!tokens.length && !emailCandidate && !ipCandidate && digitsCandidate) {
            const idParams = { ...DEFAULT_PARAMS, 'search[id]': digitsCandidate };
            const ggselParams = { ...DEFAULT_PARAMS, 'search[ggsel_id_seller]': digitsCandidate };
            params = idParams;
            summary.push(`id: ${digitsCandidate}`);
            summary.push(`ggsel: ${digitsCandidate}`);
            numericPlan = {
                type: 'multi',
                queries: [
                    { key: 'id', params: idParams, highlight: 'id', label: `ID: ${digitsCandidate}` },
                    { key: 'ggsel', params: ggselParams, highlight: 'ggsel', label: `GGSEL ID: ${digitsCandidate}` }
                ]
            };
        }

        if (!numericPlan && !emailCandidate && !ipCandidate && residualParts.length && !params['search[username_like]']) {
            const freeText = residualParts.join(' ');
            params['search[username_like]'] = freeText;
            summary.push(`username: ${freeText}`);
        }

        if (numericPlan) {
            return {
                params,
                summary: summary.length ? summary.join(' · ') : `Поиск: ${input}`,
                plan: numericPlan
            };
        }

        return {
            params,
            summary: summary.length ? summary.join(' · ') : `Поиск: ${input}`,
            plan: {
                type: 'single',
                queries: [{ key: 'default', params, highlight: null }]
            }
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
                if (EXCLUDED_ACTION_LABELS.has(text)) continue;
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

        const titleRow = document.createElement('div');
        titleRow.className = 'ggsel-user-card-title-row';
        titleRow.appendChild(name);

        if (user.matchType) {
            const badge = document.createElement('span');
            badge.className = 'ggsel-user-card-badge';
            if (user.matchType === 'id') {
                badge.classList.add('ggsel-user-card-badge--id');
                badge.textContent = 'Совпадение ID';
            } else if (user.matchType === 'ggsel') {
                badge.classList.add('ggsel-user-card-badge--ggsel');
                badge.textContent = 'Совпадение GGSEL ID';
            } else {
                badge.classList.add('ggsel-user-card-badge--both');
                badge.textContent = 'ID и GGSEL ID';
            }
            titleRow.appendChild(badge);
        }

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

        meta.appendChild(titleRow);
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

        if (user.matchType === 'id') {
            card.classList.add('match-id');
        } else if (user.matchType === 'ggsel') {
            card.classList.add('match-ggsel');
        } else if (user.matchType === 'both') {
            card.classList.add('match-both', 'match-id', 'match-ggsel');
        }

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
                mode: 'user',
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
        state.contextMenu.mode = null;
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

    function buildContextMenuItems({ mode = 'user', user, payload, card }) {
        const items = [];
        if (mode === 'panel') {
            items.push({
                type: 'action',
                label: 'Очистить поиск',
                handler: () => {
                    state.input.value = '';
                    onQueryChange('');
                    onQueryChange.flush?.();
                }
            });
            if (state.query) {
                items.push({
                    type: 'action',
                    label: 'Перезагрузить результаты',
                    handler: () => {
                        onQueryChange.flush?.();
                        performSearch({ append: false });
                    }
                });
            }

            items.push({ type: 'separator' });

            items.push({
                type: 'action',
                label: 'Справка',
                handler: () => {
                    openHelpWindow();
                }
            });

            items.push({
                type: 'action',
                label: 'Настройки',
                handler: () => {
                    openSettingsWindow();
                }
            });

            items.push({ type: 'separator' });
            items.push({
                type: 'action',
                label: 'Скрыть панель',
                handler: () => closePanel()
            });
        } else if (mode === 'user' && user) {
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
                const availableActions = details.actions.filter((action) => {
                    const label = collapseSpaces(action.text);
                    if (!label) return false;
                    if (EXCLUDED_ACTION_LABELS.has(label)) return false;
                    if (!state.settings.extraActions && OPTIONAL_ACTION_LABELS.has(label)) return false;
                    return true;
                });
                if (availableActions.length) {
                    items.push({ type: 'separator' });
                    availableActions.forEach((action) => {
                        items.push({
                            type: 'remote',
                            label: action.text,
                            action
                        });
                    });
                }
            }
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

    function renderContextMenu({ mode = 'user', user, payload, position, card, keepOpen = false }) {
        const menu = ensureContextMenuElement();
        menu.innerHTML = '';

        const items = buildContextMenuItems({ mode, user, payload, card });
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
        state.contextMenu.mode = mode;
        state.contextMenu.userId = mode === 'user' && user ? user.id : null;
        state.contextMenu.card = mode === 'user' ? (card || null) : null;
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
        if (!state.contextMenu.visible || state.contextMenu.mode !== 'user' || state.contextMenu.userId !== user.id) {
            return;
        }
        const position = state.contextMenu.lastPosition || { x: window.innerWidth / 2, y: window.innerHeight / 2 };
        renderContextMenu({
            mode: 'user',
            user,
            payload: { details, loading: false },
            position,
            card: state.contextMenu.card,
            keepOpen: true
        });
    }

    function openContextMenu(event, user, card) {
        event.preventDefault();
        event.stopPropagation();
        const cached = state.detailCache.get(user.id);
        const payload = {
            details: cached && cached.status === 'ready' ? cached.data : null,
            loading: !cached || cached.status === 'pending'
        };
        renderContextMenu({
            mode: 'user',
            user,
            payload,
            position: { x: event.clientX, y: event.clientY },
            card
        });
        if (!cached || cached.status !== 'ready') {
            ensureUserDetails(user).catch(() => {});
        }
    }

    function openPanelContextMenu(event) {
        const card = event.target instanceof Element ? event.target.closest('.ggsel-user-card') : null;
        if (card && card.__userData) {
            openContextMenu(event, card.__userData, card);
            return;
        }
        const editable = event.target instanceof Element ? event.target.closest('input, textarea, [contenteditable="true"]') : null;
        if (editable) {
            return;
        }
        if (!state.panel || !state.panel.contains(event.target)) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        renderContextMenu({
            mode: 'panel',
            position: { x: event.clientX, y: event.clientY },
            card: null,
            payload: null
        });
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
            state.loadMoreButton.disabled = true;
            state.hasMore = false;
            return;
        }

        const plan = state.searchPlan || {
            type: 'single',
            queries: [{ key: 'default', params: state.params, highlight: null }]
        };

        if (plan.type !== 'single' && append) {
            return;
        }

        const token = ++state.lastToken;
        state.loading = true;
        const loader = createLoader('Выполняем поиск...');
        if (!append || plan.type !== 'single') {
            state.resultsContainer.innerHTML = '';
            state.resultsContainer.appendChild(loader);
        } else {
            state.loadMoreButton.disabled = true;
            state.loadMoreButton.textContent = 'Загружаем...';
        }

        const resetLoadMore = () => {
            state.loadMoreButton.hidden = !state.hasMore;
            state.loadMoreButton.disabled = !state.hasMore;
            state.loadMoreButton.textContent = LOAD_MORE_LABEL;
        };

        try {
            if (plan.type === 'single') {
                const queryDef = plan.queries[0];
                const page = append ? state.page + 1 : 1;
                const url = buildUrlWithParams(queryDef.params, page);
                const doc = await fetchDocument(url);
                if (token !== state.lastToken) {
                    return;
                }
                const items = parseListFromDocument(doc).map((item) => ({
                    ...item,
                    matchType: queryDef.highlight || null
                }));
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
                resetLoadMore();
                if (!items.length && append) {
                    state.loadMoreButton.hidden = true;
                    state.loadMoreButton.disabled = true;
                }
                return;
            }

            // multi-query flow (например, поиск по ID и GGSEL ID)
            state.page = 1;
            state.hasMore = false;
            const aggregated = [];
            const seen = new Map();
            const errors = [];

            for (const queryDef of plan.queries) {
                try {
                    const url = buildUrlWithParams(queryDef.params, 1);
                    const doc = await fetchDocument(url);
                    if (token !== state.lastToken) {
                        return;
                    }
                    const items = parseListFromDocument(doc);
                    items.forEach((item) => {
                        const matchType = queryDef.highlight || null;
                        const existing = seen.get(item.id);
                        if (!existing) {
                            item.matchType = matchType;
                            aggregated.push(item);
                            seen.set(item.id, item);
                        } else if (matchType) {
                            if (existing.matchType && existing.matchType !== matchType) {
                                existing.matchType = 'both';
                            } else if (!existing.matchType) {
                                existing.matchType = matchType;
                            }
                        }
                    });
                } catch (error) {
                    errors.push({ query: queryDef, error });
                }
            }

            if (token !== state.lastToken) {
                return;
            }

            state.results = aggregated;
            state.resultsContainer.innerHTML = '';

            if (aggregated.length) {
                updateResults(aggregated, false);
            } else if (!errors.length) {
                const placeholder = document.createElement('div');
                placeholder.className = 'ggsel-user-explorer-placeholder';
                placeholder.textContent = 'По вашему запросу ничего не найдено';
                state.resultsContainer.appendChild(placeholder);
            }

            if (errors.length) {
                const errorEl = document.createElement('div');
                errorEl.className = 'ggsel-user-error';
                errorEl.textContent = errors
                    .map(({ query, error }) => `Ошибка по запросу «${query.label || query.key}»: ${error.message}`)
                    .join(' ');
                state.resultsContainer.appendChild(errorEl);
            }

            state.loadMoreButton.hidden = true;
            state.loadMoreButton.disabled = true;

            if (aggregated.length) {
                await prefetchUserDetails(aggregated);
            }
        } catch (error) {
            state.resultsContainer.innerHTML = '';
            const errorEl = document.createElement('div');
            errorEl.className = 'ggsel-user-error';
            errorEl.textContent = `Ошибка при поиске пользователей: ${error.message}`;
            state.resultsContainer.appendChild(errorEl);
            state.loadMoreButton.hidden = true;
            state.loadMoreButton.disabled = true;
        } finally {
            if (plan.type === 'single' && !state.hasMore) {
                state.loadMoreButton.hidden = true;
                state.loadMoreButton.disabled = true;
            }
            state.loading = false;
        }
    };

    const onQueryChange = debounce((value) => {
        state.query = value.trim();
        const { params, plan } = parseSearchInput(state.query);
        state.params = params;
        state.searchPlan = plan;
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
                const { params, plan } = parseSearchInput(savedQuery);
                state.params = params;
                state.searchPlan = plan;
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
        if (!state.panel || !state.button) return;
        state.panel.hidden = false;
        state.button.setAttribute('aria-pressed', 'true');
        state.open = true;
        localStorage.setItem(PANEL_STATE_KEY, '1');
        setTimeout(() => state.input.focus(), 50);
    };

    const closePanel = () => {
        if (!state.panel || !state.button) return;
        state.panel.hidden = true;
        state.button.setAttribute('aria-pressed', 'false');
        state.open = false;
        localStorage.setItem(PANEL_STATE_KEY, '0');
        closeContextMenu();
        closeAllWindows();
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
        loadSettings();

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'ggsel-user-explorer-button';
        button.title = 'Открыть поиск пользователей';
        button.innerHTML = '🔍';
        button.addEventListener('click', togglePanel);

        const panel = document.createElement('div');
        panel.className = 'ggsel-user-explorer-panel';
        panel.hidden = true;

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
        body.appendChild(resultsContainer);
        body.appendChild(loadMoreButton);

        panel.appendChild(body);

        document.body.appendChild(button);
        document.body.appendChild(panel);

        state.button = button;
        state.panel = panel;
        state.input = input;
        state.resultsContainer = resultsContainer;
        state.loadMoreButton = loadMoreButton;
        state.searchPlan = {
            type: 'single',
            queries: [{ key: 'default', params: { ...state.params }, highlight: null }]
        };

        document.addEventListener('pointerdown', (event) => {
            if (!state.open || !state.panel || !state.button) return;
            if (state.panel.contains(event.target) || state.button.contains(event.target)) return;
            if (state.query) return;
            closePanel();
        });

        panel.addEventListener('focusout', () => {
            if (!state.open) return;
            if (state.query) return;
            setTimeout(() => {
                if (!state.query && state.panel && !state.panel.contains(document.activeElement)) {
                    closePanel();
                }
            }, 0);
        });

        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                const openWin = getOpenWindow();
                if (openWin) {
                    event.preventDefault();
                    closeWindow(openWin.key);
                    return;
                }
                if (state.contextMenu.visible) {
                    closeContextMenu();
                } else if (state.open) {
                    closePanel();
                }
            }
        });

        panel.addEventListener('contextmenu', openPanelContextMenu);

        restoreState();
    };

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        init();
    } else {
        document.addEventListener('DOMContentLoaded', init);
    }
})();

