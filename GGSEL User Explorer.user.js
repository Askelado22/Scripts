// ==UserScript==
// @name         GGSEL User Explorer
// @description  Быстрый поиск и просмотр данных пользователей в админке GGSEL
// @version      1.3.0
// @match        https://back-office.ggsel.net/admin
// @match        https://back-office.ggsel.net/admin/*
// @grant        GM_addStyle
// ==/UserScript==

(function() {
    'use strict';

    const STORAGE_KEY = 'ggsel-user-explorer:last-query';
    const STORAGE_MODE_KEY = 'ggsel-user-explorer:last-mode';
    const PANEL_STATE_KEY = 'ggsel-user-explorer:panel-open';
    const SETTINGS_KEY = 'ggsel-user-explorer:settings';
    const ANCHOR_POSITION_KEY = 'ggsel-user-explorer:anchor-position';
    const DEBOUNCE_MS = 600;
    const FAB_SIZE = 56;
    const VIEWPORT_MARGIN = 16;
    const BASE_URL = window.location.origin;
    const USERS_URL = `${BASE_URL}/admin/users`;
    const ORDERS_URL = `${BASE_URL}/admin/orders`;
    const LOAD_MORE_LABEL = 'Загрузить ещё';
    const DETAIL_PREFETCH_CONCURRENCY = 3;
    const HINTS_HTML = 'Доступные фильтры: <code>id</code>, <code>username</code>, <code>email</code>, <code>ggsel</code>, <code>status</code>, <code>amount</code>, <code>created_from</code>, <code>created_to</code>, <code>last_login_from</code>, <code>last_login_to</code>, <code>ip</code>, <code>wallet</code>, <code>phone</code>. Используйте <code>ключ:значение</code> или свободный текст.';
    const HEADSET_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M8 1a5 5 0 0 0-5 5v1h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a6 6 0 1 1 12 0v6a2.5 2.5 0 0 1-2.5 2.5H9.366a1 1 0 0 1-.866.5h-1a1 1 0 1 1 0-2h1a1 1 0 0 1 .866.5H11.5A1.5 1.5 0 0 0 13 12h-1a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h1V6a5 5 0 0 0-5-5"/></svg>';
    const USERS_MODE_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M7 14s-1 0-1-1 1-4 5-4 5 3 5 4-1 1-1 1zm4-6a3 3 0 1 0 0-6 3 3 0 0 0 0 6m-5.784 6A2.24 2.24 0 0 1 5 13c0-1.355.68-2.75 1.936-3.72A6.3 6.3 0 0 0 5 9c-4 0-5 3-5 4s1 1 1 1zM4.5 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5"/></svg>';
    const ORDERS_MODE_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M14.5 3a.5.5 0 0 1 .5.5v9a.5.5 0 0 1-.5.5h-13a.5.5 0 0 1-.5-.5v-9a.5.5 0 0 1 .5-.5zm-13-1A1.5 1.5 0 0 0 0 3.5v9A1.5 1.5 0 0 0 1.5 14h13a1.5 1.5 0 0 0 1.5-1.5v-9A1.5 1.5 0 0 0 14.5 2z"/><path d="M7 5.5a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 0 1h-5a.5.5 0 0 1-.5-.5m-1.496-.854a.5.5 0 0 1 0 .708l-1.5 1.5a.5.5 0 0 1-.708 0l-.5-.5a.5.5 0 1 1 .708-.708l.146.147 1.146-1.147a.5.5 0 0 1 .708 0M7 9.5a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 0 1h-5a.5.5 0 0 1-.5-.5m-1.496-.854a.5.5 0 0 1 0 .708l-1.5 1.5a.5.5 0 0 1-.708 0l-.5-.5a.5.5 0 1 1 .708-.708l.146.147 1.146-1.147a.5.5 0 0 1 .708 0"/></svg>';
    const HISTORY_KEY = 'ggsel-user-explorer:history';
    const HISTORY_LIMIT = 5;

    const DEFAULT_SHORTCUT = Object.freeze({
        ctrl: true,
        alt: false,
        shift: false,
        meta: false,
        code: 'KeyF'
    });

    const DEFAULT_USER_FIELDS = Object.freeze({
        email: true,
        balance: true,
        ggselId: true,
        withdrawals: true
    });

    const DEFAULT_ORDER_FIELDS = Object.freeze({
        status: true,
        amount: true,
        count: true,
        buyer: true,
        created: true,
        payment: true,
        product: true
    });

    const USER_FIELD_OPTION_DEFS = [
        { key: 'email', label: 'Почта', description: 'Показывать email пользователя в карточке.' },
        { key: 'balance', label: 'Баланс', description: 'Отображать баланс пользователя.' },
        { key: 'ggselId', label: 'GGSEL ID', description: 'Показывать идентификатор продавца GGSEL.' },
        { key: 'withdrawals', label: 'Вывод', description: 'Отмечать доступность вывода средств.' }
    ];

    const ORDER_FIELD_OPTION_DEFS = [
        { key: 'status', label: 'Статус', description: 'Отображать статус заказа.' },
        { key: 'amount', label: 'Сумма', description: 'Показывать сумму заказа.' },
        { key: 'count', label: 'Кол-во', description: 'Показывать количество товаров в заказе.' },
        { key: 'buyer', label: 'Покупатель', description: 'Отображать покупателя и ссылку на профиль.' },
        { key: 'created', label: 'Создан', description: 'Показывать дату и время создания заказа.' },
        { key: 'payment', label: 'Платёж', description: 'Отображать выбранную платёжную систему.' },
        { key: 'product', label: 'Товар', description: 'Показывать название и ссылку на товар.' }
    ];
    const EXCLUDED_ACTION_LABELS = new Set(['Назад к списку']);
    const OPTIONAL_ACTION_LABELS = new Set([
        'Отключить все товары от GGSel',
        'Включить все товары для GGSel',
        'Импортировать все товары из GGSel',
        'Редактирование',
        'Заблокировать'
    ]);
    const DETAIL_HIDDEN_LABELS = new Set(['Имя пользователя']);
    const MODE_USERS = 'users';
    const MODE_ORDERS = 'orders';

    const USER_FIELD_ALIASES = {
        id: 'search[id]',
        user: 'search[username_like]',
        username: 'search[username_like]',
        name: 'search[username_like]',
        email: 'search[email_like]',
        mail: 'search[email_like]',
        digi: 'search[ggsel_id_seller]',
        digi_id: 'search[ggsel_id_seller]',
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

    const USER_DEFAULT_PARAMS = {
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

    const ORDER_FIELD_ALIASES = {
        id: 'search[id]',
        order: 'search[id]',
        order_id: 'search[id]',
        user: 'search[username]',
        username: 'search[username]',
        user_id: 'search[user_id]',
        buyer: 'search[username]',
        email: 'search[email]',
        mail: 'search[email]',
        seller: 'search[seller_name]',
        seller_name: 'search[seller_name]',
        seller_id: 'search[seller_id]',
        ggsel: 'search[seller_id]',
        digi: 'search[seller_id]',
        digi_id: 'search[seller_id]',
        uuid: 'search[uuid]',
        status: 'search[status]',
        has_payment: 'search[has_payment]',
        payment: 'search[has_payment]',
        external: 'search[external]',
        payment_system: 'search[order_payment_system_id]',
        order_payment_system_id: 'search[order_payment_system_id]'
    };

    const ORDER_DEFAULT_PARAMS = {
        'search[id]': '',
        'search[user_id]': '',
        'search[username]': '',
        'search[email]': '',
        'search[seller_name]': '',
        'search[seller_id]': '',
        'search[uuid]': '',
        'search[status]': '',
        'search[has_payment]': '',
        'search[external]': '',
        'search[order_payment_system_id]': '',
        commit: 'Фильтровать'
    };

    const MODE_CONFIG = {
        [MODE_USERS]: {
            id: MODE_USERS,
            title: 'пользователей',
            buttonTitle: 'Открыть поиск пользователей',
            fieldAliases: USER_FIELD_ALIASES,
            defaultParams: USER_DEFAULT_PARAMS,
            placeholder: 'Например: username:soda status:seller или 1271',
            hints: HINTS_HTML
        },
        [MODE_ORDERS]: {
            id: MODE_ORDERS,
            title: 'заказы',
            buttonTitle: 'Открыть поиск заказов',
            fieldAliases: ORDER_FIELD_ALIASES,
            defaultParams: ORDER_DEFAULT_PARAMS,
            placeholder: 'Например: id:81527 или seller:market',
            hints: 'Доступные фильтры: <code>id</code>, <code>user_id</code>, <code>username</code>, <code>seller_id</code>, <code>seller</code>, <code>email</code>, <code>uuid</code>, <code>status</code>, <code>has_payment</code>, <code>external</code>, <code>order_payment_system_id</code>. Используйте <code>ключ:значение</code> или свободный текст.'
        }
    };

    const collapseSpaces = (value) => (value || '').replace(/\s+/g, ' ').trim();

    const getModeConfig = (mode = MODE_USERS) => MODE_CONFIG[mode] || MODE_CONFIG[MODE_USERS];

    const getFieldAliases = (mode = MODE_USERS) => ({ ...getModeConfig(mode).fieldAliases });

    const getDefaultParams = (mode = MODE_USERS) => ({ ...getModeConfig(mode).defaultParams });

    const getLegacyQueryStorageKey = (mode = MODE_USERS) => `${STORAGE_KEY}:${mode}`;
    const getQueryStorageKey = () => STORAGE_KEY;

    const cloneShortcut = (shortcut = DEFAULT_SHORTCUT) => ({
        ctrl: Boolean(shortcut?.ctrl),
        alt: Boolean(shortcut?.alt),
        shift: Boolean(shortcut?.shift),
        meta: Boolean(shortcut?.meta),
        code: typeof shortcut?.code === 'string' && shortcut.code ? shortcut.code : DEFAULT_SHORTCUT.code
    });

    const normalizeUserFieldSettings = (value) => {
        const base = { ...DEFAULT_USER_FIELDS };
        if (value && typeof value === 'object') {
            Object.keys(base).forEach((key) => {
                if (Object.prototype.hasOwnProperty.call(value, key)) {
                    base[key] = Boolean(value[key]);
                }
            });
        }
        return base;
    };

    const normalizeOrderFieldSettings = (value) => {
        const base = { ...DEFAULT_ORDER_FIELDS };
        if (value && typeof value === 'object') {
            Object.keys(base).forEach((key) => {
                if (Object.prototype.hasOwnProperty.call(value, key)) {
                    base[key] = Boolean(value[key]);
                }
            });
        }
        return base;
    };

    const isModifierCode = (code = '') => /^(?:Control|Shift|Alt|Meta)/i.test(code);

    const normalizeShortcut = (value) => {
        const base = cloneShortcut(DEFAULT_SHORTCUT);
        if (!value || typeof value !== 'object') {
            return base;
        }
        const normalized = cloneShortcut(value);
        if (!normalized.code || isModifierCode(normalized.code)) {
            normalized.code = DEFAULT_SHORTCUT.code;
        }
        if (!normalized.ctrl && !normalized.alt && !normalized.shift && !normalized.meta) {
            normalized.ctrl = DEFAULT_SHORTCUT.ctrl;
        }
        return normalized;
    };

    const getDefaultSettings = () => ({
        extraActions: false,
        shortcut: cloneShortcut(DEFAULT_SHORTCUT),
        userFields: normalizeUserFieldSettings(),
        orderFields: normalizeOrderFieldSettings()
    });

    const state = {
        open: false,
        mode: MODE_USERS,
        loading: false,
        query: '',
        params: getDefaultParams(MODE_USERS),
        page: 1,
        hasMore: false,
        results: [],
        lastToken: 0,
        detailCache: new Map(),
        searchPlan: null,
        settings: getDefaultSettings(),
        anchorPosition: null,
        anchorPositionManual: false,
        anchorDragActive: false,
        anchorDragMoved: false,
        anchorDragFromButton: false,
        suppressNextButtonClick: false,
        windows: {
            help: null,
            settings: null
        },
        shortcutCapture: null,
        contextMenu: {
            element: null,
            visible: false,
            userId: null,
            orderId: null,
            card: null,
            lastPosition: null,
            mode: null
        },
        anchor: null,
        shell: null,
        button: null,
        panel: null,
        input: null,
        modeButton: null,
        resultsContainer: null,
        loadMoreButton: null,
        searchControl: null,
        searchRow: null,
        resultsWrapper: null,
        historyPopover: null,
        historyList: null,
        historyVisible: false,
        queryHistory: [],
        lastPanelHeight: FAB_SIZE
    };

    const formatShortcut = (shortcut) => {
        const normalized = normalizeShortcut(shortcut);
        const parts = [];
        if (normalized.ctrl) parts.push('Ctrl');
        if (normalized.alt) parts.push('Alt');
        if (normalized.shift) parts.push('Shift');
        if (normalized.meta) parts.push('Meta');
        let keyLabel = normalized.code || '';
        if (keyLabel.startsWith('Key')) {
            keyLabel = keyLabel.slice(3).toUpperCase();
        } else if (keyLabel.startsWith('Digit')) {
            keyLabel = keyLabel.slice(5);
        } else if (keyLabel.startsWith('Numpad')) {
            keyLabel = `Num ${keyLabel.slice(6)}`;
        } else if (/^Arrow(Up|Down|Left|Right)$/.test(keyLabel)) {
            keyLabel = keyLabel.replace('Arrow', '');
        }
        if (!keyLabel) {
            keyLabel = 'KeyF';
        }
        parts.push(keyLabel);
        return parts.join(' + ');
    };

    const shortcutsEqual = (a, b) => {
        const first = normalizeShortcut(a);
        const second = normalizeShortcut(b);
        return first.ctrl === second.ctrl
            && first.alt === second.alt
            && first.shift === second.shift
            && first.meta === second.meta
            && first.code === second.code;
    };

    const isShortcutPressed = (event, shortcut) => {
        if (!event || typeof event !== 'object') return false;
        const normalized = normalizeShortcut(shortcut);
        if (isModifierCode(event.code)) {
            return false;
        }
        return (
            Boolean(event.ctrlKey) === Boolean(normalized.ctrl)
            && Boolean(event.altKey) === Boolean(normalized.alt)
            && Boolean(event.shiftKey) === Boolean(normalized.shift)
            && Boolean(event.metaKey) === Boolean(normalized.meta)
            && event.code === normalized.code
        );
    };

    const formatBalanceValue = (rawValue) => {
        if (rawValue == null) return '';
        const normalized = String(rawValue).replace(/\s+/g, '').replace(',', '.');
        const amount = Number(normalized);
        if (!Number.isFinite(amount)) {
            return collapseSpaces(rawValue) || '';
        }
        const fixed = amount.toFixed(2);
        return fixed.replace(/\.00$/, '').replace(/(\.\d*?)0+$/, '$1');
    };

    const formatBooleanValue = (value) => {
        if (value == null) return '';
        if (typeof value === 'boolean') {
            return value ? 'Да' : 'Нет';
        }
        const normalized = collapseSpaces(String(value)).toLowerCase();
        if (!normalized) return '';
        if (['true', 'yes', '1', 'да'].includes(normalized)) return 'Да';
        if (['false', 'no', '0', 'нет'].includes(normalized)) return 'Нет';
        return collapseSpaces(String(value));
    };

    const loadPosition = (key) => {
        try {
            const raw = localStorage.getItem(key);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return null;
            const left = Number(parsed.left);
            const top = Number(parsed.top);
            if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
            return { left, top };
        } catch (error) {
            console.warn('[GGSEL User Explorer] Не удалось загрузить позицию', error);
            return null;
        }
    };

    const savePosition = (key, position) => {
        if (!position || typeof position !== 'object') return;
        try {
            localStorage.setItem(key, JSON.stringify({
                left: Math.round(position.left),
                top: Math.round(position.top)
            }));
        } catch (error) {
            console.warn('[GGSEL User Explorer] Не удалось сохранить позицию', error);
        }
    };

    const clampPositionToViewport = (position) => {
        if (!position) return position;
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
        const anchorRect = state.anchor?.getBoundingClientRect();
        const width = anchorRect ? Math.max(FAB_SIZE, Math.round(anchorRect.width || FAB_SIZE)) : FAB_SIZE;
        const height = anchorRect ? Math.max(FAB_SIZE, Math.round(anchorRect.height || FAB_SIZE)) : FAB_SIZE;
        const maxLeft = Math.max(0, Math.round(viewportWidth - width));
        const maxTop = Math.max(0, Math.round(viewportHeight - height));
        const applyMargin = (value, size, viewport) => {
            if (viewport <= size + VIEWPORT_MARGIN * 2) {
                return Math.min(Math.max(value, 0), Math.max(0, viewport - size));
            }
            const min = VIEWPORT_MARGIN;
            const max = Math.max(min, viewport - size - VIEWPORT_MARGIN);
            if (max <= min) {
                return Math.min(Math.max(value, 0), Math.max(0, viewport - size));
            }
            return Math.min(Math.max(value, min), max);
        };

        let left = Math.min(Math.max(Math.round(position.left), 0), maxLeft);
        let top = Math.min(Math.max(Math.round(position.top), 0), maxTop);

        left = applyMargin(left, width, viewportWidth);
        top = applyMargin(top, height, viewportHeight);

        if (state.open && state.panel) {
            const panelHeightRaw = state.panel.scrollHeight || state.panel.offsetHeight || state.lastPanelHeight || height;
            const panelHeight = Math.min(Math.max(panelHeightRaw, height), Math.round(viewportHeight * 0.9));
            const orientationUp = state.anchor?.classList.contains('expand-up');
            const bottomLimit = Math.max(VIEWPORT_MARGIN, viewportHeight - height - VIEWPORT_MARGIN);
            if (orientationUp) {
                const minTop = Math.min(
                    Math.max(VIEWPORT_MARGIN + panelHeight - height, VIEWPORT_MARGIN),
                    Math.max(0, viewportHeight - height)
                );
                top = Math.max(top, minTop);
            } else {
                const maxTopForPanel = Math.max(
                    VIEWPORT_MARGIN,
                    Math.min(viewportHeight - panelHeight - VIEWPORT_MARGIN, Math.max(0, viewportHeight - height))
                );
                top = Math.min(top, maxTopForPanel);
            }
            const minTop = Math.min(VIEWPORT_MARGIN, bottomLimit);
            const maxTopPanel = Math.max(minTop, bottomLimit);
            top = Math.min(Math.max(top, minTop), maxTopPanel);
        }

        return { left, top };
    };

    const applyAnchorPositionStyles = (position) => {
        if (!state.anchor) return;
        if (!position) {
            state.anchor.style.left = 'auto';
            state.anchor.style.top = 'auto';
            state.anchor.style.right = `${VIEWPORT_MARGIN}px`;
            state.anchor.style.bottom = `${VIEWPORT_MARGIN}px`;
        } else {
            state.anchor.style.right = 'auto';
            state.anchor.style.bottom = 'auto';
            state.anchor.style.left = `${position.left}px`;
            state.anchor.style.top = `${position.top}px`;
        }
    };

    const getAnchorBasePosition = () => {
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
        const margin = VIEWPORT_MARGIN;
        if (state.anchorPosition) {
            return { ...state.anchorPosition };
        }
        return {
            left: Math.max(0, viewportWidth - FAB_SIZE - margin),
            top: Math.max(0, viewportHeight - FAB_SIZE - margin)
        };
    };

    const getCurrentInputValue = () => {
        if (!state.input) return '';
        return state.input.value ? state.input.value.trim() : '';
    };

    const updateAnchorOrientation = () => {
        if (!state.anchor || state.anchorDragActive) return;
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
        if (!viewportWidth || !viewportHeight) return;
        const margin = VIEWPORT_MARGIN;
        const basePosition = getAnchorBasePosition();
        const panelHeight = state.panel ? state.panel.scrollHeight : 0;
        if (panelHeight) {
            state.lastPanelHeight = Math.max(FAB_SIZE, panelHeight);
        }
        const expandLeft = basePosition.left + FAB_SIZE / 2 > viewportWidth / 2;
        const availableBelow = viewportHeight - (basePosition.top + FAB_SIZE) - margin;
        const availableAbove = basePosition.top - margin;
        const estimatedHeightClosed = panelHeight || state.lastPanelHeight || FAB_SIZE;
        let expandUp = false;
        if (state.open) {
            const estimatedHeight = panelHeight || estimatedHeightClosed;
            if (availableBelow < Math.min(estimatedHeight, viewportHeight * 0.7) && availableAbove > availableBelow) {
                expandUp = true;
            }
        } else if (estimatedHeightClosed > availableBelow && availableAbove > availableBelow) {
            expandUp = true;
        }
        state.anchor.classList.toggle('expand-left', expandLeft);
        state.anchor.classList.toggle('expand-right', !expandLeft);
        state.anchor.classList.toggle('expand-up', expandUp);
        state.anchor.classList.toggle('expand-down', !expandUp);
    };

    const applyAnchorPosition = () => {
        if (!state.anchor) return;
        if (!state.anchorPosition) {
            applyAnchorPositionStyles(null);
            updateAnchorOrientation();
            return;
        }
        const normalized = clampPositionToViewport(state.anchorPosition);
        state.anchorPosition = normalized;
        applyAnchorPositionStyles(normalized);
        updateAnchorOrientation();
    };

    const beginAnchorDrag = (event) => {
        if (!state.anchor) return false;
        const rect = state.anchor.getBoundingClientRect();
        const baseLeft = Math.round(rect.left || 0);
        const baseTop = Math.round(rect.top || 0);
        const width = Math.max(FAB_SIZE, Math.round(rect.width || FAB_SIZE));
        const height = Math.max(FAB_SIZE, Math.round(rect.height || FAB_SIZE));
        let offsetX = event.clientX - baseLeft;
        let offsetY = event.clientY - baseTop;
        if (!Number.isFinite(offsetX)) offsetX = width / 2;
        if (!Number.isFinite(offsetY)) offsetY = height / 2;
        offsetX = Math.min(Math.max(Math.round(offsetX), 0), width);
        offsetY = Math.min(Math.max(Math.round(offsetY), 0), height);
        state.anchorDragActive = true;
        state.anchorDragMoved = false;
        state.anchor.classList.add('dragging');
        const onPointerMove = (moveEvent) => {
            if (moveEvent.pointerId !== event.pointerId) return;
            const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
            const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
            const maxLeft = Math.max(0, Math.round(viewportWidth - width));
            const maxTop = Math.max(0, Math.round(viewportHeight - height));
            let nextLeft = moveEvent.clientX - offsetX;
            let nextTop = moveEvent.clientY - offsetY;
            nextLeft = Math.min(Math.max(Math.round(nextLeft), 0), maxLeft);
            nextTop = Math.min(Math.max(Math.round(nextTop), 0), maxTop);
            state.anchorDragMoved = state.anchorDragMoved || (Math.abs(nextLeft - baseLeft) > 1 || Math.abs(nextTop - baseTop) > 1);
            state.anchorPosition = { left: nextLeft, top: nextTop };
            state.anchorPositionManual = true;
            applyAnchorPosition();
        };
        const finishDrag = (upEvent) => {
            if (upEvent.pointerId !== event.pointerId) return;
            state.anchor.classList.remove('dragging');
            state.anchorDragActive = false;
            document.removeEventListener('pointermove', onPointerMove);
            document.removeEventListener('pointerup', finishDrag);
            document.removeEventListener('pointercancel', finishDrag);
            if (state.anchorPosition) {
                savePosition(ANCHOR_POSITION_KEY, state.anchorPosition);
            }
            if (state.anchorDragFromButton && (state.anchorDragMoved || event.ctrlKey || event.altKey)) {
                state.suppressNextButtonClick = true;
                setTimeout(() => {
                    state.suppressNextButtonClick = false;
                }, 120);
            }
            state.anchorDragFromButton = false;
            state.anchorDragMoved = false;
            updateAnchorOrientation();
        };
        document.addEventListener('pointermove', onPointerMove);
        document.addEventListener('pointerup', finishDrag);
        document.addEventListener('pointercancel', finishDrag);
        event.preventDefault();
        return true;
    };

    const startAnchorDrag = (event) => {
        if (!state.anchor || event.button !== 0 || !(event.ctrlKey && event.altKey) || state.open) return;
        state.anchorDragFromButton = true;
        beginAnchorDrag(event);
    };

    const enablePanelTopDragging = (panel) => {
        if (!panel) return;
        panel.addEventListener('pointerdown', (event) => {
            if (event.button !== 0 || !state.anchor || !state.open) return;
            const targetEl = event.target && event.target.nodeType === 1 ? event.target : null;
            if (!targetEl) return;
            if (targetEl.closest('input, textarea, select, button, a, [contenteditable], .ggsel-user-explorer-results, .ggsel-user-load-more')) {
                return;
            }
            const rect = panel.getBoundingClientRect();
            const topZoneHeight = FAB_SIZE;
            const bottomZoneHeight = FAB_SIZE;
            const pointerFromTop = event.clientY - rect.top;
            const pointerFromBottom = rect.bottom - event.clientY;
            const expandUp = state.anchor?.classList.contains('expand-up');
            const expandDown = state.anchor?.classList.contains('expand-down');
            let draggable = false;
            if (expandUp && pointerFromBottom <= bottomZoneHeight) {
                draggable = true;
            }
            if (!draggable && (!expandUp || expandDown) && pointerFromTop <= topZoneHeight) {
                draggable = true;
            }
            if (!draggable) {
                return;
            }
            state.anchorDragFromButton = false;
            beginAnchorDrag(event);
        });
    };

    const expandSearchControl = () => {
        if (!state.searchControl) return;
        state.searchControl.classList.remove('collapsed');
        state.searchControl.classList.add('expanded');
    };

    const collapseSearchControl = () => {
        if (!state.searchControl) return;
        state.searchControl.classList.remove('expanded');
        state.searchControl.classList.add('collapsed');
    };

    const updateSearchControlValueState = () => {
        if (!state.searchControl || !state.input) return;
        const hasValue = Boolean(state.input.value && state.input.value.trim());
        state.searchControl.classList.toggle('has-value', hasValue);
    };

    const formatLocaleValue = (value) => {
        const normalized = collapseSpaces(value || '');
        if (!normalized) return '';
        const lower = normalized.toLowerCase();
        if (lower.length <= 3) {
            return lower.charAt(0).toUpperCase() + lower.slice(1);
        }
        return normalized;
    };

    const hasMeaningfulHtmlValue = (valueHtml) => {
        if (!valueHtml) return false;
        const text = valueHtml
            .replace(/<[^>]*>/g, ' ')
            .replace(/&nbsp;/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        return Boolean(text);
    };

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
        state.settings = getDefaultSettings();
        try {
            const raw = localStorage.getItem(SETTINGS_KEY);
            if (!raw) {
                return;
            }
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') {
                state.settings = {
                    extraActions: Boolean(parsed.extraActions),
                    shortcut: normalizeShortcut(parsed.shortcut),
                    userFields: normalizeUserFieldSettings(parsed.userFields),
                    orderFields: normalizeOrderFieldSettings(parsed.orderFields)
                };
            }
        } catch (error) {
            console.warn('Не удалось загрузить настройки GGSEL User Explorer', error);
            state.settings = getDefaultSettings();
        }
    };

    const saveSettings = () => {
        try {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify({
                extraActions: Boolean(state.settings?.extraActions),
                shortcut: normalizeShortcut(state.settings?.shortcut),
                userFields: normalizeUserFieldSettings(state.settings?.userFields),
                orderFields: normalizeOrderFieldSettings(state.settings?.orderFields)
            }));
        } catch (error) {
            console.warn('Не удалось сохранить настройки GGSEL User Explorer', error);
        }
    };

    const loadQueryHistory = () => {
        state.queryHistory = [];
        try {
            const raw = localStorage.getItem(HISTORY_KEY);
            if (!raw) {
                return;
            }
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                const items = parsed
                    .map((item) => collapseSpaces(typeof item === 'string' ? item : ''))
                    .filter(Boolean);
                state.queryHistory = items.slice(0, HISTORY_LIMIT);
            }
        } catch (error) {
            console.warn('Не удалось загрузить историю запросов GGSEL User Explorer', error);
            state.queryHistory = [];
        }
    };

    const saveQueryHistory = () => {
        try {
            localStorage.setItem(HISTORY_KEY, JSON.stringify(state.queryHistory || []));
        } catch (error) {
            console.warn('Не удалось сохранить историю запросов GGSEL User Explorer', error);
        }
    };

    const rememberQuery = (query) => {
        const normalized = collapseSpaces(query || '');
        if (!normalized) {
            return;
        }
        const history = Array.isArray(state.queryHistory) ? [...state.queryHistory] : [];
        const existingIndex = history.findIndex((item) => item === normalized);
        if (existingIndex !== -1) {
            history.splice(existingIndex, 1);
        }
        history.unshift(normalized);
        state.queryHistory = history.slice(0, HISTORY_LIMIT);
        saveQueryHistory();
        if (state.historyVisible) {
            renderHistoryPopover();
        }
    };

    const renderHistoryPopover = () => {
        if (!state.historyList) {
            return;
        }
        const history = Array.isArray(state.queryHistory) ? state.queryHistory : [];
        state.historyList.innerHTML = '';
        if (!history.length) {
            const empty = document.createElement('div');
            empty.className = 'ggsel-user-history-empty';
            empty.textContent = 'Нет недавних запросов';
            state.historyList.appendChild(empty);
            return;
        }
        history.slice(0, HISTORY_LIMIT).forEach((item) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'ggsel-user-history-item';
            button.textContent = item;
            button.title = item;
            button.addEventListener('click', () => {
                if (!state.input) return;
                state.input.value = item;
                try {
                    state.input.focus({ preventScroll: true });
                } catch (error) {
                    state.input.focus();
                }
                hideHistoryPopover();
                onQueryChange(item);
                onQueryChange.flush?.();
            });
            state.historyList.appendChild(button);
        });
    };

    const showHistoryPopover = () => {
        if (!state.historyPopover) {
            return;
        }
        renderHistoryPopover();
        state.historyPopover.hidden = false;
        state.historyPopover.classList.add('visible');
        state.historyVisible = true;
    };

    const hideHistoryPopover = () => {
        if (!state.historyPopover) {
            return;
        }
        if (state.historyPopover.hidden) {
            return;
        }
        state.historyPopover.hidden = true;
        state.historyPopover.classList.remove('visible');
        state.historyVisible = false;
    };

    const centerWindowElement = (element) => {
        if (!element) return;
        element.classList.remove('dragging');
        element.style.transform = 'none';
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
        const rect = element.getBoundingClientRect();
        const width = rect.width;
        const height = rect.height;
        const maxLeft = Math.max(0, Math.round(viewportWidth - width));
        const maxTop = Math.max(0, Math.round(viewportHeight - height));
        const left = Math.min(Math.max(Math.round((viewportWidth - width) / 2), 16), Math.max(16, maxLeft));
        const top = Math.min(Math.max(Math.round((viewportHeight - height) / 2), 16), Math.max(16, maxTop));
        element.style.left = `${left}px`;
        element.style.top = `${top}px`;
        element.style.right = 'auto';
        element.style.bottom = 'auto';
    };

    const enableWindowDragging = (element, handle) => {
        if (!element || !handle) return;
        const onPointerDown = (event) => {
            if (event.button !== 0) return;
            if (event.target.closest('button')) return;
            const rect = element.getBoundingClientRect();
            const offsetX = event.clientX - rect.left;
            const offsetY = event.clientY - rect.top;
            const width = rect.width;
            const height = rect.height;
            element.classList.add('dragging');
            element.style.transform = 'none';
            const onPointerMove = (moveEvent) => {
                if (moveEvent.pointerId !== event.pointerId) return;
                const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
                const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
                const maxLeft = Math.max(0, Math.round(viewportWidth - width));
                const maxTop = Math.max(0, Math.round(viewportHeight - height));
                let nextLeft = moveEvent.clientX - offsetX;
                let nextTop = moveEvent.clientY - offsetY;
                nextLeft = Math.min(Math.max(Math.round(nextLeft), 0), maxLeft);
                nextTop = Math.min(Math.max(Math.round(nextTop), 0), maxTop);
                element.style.left = `${nextLeft}px`;
                element.style.top = `${nextTop}px`;
                element.style.right = 'auto';
                element.style.bottom = 'auto';
            };
            const onPointerUp = (upEvent) => {
                if (upEvent.pointerId !== event.pointerId) return;
                element.classList.remove('dragging');
                document.removeEventListener('pointermove', onPointerMove);
                document.removeEventListener('pointerup', onPointerUp);
                document.removeEventListener('pointercancel', onPointerUp);
            };
            document.addEventListener('pointermove', onPointerMove);
            document.addEventListener('pointerup', onPointerUp);
            document.addEventListener('pointercancel', onPointerUp);
            event.preventDefault();
        };
        handle.addEventListener('pointerdown', onPointerDown);
    };

    const refreshShortcutDisplay = () => {
        const win = state.windows.settings;
        if (!win || !win.controls) return;
        const { shortcutDisplay, shortcutAssign } = win.controls;
        const capturing = Boolean(state.shortcutCapture?.active);
        if (shortcutDisplay) {
            if (capturing && state.shortcutCapture.displayEl === shortcutDisplay) {
                shortcutDisplay.textContent = 'Нажмите новое сочетание…';
            } else {
                shortcutDisplay.textContent = formatShortcut(state.settings.shortcut);
            }
            shortcutDisplay.classList.toggle('capturing', capturing);
        }
        if (shortcutAssign) {
            shortcutAssign.disabled = capturing;
        }
    };

    const stopShortcutCapture = () => {
        if (!state.shortcutCapture) return;
        const { displayEl, assignBtn } = state.shortcutCapture;
        if (assignBtn) {
            assignBtn.disabled = false;
        }
        if (displayEl) {
            displayEl.classList.remove('capturing');
        }
        state.shortcutCapture = null;
        refreshShortcutDisplay();
    };

    const beginShortcutCapture = ({ displayEl, assignBtn }) => {
        stopShortcutCapture();
        state.shortcutCapture = {
            active: true,
            displayEl: displayEl || null,
            assignBtn: assignBtn || null,
            windowKey: 'settings'
        };
        if (assignBtn) {
            assignBtn.disabled = true;
        }
        if (displayEl) {
            displayEl.classList.add('capturing');
        }
        refreshShortcutDisplay();
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
        enableWindowDragging(element, header);

        element.addEventListener('wheel', (event) => {
            event.stopPropagation();
            const target = event.target instanceof Element ? event.target.closest('.ggsel-user-window__content') : null;
            if (!target) {
                event.preventDefault();
                return;
            }
            const { scrollTop, scrollHeight, clientHeight } = target;
            if (scrollHeight <= clientHeight) {
                event.preventDefault();
                return;
            }
            const delta = event.deltaY;
            if ((delta < 0 && scrollTop <= 0) || (delta > 0 && scrollTop + clientHeight >= scrollHeight - 1)) {
                event.preventDefault();
            }
        }, { passive: false });

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
        if (state.shortcutCapture?.windowKey === type) {
            stopShortcutCapture();
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
        const userHints = getModeConfig(MODE_USERS).hints;
        const orderHints = getModeConfig(MODE_ORDERS).hints;
        win.content.innerHTML = `
            <div class="ggsel-user-explorer-hints">
                <h4>Поиск пользователей</h4>
                <p>${userHints}</p>
                <h4>Поиск заказов</h4>
                <p>${orderHints}</p>
            </div>
        `;
        win.element.hidden = false;
        requestAnimationFrame(() => {
            centerWindowElement(win.element);
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

            const fieldsContainer = document.createElement('div');
            fieldsContainer.className = 'ggsel-user-window__field-groups';

            const fieldControls = { userFields: {}, orderFields: {} };

            const buildFieldsGroup = (groupKey, headingText, defs) => {
                const group = document.createElement('div');
                group.className = 'ggsel-user-window__fields-group';

                const heading = document.createElement('h4');
                heading.className = 'ggsel-user-window__fields-title';
                heading.textContent = headingText;
                group.appendChild(heading);

                const list = document.createElement('div');
                list.className = 'ggsel-user-window__fields-list';

                defs.forEach((optionDef) => {
                    const row = document.createElement('label');
                    row.className = 'ggsel-user-window__toggle';

                    const fieldCheckbox = document.createElement('input');
                    fieldCheckbox.type = 'checkbox';
                    fieldCheckbox.dataset.group = groupKey;
                    fieldCheckbox.dataset.key = optionDef.key;

                    const text = document.createElement('div');
                    text.className = 'ggsel-user-window__toggle-text';

                    const rowTitle = document.createElement('span');
                    rowTitle.className = 'ggsel-user-window__option-title';
                    rowTitle.textContent = optionDef.label;

                    const rowDesc = document.createElement('span');
                    rowDesc.className = 'ggsel-user-window__option-desc ggsel-user-window__toggle-desc';
                    rowDesc.textContent = optionDef.description || '';

                    text.appendChild(rowTitle);
                    if (optionDef.description) {
                        text.appendChild(rowDesc);
                    }

                    row.appendChild(fieldCheckbox);
                    row.appendChild(text);

                    fieldCheckbox.addEventListener('change', () => {
                        if (!state.settings[groupKey]) {
                            state.settings[groupKey] = groupKey === 'userFields'
                                ? normalizeUserFieldSettings()
                                : normalizeOrderFieldSettings();
                        }
                        state.settings[groupKey] = {
                            ...state.settings[groupKey],
                            [optionDef.key]: fieldCheckbox.checked
                        };
                        saveSettings();
                        rerenderCurrentResults();
                    });

                    list.appendChild(row);
                    fieldControls[groupKey][optionDef.key] = fieldCheckbox;
                });

                group.appendChild(list);
                fieldsContainer.appendChild(group);
            };

            buildFieldsGroup('userFields', 'Пользователи', USER_FIELD_OPTION_DEFS);
            buildFieldsGroup('orderFields', 'Заказы', ORDER_FIELD_OPTION_DEFS);

            options.appendChild(fieldsContainer);

            const shortcutWrap = document.createElement('div');
            shortcutWrap.className = 'ggsel-user-window__shortcut';

            const shortcutInfo = document.createElement('div');
            shortcutInfo.className = 'ggsel-user-window__shortcut-info';

            const shortcutTitle = document.createElement('span');
            shortcutTitle.className = 'ggsel-user-window__option-title';
            shortcutTitle.textContent = 'Горячая клавиша поиска';

            const shortcutDesc = document.createElement('span');
            shortcutDesc.className = 'ggsel-user-window__option-desc';
            shortcutDesc.textContent = 'Комбинация для открытия и фокусировки строки поиска (работает в любой раскладке).';

            shortcutInfo.appendChild(shortcutTitle);
            shortcutInfo.appendChild(shortcutDesc);

            const shortcutControls = document.createElement('div');
            shortcutControls.className = 'ggsel-user-window__shortcut-controls';

            const shortcutDisplay = document.createElement('div');
            shortcutDisplay.className = 'ggsel-user-window__shortcut-display';

            const shortcutButtons = document.createElement('div');
            shortcutButtons.className = 'ggsel-user-window__shortcut-buttons';

            const assignBtn = document.createElement('button');
            assignBtn.type = 'button';
            assignBtn.className = 'ggsel-user-window__shortcut-button';
            assignBtn.textContent = 'Изменить';
            assignBtn.addEventListener('click', () => {
                beginShortcutCapture({ displayEl: shortcutDisplay, assignBtn });
            });

            const resetBtn = document.createElement('button');
            resetBtn.type = 'button';
            resetBtn.className = 'ggsel-user-window__shortcut-button';
            resetBtn.textContent = 'Сбросить';
            resetBtn.addEventListener('click', () => {
                stopShortcutCapture();
                state.settings.shortcut = cloneShortcut(DEFAULT_SHORTCUT);
                saveSettings();
                refreshShortcutDisplay();
            });

            shortcutButtons.appendChild(assignBtn);
            shortcutButtons.appendChild(resetBtn);

            shortcutControls.appendChild(shortcutDisplay);
            shortcutControls.appendChild(shortcutButtons);

            shortcutWrap.appendChild(shortcutInfo);
            shortcutWrap.appendChild(shortcutControls);

            options.appendChild(shortcutWrap);
            win.content.appendChild(options);

            checkbox.addEventListener('change', () => {
                state.settings.extraActions = checkbox.checked;
                saveSettings();
                closeContextMenu();
            });

            win.initialized = true;
            win.controls = {
                checkbox,
                shortcutDisplay,
                shortcutAssign: assignBtn,
                shortcutReset: resetBtn,
                fieldCheckboxes: fieldControls
            };
        }

        if (win.controls?.checkbox) {
            win.controls.checkbox.checked = Boolean(state.settings.extraActions);
        }

        if (win.controls?.fieldCheckboxes) {
            const userSettings = normalizeUserFieldSettings(state.settings.userFields);
            const orderSettings = normalizeOrderFieldSettings(state.settings.orderFields);
            Object.entries(win.controls.fieldCheckboxes.userFields || {}).forEach(([key, el]) => {
                if (el) {
                    el.checked = Boolean(userSettings[key]);
                }
            });
            Object.entries(win.controls.fieldCheckboxes.orderFields || {}).forEach(([key, el]) => {
                if (el) {
                    el.checked = Boolean(orderSettings[key]);
                }
            });
        }

        refreshShortcutDisplay();

        win.element.hidden = false;
        requestAnimationFrame(() => {
            centerWindowElement(win.element);
            try {
                win.element.focus({ preventScroll: true });
            } catch (error) {
                win.element.focus();
            }
        });
    };

    const injectStyles = () => {
        const css = `
            .ggsel-user-explorer-anchor {
                position: fixed;
                z-index: 9999;
                pointer-events: none;
                width: var(--ggsel-user-explorer-fab, 56px);
                height: var(--ggsel-user-explorer-fab, 56px);
            }
            .ggsel-user-explorer-anchor.dragging * {
                cursor: grabbing !important;
            }
            .ggsel-user-explorer-shell {
                position: relative;
                width: 100%;
                height: 100%;
                pointer-events: auto;
                overflow: visible;
            }
            .ggsel-user-explorer-button {
                position: absolute;
                inset: 0;
                width: 100%;
                height: 100%;
                border-radius: 18px;
                background: rgba(16, 16, 16, 0.92);
                border: 1px solid #2f2f2f;
                color: #8ab4ff;
                box-shadow: 0 10px 28px rgba(0, 0, 0, 0.42);
                cursor: pointer;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                transition: opacity 0.2s ease, transform 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease;
                touch-action: manipulation;
            }
            .ggsel-user-explorer-button svg {
                width: 28px;
                height: 28px;
            }
            .ggsel-user-explorer-button:hover {
                border-color: #8ab4ff;
                box-shadow: 0 16px 36px rgba(0, 0, 0, 0.48);
            }
            .ggsel-user-explorer-button:active {
                transform: scale(0.95);
            }
            .ggsel-user-explorer-anchor.expanded .ggsel-user-explorer-button {
                opacity: 0;
                transform: scale(0.7);
                pointer-events: none;
            }
            .ggsel-user-explorer-panel {
                position: absolute;
                width: min(500px, calc(100vw - 48px));
                max-height: min(80vh, 720px);
                background: rgba(16, 16, 16, 0.92);
                border: 1px solid #2f2f2f;
                border-radius: 14px;
                color: #eaeaea;
                box-shadow: 0 12px 34px rgba(0, 0, 0, 0.38);
                display: flex;
                flex-direction: column;
                overflow: hidden;
                backdrop-filter: blur(6px);
                opacity: 0;
                visibility: hidden;
                pointer-events: none;
                transform: scale(0.6);
                transform-origin: var(--ggsel-panel-origin-x, left) var(--ggsel-panel-origin-y, top);
                transition: transform 0.24s ease, opacity 0.2s ease, visibility 0.2s ease;
                height: auto;
            }
            .ggsel-user-explorer-anchor.no-results .ggsel-user-explorer-panel {
                height: var(--ggsel-user-explorer-fab, 56px);
            }
            .ggsel-user-explorer-anchor.expand-right .ggsel-user-explorer-panel {
                left: 0;
                right: auto;
                --ggsel-panel-origin-x: left;
            }
            .ggsel-user-explorer-anchor.expand-left .ggsel-user-explorer-panel {
                left: auto;
                right: 0;
                --ggsel-panel-origin-x: right;
            }
            .ggsel-user-explorer-anchor.expand-down .ggsel-user-explorer-panel {
                top: 0;
                bottom: auto;
                --ggsel-panel-origin-y: top;
            }
            .ggsel-user-explorer-anchor.expand-up .ggsel-user-explorer-panel {
                top: auto;
                bottom: 0;
                --ggsel-panel-origin-y: bottom;
            }
            .ggsel-user-explorer-anchor.expanded .ggsel-user-explorer-panel {
                opacity: 1;
                visibility: visible;
                transform: scale(1);
                pointer-events: auto;
            }
            .ggsel-user-explorer-body {
                display: flex;
                flex-direction: column;
                gap: 14px;
                padding: 0 16px;
                flex: 1 1 auto;
                min-height: 0;
            }
            .ggsel-user-explorer-anchor.no-results .ggsel-user-explorer-body {
                padding: 0 16px;
                gap: 0;
                justify-content: center;
            }
            .ggsel-user-explorer-search-row {
                display: flex;
                align-items: center;
                justify-content: flex-start;
                order: 1;
                min-height: var(--ggsel-user-explorer-fab, 56px);
                padding: 0;
                width: 100%;
            }
            .ggsel-user-explorer-anchor.no-results .ggsel-user-explorer-search-row {
                padding: 0;
                width: 100%;
                min-height: var(--ggsel-user-explorer-fab, 56px);
            }
            .ggsel-user-explorer-results-wrapper {
                display: flex;
                flex-direction: column;
                gap: 12px;
                order: 2;
                flex: 1 1 auto;
                min-height: 0;
                padding: 0 0 16px;
            }
            .ggsel-user-explorer-results-wrapper[hidden] {
                display: none !important;
            }
            .ggsel-user-explorer-anchor.expand-up .ggsel-user-explorer-search-row {
                order: 2;
            }
            .ggsel-user-explorer-anchor.expand-up .ggsel-user-explorer-results-wrapper {
                order: 1;
                padding: 16px 0 0;
            }
            .ggsel-user-explorer-search-control {
                flex: 1 1 auto;
                display: flex;
                align-items: center;
                transition: opacity 0.2s ease, transform 0.2s ease;
                opacity: 0;
                transform: scaleX(0.9);
                pointer-events: none;
                position: relative;
            }
            .ggsel-user-explorer-anchor.expand-left .ggsel-user-explorer-search-control {
                transform-origin: right center;
            }
            .ggsel-user-explorer-anchor.expand-right .ggsel-user-explorer-search-control {
                transform-origin: left center;
            }
            .ggsel-user-explorer-search-control.expanded {
                opacity: 1;
                transform: scaleX(1);
                pointer-events: auto;
            }
            .ggsel-user-explorer-mode-toggle {
                flex: 0 0 auto;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 44px;
                height: 44px;
                margin-left: 12px;
                border-radius: 14px;
                border: 1px solid rgba(111, 137, 255, 0.35);
                background: rgba(111, 137, 255, 0.15);
                color: #9fb7ff;
                cursor: pointer;
                transition: background 0.25s ease, border-color 0.25s ease, color 0.25s ease, transform 0.25s ease;
                box-shadow: inset 0 0 0 0 rgba(111, 137, 255, 0.25);
            }
            .ggsel-user-explorer-mode-toggle svg {
                flex: 0 0 auto;
                width: 20px;
                height: 20px;
                transition: transform 0.25s ease;
            }
            .ggsel-user-explorer-mode-toggle:hover,
            .ggsel-user-explorer-mode-toggle:focus-visible {
                outline: none;
                transform: scale(1.05);
            }
            .ggsel-user-explorer-mode-toggle.mode-users {
                border-color: rgba(111, 137, 255, 0.45);
                background: rgba(111, 137, 255, 0.2);
                color: #9fb7ff;
            }
            .ggsel-user-explorer-mode-toggle.mode-users:hover,
            .ggsel-user-explorer-mode-toggle.mode-users:focus-visible {
                box-shadow: inset 0 0 0 1px rgba(111, 137, 255, 0.45);
            }
            .ggsel-user-explorer-mode-toggle.mode-orders {
                border-color: rgba(255, 189, 122, 0.55);
                background: rgba(255, 189, 122, 0.18);
                color: #ffd49a;
            }
            .ggsel-user-explorer-mode-toggle.mode-orders:hover,
            .ggsel-user-explorer-mode-toggle.mode-orders:focus-visible {
                box-shadow: inset 0 0 0 1px rgba(255, 189, 122, 0.45);
            }
            .ggsel-user-explorer-mode-toggle.toggling svg {
                animation: ggselModeSwap 0.3s ease;
            }
            @keyframes ggselModeSwap {
                0% {
                    transform: scale(0.85) rotate(-12deg);
                }
                50% {
                    transform: scale(1.15) rotate(8deg);
                }
                100% {
                    transform: scale(1) rotate(0deg);
                }
            }
            .ggsel-user-explorer-search-input {
                flex: 1 1 auto;
                border-radius: 18px;
                border: 1px solid #333;
                background: rgba(12, 14, 20, 0.95);
                color: #eaeaea;
                font-size: 15px;
                padding: 0 18px;
                height: calc(var(--ggsel-user-explorer-fab, 56px) - 12px);
                line-height: calc(var(--ggsel-user-explorer-fab, 56px) - 12px);
                outline: none;
                box-shadow: 0 0 0 0 rgba(111, 137, 255, 0);
                transition: border-color 0.2s ease, box-shadow 0.2s ease;
            }
            .ggsel-user-explorer-search-input::placeholder {
                color: rgba(187, 193, 216, 0.65);
            }
            .ggsel-user-explorer-search-input:focus {
                border-color: #6f89ff;
                box-shadow: 0 0 0 3px rgba(111, 137, 255, 0.25);
            }
            .ggsel-user-history-popover {
                position: absolute;
                top: calc(100% + 6px);
                left: 0;
                right: 0;
                border-radius: 14px;
                border: 1px solid #2f2f2f;
                background: rgba(16, 16, 16, 0.94);
                box-shadow: 0 10px 28px rgba(0, 0, 0, 0.45);
                padding: 10px;
                display: flex;
                flex-direction: column;
                gap: 6px;
                max-height: 220px;
                overflow-y: auto;
                z-index: 5;
            }
            .ggsel-user-history-popover[hidden] {
                display: none !important;
            }
            .ggsel-user-history-list {
                display: flex;
                flex-direction: column;
                gap: 6px;
            }
            .ggsel-user-history-item {
                border: 1px solid #2f2f2f;
                border-radius: 12px;
                background: #181818;
                color: #eaeaea;
                font-size: 13px;
                padding: 6px 10px;
                text-align: left;
                cursor: pointer;
                transition: border-color 0.2s ease, color 0.2s ease, background 0.2s ease;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .ggsel-user-history-item:hover,
            .ggsel-user-history-item:focus-visible {
                outline: none;
                border-color: #6f89ff;
                color: #9fb7ff;
                background: rgba(111, 137, 255, 0.18);
            }
            .ggsel-user-history-empty {
                font-size: 12px;
                color: #a5a5a5;
                text-align: center;
                padding: 4px 0;
            }
            .ggsel-user-explorer-results {
                display: flex;
                flex-direction: column;
                gap: 10px;
                flex: 1 1 auto;
                min-height: 0;
                overflow-y: auto;
                padding-right: 4px;
                overscroll-behavior: contain;
            }
            .ggsel-user-window {
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
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
                touch-action: none;
            }
            .ggsel-user-window.dragging {
                cursor: grabbing;
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
                cursor: grab;
                user-select: none;
            }
            .ggsel-user-window.dragging .ggsel-user-window__header {
                cursor: grabbing;
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
            .ggsel-user-explorer-hints {
                display: flex;
                flex-direction: column;
                gap: 12px;
                font-size: 13px;
                color: #d0d0d0;
            }
            .ggsel-user-explorer-hints h4 {
                margin: 0;
                font-size: 13px;
                font-weight: 700;
                color: #8ab4ff;
                letter-spacing: 0.2px;
            }
            .ggsel-user-explorer-hints p {
                margin: 0;
                color: #c9c9c9;
                line-height: 1.55;
            }
            .ggsel-user-explorer-hints code {
                background: rgba(138, 180, 255, 0.12);
                border: 1px solid rgba(138, 180, 255, 0.2);
                border-radius: 6px;
                padding: 1px 4px;
                color: #8ab4ff;
                font-size: 12px;
            }
            .ggsel-user-window__options {
                display: flex;
                flex-direction: column;
                gap: 10px;
                margin-top: 6px;
            }
            .ggsel-user-window__field-groups {
                display: flex;
                flex-direction: column;
                gap: 10px;
            }
            .ggsel-user-window__fields-group {
                display: flex;
                flex-direction: column;
                gap: 8px;
                background: #121212;
                border: 1px solid #2f2f2f;
                border-radius: 10px;
                padding: 10px 12px;
            }
            .ggsel-user-window__fields-title {
                margin: 0;
                font-size: 12px;
                font-weight: 600;
                color: #8ab4ff;
                letter-spacing: 0.35px;
                text-transform: uppercase;
            }
            .ggsel-user-window__fields-list {
                display: flex;
                flex-direction: column;
                gap: 6px;
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
            .ggsel-user-window__toggle {
                display: flex;
                align-items: center;
                gap: 10px;
            }
            .ggsel-user-window__toggle input[type="checkbox"] {
                width: 18px;
                height: 18px;
                accent-color: #8ab4ff;
            }
            .ggsel-user-window__toggle-text {
                display: flex;
                flex-direction: column;
                gap: 2px;
            }
            .ggsel-user-window__toggle-desc {
                color: #a8a8a8;
            }
            .ggsel-user-window__shortcut {
                display: flex;
                flex-direction: column;
                gap: 8px;
                margin-top: 8px;
                background: #121212;
                border: 1px solid #2f2f2f;
                border-radius: 10px;
                padding: 10px 12px;
            }
            .ggsel-user-window__shortcut-info {
                display: flex;
                flex-direction: column;
                gap: 2px;
            }
            .ggsel-user-window__shortcut-controls {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 12px;
                flex-wrap: wrap;
            }
            .ggsel-user-window__shortcut-display {
                font-size: 12px;
                font-weight: 600;
                color: #eaeaea;
                padding: 6px 14px;
                border-radius: 999px;
                border: 1px solid #2f2f2f;
                background: #181818;
                min-width: 120px;
                text-align: center;
                letter-spacing: 0.35px;
            }
            .ggsel-user-window__shortcut-display.capturing {
                color: #8ab4ff;
                border-color: #8ab4ff;
                background: rgba(138, 180, 255, 0.15);
            }
            .ggsel-user-window__shortcut-buttons {
                display: flex;
                gap: 8px;
                flex-wrap: wrap;
            }
            .ggsel-user-window__shortcut-button {
                border-radius: 10px;
                border: 1px solid #3a3a3a;
                background: #1d1d1d;
                color: #eaeaea;
                padding: 6px 12px;
                font-size: 12px;
                cursor: pointer;
                transition: border-color 0.2s ease, color 0.2s ease;
            }
            .ggsel-user-window__shortcut-button:hover {
                border-color: #8ab4ff;
                color: #8ab4ff;
            }
            .ggsel-user-window__shortcut-button:disabled {
                opacity: 0.5;
                cursor: default;
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
                position: relative;
                background: #121212;
                border-radius: 14px;
                border: 1px solid #2f2f2f;
                overflow: visible;
                transition: border-color 0.2s ease, box-shadow 0.2s ease;
            }
            .ggsel-user-card::before {
                content: '';
                position: absolute;
                inset: -1px;
                border-radius: inherit;
                pointer-events: none;
                border: 1px solid transparent;
                box-shadow: 0 0 0 0 rgba(138, 180, 255, 0.3);
                opacity: 0;
                transition: opacity 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
            }
            .ggsel-user-card.seller-card::before {
                border-color: rgba(138, 180, 255, 0.5);
                box-shadow: 0 0 18px rgba(138, 180, 255, 0.2);
                opacity: 1;
            }
            .ggsel-user-card:hover {
                border-color: #8ab4ff;
                box-shadow: 0 10px 28px rgba(0, 0, 0, 0.35);
            }
            .ggsel-user-card-header {
                display: flex;
                align-items: stretch;
                padding: 16px 24px 14px 18px;
                cursor: pointer;
                gap: 12px;
            }
            .ggsel-user-card-meta {
                display: flex;
                flex-direction: column;
                gap: 12px;
                width: 100%;
                flex: 1 1 auto;
                min-width: 0;
            }
            .ggsel-user-card-title-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 12px;
                flex-wrap: nowrap;
                width: 100%;
            }
            .ggsel-user-card-title-group {
                display: flex;
                align-items: center;
                gap: 8px;
                flex-wrap: wrap;
                flex: 1 1 auto;
                min-width: 0;
            }
            .ggsel-user-card-name {
                font-size: 16px;
                font-weight: 600;
                color: #e0e8ff;
                letter-spacing: 0.2px;
                max-width: 100%;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .ggsel-user-card-id-meta {
                display: inline-flex;
                align-items: center;
                gap: 8px;
                flex-shrink: 0;
            }
            .ggsel-user-card-info {
                display: flex;
                align-items: flex-start;
                justify-content: space-between;
                gap: 12px;
                width: 100%;
            }
            .ggsel-user-card-footer {
                display: flex;
                align-items: center;
                justify-content: flex-end;
                gap: 8px;
                flex-shrink: 0;
                min-width: max-content;
            }
            .ggsel-user-card-id {
                font-size: 14px;
                font-weight: 600;
                color: #9fb7ff;
            }
            .ggsel-user-card-locale {
                font-size: 12px;
                font-weight: 600;
                color: #9fb7ff;
                letter-spacing: 0.3px;
                text-transform: uppercase;
            }
            .ggsel-user-card-locale[hidden] {
                display: none !important;
            }
            .ggsel-user-card-badge {
                padding: 2px 8px;
                border-radius: 999px;
                font-size: 11px;
                letter-spacing: 0.25px;
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
                display: flex;
                flex-wrap: wrap;
                gap: 6px;
                align-items: center;
                width: 100%;
            }
            .ggsel-user-card-field {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                padding: 6px 10px;
                border-radius: 12px;
                border: 1px solid #2a2a2a;
                background: #181818;
                flex: 0 0 auto;
                min-width: 0;
                max-width: 100%;
                white-space: nowrap;
            }
            .ggsel-user-card-field-label {
                font-size: 12px;
                letter-spacing: 0.35px;
                text-transform: uppercase;
                color: #8d96b8;
                white-space: nowrap;
            }
            .ggsel-user-card-field-value {
                display: inline-block;
                font-size: 13.5px;
                font-weight: 600;
                color: #f3f5ff;
                word-break: normal;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                max-width: 240px;
            }
            .ggsel-user-card-body {
                display: none;
                padding: 18px;
                border-top: 1px solid #2f2f2f;
                background: #111;
            }
            .ggsel-user-card.open .ggsel-user-card-body {
                display: flex;
                flex-direction: column;
                gap: 16px;
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
            .ggsel-user-card.order-match-id {
                border-color: rgba(245, 245, 245, 0.85);
                box-shadow: 0 0 0 1px rgba(245, 245, 245, 0.35), 0 10px 28px rgba(0, 0, 0, 0.35);
            }
            .ggsel-user-card.order-match-id:hover {
                border-color: rgba(255, 255, 255, 0.95);
            }
            .ggsel-user-card.order-match-uuid {
                border-color: rgba(168, 225, 255, 0.85);
                box-shadow: 0 0 0 1px rgba(168, 225, 255, 0.32), 0 10px 28px rgba(0, 0, 0, 0.32);
            }
            .ggsel-user-card.order-match-uuid:hover {
                border-color: rgba(188, 235, 255, 0.95);
            }
            .ggsel-user-card.order-match-email {
                border-color: rgba(142, 214, 255, 0.82);
                box-shadow: 0 0 0 1px rgba(142, 214, 255, 0.28), 0 10px 28px rgba(0, 0, 0, 0.32);
            }
            .ggsel-user-card.order-match-email:hover {
                border-color: rgba(162, 224, 255, 0.95);
            }
            .ggsel-order-card {
                cursor: pointer;
            }
            .ggsel-order-card-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 16px 20px 12px 18px;
                gap: 12px;
            }
            .ggsel-order-card-title-group {
                display: flex;
                flex-direction: column;
                gap: 4px;
                min-width: 0;
            }
            .ggsel-order-card-title {
                font-size: 14px;
                font-weight: 600;
                color: #f3f5ff;
                max-width: 360px;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .ggsel-order-card-subtitle {
                font-size: 12px;
                color: #a8a8a8;
                max-width: 360px;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .ggsel-order-card-badge {
                display: inline-flex;
                align-items: center;
                gap: 4px;
                padding: 2px 8px;
                border-radius: 999px;
                border: 1px solid rgba(138, 180, 255, 0.4);
                background: rgba(138, 180, 255, 0.16);
                color: #8ab4ff;
                font-size: 11px;
                font-weight: 600;
                letter-spacing: 0.35px;
                text-transform: uppercase;
                max-width: 100%;
            }
            .ggsel-order-card-id {
                font-size: 13px;
                font-weight: 700;
                color: #bfcfff;
                white-space: nowrap;
            }
            .ggsel-order-card-content {
                display: flex;
                flex-direction: column;
                gap: 8px;
                padding: 0 18px 16px 18px;
            }
            .ggsel-order-card-info {
                display: flex;
                align-items: flex-start;
                justify-content: space-between;
                gap: 12px;
                width: 100%;
            }
            .ggsel-order-card-footer {
                display: flex;
                align-items: center;
                justify-content: flex-end;
                flex-shrink: 0;
                min-width: max-content;
            }
            .ggsel-order-card-created {
                font-size: 12px;
                color: #a3abc8;
                letter-spacing: 0.25px;
            }
            .ggsel-order-chip-row {
                display: flex;
                flex-wrap: wrap;
                gap: 6px;
                align-items: center;
            }
            .ggsel-order-chip {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                padding: 6px 10px;
                border-radius: 12px;
                border: 1px solid #2a2a2a;
                background: #181818;
                color: #eaeaea;
                text-decoration: none;
                font-size: 12.5px;
                transition: border-color 0.2s ease, color 0.2s ease;
                max-width: 100%;
            }
            .ggsel-order-chip:hover,
            .ggsel-order-chip:focus-visible {
                border-color: #8ab4ff;
                color: #8ab4ff;
                outline: none;
            }
            .ggsel-order-chip-label {
                font-size: 11px;
                letter-spacing: 0.35px;
                text-transform: uppercase;
                color: #8d96b8;
                white-space: nowrap;
            }
            .ggsel-order-chip-value {
                font-size: 13px;
                font-weight: 600;
                color: #f3f5ff;
                white-space: nowrap;
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
            .ggsel-user-detail-grid {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
                gap: 12px;
            }
            .ggsel-user-detail-item {
                display: flex;
                flex-direction: column;
                gap: 6px;
                padding: 12px 14px;
                border-radius: 12px;
                border: 1px solid #2f2f2f;
                background: #181818;
                color: #f3f5ff;
            }
            .ggsel-user-detail-item__label {
                font-size: 11px;
                letter-spacing: 0.35px;
                text-transform: uppercase;
                color: #8f9bbd;
            }
            .ggsel-user-detail-item__value {
                font-size: 13px;
                line-height: 1.45;
                word-break: break-word;
            }
            .ggsel-user-detail-item__value a {
                color: #9fc0ff;
            }
            .ggsel-user-detail-empty {
                color: #7f7f7f;
                font-style: italic;
                font-size: 12px;
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

    const parseUserSearchInput = (rawInput) => {
        let params = getDefaultParams(MODE_USERS);
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
            const mapped = USER_FIELD_ALIASES[key];
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
            const idParams = { ...USER_DEFAULT_PARAMS, 'search[id]': digitsCandidate };
            const ggselParams = { ...USER_DEFAULT_PARAMS, 'search[ggsel_id_seller]': digitsCandidate };
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

    const parseOrderSearchInput = (rawInput) => {
        let params = getDefaultParams(MODE_ORDERS);
        const summary = [];
        const input = (rawInput || '').trim();
        let singleQueryHighlight = null;
        if (!input) {
            return {
                params,
                summary: 'Фильтры не применены',
                plan: {
                    type: 'single',
                    queries: [{ key: 'default', params, highlight: singleQueryHighlight }]
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
            const mapped = ORDER_FIELD_ALIASES[key];
            if (mapped) {
                params[mapped] = value;
                summary.push(`${key}: ${value || '—'}`);
                if (!singleQueryHighlight && mapped === 'search[email]') {
                    singleQueryHighlight = 'order-email';
                }
                if (!singleQueryHighlight && mapped === 'search[uuid]') {
                    singleQueryHighlight = 'order-uuid';
                }
            }
        });

        let remainder = input;
        tokens.forEach(({ raw }) => {
            remainder = remainder.replace(raw, ' ');
        });

        const looksLikeEmail = (value) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/i.test(value);
        const looksLikeDigits = (value) => /^\d+$/.test(value);
        const looksLikeUuid = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

        const freeParts = remainder
            .split(/\s+/)
            .map(part => part.replace(/^['"]|['"]$/g, ''))
            .filter(part => part.length);

        let emailCandidate = '';
        let uuidCandidate = '';
        let digitsCandidate = '';
        const residualParts = [];

        for (const part of freeParts) {
            const cleaned = part.replace(/[.,;]+$/g, '');
            if (!params['search[email]'] && looksLikeEmail(cleaned)) {
                if (!emailCandidate) {
                    emailCandidate = cleaned;
                }
            } else if (!params['search[uuid]'] && looksLikeUuid(cleaned)) {
                if (!uuidCandidate) {
                    uuidCandidate = cleaned;
                }
            } else if (!digitsCandidate && looksLikeDigits(cleaned)) {
                digitsCandidate = cleaned;
            } else {
                residualParts.push(part);
            }
        }

        if (emailCandidate) {
            params['search[email]'] = emailCandidate;
            summary.push(`email: ${emailCandidate}`);
            singleQueryHighlight = 'order-email';
        }

        if (!emailCandidate && uuidCandidate) {
            params['search[uuid]'] = uuidCandidate;
            summary.push(`uuid: ${uuidCandidate}`);
            return {
                params,
                summary: summary.length ? summary.join(' · ') : `Поиск: ${input}`,
                plan: {
                    type: 'single',
                    queries: [{ key: 'uuid', params: { ...ORDER_DEFAULT_PARAMS, 'search[uuid]': uuidCandidate }, highlight: 'order-uuid' }]
                }
            };
        }

        if (!emailCandidate && !uuidCandidate && params['search[uuid]']) {
            singleQueryHighlight = 'order-uuid';
        }

        if (!tokens.length && !emailCandidate && !uuidCandidate && digitsCandidate) {
            const orderParams = { ...ORDER_DEFAULT_PARAMS, 'search[id]': digitsCandidate };
            const sellerParams = { ...ORDER_DEFAULT_PARAMS, 'search[seller_id]': digitsCandidate };
            const userParams = { ...ORDER_DEFAULT_PARAMS, 'search[user_id]': digitsCandidate };
            params = orderParams;
            summary.push(`id: ${digitsCandidate}`);
            const queries = [
                { key: 'order-id', params: orderParams, highlight: 'order-id', label: `ID заказа: ${digitsCandidate}` },
                { key: 'seller-id', params: sellerParams, highlight: 'seller-id', label: `ID продавца: ${digitsCandidate}` },
                { key: 'user-id', params: userParams, highlight: 'user-id', label: `ID пользователя: ${digitsCandidate}` }
            ];
            return {
                params,
                summary: summary.length ? summary.join(' · ') : `Поиск: ${input}`,
                plan: {
                    type: 'multi',
                    queries
                }
            };
        }

        if (residualParts.length && !params['search[username]'] && !params['search[seller_name]']) {
            const freeText = residualParts.join(' ');
            const usernameParams = { ...ORDER_DEFAULT_PARAMS, 'search[username]': freeText };
            const sellerParams = { ...ORDER_DEFAULT_PARAMS, 'search[seller_name]': freeText };
            params = usernameParams;
            summary.push(`username: ${freeText}`);
            return {
                params,
                summary: summary.length ? summary.join(' · ') : `Поиск: ${input}`,
                plan: {
                    type: 'multi',
                    queries: [
                        { key: 'username', params: usernameParams, highlight: 'order-username', label: `Покупатель: ${freeText}` },
                        { key: 'seller', params: sellerParams, highlight: 'order-seller', label: `Продавец: ${freeText}` }
                    ]
                }
            };
        }

        return {
            params,
            summary: summary.length ? summary.join(' · ') : `Поиск: ${input}`,
            plan: {
                type: 'single',
                queries: [{ key: 'default', params, highlight: singleQueryHighlight }]
            }
        };
    };

    const parseSearchInput = (rawInput, mode = state.mode || MODE_USERS) => (
        mode === MODE_ORDERS ? parseOrderSearchInput(rawInput) : parseUserSearchInput(rawInput)
    );

    const parseResultsFromDocument = (doc, mode = state.mode || MODE_USERS) => (
        mode === MODE_ORDERS ? parseOrdersFromDocument(doc) : parseUsersFromDocument(doc)
    );

    const ensureMatchTags = (item) => {
        if (item.matchTags instanceof Set) {
            return item.matchTags;
        }
        if (Array.isArray(item.matchTags)) {
            const set = new Set(item.matchTags);
            item.matchTags = set;
            return set;
        }
        const set = new Set();
        if (item.matchType) {
            set.add(item.matchType);
        }
        item.matchTags = set;
        return set;
    };

    const addMatchTagToItem = (item, tag) => {
        if (!tag) return;
        const tags = ensureMatchTags(item);
        tags.add(tag);
        item.matchTags = tags;
    };

    const mergeMatchTags = (target, source) => {
        if (!target || !source) return;
        const targetTags = ensureMatchTags(target);
        const sourceTags = ensureMatchTags(source);
        sourceTags.forEach((tag) => targetTags.add(tag));
        target.matchTags = targetTags;
    };

    const normalizeMatchMetadata = (item, mode = MODE_USERS) => {
        const tags = ensureMatchTags(item);
        if (mode === MODE_USERS) {
            const hasId = tags.has('id');
            const hasGgsel = tags.has('ggsel');
            if (hasId && hasGgsel) {
                item.matchType = 'both';
            } else if (hasId) {
                item.matchType = 'id';
            } else if (hasGgsel) {
                item.matchType = 'ggsel';
            } else {
                item.matchType = null;
            }
        }
        return item;
    };

    const renderResultCard = (item, mode = state.mode || MODE_USERS) => (
        mode === MODE_ORDERS ? renderOrderCard(item) : renderUserCard(item)
    );

    const updateModeButton = () => {
        if (!state.modeButton) return;
        const mode = state.mode || MODE_USERS;
        const label = mode === MODE_ORDERS ? 'Заказы' : 'Пользователи';
        const icon = mode === MODE_ORDERS ? ORDERS_MODE_ICON : USERS_MODE_ICON;
        if (state.modeButton.dataset.mode !== mode) {
            state.modeButton.classList.add('toggling');
            setTimeout(() => {
                state.modeButton?.classList.remove('toggling');
            }, 260);
        }
        state.modeButton.innerHTML = icon;
        state.modeButton.setAttribute('aria-label', `Режим поиска: ${label}`);
        state.modeButton.setAttribute('aria-pressed', mode === MODE_ORDERS ? 'true' : 'false');
        state.modeButton.title = `Переключить режим поиска (${label})`;
        state.modeButton.dataset.mode = mode;
        state.modeButton.classList.toggle('mode-orders', mode === MODE_ORDERS);
        state.modeButton.classList.toggle('mode-users', mode !== MODE_ORDERS);
    };

    const setMode = (mode, { focusInput = false, force = false } = {}) => {
        const previousMode = state.mode || MODE_USERS;
        const normalized = mode === MODE_ORDERS ? MODE_ORDERS : MODE_USERS;
        const currentValue = state.input ? state.input.value || '' : (state.query || '');
        if (!force && normalized === previousMode) {
            updateModeButton();
            const config = getModeConfig(normalized);
            if (state.button) {
                state.button.title = config.buttonTitle;
            }
            if (state.input) {
                state.input.placeholder = config.placeholder;
            }
            return;
        }

        state.mode = normalized;
        try {
            localStorage.setItem(STORAGE_MODE_KEY, normalized);
        } catch (error) {
            console.warn('[GGSEL User Explorer] Не удалось сохранить режим', error);
        }

        hideHistoryPopover();

        const config = getModeConfig(normalized);
        if (state.button) {
            state.button.title = config.buttonTitle;
        }
        if (state.input) {
            state.input.placeholder = config.placeholder;
        }

        updateModeButton();

        const savedQuery = typeof currentValue === 'string' ? currentValue : '';
        state.query = savedQuery.trim();
        if (state.input) {
            state.input.value = savedQuery;
        }
        try {
            localStorage.setItem(getQueryStorageKey(), savedQuery || '');
        } catch (error) {
            console.warn('[GGSEL User Explorer] Не удалось сохранить общий запрос', error);
        }

        const { params, plan } = parseSearchInput(state.query, normalized);
        state.params = params;
        state.searchPlan = plan;
        state.page = 1;
        state.hasMore = false;
        state.results = [];
        if (state.resultsContainer) {
            state.resultsContainer.innerHTML = '';
        }
        updateSearchControlValueState();
        updateResultsVisibility();

        if (state.query) {
            performSearch({ append: false });
        } else {
            if (state.loadMoreButton) {
                state.loadMoreButton.hidden = true;
                state.loadMoreButton.disabled = true;
            }
        }

        if (focusInput) {
            focusSearchInput();
        }
    };

    const toggleMode = () => {
        const nextMode = state.mode === MODE_ORDERS ? MODE_USERS : MODE_ORDERS;
        setMode(nextMode, { focusInput: true });
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

    const parseUsersFromDocument = (doc) => {
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
            const balanceRaw = collapseSpaces(cells[4] ? cells[4].textContent : '');
            const withdrawalsRaw = collapseSpaces(cells[5] ? cells[5].textContent : '');
            const ggselId = collapseSpaces(cells[6] ? cells[6].textContent : '');
            const localeRaw = collapseSpaces(cells[7] ? cells[7].textContent : '');

            const balance = formatBalanceValue(balanceRaw);
            const withdrawalsDisplay = formatBooleanValue(withdrawalsRaw) || withdrawalsRaw;
            const localeDisplay = formatLocaleValue(localeRaw);
            const isSeller = /продав/i.test(status.toLowerCase()) || /seller/i.test(status.toLowerCase());

            items.push({
                id,
                profileUrl,
                username,
                email,
                status,
                isSeller,
                balance,
                balanceRaw,
                withdrawals: withdrawalsDisplay,
                withdrawalsRaw,
                ggselId,
                locale: localeRaw,
                localeDisplay
            });
        }
        return items;
    };

    const parseOrdersFromDocument = (doc) => {
        const rows = Array.from(doc.querySelectorAll('table tbody tr'));
        const items = [];
        for (const row of rows) {
            const cells = Array.from(row.children);
            if (!cells.length) continue;
            if (cells[0].tagName === 'TH') continue;
            const idLink = cells[0]?.querySelector('a');
            if (!idLink) continue;
            const id = collapseSpaces(idLink.textContent);
            const orderUrl = new URL(idLink.getAttribute('href') || '#', BASE_URL).href;

            const paymentSystem = collapseSpaces(cells[1]?.textContent || '');

            const userCell = cells[2];
            const userLink = userCell?.querySelector('a');
            const userId = userLink ? collapseSpaces(userLink.textContent) : collapseSpaces(userCell?.textContent || '');
            const userUrl = userLink ? new URL(userLink.getAttribute('href') || '#', BASE_URL).href : '';

            const amount = collapseSpaces(cells[3]?.textContent || '');
            const offerCell = cells[4];
            const offerLink = offerCell?.querySelector('a');
            const offerLabel = collapseSpaces(offerCell?.textContent || '');
            const offerUrl = offerLink ? new URL(offerLink.getAttribute('href') || '#', BASE_URL).href : '';

            const count = collapseSpaces(cells[5]?.textContent || '');
            const status = collapseSpaces(cells[6]?.textContent || '');
            const createdAt = collapseSpaces(cells[7]?.textContent || '');

            items.push({
                id,
                orderUrl,
                paymentSystem,
                userId,
                userUrl,
                amount,
                offerLabel,
                offerUrl,
                count,
                status,
                createdAt
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
        const headerTitle = collapseSpaces(box.querySelector('.box-header .box-title')?.textContent || '');
        const dl = box.querySelector('.box-body dl.dl-horizontal');
        const entries = [];
        let userIdFromDetails = '';
        if (dl) {
            for (let node = dl.firstElementChild; node; node = node.nextElementSibling) {
                if (node.tagName === 'DT') {
                    const label = collapseSpaces(node.textContent);
                    let valueNode = node.nextElementSibling;
                    while (valueNode && valueNode.tagName !== 'DD') {
                        valueNode = valueNode.nextElementSibling;
                    }
                    const valueHtml = valueNode ? valueNode.innerHTML.trim() : '';
                    const valueText = collapseSpaces(valueNode ? valueNode.textContent : '');
                    if (!userIdFromDetails && label.toLowerCase() === 'id' && valueText) {
                        userIdFromDetails = valueText;
                    }
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
        return { title: headerTitle, entries, actions, userId: userIdFromDetails };
    };

    function renderUserDetails(container, details) {
        container.innerHTML = '';
        const entries = (details?.entries || []).filter(({ label, valueHtml }) => {
            if (DETAIL_HIDDEN_LABELS.has(label)) {
                return false;
            }
            return hasMeaningfulHtmlValue(valueHtml);
        });

        if (entries.length) {
            const grid = document.createElement('div');
            grid.className = 'ggsel-user-detail-grid';
            entries.forEach(({ label, valueHtml }) => {
                const item = document.createElement('div');
                item.className = 'ggsel-user-detail-item';

                const labelEl = document.createElement('div');
                labelEl.className = 'ggsel-user-detail-item__label';
                labelEl.textContent = label || '';

                const valueEl = document.createElement('div');
                valueEl.className = 'ggsel-user-detail-item__value';
                valueEl.innerHTML = valueHtml || '';

                const plainText = valueEl.textContent.trim().toLowerCase();
                if (['true', 'false', 'yes', 'no', 'да', 'нет', '1', '0'].includes(plainText)) {
                    valueEl.textContent = formatBooleanValue(plainText);
                }

                if (!valueHtml) {
                    valueEl.textContent = '—';
                    valueEl.classList.add('ggsel-user-detail-empty');
                }

                item.appendChild(labelEl);
                item.appendChild(valueEl);
                grid.appendChild(item);
            });
            container.appendChild(grid);
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
        const workerCount = Math.min(DETAIL_PREFETCH_CONCURRENCY, queue.length);

        const runWorker = async () => {
            while (true) {
                const currentIndex = index;
                index += 1;
                if (currentIndex >= queue.length) {
                    break;
                }
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
        };

        const workers = Array.from({ length: workerCount }, () => runWorker());
        await Promise.all(workers);
    };

    const renderUserCard = (user) => {
        const card = document.createElement('div');
        card.className = 'ggsel-user-card';
        card.dataset.userId = user.id;
        card.__userData = user;
        const matchTags = ensureMatchTags(user);
        const userFieldSettings = normalizeUserFieldSettings(state.settings.userFields);

        const header = document.createElement('div');
        header.className = 'ggsel-user-card-header';

        const meta = document.createElement('div');
        meta.className = 'ggsel-user-card-meta';

        const name = document.createElement('div');
        name.className = 'ggsel-user-card-name';
        name.textContent = user.username || '(без имени)';

        const titleRow = document.createElement('div');
        titleRow.className = 'ggsel-user-card-title-row';

        const titleGroup = document.createElement('div');
        titleGroup.className = 'ggsel-user-card-title-group';
        titleGroup.appendChild(name);

        const hasIdMatch = matchTags.has('id');
        const hasGgselMatch = matchTags.has('ggsel');
        if (hasIdMatch || hasGgselMatch) {
            const badge = document.createElement('span');
            badge.className = 'ggsel-user-card-badge';
            if (hasIdMatch && hasGgselMatch) {
                badge.classList.add('ggsel-user-card-badge--both');
                badge.textContent = 'ID и GGSEL ID';
            } else if (hasIdMatch) {
                badge.classList.add('ggsel-user-card-badge--id');
                badge.textContent = 'Совпадение ID';
            } else {
                badge.classList.add('ggsel-user-card-badge--ggsel');
                badge.textContent = 'Совпадение GGSEL ID';
            }
            titleGroup.appendChild(badge);
        }

        const idTag = document.createElement('span');
        idTag.className = 'ggsel-user-card-id';
        idTag.textContent = `#${user.id}`;

        titleRow.appendChild(titleGroup);

        const chips = document.createElement('div');
        chips.className = 'ggsel-user-card-line';
        let hasChips = false;

        const appendFields = (fields) => {
            fields.forEach(({ key, label, value }) => {
                if (key && Object.prototype.hasOwnProperty.call(userFieldSettings, key)) {
                    if (!userFieldSettings[key]) {
                        return;
                    }
                }
                const raw = value;
                const normalized = raw === null || raw === undefined ? '' : collapseSpaces(String(raw));
                if (!normalized) {
                    return;
                }
                const field = document.createElement('span');
                field.className = 'ggsel-user-card-field';
                const labelEl = document.createElement('span');
                labelEl.className = 'ggsel-user-card-field-label';
                labelEl.textContent = label;
                const valueEl = document.createElement('span');
                valueEl.className = 'ggsel-user-card-field-value';
                valueEl.textContent = normalized;
                field.title = `${label}: ${normalized}`;
                field.appendChild(labelEl);
                field.appendChild(valueEl);
                chips.appendChild(field);
                hasChips = true;
            });
        };

        appendFields([
            { key: 'email', label: 'Почта', value: user.email },
            { key: 'balance', label: 'Баланс', value: user.balance }
        ]);
        appendFields([
            { key: 'ggselId', label: 'GGSEL ID', value: user.ggselId },
            { key: 'withdrawals', label: 'Вывод', value: user.withdrawals }
        ]);

        meta.appendChild(titleRow);
        const infoRow = document.createElement('div');
        infoRow.className = 'ggsel-user-card-info';
        infoRow.appendChild(chips);

        header.appendChild(meta);

        const idMeta = document.createElement('div');
        idMeta.className = 'ggsel-user-card-id-meta';
        idMeta.appendChild(idTag);
        titleRow.appendChild(idMeta);

        const body = document.createElement('div');
        body.className = 'ggsel-user-card-body';

        card.appendChild(header);
        card.appendChild(body);

        const footer = document.createElement('div');
        footer.className = 'ggsel-user-card-footer';
        if (user.localeDisplay) {
            const localeTag = document.createElement('div');
            localeTag.className = 'ggsel-user-card-locale';
            localeTag.textContent = user.localeDisplay;
            footer.appendChild(localeTag);
        }
        if (footer.childElementCount) {
            infoRow.appendChild(footer);
        }
        if (hasChips || footer.childElementCount) {
            meta.appendChild(infoRow);
        }

        if (user.isSeller || matchTags.has('seller')) {
            card.classList.add('seller-card');
        }

        if (hasIdMatch && !hasGgselMatch) {
            card.classList.add('match-id');
        } else if (hasGgselMatch && !hasIdMatch) {
            card.classList.add('match-ggsel');
        } else if (hasIdMatch && hasGgselMatch) {
            card.classList.add('match-both', 'match-id', 'match-ggsel');
        }

        const toggleCard = async () => {
            const isOpen = card.classList.contains('open');
            if (isOpen) {
                card.classList.remove('open');
                requestAnimationFrame(() => updateAnchorOrientation());
                return;
            }
            card.classList.add('open');
            requestAnimationFrame(() => updateAnchorOrientation());
            const cached = state.detailCache.get(user.id);
            if (cached && cached.status === 'ready') {
                renderUserDetails(body, cached.data);
                requestAnimationFrame(() => updateAnchorOrientation());
                return;
            }
            body.innerHTML = '';
            body.appendChild(createLoader('Получаем детали...'));
            try {
                const details = await ensureUserDetails(user);
                if (card.classList.contains('open')) {
                    renderUserDetails(body, details);
                    requestAnimationFrame(() => updateAnchorOrientation());
                }
            } catch (error) {
                body.innerHTML = '';
                const errorEl = document.createElement('div');
                errorEl.className = 'ggsel-user-error';
                errorEl.textContent = `Не удалось загрузить карточку пользователя: ${error.message}`;
                body.appendChild(errorEl);
                requestAnimationFrame(() => updateAnchorOrientation());
            }
        };

        card.toggleCard = toggleCard;

        header.addEventListener('click', toggleCard);
        card.addEventListener('contextmenu', (event) => {
            openUserContextMenu(event, user, card);
        });

        return card;
    };

    const renderOrderCard = (order) => {
        const card = document.createElement('div');
        card.className = 'ggsel-user-card ggsel-order-card';
        card.dataset.orderId = order.id;
        card.__orderData = order;
        const matchTags = ensureMatchTags(order);
        const orderFieldSettings = normalizeOrderFieldSettings(state.settings.orderFields);

        const header = document.createElement('div');
        header.className = 'ggsel-order-card-header';

        const titleGroup = document.createElement('div');
        titleGroup.className = 'ggsel-order-card-title-group';

        const title = document.createElement('div');
        title.className = 'ggsel-order-card-title';
        title.textContent = collapseSpaces(order.offerLabel) || 'Заказ';
        titleGroup.appendChild(title);

        const badgePriority = [
            ['order-id', 'Совпадение ID заказа'],
            ['order-uuid', 'Совпадение UUID заказа'],
            ['order-email', 'Совпадение email'],
            ['seller-id', 'Совпадение ID продавца'],
            ['order-seller', 'Совпадение продавца'],
            ['user-id', 'Совпадение ID пользователя'],
            ['order-username', 'Совпадение покупателя']
        ];
        const badgeEntry = badgePriority.find(([tag]) => matchTags.has(tag));
        if (badgeEntry) {
            const badge = document.createElement('span');
            badge.className = 'ggsel-order-card-badge';
            badge.textContent = badgeEntry[1];
            titleGroup.appendChild(badge);
        }

        const idWrap = document.createElement('div');
        idWrap.className = 'ggsel-order-card-id';
        idWrap.textContent = `#${order.id}`;

        header.appendChild(titleGroup);
        header.appendChild(idWrap);

        const content = document.createElement('div');
        content.className = 'ggsel-order-card-content';

        const chipRow = document.createElement('div');
        chipRow.className = 'ggsel-order-chip-row';
        let hasChips = false;

        const appendChipGroup = (fields) => {
            fields.forEach(({ key, label, value, url }) => {
                if (key && Object.prototype.hasOwnProperty.call(orderFieldSettings, key)) {
                    if (!orderFieldSettings[key]) {
                        return;
                    }
                }
                const normalized = collapseSpaces(value || '');
                if (!normalized) {
                    return;
                }
                const chip = document.createElement(url ? 'a' : 'span');
                chip.className = 'ggsel-order-chip';
                if (url) {
                    chip.href = url;
                    chip.target = '_blank';
                    chip.rel = 'noopener';
                    chip.addEventListener('click', (event) => {
                        event.stopPropagation();
                    });
                }
                if (label) {
                    const labelEl = document.createElement('span');
                    labelEl.className = 'ggsel-order-chip-label';
                    labelEl.textContent = label;
                    const valueEl = document.createElement('span');
                    valueEl.className = 'ggsel-order-chip-value';
                    valueEl.textContent = normalized;
                    chip.appendChild(labelEl);
                    chip.appendChild(valueEl);
                } else {
                    chip.textContent = normalized;
                }
                chipRow.appendChild(chip);
                hasChips = true;
            });
        };

        appendChipGroup([
            { key: 'status', label: 'Статус', value: order.status },
            { key: 'amount', label: 'Сумма', value: order.amount },
            { key: 'count', label: 'Кол-во', value: order.count }
        ]);
        appendChipGroup([
            { key: 'buyer', label: 'Покупатель', value: order.userId, url: order.userUrl },
            { key: 'payment', label: 'Платёж', value: order.paymentSystem }
        ]);
        appendChipGroup([
            { key: 'product', label: 'Товар', value: order.offerLabel, url: order.offerUrl }
        ]);

        const infoRow = document.createElement('div');
        infoRow.className = 'ggsel-order-card-info';
        infoRow.appendChild(chipRow);

        let footer = null;
        if (orderFieldSettings.created) {
            const createdText = collapseSpaces(order.createdAt || '');
            if (createdText) {
                footer = document.createElement('div');
                footer.className = 'ggsel-order-card-footer';
                const createdEl = document.createElement('div');
                createdEl.className = 'ggsel-order-card-created';
                createdEl.textContent = createdText;
                footer.appendChild(createdEl);
                infoRow.appendChild(footer);
            }
        }

        if (hasChips || (footer && footer.childElementCount)) {
            content.appendChild(infoRow);
        }

        const openOrder = () => {
            if (order.orderUrl) {
                window.location.href = order.orderUrl;
            }
        };

        card.addEventListener('click', (event) => {
            if (event.defaultPrevented || event.button !== 0) return;
            openOrder();
        });

        card.tabIndex = 0;
        card.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                openOrder();
            }
        });

        card.addEventListener('contextmenu', (event) => {
            openOrderContextMenu(event, order, card);
        });

        card.appendChild(header);
        card.appendChild(content);

        if (matchTags.has('seller-id') || matchTags.has('order-seller')) {
            card.classList.add('seller-card', 'order-match-seller');
        }
        if (matchTags.has('order-id')) {
            card.classList.add('order-match-id');
        }
        if (matchTags.has('order-uuid')) {
            card.classList.add('order-match-uuid');
        }
        if (matchTags.has('order-email')) {
            card.classList.add('order-match-email');
        }
        if (matchTags.has('user-id') || matchTags.has('order-username')) {
            card.classList.add('order-match-user');
        }

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
            const mode = state.contextMenu.mode;
            const card = state.contextMenu.card;
            if (mode === 'user') {
                const userId = state.contextMenu.userId;
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
            } else if (mode === 'order') {
                const orderData = card ? card.__orderData : null;
                if (!position || !orderData) {
                    closeContextMenu();
                    return;
                }
                renderContextMenu({
                    mode: 'order',
                    order: orderData,
                    position,
                    card,
                    keepOpen: true
                });
            } else {
                closeContextMenu();
            }
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
        state.contextMenu.orderId = null;
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

    function buildContextMenuItems({ mode = 'user', user, order, payload, card }) {
        const items = [];
        if (mode === 'panel') {
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
        } else if (mode === 'input') {
            const hasValue = Boolean(state.input && state.input.value);
            items.push({
                type: 'action',
                label: 'Копировать значение',
                handler: () => {
                    if (!state.input) return;
                    const value = state.input.value || '';
                    if (!value) return;
                    copyToClipboard(value);
                }
            });
            items.push({
                type: 'action',
                label: 'Вставить',
                handler: async () => {
                    if (!state.input) return;
                    if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
                        try {
                            const text = await navigator.clipboard.readText();
                            if (typeof text === 'string') {
                                const { selectionStart, selectionEnd, value } = state.input;
                                const start = typeof selectionStart === 'number' ? selectionStart : value.length;
                                const end = typeof selectionEnd === 'number' ? selectionEnd : start;
                                const nextValue = value.slice(0, start) + text + value.slice(end);
                                state.input.value = nextValue;
                                const inputEvent = new Event('input', { bubbles: true });
                                state.input.dispatchEvent(inputEvent);
                            }
                        } catch (error) {
                            console.warn('[GGSEL User Explorer] Не удалось вставить из буфера обмена', error);
                        }
                    }
                }
            });
            if (hasValue) {
                items.push({ type: 'separator' });
                items.push({
                    type: 'action',
                    label: 'Очистить поле ввода',
                    handler: () => {
                        if (!state.input) return;
                        state.input.value = '';
                        onQueryChange('');
                        onQueryChange.flush?.();
                    }
                });
            }
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
        } else if (mode === 'order' && order) {
            if (order.orderUrl) {
                items.push({
                    type: 'action',
                    label: 'Перейти к заказу',
                    handler: () => {
                        window.location.href = order.orderUrl;
                    }
                });
                items.push({
                    type: 'action',
                    label: 'Открыть заказ в новой вкладке',
                    handler: () => {
                        window.open(order.orderUrl, '_blank');
                    }
                });
            }

            items.push({ type: 'separator' });

            if (order.id) {
                items.push({
                    type: 'action',
                    label: 'Скопировать ID заказа',
                    handler: () => copyToClipboard(order.id)
                });
            }

            if (order.userId) {
                items.push({
                    type: 'action',
                    label: 'Скопировать ID пользователя',
                    handler: () => copyToClipboard(order.userId)
                });
            }

            if (order.userUrl) {
                items.push({
                    type: 'action',
                    label: 'Открыть пользователя в новой вкладке',
                    handler: () => {
                        window.open(order.userUrl, '_blank');
                    }
                });
            }

            if (order.offerUrl) {
                items.push({
                    type: 'action',
                    label: 'Открыть товар в новой вкладке',
                    handler: () => {
                        window.open(order.offerUrl, '_blank');
                    }
                });
            }

            if (order.orderUrl) {
                items.push({
                    type: 'action',
                    label: 'Скопировать ссылку на заказ',
                    handler: () => copyToClipboard(order.orderUrl)
                });
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

    function renderContextMenu({ mode = 'user', user, order, payload, position, card, keepOpen = false }) {
        const menu = ensureContextMenuElement();
        menu.innerHTML = '';

        const items = buildContextMenuItems({ mode, user, order, payload, card });
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
        state.contextMenu.orderId = mode === 'order' && order ? order.id : null;
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

    function openUserContextMenu(event, user, card) {
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

    function openOrderContextMenu(event, order, card) {
        event.preventDefault();
        event.stopPropagation();
        renderContextMenu({
            mode: 'order',
            order,
            position: { x: event.clientX, y: event.clientY },
            card
        });
    }

    function openInputContextMenu(event) {
        if (!state.input || event.target !== state.input) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        renderContextMenu({
            mode: 'input',
            position: { x: event.clientX, y: event.clientY },
            card: null,
            payload: null
        });
    }

    function openPanelContextMenu(event) {
        const card = event.target instanceof Element ? event.target.closest('.ggsel-user-card') : null;
        if (card && card.__userData) {
            openUserContextMenu(event, card.__userData, card);
            return;
        }
        if (card && card.__orderData) {
            openOrderContextMenu(event, card.__orderData, card);
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
            updateResultsVisibility();
            return;
        }
        const fragment = document.createDocumentFragment();
        items.forEach((item) => {
            const card = renderResultCard(item);
            fragment.appendChild(card);
        });
        state.resultsContainer.appendChild(fragment);
        updateResultsVisibility();
    };

    const rerenderCurrentResults = () => {
        if (state.loading || !state.resultsContainer) {
            return;
        }
        const items = Array.isArray(state.results) ? state.results : [];
        const previousScroll = state.resultsContainer.scrollTop;
        updateResults(items, false);
        requestAnimationFrame(() => {
            if (state.resultsContainer) {
                state.resultsContainer.scrollTop = previousScroll;
            }
        });
    };

    const updateResultsVisibility = () => {
        if (!state.resultsWrapper) return;
        const hasContent = Boolean(state.resultsContainer && state.resultsContainer.childElementCount > 0);
        const hasLoadMore = Boolean(state.loadMoreButton && !state.loadMoreButton.hidden);
        const showWrapper = hasContent || hasLoadMore;
        state.resultsWrapper.hidden = !showWrapper;
        if (state.anchor) {
            const shouldFlatten = !showWrapper && !state.loading;
            state.anchor.classList.toggle('no-results', shouldFlatten);
        }
        requestAnimationFrame(() => updateAnchorOrientation());
    };

    const buildUrlWithParams = (params, page, mode = state.mode || MODE_USERS) => {
        const baseUrl = mode === MODE_ORDERS ? ORDERS_URL : USERS_URL;
        const url = new URL(baseUrl);
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
        const mode = state.mode || MODE_USERS;
        if (!state.query) {
            state.resultsContainer.innerHTML = '';
            state.loadMoreButton.hidden = true;
            state.loadMoreButton.disabled = true;
            state.hasMore = false;
            state.loading = false;
            updateResultsVisibility();
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
        const loaderMessage = mode === MODE_ORDERS ? 'Ищем заказы…' : 'Ищем пользователей…';
        const loader = createLoader(loaderMessage);
        if (!append || plan.type !== 'single') {
            state.resultsContainer.innerHTML = '';
            state.resultsContainer.appendChild(loader);
            updateResultsVisibility();
        } else {
            state.loadMoreButton.disabled = true;
            state.loadMoreButton.textContent = 'Загружаем...';
        }

        const resetLoadMore = () => {
            state.loadMoreButton.hidden = !state.hasMore;
            state.loadMoreButton.disabled = !state.hasMore;
            state.loadMoreButton.textContent = LOAD_MORE_LABEL;
            updateResultsVisibility();
        };

        try {
            if (plan.type === 'single') {
                const queryDef = plan.queries[0];
                const page = append ? state.page + 1 : 1;
                const url = buildUrlWithParams(queryDef.params, page, mode);
                const doc = await fetchDocument(url);
                if (token !== state.lastToken) {
                    return;
                }
                const rawItems = parseResultsFromDocument(doc, mode);
                const items = rawItems.map((raw) => {
                    const item = { ...raw };
                    addMatchTagToItem(item, queryDef.highlight || null);
                    normalizeMatchMetadata(item, mode);
                    return item;
                });
                state.page = page;
                state.hasMore = hasNextPage(doc);
                state.results = append ? state.results.concat(items) : items;
                if (!append) {
                    rememberQuery(state.query);
                }
                if (!append) {
                    updateResults(state.results, false);
                } else {
                    updateResults(items, true);
                }
                if (mode === MODE_USERS) {
                    await prefetchUserDetails(append ? items : state.results);
                }
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

            state.page = 1;
            state.hasMore = false;
            const aggregated = [];
            const seen = new Map();
            const errors = [];

            for (const queryDef of plan.queries) {
                try {
                    const url = buildUrlWithParams(queryDef.params, 1, mode);
                    const doc = await fetchDocument(url);
                    if (token !== state.lastToken) {
                        return;
                    }
                    const rawItems = parseResultsFromDocument(doc, mode);
                    rawItems.forEach((raw) => {
                        const item = { ...raw };
                        addMatchTagToItem(item, queryDef.highlight || null);
                        normalizeMatchMetadata(item, mode);
                        const key = item.id || item.orderUrl || `${queryDef.key}:${aggregated.length}`;
                        const existing = seen.get(key);
                        if (!existing) {
                            seen.set(key, item);
                            aggregated.push(item);
                        } else {
                            mergeMatchTags(existing, item);
                            normalizeMatchMetadata(existing, mode);
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
            rememberQuery(state.query);
            state.resultsContainer.innerHTML = '';

            if (aggregated.length) {
                updateResults(aggregated, false);
            } else if (!errors.length) {
                const placeholder = document.createElement('div');
                placeholder.className = 'ggsel-user-explorer-placeholder';
                placeholder.textContent = 'По вашему запросу ничего не найдено';
                state.resultsContainer.appendChild(placeholder);
                updateResultsVisibility();
            }

            if (errors.length) {
                const errorEl = document.createElement('div');
                errorEl.className = 'ggsel-user-error';
                errorEl.textContent = errors
                    .map(({ query, error }) => `Ошибка по запросу «${query.label || query.key}»: ${error.message}`)
                    .join(' ');
                state.resultsContainer.appendChild(errorEl);
                updateResultsVisibility();
            }

            state.loadMoreButton.hidden = true;
            state.loadMoreButton.disabled = true;

            if (mode === MODE_USERS && aggregated.length) {
                await prefetchUserDetails(aggregated);
            }
        } catch (error) {
            state.resultsContainer.innerHTML = '';
            const errorEl = document.createElement('div');
            errorEl.className = 'ggsel-user-error';
            errorEl.textContent = `${mode === MODE_ORDERS ? 'Ошибка при поиске заказов' : 'Ошибка при поиске пользователей'}: ${error.message}`;
            state.resultsContainer.appendChild(errorEl);
            state.loadMoreButton.hidden = true;
            state.loadMoreButton.disabled = true;
            updateResultsVisibility();
        } finally {
            if (plan.type === 'single' && !state.hasMore) {
                state.loadMoreButton.hidden = true;
                state.loadMoreButton.disabled = true;
            }
            state.loading = false;
            updateResultsVisibility();
        }
    };

    const onQueryChange = debounce((value) => {
        state.query = value.trim();
        const { params, plan } = parseSearchInput(state.query, state.mode);
        state.params = params;
        state.searchPlan = plan;
        localStorage.setItem(getQueryStorageKey(), state.query);
        state.page = 1;
        state.hasMore = false;
        state.detailCache.clear();
        updateSearchControlValueState();
        closeContextMenu();
        performSearch({ append: false });
    }, DEBOUNCE_MS);

    const restoreState = () => {
        try {
            const savedMode = localStorage.getItem(STORAGE_MODE_KEY);
            const normalizedMode = savedMode === MODE_ORDERS ? MODE_ORDERS : MODE_USERS;
            setMode(normalizedMode, { force: true });
            const openState = localStorage.getItem(PANEL_STATE_KEY);
            if (openState === '1') {
                openPanel();
            }
        } catch (error) {
            console.warn('[GGSEL User Explorer] Не удалось восстановить состояние', error);
        }
    };

    const openPanel = () => {
        if (!state.anchor || !state.panel || !state.button) return;
        state.open = true;
        state.anchor.classList.remove('collapsed');
        state.anchor.classList.add('expanded');
        state.button.setAttribute('aria-pressed', 'true');
        state.panel.setAttribute('aria-hidden', 'false');
        localStorage.setItem(PANEL_STATE_KEY, '1');
        requestAnimationFrame(() => {
            applyAnchorPosition();
            expandSearchControl();
            updateSearchControlValueState();
            if (!state.input) return;
            try {
                state.input.focus({ preventScroll: true });
            } catch (error) {
                state.input.focus();
            }
        });
    };

    const closePanel = () => {
        if (!state.anchor || !state.panel || !state.button) return;
        state.open = false;
        state.anchor.classList.add('collapsed');
        state.anchor.classList.remove('expanded');
        state.button.setAttribute('aria-pressed', 'false');
        state.panel.setAttribute('aria-hidden', 'true');
        localStorage.setItem(PANEL_STATE_KEY, '0');
        collapseSearchControl();
        updateSearchControlValueState();
        hideHistoryPopover();
        closeContextMenu();
        closeAllWindows();
        requestAnimationFrame(() => {
            applyAnchorPosition();
        });
    };

    const togglePanel = () => {
        if (state.open) {
            closePanel();
        } else {
            openPanel();
        }
    };

    const focusSearchInput = ({ selectAll = false } = {}) => {
        if (!state.input) return;
        const applyFocus = () => {
            if (!state.input) return;
            try {
                state.input.focus({ preventScroll: true });
            } catch (error) {
                state.input.focus();
            }
            if (selectAll) {
                try {
                    state.input.select();
                } catch (err) {
                    /* noop */
                }
            }
        };
        closeContextMenu();
        if (!state.open) {
            openPanel();
            requestAnimationFrame(() => {
                requestAnimationFrame(applyFocus);
            });
        } else {
            applyFocus();
        }
    };

    const handleGlobalShortcut = (event) => {
        if (!event) return;
        if (state.shortcutCapture?.active) {
            event.preventDefault();
            event.stopPropagation();
            if (event.code === 'Escape') {
                stopShortcutCapture();
                return;
            }
            if (isModifierCode(event.code)) {
                return;
            }
            const nextShortcut = normalizeShortcut({
                ctrl: event.ctrlKey,
                alt: event.altKey,
                shift: event.shiftKey,
                meta: event.metaKey,
                code: event.code
            });
            state.settings.shortcut = nextShortcut;
            saveSettings();
            stopShortcutCapture();
            return;
        }
        if (!isShortcutPressed(event, state.settings.shortcut)) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        focusSearchInput({ selectAll: true });
    };

    const init = () => {
        injectStyles();
        loadSettings();
        loadQueryHistory();

        const anchor = document.createElement('div');
        anchor.className = 'ggsel-user-explorer-anchor collapsed expand-right expand-down';
        anchor.style.setProperty('--ggsel-user-explorer-fab', `${FAB_SIZE}px`);

        const shell = document.createElement('div');
        shell.className = 'ggsel-user-explorer-shell';

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'ggsel-user-explorer-button';
        button.innerHTML = HEADSET_ICON;
        button.addEventListener('click', (event) => {
            if (state.suppressNextButtonClick) {
                state.suppressNextButtonClick = false;
                event.preventDefault();
                return;
            }
            togglePanel();
        });
        button.addEventListener('pointerdown', startAnchorDrag);

        const panel = document.createElement('div');
        panel.className = 'ggsel-user-explorer-panel';
        panel.setAttribute('aria-hidden', 'true');

        const body = document.createElement('div');
        body.className = 'ggsel-user-explorer-body';

        const searchRow = document.createElement('div');
        searchRow.className = 'ggsel-user-explorer-search-row';

        const searchControl = document.createElement('div');
        searchControl.className = 'ggsel-user-explorer-search-control collapsed';

        const input = document.createElement('input');
        input.type = 'search';
        input.className = 'ggsel-user-explorer-search-input';
        input.addEventListener('input', (event) => {
            hideHistoryPopover();
            updateSearchControlValueState();
            onQueryChange(event.target.value);
        });
        input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                onQueryChange.flush?.();
            }
        });
        input.addEventListener('contextmenu', openInputContextMenu);
        input.addEventListener('dblclick', (event) => {
            event.preventDefault();
            event.stopPropagation();
            showHistoryPopover();
        });

        searchControl.appendChild(input);

        const historyPopover = document.createElement('div');
        historyPopover.className = 'ggsel-user-history-popover';
        historyPopover.hidden = true;

        const historyList = document.createElement('div');
        historyList.className = 'ggsel-user-history-list';
        historyPopover.appendChild(historyList);

        searchControl.appendChild(historyPopover);
        searchRow.appendChild(searchControl);

        const modeButton = document.createElement('button');
        modeButton.type = 'button';
        modeButton.className = 'ggsel-user-explorer-mode-toggle';
        modeButton.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            toggleMode();
        });
        searchRow.appendChild(modeButton);

        const resultsWrapper = document.createElement('div');
        resultsWrapper.className = 'ggsel-user-explorer-results-wrapper';
        resultsWrapper.hidden = true;

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

        resultsWrapper.appendChild(resultsContainer);
        resultsWrapper.appendChild(loadMoreButton);

        body.appendChild(searchRow);
        body.appendChild(resultsWrapper);

        panel.appendChild(body);

        shell.appendChild(button);
        shell.appendChild(panel);
        anchor.appendChild(shell);
        document.body.appendChild(anchor);

        state.anchor = anchor;
        state.shell = shell;
        state.button = button;
        state.panel = panel;
        state.input = input;
        state.modeButton = modeButton;
        state.resultsContainer = resultsContainer;
        state.loadMoreButton = loadMoreButton;
        state.searchControl = searchControl;
        state.searchRow = searchRow;
        state.resultsWrapper = resultsWrapper;
        state.historyPopover = historyPopover;
        state.historyList = historyList;
        enablePanelTopDragging(panel);
        const initialConfig = getModeConfig(state.mode);
        if (button) {
            button.title = initialConfig.buttonTitle;
        }
        if (input) {
            input.placeholder = initialConfig.placeholder;
        }
        let initialQuery = '';
        try {
            initialQuery = localStorage.getItem(getQueryStorageKey()) || '';
            if (!initialQuery) {
                const savedMode = localStorage.getItem(STORAGE_MODE_KEY);
                const primaryLegacy = getLegacyQueryStorageKey(savedMode === MODE_ORDERS ? MODE_ORDERS : MODE_USERS);
                initialQuery = localStorage.getItem(primaryLegacy) || '';
                if (!initialQuery) {
                    initialQuery = localStorage.getItem(getLegacyQueryStorageKey(MODE_ORDERS))
                        || localStorage.getItem(getLegacyQueryStorageKey(MODE_USERS))
                        || '';
                }
            }
        } catch (error) {
            console.warn('[GGSEL User Explorer] Не удалось загрузить сохранённый запрос', error);
            initialQuery = '';
        }
        if (input) {
            input.value = initialQuery;
        }
        state.query = initialQuery.trim();
        try {
            const { params, plan } = parseSearchInput(state.query, state.mode);
            state.params = params;
            state.searchPlan = plan;
        } catch (error) {
            console.warn('[GGSEL User Explorer] Не удалось разобрать стартовый запрос', error);
            state.params = getDefaultParams(state.mode);
            state.searchPlan = {
                type: 'single',
                queries: [{ key: 'default', params: { ...state.params }, highlight: null }]
            };
        }
        updateModeButton();
        state.anchorPosition = loadPosition(ANCHOR_POSITION_KEY);
        state.anchorPositionManual = Boolean(state.anchorPosition);
        applyAnchorPosition();

        updateSearchControlValueState();
        updateResultsVisibility();

        document.addEventListener('keydown', handleGlobalShortcut, true);
        document.addEventListener('pointerdown', (event) => {
            if (!state.historyVisible) return;
            const target = event.target instanceof Element ? event.target : null;
            if (target) {
                if (state.historyPopover && state.historyPopover.contains(target)) {
                    return;
                }
                if (state.input && state.input.contains(target)) {
                    return;
                }
            }
            hideHistoryPopover();
        });
        document.addEventListener('pointerdown', (event) => {
            if (!state.open || !state.panel || !state.button || !state.anchor) return;
            if (state.anchor.contains(event.target)) return;
            if (getCurrentInputValue()) return;
            closePanel();
        });

        panel.addEventListener('focusout', () => {
            if (!state.open) return;
            if (getCurrentInputValue()) return;
            setTimeout(() => {
                if (!getCurrentInputValue() && state.panel && !state.panel.contains(document.activeElement)) {
                    closePanel();
                }
            }, 0);
        });

        panel.addEventListener('wheel', (event) => {
            event.stopPropagation();
            if (!(event.target instanceof Element)) {
                event.preventDefault();
                return;
            }
            let scrollTarget = event.target.closest('.ggsel-user-explorer-results, .ggsel-user-card-body, .ggsel-user-window__content');
            if (scrollTarget && scrollTarget.classList.contains('ggsel-user-card-body') && scrollTarget.scrollHeight <= scrollTarget.clientHeight) {
                const parentResults = scrollTarget.closest('.ggsel-user-explorer-results');
                if (parentResults) {
                    scrollTarget = parentResults;
                }
            }
            if (!scrollTarget && state.resultsContainer) {
                scrollTarget = state.resultsContainer;
            }
            if (!scrollTarget) {
                event.preventDefault();
                return;
            }
            const { scrollTop, scrollHeight, clientHeight } = scrollTarget;
            if (scrollHeight <= clientHeight) {
                event.preventDefault();
                return;
            }
            const delta = event.deltaY;
            const atTop = scrollTop <= 0;
            const atBottom = scrollTop + clientHeight >= scrollHeight - 1;
            if ((delta < 0 && atTop) || (delta > 0 && atBottom)) {
                event.preventDefault();
                if (delta < 0 && atTop) {
                    scrollTarget.scrollTop = 0;
                }
                if (delta > 0 && atBottom) {
                    scrollTarget.scrollTop = scrollHeight - clientHeight;
                }
            }
        }, { passive: false });

        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                if (state.historyVisible) {
                    event.preventDefault();
                    hideHistoryPopover();
                    return;
                }
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

        anchor.addEventListener('contextmenu', openPanelContextMenu);

        window.addEventListener('resize', () => {
            applyAnchorPosition();
        });

        restoreState();
    };

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        init();
    } else {
        document.addEventListener('DOMContentLoaded', init);
    }
})();

