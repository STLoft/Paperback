// Paperback — SillyTavern 채팅을 책처럼 쪽으로 나누어 읽는 확장
//
// 구조
//   · 장(chapter) = 캐릭터 메시지 하나. 앞선 사용자 메시지는 설정에 따라 장 머리에 붙는다.
//   · 장 하나를 CSS 다단(column) 흐름으로 그리고, 단 너비만큼 옆으로 밀어 쪽을 넘긴다.
//   · 읽던 위치와 책갈피는 채팅 메타데이터(chat_metadata)에 저장해 채팅 파일과 함께 다닌다.
//     읽던 위치는 쪽을 넘길 때마다 localStorage에도 적어 두어, 책을 닫지 않고 채팅을 바꿔도 남는다.

const MODULE = 'paperback';
const ctx = () => SillyTavern.getContext();

const SERIF = '"Noto Serif KR","Nanum Myeongjo","AppleMyungjo","Batang",serif';
const SANS = '"Pretendard","Noto Sans KR","Apple SD Gothic Neo","Malgun Gothic",system-ui,sans-serif';

const FONTS = {
    serif: { label: '명조 (시스템)', stack: SERIF },
    sans: { label: '고딕 (시스템)', stack: SANS },
    gowunBatang: { label: '고운바탕', family: 'Gowun Batang', google: 'Gowun+Batang:wght@400;700', fallback: SERIF },
    notoSerif: { label: '본명조', family: 'Noto Serif KR', google: 'Noto+Serif+KR:wght@400;700', fallback: SERIF },
    nanumMyeongjo: { label: '나눔명조', family: 'Nanum Myeongjo', google: 'Nanum+Myeongjo:wght@400;700', fallback: SERIF },
    hahmlet: { label: '함렛', family: 'Hahmlet', google: 'Hahmlet:wght@400;700', fallback: SERIF },
    ridiBatang: { label: '리디바탕', family: 'RIDIBatang', face: 'https://cdn.jsdelivr.net/gh/projectnoonnu/noonfonts_twelve@1.0/RIDIBatang.woff', fallback: SERIF },
    gowunDodum: { label: '고운돋움', family: 'Gowun Dodum', google: 'Gowun+Dodum', fallback: SANS },
    notoSans: { label: '본고딕', family: 'Noto Sans KR', google: 'Noto+Sans+KR:wght@400;700', fallback: SANS },
};

const THEMES = {
    paper: '종이',
    white: '하양',
    sepia: '세피아',
    mint: '민트',
    night: '밤',
};

const DEFAULTS = Object.freeze({
    theme: 'paper',
    font: 'serif',
    fontSize: 18,
    lineHeight: 1.8,
    margin: 48,
    align: 'justify',
    indent: true,
    layout: 'auto',
    effect: 'flip',
    sound: true,
    volume: 0.5,
    includeUser: false,
    chapterChars: 5000,
    showImages: true,
    showInfoPanel: true,
    wheel: true,
});

const FLIP_MS = 560;
const SLIDE_MS = 260;
const NARROW = 700;

// ── 설정 ────────────────────────────────────────────────────────────────

function S() {
    const all = ctx().extensionSettings;
    if (!all[MODULE] || typeof all[MODULE] !== 'object') all[MODULE] = {};
    const s = all[MODULE];
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (s[k] === undefined || typeof s[k] !== typeof v) s[k] = v;
    }
    // 사용자가 더한 테마·글꼴. '기본값으로'를 눌러도 지우지 않는다.
    //   customThemes: [{ id, name, desk, paper, ink, muted, accent, quote }]
    //   customFonts:  [{ id, name(font-family), url(없으면 기기에 설치된 글꼴) }]
    if (!Array.isArray(s.customThemes)) s.customThemes = [];
    if (!Array.isArray(s.customFonts)) s.customFonts = [];
    if (!FONTS[s.font] && !s.customFonts.some((f) => f.id === s.font)) s.font = DEFAULTS.font;
    if (!THEMES[s.theme] && !s.customThemes.some((t) => t.id === s.theme)) s.theme = DEFAULTS.theme;
    return s;
}

const newId = () => `u${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

function setSetting(key, value) {
    S()[key] = value;
    ctx().saveSettingsDebounced();
}

// ── 작은 도구 ────────────────────────────────────────────────────────────

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
}

function debounce(fn, ms) {
    let t = 0;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function plainText(raw) {
    return String(raw || '')
        .replace(/\{\{[^}]*\}\}/g, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/[*_~`#>|[\]]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function toast(msg) {
    if (!dom) return;
    dom.toast.textContent = msg;
    dom.toast.classList.add('pbk-show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => dom.toast.classList.remove('pbk-show'), 1600);
}

// ── 상태 ────────────────────────────────────────────────────────────────

const st = {
    open: false,
    chatId: null,
    chapters: [],
    ch: 0,
    page: 0,
    pages: 1,
    totalCols: 1,
    geo: null,
    rendered: null, // { idx, sig }
    posDirty: false,
    anims: [],
    animGen: 0,
    follow: null, // 책에서 보낸 뒤 새로 올 메시지의 첫 자리(chat 길이). 그 메시지가 오면 그 쪽으로 간다.
    quietUntil: 0, // 이 시각까지는 '이야기가 이어졌습니다' 같은 알림을 띄우지 않는다.
    busy: false,
    swipePin: null, // 방금 버전을 바꾼 메시지. 쪽을 넘기기 전까지는 계속 이 메시지를 고른다.
    edit: null, // { idx, key }
    relayoutPending: false,
};
let dom = null;

// ── 장 만들기 ────────────────────────────────────────────────────────────

const rawText = (m) => (m?.extra?.display_text || m?.mes || '');

// 상태창(인포패널): <Info_panel>·<status> 같은 태그, 같은 이름의 코드블록, info-panel 류 class가 붙은 <div>.
// '상태창 보이기'를 끄면 본문에서 빼고 그린다. 채팅 원문은 건드리지 않는다.
const INFO_TAGS = '(?:[a-z0-9]+[-_])*(?:info(?:[-_]?(?:panel|box|block|card))?|status(?:[-_]?(?:panel|box|block|card|window))?|stat(?:s|[-_]?block)?)';
const INFO_CLASSES = '(?:custom[-_]?info[-_]?card|info[-_]?(?:panel|box|block|card)|status[-_]?(?:panel|box|block|card|window))';
const TAG_END = '(?=[\\s/>])';
const SELF_CLOSED = /\/\s*>$/;

// from에서 열린 블록이 끝나는 자리. 닫는 태그가 없으면 그 문단까지만 잡아서 뒤따르는 본문을 지우지 않는다.
function infoBlockEnd(text, from, tag) {
    const token = new RegExp(`<(/?)${tag}${TAG_END}[^>]*>`, 'gi');
    token.lastIndex = from;
    let depth = 1;
    let m;
    while ((m = token.exec(text)) !== null) {
        if (m[1]) {
            if (--depth === 0) return m.index + m[0].length;
        } else if (!SELF_CLOSED.test(m[0])) {
            depth++;
        }
    }
    const blank = /\n[ \t]*\n/g;
    blank.lastIndex = from;
    const end = blank.exec(text);
    return end ? end.index : text.length;
}

function cutInfoBlocks(text, open, tagOf) {
    let out = '';
    let last = 0;
    let m;
    open.lastIndex = 0;
    while ((m = open.exec(text)) !== null) {
        let end = m.index + m[0].length;
        if (!SELF_CLOSED.test(m[0])) end = infoBlockEnd(text, end, tagOf(m));
        out += text.slice(last, m.index);
        last = end;
        open.lastIndex = end;
    }
    return out + text.slice(last);
}

function stripInfoPanel(text) {
    const codeHead = '```\\s*' + INFO_TAGS + '(?![\\w-])[^\\n]*\\n';
    let out = cutInfoBlocks(String(text || ''), new RegExp(`<(${INFO_TAGS})${TAG_END}[^>]*>`, 'gi'), (m) => m[1]);
    out = out
        .replace(new RegExp(`</?${INFO_TAGS}${TAG_END}[^>]*>`, 'gi'), '')
        .replace(new RegExp(codeHead + '[\\s\\S]*?```', 'gi'), '')
        .replace(new RegExp(codeHead + '[\\s\\S]*?(?=\\n[ \\t]*\\n|$)', 'gi'), '');
    out = cutInfoBlocks(out, new RegExp(`<div\\b[^>]*class=["'][^"']*${INFO_CLASSES}[^"']*["'][^>]*>`, 'gi'), () => 'div');
    // 상태창 앞에 두던 구분선이 끝에 홀로 남으면 함께 지운다.
    return out.replace(/(?:\n\s*[-*_]{3,}\s*)+$/, '').replace(/\n{3,}/g, '\n\n').trim();
}

const strippedCache = new WeakMap();
function msgText(m) {
    const raw = rawText(m);
    if (!m || S().showInfoPanel) return raw;
    const hit = strippedCache.get(m);
    if (hit && hit.raw === raw) return hit.out;
    const out = stripInfoPanel(raw);
    strippedCache.set(m, { raw, out });
    return out;
}

// 정규식 스크립트가 그려 낸 상태창 카드처럼, 원문에는 없고 그린 뒤에야 생기는 것
function removeRenderedInfoPanels(root) {
    const byClass = new RegExp(`(?:^|\\s)${INFO_CLASSES}(?:\\s|$)`, 'i');
    const byTag = new RegExp(`^${INFO_TAGS}$`, 'i');
    for (const el of [...root.querySelectorAll('.pbk-msg *')]) {
        if (!el.isConnected) continue;
        if (byTag.test(el.localName) || byClass.test(el.getAttribute('class') || '') || byClass.test(el.id || '')) el.remove();
    }
}
const msgKey = (m, i) => (m?.send_date ? String(m.send_date) : `#${i}`);

// 숨김 처리된 대화 메시지는 읽되, 실리태번 안내문 같은 시스템 메시지는 뺀다.
function isNotice(m) {
    return !!(m?.is_system && (m.extra?.type || m.name === 'SillyTavern System'));
}

// 장 나누기
//   · 처음부터 차례로 메시지를 담다가, 담은 본문이 목표 분량(chapterChars)에 이르면 다음 메시지부터 새 장을 연다.
//   · 메시지 중간에서는 자르지 않는다. 목표보다 긴 메시지는 그 하나로 한 장이 된다.
//   · 목표의 절반을 넘긴 뒤 장면 구분(***, ---, ## 제목 등)으로 시작하는 메시지가 오면 그 앞에서 끊는다.
//   · 사용자가 직접 정한 장 나눔(chat_metadata.paperback.breaks)은 자동 규칙보다 앞선다.
//   · 첫 메시지(인사말)는 언제나 '프롤로그' 한 장이 된다.
// 앞에서부터 채우므로 새 메시지가 와도 마지막 장만 늘어나고 지난 장은 바뀌지 않는다.

const SCENE_BREAK = /^(?:(?:[*\-_=~]\s*){3,}|[*＊※◇◆⁂]+(?:\s*[*＊※◇◆⁂]+){1,}|#{1,3}\s+\S.*|<hr\b[^>]*>)$/;

function startsWithSceneBreak(m) {
    const first = msgText(m).split('\n').map((l) => l.trim()).find((l) => l);
    return !!first && SCENE_BREAK.test(first);
}

const msgLength = (m) => plainText(msgText(m)).length;

function buildChapters() {
    const { chat } = ctx();
    const s = S();
    const target = s.chapterChars;
    const breaks = new Set(manualBreaks());
    const out = [];
    let cur = null;
    let pending = [];
    let num = 0;

    const add = (charIdx) => {
        const items = pending.map((i) => ({ idx: i, key: msgKey(chat[i], i), user: true }));
        if (charIdx !== undefined) items.push({ idx: charIdx, key: msgKey(chat[charIdx], charIdx), user: false });
        pending = [];
        const head = items[0];
        const manual = items.some((it) => breaks.has(it.key));
        const scene = charIdx !== undefined && startsWithSceneBreak(chat[charIdx]);
        const prologue = charIdx === 0 && items.length === 1;
        const fresh = !cur || cur.prologue || prologue || manual
            || cur.chars >= target
            || (scene && cur.chars >= target / 2);
        if (fresh) {
            if (!prologue) num++;
            cur = { key: head.key, idx: head.idx, prologue, num: prologue ? 0 : num, msgs: [], chars: 0, sig: '' };
            out.push(cur);
        }
        for (const it of items) {
            cur.msgs.push(it);
            cur.chars += msgLength(chat[it.idx]);
            cur.sig += `${msgText(chat[it.idx])}\u0000`;
        }
    };

    (chat || []).forEach((m, i) => {
        if (!m || isNotice(m)) return;
        if (m.is_user) {
            if (s.includeUser && msgText(m).trim()) pending.push(i);
            return;
        }
        if (!msgText(m).trim() && !m.extra?.media?.length && !m.extra?.image) return;
        add(i);
    });
    if (pending.length) add();
    return out;
}

function chapterLabel(ch) {
    if (!ch) return '';
    return ch.prologue ? '프롤로그' : `제 ${ch.num} 장`;
}

function chapterPlain(ch) {
    if (ch.plain === undefined) {
        const { chat } = ctx();
        ch.plain = plainText(ch.msgs.map((it) => msgText(chat[it.idx])).join('\n'));
    }
    return ch.plain;
}

function bookTitle() {
    const c = ctx();
    if (c.groupId) {
        const g = (c.groups || []).find((x) => x.id === c.groupId);
        if (g?.name) return g.name;
    }
    return c.name2 || '';
}

// 메시지가 들어 있는 장 번호. 같은 키가 여럿이면 원래 자리(idx)에 가까운 쪽을 고른다.
function chapterOfMessage(mkey, midx) {
    const list = st.chapters;
    let best = -1;
    let bestDist = Infinity;
    list.forEach((ch, i) => {
        for (const it of ch.msgs) {
            if (it.key !== mkey) continue;
            const d = Math.abs(it.idx - midx);
            if (d < bestDist) { best = i; bestDist = d; }
        }
    });
    if (best >= 0) return best;
    for (let i = list.length - 1; i >= 0; i--) if (list[i].idx <= midx) return i;
    return 0;
}

function formatMessage(m, i) {
    return ctx().messageFormatting(msgText(m), m.name, m.is_system, m.is_user, i);
}

function mediaHtml(m) {
    const list = [];
    if (Array.isArray(m?.extra?.media)) {
        for (const a of m.extra.media) if (a?.url) list.push(a);
    } else if (m?.extra?.image) {
        list.push({ url: m.extra.image, type: 'image', title: m.extra.title });
    }
    return list.map((a) => {
        const src = esc(a.url);
        if (a.type === 'video') return `<figure class="pbk-fig"><video src="${src}" controls playsinline></video></figure>`;
        if (a.type === 'audio') return `<figure class="pbk-fig"><audio src="${src}" controls></audio></figure>`;
        return `<figure class="pbk-fig"><img src="${src}" alt="${esc(a.title || '')}" loading="eager"></figure>`;
    }).join('');
}

function chapterHtml(ch) {
    const { chat, groupId } = ctx();
    let h = '<header class="pbk-ch-head">'
        + `<div class="pbk-ch-num">${esc(chapterLabel(ch))}</div>`
        + '<div class="pbk-ch-orn" aria-hidden="true"></div>'
        + '</header>';
    for (const it of ch.msgs) {
        const m = chat[it.idx];
        if (!m) continue;
        const attrs = `data-idx="${it.idx}" data-key="${esc(it.key)}"`;
        if (it.user) {
            h += `<section class="pbk-msg pbk-prelude" ${attrs}><div class="pbk-prelude-name">${esc(m.name)}</div>${formatMessage(m, it.idx)}</section>`;
        } else {
            h += `<section class="pbk-msg pbk-body" ${attrs}>`
                + (groupId && m.name ? `<div class="pbk-speaker">${esc(m.name)}</div>` : '')
                + mediaHtml(m) + formatMessage(m, it.idx) + '</section>';
        }
    }
    h += '<div class="pbk-end"><span>​</span></div>';
    return h;
}

// ── 쪽 나누기 ────────────────────────────────────────────────────────────

function computeGeometry() {
    const s = S();
    const W = dom.stage.clientWidth;
    const H = dom.stage.clientHeight;
    const narrow = W < NARROW;
    let cols = s.layout === 'double' ? 2 : s.layout === 'single' ? 1 : (W >= 960 && W > H * 1.15 ? 2 : 1);
    if (narrow) cols = 1;
    const outerX = narrow ? 0 : 24;
    const outerY = narrow ? 0 : 16;
    const mx = narrow ? Math.min(s.margin, 28) : s.margin;
    const maxPageW = Math.round(s.fontSize * 34 + mx * 2);
    const pageW = Math.max(200, Math.floor(Math.min((W - outerX * 2) / cols, narrow ? W : maxPageW)));
    const bookW = pageW * cols;
    const bookH = Math.max(240, Math.floor(H - outerY * 2));
    // 좁은 화면에서는 위아래 막대가 책 위에 떠 있으므로 막대 높이만큼 비워 둔다.
    const top = Math.max(narrow ? 60 : 40, Math.round(mx * 0.85));
    const bottom = Math.max(narrow ? 56 : 44, Math.round(mx * 0.95));
    const cw = pageW - mx * 2;
    const gap = mx * 2;
    return {
        cols, narrow, pageW, bookW, bookH, mx, top, bottom, cw, gap,
        vw: cols * cw + (cols - 1) * gap,
        vh: bookH - top - bottom,
        step: cw + gap,
    };
}

function applyGeometry() {
    const g = st.geo;
    dom.root.classList.toggle('pbk-double', g.cols === 2);
    dom.root.classList.toggle('pbk-narrow', g.narrow);
    Object.assign(dom.book.style, { width: `${g.bookW}px`, height: `${g.bookH}px` });
    Object.assign(dom.viewport.style, { left: `${g.mx}px`, top: `${g.top}px`, width: `${g.vw}px`, height: `${g.vh}px` });
    Object.assign(dom.flow.style, {
        width: `${g.vw}px`, height: `${g.vh}px`,
        columnCount: String(g.cols), columnGap: `${g.gap}px`,
    });
    dom.flow.style.setProperty('--pbk-vh', `${g.vh}px`);
    const headTop = `${Math.round(g.top / 2)}px`;
    const footBottom = `${Math.round(g.bottom / 2)}px`;
    dom.headL.style.top = dom.headR.style.top = headTop;
    dom.folioL.style.bottom = dom.folioR.style.bottom = footBottom;
    dom.headL.style.left = dom.folioL.style.left = `${g.mx}px`;
    dom.headR.style.right = dom.folioR.style.right = `${g.mx}px`;
    dom.headL.style.width = dom.headR.style.width = `${g.cw}px`;
    dom.folioL.style.width = dom.folioR.style.width = `${g.cw}px`;
}

function measure() {
    const g = st.geo;
    const end = dom.flow.querySelector('.pbk-end span');
    if (!end) { st.totalCols = 1; st.pages = 1; return; }
    const x = end.getBoundingClientRect().left - dom.flow.getBoundingClientRect().left;
    st.totalCols = Math.max(1, Math.floor((x + 2) / g.step) + 1);
    st.pages = Math.max(1, Math.ceil(st.totalCols / g.cols));
    // 메시지마다 걸친 단(column) 범위. 위치·책갈피를 '메시지 + 메시지 안의 위치'로 다루는 데 쓴다.
    const fl = dom.flow.getBoundingClientRect().left;
    st.msgCols = [...dom.flow.querySelectorAll('.pbk-msg')].map((sec) => {
        const cols = [...sec.getClientRects()]
            .filter((r) => r.width > 0 && r.height > 0)
            .map((r) => Math.floor((r.left - fl + 2) / g.step));
        if (!cols.length) return null;
        return { idx: Number(sec.dataset.idx), key: sec.dataset.key, start: Math.min(...cols), end: Math.max(...cols) };
    }).filter(Boolean);
}

// 지금 쪽 맨 위에 걸린 메시지와, 그 메시지 안에서의 위치(0~1)
function pageAnchor() {
    const list = st.msgCols || [];
    if (!list.length) {
        const ch = st.chapters[st.ch];
        return ch ? { mkey: ch.key, midx: ch.idx, mfrac: 0 } : null;
    }
    const c0 = st.page * st.geo.cols;
    const a = list.find((m) => m.start <= c0 && m.end >= c0) || list.find((m) => m.start >= c0) || list[list.length - 1];
    return { mkey: a.key, midx: a.idx, mfrac: clamp((c0 - a.start) / (a.end - a.start + 1), 0, 1) };
}

// 그려 둔 장 안에서 위치가 놓인 쪽 번호
function pageOfAnchor(anchor) {
    const list = st.msgCols || [];
    const a = list.find((m) => m.key === anchor.mkey && m.idx === anchor.midx)
        || list.find((m) => m.key === anchor.mkey)
        || list.find((m) => m.idx === anchor.midx);
    if (!a) {
        // 그 메시지가 없어졌으면(지웠거나 책에 넣지 않는 메시지) 바로 앞 메시지가 끝나는 쪽으로 간다.
        const prev = list.filter((m) => m.idx <= anchor.midx).pop();
        return prev ? Math.floor(prev.end / st.geo.cols) : 0;
    }
    const col =Math.min(a.end, a.start + Math.round((anchor.mfrac || 0) * (a.end - a.start + 1)));
    return Math.floor(col / st.geo.cols);
}

// 예전 형식({ key, idx, frac })으로 저장된 값도 받아 준다.
function normAnchor(o) {
    if (!o || typeof o !== 'object') return null;
    if (o.mkey !== undefined) return { mkey: String(o.mkey), midx: Number(o.midx) || 0, mfrac: Number(o.mfrac) || 0 };
    if (o.key !== undefined) return { mkey: String(o.key), midx: Number(o.idx) || 0, mfrac: 0 };
    return null;
}

const chapterOfAnchor = (a) => chapterOfMessage(a.mkey, a.midx);

function renderChapter(i) {
    const ch = st.chapters[i];
    clearHighlight();
    dom.flow.innerHTML = chapterHtml(ch);
    dom.flow.classList.toggle('pbk-noimg', !S().showImages);
    if (!S().showInfoPanel) removeRenderedInfoPanels(dom.flow);
    for (const a of dom.flow.querySelectorAll('a[href]')) {
        if (/^https?:/i.test(a.getAttribute('href'))) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    }
    for (const img of dom.flow.querySelectorAll('img')) {
        if (!img.complete) img.addEventListener('load', scheduleRelayout, { once: true });
    }
    st.rendered = { idx: i, sig: ch.sig };
    dom.flow.style.transform = 'translateX(0)';
    measure();
}

// pos: 쪽 번호 | 'last' | { anchor }
function show(i, pos) {
    i = clamp(i, 0, st.chapters.length - 1);
    const ch = st.chapters[i];
    if (!st.rendered || st.rendered.idx !== i || st.rendered.sig !== ch.sig) renderChapter(i);
    const page = pos === 'last' ? st.pages - 1
        : pos?.anchor ? pageOfAnchor(pos.anchor)
            : Number(pos) || 0;
    st.ch = i;
    st.page = clamp(page, 0, st.pages - 1);
    dom.flow.style.transform = `translateX(${-st.page * st.geo.cols * st.geo.step}px)`;
    updateChrome();
    savePos();
}

function relayout() {
    if (!st.open || !st.chapters.length) return;
    finishAnim();
    const anchor = pageAnchor();
    st.geo = computeGeometry();
    applyGeometry();
    st.rendered = null;
    show(st.ch, anchor ? { anchor } : 0);
}
const scheduleRelayout = debounce(relayout, 120);

// ── 넘기기 ──────────────────────────────────────────────────────────────

function go(dir) {
    if (!st.open || !st.geo || !st.chapters.length) return;
    st.follow = null;
    st.swipePin = null;
    finishAnim();
    let i = st.ch;
    let page = st.page + dir;
    if (page >= st.pages) {
        if (i + 1 >= st.chapters.length) { toast('마지막 쪽입니다'); return; }
        i++; page = 0;
    } else if (page < 0) {
        if (i === 0) { toast('첫 쪽입니다'); return; }
        i--; page = 'last';
    }
    const effect = S().effect;
    const oldC = effect !== 'none' ? snapshot() : null;
    show(i, page);
    if (oldC) animate(oldC, snapshot(), dir, effect);
    playFlip();
}

function jump(i, pos = 0) {
    if (!st.open || !st.geo) return;
    st.follow = null;
    st.swipePin = null;
    finishAnim();
    const effect = S().effect;
    const oldC = effect !== 'none' ? snapshot() : null;
    const before = st.ch * 1e6 + st.page;
    show(i, pos);
    const after = st.ch * 1e6 + st.page;
    if (after === before) return;
    if (oldC) animate(oldC, snapshot(), after > before ? 1 : -1, effect);
    playFlip();
}

// ── 넘기는 모양 ──────────────────────────────────────────────────────────

function snapshot() {
    const c = dom.paper.cloneNode(true);
    c.removeAttribute('id');
    c.classList.add('pbk-clone');
    for (const v of c.querySelectorAll('video, audio')) { v.removeAttribute('autoplay'); v.preload = 'none'; }
    return c;
}

function finishAnim() {
    for (const a of st.anims) { try { a.cancel(); } catch { /* 이미 끝남 */ } }
    st.anims = [];
    st.animGen++;
    if (dom) dom.fx.replaceChildren();
}

function face(node, clip, back) {
    const f = el('div', `pbk-face${back ? ' pbk-back' : ''}${node ? '' : ' pbk-blank'}`);
    if (node) f.appendChild(node);
    if (clip) f.style.clipPath = clip;
    f.appendChild(el('div', 'pbk-shade'));
    return f;
}

function animate(oldC, newC, dir, effect) {
    const fx = dom.fx;
    const gen = st.animGen;
    const done = () => { if (gen === st.animGen) { st.anims = []; fx.replaceChildren(); } };

    if (effect === 'slide') {
        const f = face(oldC);
        fx.appendChild(f);
        const a = f.animate(
            [{ transform: 'translateX(0)', opacity: 1 }, { transform: `translateX(${dir > 0 ? -48 : 48}px)`, opacity: 0 }],
            { duration: SLIDE_MS, easing: 'ease-out', fill: 'forwards' },
        );
        st.anims.push(a);
        a.finished.then(done, () => {});
        return;
    }

    const L = 'inset(0 50% 0 0)';
    const R = 'inset(0 0 0 50%)';
    const double = st.geo.cols === 2;
    let under = null;
    let front;
    let back;
    if (double) {
        // 오른쪽 쪽이 책등을 축으로 왼쪽으로 넘어간다. 뒷면은 새 왼쪽 쪽.
        if (dir > 0) { under = face(oldC, L); front = face(oldC.cloneNode(true), R); back = face(newC, L, true); }
        else { under = face(oldC, R); front = face(newC, R); back = face(oldC.cloneNode(true), L, true); }
    } else {
        // 한 쪽 보기: 종이 한 장이 왼쪽 가장자리를 축으로 넘어간다.
        if (dir > 0) { front = face(oldC); back = face(null, null, true); }
        else { under = face(oldC); front = face(newC); back = face(null, null, true); }
    }
    if (under) { under.classList.add('pbk-under'); fx.appendChild(under); }
    // opacity를 넘기는 종이 자체에 걸면 크롬이 preserve-3d를 풀어 버리므로 바깥 틀에 건다.
    const wrap = el('div', 'pbk-leafwrap');
    const leaf = el('div', 'pbk-leaf');
    leaf.style.transformOrigin = double ? '50% 50%' : '0% 50%';
    leaf.append(front, back);
    wrap.appendChild(leaf);
    fx.appendChild(wrap);

    const end = double ? -180 : -165;
    const opts = { duration: FLIP_MS, easing: 'cubic-bezier(.4,.1,.3,1)', fill: 'forwards' };
    const turn = [{ transform: 'rotateY(0deg)' }, { transform: `rotateY(${end}deg)` }];
    const a = leaf.animate(dir > 0 ? turn : turn.slice().reverse(), opts);
    st.anims.push(a);
    if (!double) {
        const fade = [{ opacity: 1 }, { opacity: 1, offset: 0.55 }, { opacity: 0 }];
        st.anims.push(wrap.animate(dir > 0 ? fade : fade.slice().reverse(), opts));
    }
    for (const sh of leaf.querySelectorAll('.pbk-shade')) {
        st.anims.push(sh.animate([{ opacity: 0 }, { opacity: 1, offset: 0.5 }, { opacity: 0 }], opts));
    }
    if (under) {
        const sh = under.querySelector('.pbk-shade');
        st.anims.push(sh.animate([{ opacity: dir > 0 ? 0 : 0.6 }, { opacity: dir > 0 ? 0.6 : 0 }], opts));
    }
    a.finished.then(done, () => {});
}

// ── 넘기는 소리 (파일 없이 Web Audio로 합성) ─────────────────────────────

let actx = null;
function playFlip() {
    const s = S();
    if (!s.sound || s.volume <= 0) return;
    try {
        actx ||= new (window.AudioContext || window.webkitAudioContext)();
        if (actx.state === 'suspended') actx.resume();
        const sr = actx.sampleRate;
        const dur = 0.42;
        const n = Math.floor(sr * dur);
        const buf = actx.createBuffer(1, n, sr);
        const d = buf.getChannelData(0);
        const peak = 0.16 + Math.random() * 0.08;
        let brown = 0;
        for (let i = 0; i < n; i++) {
            const t = i / sr;
            const white = Math.random() * 2 - 1;
            brown = (brown + 0.02 * white) / 1.02;
            const env = t < peak ? Math.pow(t / peak, 1.8) : Math.exp(-(t - peak) * 13);
            const crackle = Math.random() < 0.0025 ? (Math.random() * 2 - 1) * 2 : 0;
            d[i] = (white * 0.5 + brown * 3 + crackle) * env;
        }
        const now = actx.currentTime;
        const src = actx.createBufferSource();
        src.buffer = buf;
        const bp = actx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.Q.value = 0.7;
        bp.frequency.setValueAtTime(900, now);
        bp.frequency.linearRampToValueAtTime(2800, now + peak);
        bp.frequency.linearRampToValueAtTime(1300, now + dur);
        const hp = actx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 220;
        const gain = actx.createGain();
        gain.gain.value = s.volume * 0.7;
        src.connect(bp).connect(hp).connect(gain).connect(actx.destination);
        src.start(now);
    } catch { /* 소리를 낼 수 없는 환경 */ }
}

// ── 글꼴 ────────────────────────────────────────────────────────────────

const FONT_FILE = /\.(?:woff2?|ttf|otf)(?:[?#]|$)/i;

// 글꼴 정의: { label, family, fallback } + 불러올 곳(google | css | face) 또는 stack
function fontDef(key) {
    if (FONTS[key]) return FONTS[key];
    const f = S().customFonts.find((x) => x.id === key);
    if (!f) return null;
    const def = { label: f.name, family: f.name, fallback: SERIF };
    if (f.url) def[FONT_FILE.test(f.url) ? 'face' : 'css'] = f.url;
    return def;
}

const loadedFonts = new Set();
function loadFont(key) {
    const f = fontDef(key);
    if (!f || loadedFonts.has(key) || !(f.google || f.css || f.face)) return;
    loadedFonts.add(key);
    const ready = () => document.fonts.ready.then(() => { if (st.open) scheduleRelayout(); });
    const failed = () => { loadedFonts.delete(key); toast(`'${f.label}' 글꼴을 불러오지 못했습니다`); };
    if (f.face) {
        // 글꼴 파일 주소: @font-face를 직접 만든다.
        new FontFace(f.family, `url(${JSON.stringify(f.face)})`).load()
            .then((face) => { document.fonts.add(face); ready(); }, failed);
        return;
    }
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = f.css || `https://fonts.googleapis.com/css2?family=${f.google}&display=swap`;
    link.addEventListener('load', ready);
    link.addEventListener('error', failed);
    document.head.appendChild(link);
}

const fontStack = (key) => {
    const f = fontDef(key) || FONTS.serif;
    return f.family ? `"${f.family.replace(/["\\]/g, '')}",${f.fallback}` : f.stack;
};

// ── 사용자 테마 ──────────────────────────────────────────────────────────

const THEME_COLORS = [
    ['desk', '바탕'],
    ['paper', '종이'],
    ['ink', '글자'],
    ['muted', '흐린 글자'],
    ['accent', '강조'],
    ['quote', '대사'],
];
const THEME_VARS = ['desk', 'paper', 'ink', 'muted', 'accent', 'quote', 'line', 'ui', 'ui-ink', 'shadow'];

function hex6(v, fallback = '#888888') {
    const m = String(v || '').trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (!m) return fallback;
    const h = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1];
    return `#${h.toLowerCase()}`;
}

function rgbOf(hex) {
    const n = parseInt(hex6(hex).slice(1), 16);
    return [n >> 16, (n >> 8) & 255, n & 255];
}

const brightness = (hex) => { const [r, g, b] = rgbOf(hex); return (r * 299 + g * 587 + b * 114) / 255000; };

const customTheme = (key = S().theme) => S().customThemes.find((t) => t.id === key) || null;

function applyTheme() {
    const s = S();
    const t = customTheme(s.theme);
    const r = dom.root.style;
    dom.root.dataset.theme = t ? 'custom' : s.theme;
    for (const v of THEME_VARS) r.removeProperty(`--pbk-${v}`);
    let lightDesk = s.theme === 'white';
    if (t) {
        for (const [k] of THEME_COLORS) r.setProperty(`--pbk-${k}`, hex6(t[k]));
        // 나머지 색은 고른 색에서 만든다.
        lightDesk = brightness(t.desk) > 0.55;
        r.setProperty('--pbk-line', `rgba(${rgbOf(t.ink).join(',')},0.14)`);
        r.setProperty('--pbk-ui', lightDesk ? 'rgba(40,44,52,0.82)' : 'rgba(20,18,16,0.84)');
        r.setProperty('--pbk-ui-ink', '#f0ece4');
        r.setProperty('--pbk-shadow', `rgba(0,0,0,${brightness(t.desk) < 0.12 ? 0.7 : lightDesk ? 0.25 : 0.45})`);
    }
    // 바탕이 밝으면 위아래 막대 글자를 어둡게 한다.
    dom.root.classList.toggle('pbk-lightdesk', lightDesk);
}

function addCustomTheme() {
    const s = S();
    const cs = getComputedStyle(dom.root);
    const t = { id: newId(), name: `내 테마 ${s.customThemes.length + 1}` };
    for (const [k] of THEME_COLORS) t[k] = hex6(cs.getPropertyValue(`--pbk-${k}`));
    s.customThemes.push(t);
    s.theme = t.id;
    ctx().saveSettingsDebounced();
    renderCustom();
    syncSettingsForm();
    applyStyles();
    toast('지금 테마를 바탕으로 새 테마를 만들었습니다');
}

function deleteCustomTheme() {
    const s = S();
    const at = s.customThemes.findIndex((t) => t.id === s.theme);
    if (at < 0) return;
    s.customThemes.splice(at, 1);
    s.theme = DEFAULTS.theme;
    ctx().saveSettingsDebounced();
    renderCustom();
    syncSettingsForm();
    applyStyles();
}

function editCustomTheme(key, value) {
    const t = customTheme();
    if (!t) return;
    if (key === 'name') {
        t.name = String(value).trim().slice(0, 20) || '내 테마';
        const sw = dom.settings.querySelector(`.pbk-swatch[data-v="${t.id}"]`);
        if (sw) { sw.title = t.name; sw.querySelector('span').textContent = t.name; }
    } else {
        t[key] = hex6(value);
        const sw = dom.settings.querySelector(`.pbk-swatch[data-v="${t.id}"]`);
        if (sw) { sw.style.background = t.paper; sw.style.color = t.ink; }
        applyTheme();
    }
    ctx().saveSettingsDebounced();
}

function addCustomFont() {
    const s = S();
    const nameEl = dom.settings.querySelector('[data-new="font-name"]');
    const urlEl = dom.settings.querySelector('[data-new="font-url"]');
    const name = nameEl.value.trim().replace(/["\\]/g, '').slice(0, 60);
    const url = urlEl.value.trim();
    if (!name) { toast('글꼴 이름을 적어 주세요'); nameEl.focus(); return; }
    if (url && !/^https?:\/\//i.test(url) && !url.startsWith('/')) { toast('주소는 http(s)로 시작해야 합니다'); urlEl.focus(); return; }
    const f = { id: newId(), name, url };
    s.customFonts.push(f);
    s.font = f.id;
    nameEl.value = '';
    urlEl.value = '';
    ctx().saveSettingsDebounced();
    renderCustom();
    syncSettingsForm();
    applyStyles();
    scheduleRelayout();
}

function deleteCustomFont(id) {
    const s = S();
    const at = s.customFonts.findIndex((f) => f.id === id);
    if (at < 0) return;
    s.customFonts.splice(at, 1);
    const wasCurrent = s.font === id;
    if (wasCurrent) s.font = DEFAULTS.font;
    ctx().saveSettingsDebounced();
    renderCustom();
    syncSettingsForm();
    if (wasCurrent) { applyStyles(); scheduleRelayout(); }
}

// 설정 창에서 사용자 테마·글꼴에 따라 달라지는 부분을 다시 그린다.
function renderCustom() {
    const s = S();
    const $ = (sel) => dom.settings.querySelector(sel);

    $('.pbk-swatches').innerHTML = Object.entries(THEMES)
        .map(([k, n]) => `<button class="pbk-swatch" data-theme-key="${k}" data-k="theme" data-v="${k}" title="${n}"><span>${n}</span></button>`)
        .concat(s.customThemes.map((t) => `<button class="pbk-swatch" data-k="theme" data-v="${esc(t.id)}" title="${esc(t.name)}" style="background:${hex6(t.paper)};color:${hex6(t.ink)}"><span>${esc(t.name)}</span></button>`))
        .join('') + '<button class="pbk-swatch pbk-swatch-add" data-act="theme-add" title="지금 테마를 바탕으로 사용자 테마 추가"><i class="fa-solid fa-plus"></i></button>';

    const t = customTheme(s.theme);
    const themeBox = $('[data-custom="theme"]');
    themeBox.hidden = !t;
    themeBox.innerHTML = !t ? '' : '<div class="pbk-custom-line">'
        + `<input type="text" class="pbk-in" data-tk="name" maxlength="20" value="${esc(t.name)}" placeholder="테마 이름">`
        + '<button class="pbk-mini" data-act="theme-del">지우기</button></div>'
        + `<div class="pbk-colors">${THEME_COLORS.map(([k, n]) => `<label><input type="color" data-tk="${k}" value="${hex6(t[k])}"><span>${n}</span></label>`).join('')}</div>`;

    $('select[data-k="font"]').innerHTML = Object.entries(FONTS).map(([k, f]) => `<option value="${k}">${esc(f.label)}</option>`)
        .concat(s.customFonts.map((f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`)).join('');

    const list = $('.pbk-custom-fonts');
    list.innerHTML = s.customFonts.map((f) => `<li><span title="${esc(f.url || '기기에 설치된 글꼴')}">${esc(f.name)}</span>`
        + `<button class="pbk-mini" data-font-del="${esc(f.id)}" title="이 글꼴 빼기"><i class="fa-solid fa-xmark"></i></button></li>`).join('');
    list.hidden = !s.customFonts.length;
}

function applyStyles() {
    const s = S();
    loadFont(s.font);
    applyTheme();
    const r = dom.root.style;
    r.setProperty('--pbk-font', fontStack(s.font));
    r.setProperty('--pbk-fs', `${s.fontSize}px`);
    r.setProperty('--pbk-lh', String(s.lineHeight));
    r.setProperty('--pbk-align', s.align);
    r.setProperty('--pbk-indent', s.indent ? '1em' : '0');
}

// ── 위치 · 책갈피 ────────────────────────────────────────────────────────

const posStoreKey = () => `pbk:pos:${st.chatId}`;

function meta() {
    const md = ctx().chatMetadata;
    if (!md[MODULE] || typeof md[MODULE] !== 'object') md[MODULE] = {};
    return md[MODULE];
}
const sameChat = () => ctx().getCurrentChatId() === st.chatId;

function savePos() {
    const anchor = pageAnchor();
    if (!anchor || !st.chatId) return;
    const pos = { ...anchor, at: Date.now() };
    try { localStorage.setItem(posStoreKey(), JSON.stringify(pos)); } catch { /* 저장소 없음 */ }
    if (sameChat()) { meta().pos = pos; st.posDirty = true; }
}

function loadPos() {
    let local = null;
    try { local = JSON.parse(localStorage.getItem(posStoreKey()) || 'null'); } catch { local = null; }
    const remote = meta().pos || null;
    const pick = local && remote ? ((local.at || 0) >= (remote.at || 0) ? local : remote) : (local || remote);
    return normAnchor(pick);
}

// 직접 정한 장 나눔: 이 키의 메시지에서 새 장이 시작된다.
function manualBreaks() {
    const list = meta().breaks;
    return Array.isArray(list) ? list : [];
}

function saveBreaks(list) {
    if (!sameChat()) return;
    meta().breaks = list;
    ctx().saveMetadataDebounced();
}

function toggleBreak() {
    if (!st.open) return;
    finishAnim();
    const a = pageAnchor();
    const ch = st.chapters[st.ch];
    if (!a || !ch) return;
    const list = manualBreaks().slice();
    const at = list.indexOf(a.mkey);
    if (at >= 0) {
        list.splice(at, 1);
        toast('장 나눔을 없앴습니다');
    } else if (ch.msgs[0]?.key === a.mkey) {
        toast('이미 이 메시지에서 장이 시작됩니다');
        return;
    } else {
        list.push(a.mkey);
        toast('이 메시지부터 새 장을 엽니다');
    }
    saveBreaks(list);
    rebuild({ ...a, mfrac: at >= 0 ? a.mfrac : 0 });
}

function bookmarks() {
    const list = meta().bookmarks;
    return Array.isArray(list) ? list : [];
}

function saveBookmarks(list) {
    if (!sameChat()) return;
    meta().bookmarks = list;
    ctx().saveMetadataDebounced();
}

function bookmarkPage(b) {
    const a = normAnchor(b);
    if (!a) return { i: -1, page: -1 };
    const i = chapterOfAnchor(a);
    return { i, page: i === st.ch ? clamp(pageOfAnchor(a), 0, st.pages - 1) : -1 };
}

function currentBookmark() {
    return bookmarks().findIndex((b) => {
        const p = bookmarkPage(b);
        return p.i === st.ch && p.page === st.page;
    });
}

// 지금 쪽 맨 위의 글 몇 자를 책갈피 이름으로 쓴다.
function visibleSnippet() {
    const r = dom.viewport.getBoundingClientRect();
    const x = r.left + 4;
    const y = r.top + 4;
    let node = null;
    let offset = 0;
    if (document.caretRangeFromPoint) {
        const range = document.caretRangeFromPoint(x, y);
        if (range) { node = range.startContainer; offset = range.startOffset; }
    } else if (document.caretPositionFromPoint) {
        const p = document.caretPositionFromPoint(x, y);
        if (p) { node = p.offsetNode; offset = p.offset; }
    }
    if (node && dom.flow.contains(node)) {
        const walker = document.createTreeWalker(dom.flow, NodeFilter.SHOW_TEXT);
        walker.currentNode = node;
        const inHead = (n) => !!n.parentElement?.closest('.pbk-ch-head');
        let text = node.nodeType === Node.TEXT_NODE && !inHead(node) ? node.data.slice(offset) : '';
        while (text.length < 80 && walker.nextNode()) {
            if (!inHead(walker.currentNode)) text += ` ${walker.currentNode.data}`;
        }
        text = text.replace(/\s+/g, ' ').trim();
        if (text) return text.slice(0, 60);
    }
    return chapterPlain(st.chapters[st.ch]).slice(0, 60);
}

function toggleBookmark() {
    if (!st.open) return;
    finishAnim();
    const list = bookmarks().slice();
    const at = currentBookmark();
    if (at >= 0) {
        list.splice(at, 1);
        toast('책갈피를 뺐습니다');
    } else {
        const a = pageAnchor();
        if (!a) return;
        list.push({ ...a, text: visibleSnippet(), at: Date.now() });
        toast('책갈피를 끼웠습니다');
    }
    saveBookmarks(list);
    updateChrome();
    if (dom.panel.dataset.tab === 'marks' && !dom.panel.hidden) renderMarks();
}

// ── 본문 찾기 (목차 검색에서 고른 곳으로 가기) ──────────────────────────

function clearHighlight() {
    if (window.CSS?.highlights) CSS.highlights.delete('pbk-hit');
}

function goToText(i, query) {
    jump(i, 0);
    const q = query.toLowerCase();
    const walker = document.createTreeWalker(dom.flow, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
        const n = walker.currentNode;
        const at = n.data.toLowerCase().indexOf(q);
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(n, at);
        range.setEnd(n, at + q.length);
        const rect = range.getBoundingClientRect();
        const x = rect.left - dom.flow.getBoundingClientRect().left;
        const page = Math.floor(Math.floor((x + 2) / st.geo.step) / st.geo.cols);
        finishAnim();
        show(i, page);
        if (window.CSS?.highlights && window.Highlight) CSS.highlights.set('pbk-hit', new Highlight(range));
        return;
    }
}

// ── 화면 위 장식 (머리글 · 쪽 번호 · 진행 막대) ─────────────────────────

function updateChrome() {
    const ch = st.chapters[st.ch];
    if (!ch) return;
    const label = chapterLabel(ch);
    const title = bookTitle();
    const g = st.geo;
    dom.title.textContent = title;
    dom.chap.textContent = label;

    if (g.cols === 2) {
        dom.headL.textContent = title;
        dom.headR.textContent = label;
    } else {
        dom.headL.textContent = label;
        dom.headR.textContent = '';
    }
    const first = st.page * g.cols + 1;
    dom.folioL.textContent = String(first);
    dom.folioR.textContent = g.cols === 2 && first + 1 <= st.totalCols ? String(first + 1) : '';

    const last = Math.min(st.totalCols, first + g.cols - 1);
    dom.pageInfo.textContent = `${label} · ${first === last ? first : `${first}–${last}`} / ${st.totalCols}쪽`;
    const total = st.chapters.length;
    const pct = ((st.ch + (st.page + 1) / st.pages) / total) * 100;
    dom.progressFill.style.width = `${pct}%`;
    dom.pct.textContent = `${Math.floor(pct)}%`;

    const anchor = pageAnchor();
    const manualStart = !!anchor && ch.msgs[0]?.key === anchor.mkey && manualBreaks().includes(anchor.mkey);
    dom.breakBtn.classList.toggle('pbk-on', manualStart);
    dom.breakBtn.title = manualStart ? '직접 나눈 장 합치기 (N)' : '이 쪽의 메시지부터 새 장 (N)';

    const marked = currentBookmark() >= 0;
    dom.ribbon.hidden = !marked;
    dom.markBtn.classList.toggle('pbk-on', marked);
    dom.markBtn.querySelector('i').className = `${marked ? 'fa-solid' : 'fa-regular'} fa-bookmark`;

    updateSwipeUi();
    if (!dom.menu.hidden) renderMenu();
    if (!dom.panel.hidden && dom.panel.dataset.tab === 'toc') markTocCurrent();
}

// ── 곁 창: 목차 · 책갈피 · 설정 ─────────────────────────────────────────

function openPanel(tab) {
    finishAnim();
    if (!dom.panel.hidden && dom.panel.dataset.tab === tab) { closePanel(); return; }
    clearHighlight();
    dom.panel.hidden = false;
    dom.panel.dataset.tab = tab;
    for (const b of dom.panel.querySelectorAll('[data-tab-btn]')) b.classList.toggle('pbk-on', b.dataset.tabBtn === tab);
    for (const b of dom.panel.querySelectorAll('[data-body]')) b.hidden = b.dataset.body !== tab;
    if (tab === 'toc') renderToc();
    if (tab === 'marks') renderMarks();
    if (tab === 'settings') { renderCustom(); syncSettingsForm(); }
}

function closePanel() {
    if (dom) dom.panel.hidden = true;
}

function renderToc() {
    const q = dom.search.value.trim().toLowerCase();
    const items = [];
    st.chapters.forEach((ch, i) => {
        const plain = chapterPlain(ch);
        let snip;
        if (q) {
            const at = plain.toLowerCase().indexOf(q);
            if (at < 0) return;
            const s0 = Math.max(0, at - 24);
            snip = `${s0 > 0 ? '…' : ''}${esc(plain.slice(s0, at))}<mark>${esc(plain.slice(at, at + q.length))}</mark>${esc(plain.slice(at + q.length, at + q.length + 48))}…`;
        } else {
            snip = esc(plain.slice(0, 80)) + (plain.length > 80 ? '…' : '');
        }
        const info = `메시지 ${ch.msgs.length}개 · ${ch.chars.toLocaleString()}자`;
        items.push(`<li data-i="${i}"><span class="pbk-toc-n">${esc(chapterLabel(ch))} <small>${info}</small></span><span class="pbk-toc-s">${snip}</span></li>`);
    });
    dom.toc.innerHTML = items.join('') || '<li class="pbk-empty">찾는 글이 없습니다</li>';
    markTocCurrent(true);
}

function markTocCurrent(scroll) {
    const prev = dom.toc.querySelector('.pbk-cur');
    if (prev) prev.classList.remove('pbk-cur');
    const cur = dom.toc.querySelector(`li[data-i="${st.ch}"]`);
    if (cur) {
        cur.classList.add('pbk-cur');
        if (scroll) cur.scrollIntoView({ block: 'center' });
    }
}

function renderMarks() {
    const list = bookmarks()
        .map((b, n) => ({ b, n, a: normAnchor(b) }))
        .filter((x) => x.a)
        .map((x) => ({ ...x, i: chapterOfAnchor(x.a) }))
        .sort((x, z) => x.i - z.i || x.a.midx - z.a.midx || x.a.mfrac - z.a.mfrac);
    if (!list.length) {
        dom.marks.innerHTML = '<li class="pbk-empty">아직 책갈피가 없습니다.<br>위쪽 <i class="fa-regular fa-bookmark"></i> 단추나 <kbd>B</kbd> 키로 끼울 수 있습니다.</li>';
        return;
    }
    dom.marks.innerHTML = list.map(({ b, n, i }) => {
        const date = new Date(b.at || 0).toLocaleDateString();
        return `<li data-n="${n}"><span class="pbk-toc-n">${esc(chapterLabel(st.chapters[i]))} <small>${esc(date)}</small></span>`
            + `<span class="pbk-toc-s">${esc(b.text || '')}</span>`
            + '<button class="pbk-del" title="책갈피 빼기"><i class="fa-solid fa-xmark"></i></button></li>';
    }).join('');
}

// 설정 양식: [키, 이름, 종류, 선택지/범위]
const FORM = [
    ['theme', '테마', 'swatch'],
    ['font', '글꼴', 'select', Object.fromEntries(Object.entries(FONTS).map(([k, f]) => [k, f.label]))],
    ['fontSize', '글자 크기', 'range', [13, 30, 1, 'px']],
    ['lineHeight', '줄 간격', 'range', [1.3, 2.6, 0.05, '']],
    ['margin', '여백', 'range', [16, 96, 4, 'px']],
    ['align', '정렬', 'seg', { justify: '양쪽', left: '왼쪽' }],
    ['indent', '첫 줄 들여쓰기', 'check'],
    ['layout', '펼침', 'seg', { auto: '자동', single: '한 쪽', double: '두 쪽' }],
    ['effect', '넘기는 모양', 'seg', { flip: '넘기기', slide: '밀기', none: '없음' }],
    ['sound', '넘기는 소리', 'check'],
    ['volume', '소리 크기', 'range', [0, 1, 0.05, '%']],
    ['chapterChars', '장 분량', 'range', [2000, 15000, 500, '자']],
    ['includeUser', '사용자 메시지도 넣기', 'check'],
    ['showImages', '그림 보이기', 'check'],
    ['showInfoPanel', '상태창 보이기', 'check'],
    ['wheel', '휠로 넘기기', 'check'],
];

function buildSettingsForm() {
    const rows = FORM.map(([key, label, type, opt]) => {
        let ctl = '';
        if (type === 'swatch') {
            ctl = '<div class="pbk-swatches"></div>'; // renderCustom()이 채운다.
        } else if (type === 'select') {
            ctl = `<select data-k="${key}">${Object.entries(opt).map(([k, n]) => `<option value="${k}">${esc(n)}</option>`).join('')}</select>`;
        } else if (type === 'range') {
            ctl = `<input type="range" data-k="${key}" min="${opt[0]}" max="${opt[1]}" step="${opt[2]}"><output data-out="${key}"></output>`;
        } else if (type === 'seg') {
            ctl = `<div class="pbk-seg">${Object.entries(opt).map(([k, n]) => `<button data-k="${key}" data-v="${k}">${esc(n)}</button>`).join('')}</div>`;
        } else if (type === 'check') {
            ctl = `<label class="pbk-switch"><input type="checkbox" data-k="${key}"><span></span></label>`;
        }
        let extra = '';
        if (key === 'theme') {
            extra = '<div class="pbk-custom" data-custom="theme" hidden></div>';
        } else if (key === 'font') {
            extra = '<details class="pbk-custom" data-custom="font"><summary>글꼴 추가</summary>'
                + '<ul class="pbk-custom-fonts" hidden></ul>'
                + '<div class="pbk-custom-line"><input type="text" class="pbk-in" data-new="font-name" placeholder="글꼴 이름 (font-family)"></div>'
                + '<div class="pbk-custom-line"><input type="url" class="pbk-in" data-new="font-url" placeholder="주소 (선택): CSS 또는 woff2·woff·ttf">'
                + '<button class="pbk-mini" data-act="font-add">추가</button></div>'
                + '<p class="pbk-hint">주소를 비우면 기기에 설치된 글꼴을 이름으로 찾아 씁니다.</p></details>';
        }
        return `<div class="pbk-row pbk-row-${type}"><div class="pbk-row-label">${esc(label)}</div><div class="pbk-row-ctl">${ctl}</div></div>${extra}`;
    });
    rows.push('<div class="pbk-row"><button class="pbk-reset">기본값으로</button></div>');
    return rows.join('');
}

function formatOut(key, v) {
    const row = FORM.find((r) => r[0] === key);
    const unit = row?.[3]?.[3] ?? '';
    if (unit === '%') return `${Math.round(v * 100)}%`;
    if (unit === '자') return `${Number(v).toLocaleString()}자`;
    return `${Number.isInteger(v) ? v : Number(v).toFixed(2)}${unit}`;
}

function syncSettingsForm() {
    const s = S();
    for (const c of dom.settings.querySelectorAll('[data-k]')) {
        const k = c.dataset.k;
        if (c.matches('select')) c.value = s[k];
        else if (c.matches('input[type=range]')) c.value = s[k];
        else if (c.matches('input[type=checkbox]')) c.checked = !!s[k];
        else if (c.dataset.v !== undefined) c.classList.toggle('pbk-on', String(s[k]) === c.dataset.v);
    }
    for (const o of dom.settings.querySelectorAll('[data-out]')) o.textContent = formatOut(o.dataset.out, s[o.dataset.out]);
}

function onSettingChange(key, raw) {
    const type = typeof DEFAULTS[key];
    const value = type === 'number' ? Number(raw) : type === 'boolean' ? !!raw : String(raw);
    if (S()[key] === value) return;
    setSetting(key, value);
    if (key === 'theme') renderCustom();
    syncSettingsForm();
    applyStyles();
    if (key === 'includeUser' || key === 'showInfoPanel') {
        st.quietUntil = Date.now() + 1000;
        rebuild();
    } else if (key === 'chapterChars') {
        scheduleRebuild();
    } else if (['font', 'fontSize', 'lineHeight', 'margin', 'align', 'indent', 'layout', 'showImages'].includes(key)) {
        scheduleRelayout();
    } else if (key === 'sound' && value) {
        playFlip();
    }
}

// ── DOM ─────────────────────────────────────────────────────────────────

function createDom() {
    if (dom) return;
    const root = el('div', 'pbk-root');
    root.id = 'pbk-root';
    root.hidden = true;
    root.tabIndex = -1;
    root.innerHTML = `
        <div class="pbk-stage">
            <div class="pbk-book">
                <div class="pbk-paper">
                    <div class="pbk-head pbk-head-l"></div><div class="pbk-head pbk-head-r"></div>
                    <div class="pbk-viewport"><div class="pbk-flow"></div></div>
                    <div class="pbk-folio pbk-folio-l"></div><div class="pbk-folio pbk-folio-r"></div>
                </div>
                <div class="pbk-ribbon" hidden></div>
                <div class="pbk-fx"></div>
            </div>
        </div>
        <div class="pbk-bar pbk-top">
            <button class="pbk-btn" data-act="close" title="닫기 (Esc)"><i class="fa-solid fa-xmark"></i></button>
            <div class="pbk-titles"><span class="pbk-title"></span><span class="pbk-chap"></span></div>
            <button class="pbk-btn" data-act="toc" title="목차 (T)"><i class="fa-solid fa-list"></i></button>
            <button class="pbk-btn pbk-break" data-act="break" title="이 쪽의 메시지부터 새 장 (N)"><i class="fa-solid fa-scissors"></i></button>
            <button class="pbk-btn pbk-mark" data-act="mark" title="책갈피 (B)"><i class="fa-regular fa-bookmark"></i></button>
            <button class="pbk-btn" data-act="marks" title="책갈피 목록"><i class="fa-solid fa-bookmark"></i><i class="fa-solid fa-list pbk-sub"></i></button>
            <button class="pbk-btn" data-act="settings" title="설정"><i class="fa-solid fa-sliders"></i></button>
        </div>
        <div class="pbk-bar pbk-bottom">
            <span class="pbk-pageinfo"></span>
            <div class="pbk-progress" title="눌러서 장 옮기기"><div class="pbk-progress-fill"></div></div>
            <span class="pbk-pct"></span>
            <div class="pbk-swipe" hidden>
                <button class="pbk-btn" data-act="swipe-prev" title="앞 버전 ([)"><i class="fa-solid fa-chevron-left"></i></button>
                <span class="pbk-swipe-n"></span>
                <button class="pbk-btn" data-act="swipe-next" title="다음 버전 (])"><i class="fa-solid fa-chevron-right"></i></button>
            </div>
            <button class="pbk-btn" data-act="msgmenu" title="이 쪽의 메시지 고치기·지우기"><i class="fa-solid fa-ellipsis"></i></button>
            <button class="pbk-btn pbk-compose-btn" data-act="compose" title="메시지 쓰기 (I)"><i class="fa-solid fa-pen-nib"></i></button>
        </div>
        <div class="pbk-compose" hidden>
            <textarea class="pbk-compose-input" rows="1" placeholder="메시지 쓰기…"></textarea>
            <button class="pbk-btn pbk-send" data-act="send" title="보내기 (Enter)"><i class="fa-solid fa-paper-plane"></i></button>
        </div>
        <div class="pbk-menu" hidden><ol class="pbk-list pbk-menu-list"></ol></div>
        <aside class="pbk-panel" hidden>
            <div class="pbk-panel-head">
                <div class="pbk-tabs">
                    <button data-tab-btn="toc">목차</button>
                    <button data-tab-btn="marks">책갈피</button>
                    <button data-tab-btn="settings">설정</button>
                </div>
                <button class="pbk-btn" data-act="panel-close" title="닫기"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="pbk-panel-body" data-body="toc">
                <input type="search" class="pbk-search" placeholder="본문에서 찾기">
                <ol class="pbk-list pbk-toc"></ol>
            </div>
            <div class="pbk-panel-body" data-body="marks"><ol class="pbk-list pbk-marks"></ol></div>
            <div class="pbk-panel-body pbk-settings" data-body="settings">${buildSettingsForm()}</div>
        </aside>
        <div class="pbk-editor" hidden>
            <div class="pbk-editor-box">
                <div class="pbk-editor-head"></div>
                <textarea class="pbk-editor-input" spellcheck="false"></textarea>
                <div class="pbk-editor-foot">
                    <span class="pbk-editor-hint">Ctrl+Enter 저장 · Esc 취소</span>
                    <button data-act="edit-cancel">취소</button>
                    <button class="pbk-primary" data-act="edit-save">저장</button>
                </div>
            </div>
        </div>
        <div class="pbk-toast"></div>`;
    document.body.appendChild(root);

    const $ = (sel) => root.querySelector(sel);
    dom = {
        root,
        stage: $('.pbk-stage'),
        book: $('.pbk-book'),
        paper: $('.pbk-paper'),
        viewport: $('.pbk-viewport'),
        flow: $('.pbk-flow'),
        fx: $('.pbk-fx'),
        ribbon: $('.pbk-ribbon'),
        headL: $('.pbk-head-l'),
        headR: $('.pbk-head-r'),
        folioL: $('.pbk-folio-l'),
        folioR: $('.pbk-folio-r'),
        title: $('.pbk-title'),
        chap: $('.pbk-chap'),
        markBtn: $('.pbk-mark'),
        breakBtn: $('.pbk-break'),
        pageInfo: $('.pbk-pageinfo'),
        progress: $('.pbk-progress'),
        progressFill: $('.pbk-progress-fill'),
        pct: $('.pbk-pct'),
        panel: $('.pbk-panel'),
        search: $('.pbk-search'),
        toc: $('.pbk-toc'),
        marks: $('.pbk-marks'),
        settings: $('.pbk-settings'),
        toast: $('.pbk-toast'),
        swipe: $('.pbk-swipe'),
        swipeN: $('.pbk-swipe-n'),
        swipePrev: $('[data-act="swipe-prev"]'),
        swipeNext: $('[data-act="swipe-next"]'),
        composeBtn: $('.pbk-compose-btn'),
        compose: $('.pbk-compose'),
        composeInput: $('.pbk-compose-input'),
        sendBtn: $('.pbk-send'),
        menu: $('.pbk-menu'),
        menuList: $('.pbk-menu-list'),
        editor: $('.pbk-editor'),
        editorHead: $('.pbk-editor-head'),
        editorInput: $('.pbk-editor-input'),
    };
    renderCustom();
    bindDom();
}

function bindDom() {
    const { root, stage, panel } = dom;

    root.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-act]');
        const act = btn?.dataset.act;
        if (!dom.menu.hidden && act !== 'msgmenu' && !e.target.closest('.pbk-menu')) closeMenu();
        if (!btn) return;
        if (act === 'close') closeBook();
        else if (act === 'toc' || act === 'marks' || act === 'settings') openPanel(act);
        else if (act === 'mark') toggleBookmark();
        else if (act === 'break') toggleBreak();
        else if (act === 'panel-close') closePanel();
        else if (act === 'swipe-prev') doSwipe(-1);
        else if (act === 'swipe-next') doSwipe(1);
        else if (act === 'msgmenu') toggleMenu();
        else if (act === 'compose') { if (generating()) ctx().stopGeneration(); else toggleCompose(); }
        else if (act === 'send') sendFromBook();
        else if (act === 'msg-edit') openEditor(Number(btn.closest('li').dataset.idx));
        else if (act === 'msg-del') deleteFromBook(Number(btn.closest('li').dataset.idx));
        else if (act === 'edit-cancel') closeEditor();
        else if (act === 'edit-save') saveEditor();
        else if (act === 'theme-add') addCustomTheme();
        else if (act === 'theme-del') deleteCustomTheme();
        else if (act === 'font-add') addCustomFont();
    });

    dom.composeInput.addEventListener('input', () => { growCompose(); mirrorDraft(); });
    dom.composeInput.addEventListener('blur', () => {
        if (st.relayoutPending) { st.relayoutPending = false; scheduleRelayout(); }
    });

    panel.addEventListener('click', (e) => {
        const tab = e.target.closest('[data-tab-btn]');
        if (tab) { openPanel(tab.dataset.tabBtn); return; }
        const tocItem = e.target.closest('.pbk-toc li[data-i]');
        if (tocItem) {
            const i = Number(tocItem.dataset.i);
            const q = dom.search.value.trim();
            if (q) goToText(i, q); else jump(i, 0);
            if (st.geo.narrow) closePanel(); else markTocCurrent();
            return;
        }
        const mark = e.target.closest('.pbk-marks li[data-n]');
        if (mark) {
            const n = Number(mark.dataset.n);
            if (e.target.closest('.pbk-del')) {
                const list = bookmarks().slice();
                list.splice(n, 1);
                saveBookmarks(list);
                renderMarks();
                updateChrome();
                return;
            }
            const b = bookmarks()[n];
            if (b) {
                const a = normAnchor(b);
                if (a) jump(chapterOfAnchor(a), { anchor: a });
                if (st.geo.narrow) closePanel();
            }
            return;
        }
        const fontDel = e.target.closest('[data-font-del]');
        if (fontDel) { deleteCustomFont(fontDel.dataset.fontDel); return; }
        const opt = e.target.closest('[data-k][data-v]');
        if (opt) { onSettingChange(opt.dataset.k, opt.dataset.v); return; }
        if (e.target.closest('.pbk-reset')) {
            const s = S();
            for (const [k, v] of Object.entries(DEFAULTS)) s[k] = v;
            ctx().saveSettingsDebounced();
            renderCustom();
            syncSettingsForm();
            applyStyles();
            rebuild();
        }
    });

    panel.addEventListener('input', (e) => {
        const c = e.target;
        if (c === dom.search) { searchToc(); return; }
        if (c.dataset.tk) { editCustomTheme(c.dataset.tk, c.value); return; }
        if (c.matches('input[type=range][data-k]')) onSettingChange(c.dataset.k, c.value);
    });
    panel.addEventListener('change', (e) => {
        const c = e.target;
        if (c.matches('select[data-k]')) onSettingChange(c.dataset.k, c.value);
        else if (c.matches('input[type=checkbox][data-k]')) onSettingChange(c.dataset.k, c.checked);
    });

    dom.progress.addEventListener('click', (e) => {
        const r = dom.progress.getBoundingClientRect();
        const f = clamp((e.clientX - r.left) / r.width, 0, 0.9999);
        jump(Math.floor(f * st.chapters.length), 0);
    });

    // 누르기: 왼쪽 30%는 앞쪽, 오른쪽 30%는 뒤쪽, 가운데는 위아래 막대 감추기/보이기
    let down = null;
    let swiped = false;
    let menuWasOpen = false;
    stage.addEventListener('pointerdown', (e) => {
        down = { x: e.clientX, y: e.clientY, type: e.pointerType };
        swiped = false;
        menuWasOpen = !dom.menu.hidden;
    });
    stage.addEventListener('pointerup', (e) => {
        if (!down) return;
        const dx = e.clientX - down.x;
        const dy = e.clientY - down.y;
        if (down.type !== 'mouse' && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
            swiped = true;
            go(dx < 0 ? 1 : -1);
        }
        down = null;
    });
    stage.addEventListener('click', (e) => {
        if (swiped) { swiped = false; return; }
        if (!panel.hidden) { closePanel(); return; }
        if (menuWasOpen) return;
        if (e.target.closest('a, button, summary, details, input, select, textarea, video, audio, label')) return;
        if (String(window.getSelection?.() || '').length) return;
        const r = stage.getBoundingClientRect();
        const f = (e.clientX - r.left) / r.width;
        if (f < 0.3) go(-1);
        else if (f > 0.7) go(1);
        else root.classList.toggle('pbk-bare');
    });

    // 휠: 한 번 굴리는 동작(제스처)마다 한 쪽
    let wheelLast = 0;
    let wheelAcc = 0;
    let wheelUsed = false;
    let wheelStart = 0;
    stage.addEventListener('wheel', (e) => {
        if (!S().wheel || e.ctrlKey) return;
        e.preventDefault();
        const now = performance.now();
        if (now - wheelLast > 220) { wheelAcc = 0; wheelUsed = false; wheelStart = now; }
        wheelLast = now;
        if (wheelUsed && now - wheelStart < 900) return;
        if (wheelUsed) { wheelUsed = false; wheelAcc = 0; wheelStart = now; }
        wheelAcc += Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
        if (Math.abs(wheelAcc) >= 40) {
            go(wheelAcc > 0 ? 1 : -1);
            wheelUsed = true;
        }
    }, { passive: false });

    new ResizeObserver(() => {
        if (!st.open) return;
        // 터치 기기에서 글을 쓰는 동안에는 자판이 화면을 줄여도 쪽을 다시 나누지 않는다.
        if (coarse() && document.activeElement === dom.composeInput) { st.relayoutPending = true; return; }
        scheduleRelayout();
    }).observe(stage);

    window.visualViewport?.addEventListener('resize', syncKeyboard);
    window.visualViewport?.addEventListener('scroll', syncKeyboard);
}

const searchToc = debounce(() => renderToc(), 200);

function onKey(e) {
    if (!st.open) return;
    // 실리태번 확인 창(지우기 등)이 떠 있으면 그 창이 키를 받게 둔다.
    if (document.querySelector('dialog[open]')) return;
    // 책이 열린 동안에는 실리태번 단축키(스와이프·입력창 포커스 등)가 받지 않게 한다.
    e.stopPropagation();
    const k = e.key;
    const field = e.target?.closest?.('.pbk-root input, .pbk-root select, .pbk-root textarea');
    if (field) {
        if (e.isComposing || e.keyCode === 229) return; // 한글 조합 중
        if (field === dom.composeInput) {
            if (k === 'Escape') { e.preventDefault(); closeCompose(); }
            else if (k === 'Enter' && !e.shiftKey && !coarse()) { e.preventDefault(); sendFromBook(); }
        } else if (field === dom.editorInput) {
            if (k === 'Escape') { e.preventDefault(); closeEditor(); }
            else if (k === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveEditor(); }
        } else if (k === 'Escape') { e.preventDefault(); closePanel(); dom.root.focus(); }
        else if (k === 'Enter' && field.dataset.new) { e.preventDefault(); addCustomFont(); }
        return;
    }
    if (!dom.editor.hidden) {
        if (k === 'Escape') { e.preventDefault(); closeEditor(); }
        return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (k === 'ArrowRight' || k === 'PageDown' || (k === ' ' && !e.shiftKey) || k === 'ArrowDown') { e.preventDefault(); go(1); }
    else if (k === 'ArrowLeft' || k === 'PageUp' || (k === ' ' && e.shiftKey) || k === 'ArrowUp') { e.preventDefault(); go(-1); }
    else if (k === 'Home') { e.preventDefault(); jump(st.ch, 0); }
    else if (k === 'End') { e.preventDefault(); jump(st.ch, 'last'); }
    else if (k === 'Escape') {
        e.preventDefault();
        if (!dom.menu.hidden) closeMenu();
        else if (!dom.panel.hidden) closePanel();
        else if (!dom.compose.hidden) closeCompose();
        else closeBook();
    }
    else if (k === 'i' || k === 'I') { e.preventDefault(); if (!generating()) openCompose(); }
    else if (k === '[') { e.preventDefault(); doSwipe(-1); }
    else if (k === ']') { e.preventDefault(); doSwipe(1); }
    else if (k === 'b' || k === 'B') { e.preventDefault(); toggleBookmark(); }
    else if (k === 't' || k === 'T') { e.preventDefault(); openPanel('toc'); }
    else if (k === 'n' || k === 'N') { e.preventDefault(); toggleBreak(); }
}

// ── 열기 · 닫기 · 새로 고침 ──────────────────────────────────────────────

async function openBook() {
    const c = ctx();
    const chatId = c.getCurrentChatId();
    if (!chatId) { toastr.info('먼저 채팅을 열어 주세요.'); return; }
    createDom();
    st.chatId = chatId;
    st.chapters = buildChapters();
    if (!st.chapters.length) { toastr.info('책으로 펼칠 메시지가 없습니다.'); return; }

    st.open = true;
    st.rendered = null;
    st.posDirty = false;
    dom.root.hidden = false;
    dom.root.classList.remove('pbk-bare');
    document.body.classList.add('pbk-open');
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    closePanel();
    closeMenu();
    closeEditor();
    dom.compose.hidden = true;
    dom.root.classList.remove('pbk-composing');
    st.follow = null;
    st.swipePin = null;
    dom.search.value = '';
    applyStyles();
    updateGenUi();

    await nextFrame();
    st.geo = computeGeometry();
    applyGeometry();
    const pos = loadPos();
    if (pos) show(chapterOfAnchor(pos), { anchor: pos });
    else show(0, 0);
    dom.root.focus({ preventScroll: true });
}

function closeBook() {
    if (!st.open) return;
    finishAnim();
    clearHighlight();
    st.open = false;
    dom.root.hidden = true;
    dom.flow.innerHTML = '';
    st.rendered = null;
    st.follow = null;
    closePanel();
    closeMenu();
    closeEditor();
    dom.compose.hidden = true;
    dom.root.classList.remove('pbk-composing');
    document.body.classList.remove('pbk-open');
    if (st.posDirty && sameChat()) ctx().saveMetadataDebounced();
    st.posDirty = false;
}

// 책에서 보낸 뒤 새로 온 메시지의 첫머리. 캐릭터의 답이 오면 따라가기를 끝낸다.
function followAnchor() {
    if (st.follow == null) return null;
    let first = null;
    let answered = false;
    for (const ch of st.chapters) {
        for (const it of ch.msgs) {
            if (it.idx < st.follow) continue;
            first ||= it;
            if (!it.user) answered = true;
        }
    }
    if (answered) st.follow = null;
    return first ? { mkey: first.key, midx: first.idx, mfrac: 0 } : null;
}

// anchor를 주면 그 자리로, 아니면 지금 읽던 자리로 돌아온다.
// soft: 글이 써지는 동안 자주 부르는 용도. 보고 있는 장이 그대로면 다시 그리지 않는다.
function rebuild(anchor, { soft = false } = {}) {
    if (!st.open) return;
    const chapters = buildChapters();
    if (!chapters.length) { closeBook(); return; }
    if (soft && st.follow == null && st.rendered && st.rendered.idx === st.ch && chapters[st.ch]?.sig === st.rendered.sig) {
        st.chapters = chapters;
        updateChrome();
        return;
    }
    finishAnim();
    let keep = anchor || pageAnchor();
    const wasLast = st.ch === st.chapters.length - 1;
    const before = st.chapters.length;
    const lastSig = st.chapters[before - 1]?.sig;
    st.chapters = chapters;
    if (!anchor) keep = followAnchor() || keep;
    if (!soft) {
        st.geo = computeGeometry();
        applyGeometry();
        st.rendered = null;
    }
    if (keep) show(chapterOfAnchor(keep), { anchor: keep });
    else show(0, 0);
    if (wasLast && !anchor && Date.now() > st.quietUntil) {
        if (st.chapters.length > before) toast('새 장이 시작되었습니다');
        else if (st.chapters[st.chapters.length - 1].sig !== lastSig) toast('이야기가 이어졌습니다');
    }
    if (!dom.panel.hidden && dom.panel.dataset.tab === 'toc') renderToc();
    if (!dom.panel.hidden && dom.panel.dataset.tab === 'marks') renderMarks();
}

const scheduleRebuild = debounce(() => rebuild(), 150);

// 글이 써지는 동안(스트리밍)에는 0.4초에 한 번만 반영한다. 책장이 넘어가는 중이면 끝난 뒤로 미룬다.
let streamTimer = 0;
function onStreamToken() {
    if (!st.open || streamTimer) return;
    streamTimer = setTimeout(function tick() {
        if (st.anims.length) { streamTimer = setTimeout(tick, 150); return; }
        streamTimer = 0;
        if (!st.open || !sameChat()) return;
        st.quietUntil = Date.now() + 2000;
        rebuild(undefined, { soft: true });
    }, 400);
}

// ── 책 안에서 쓰기 · 버전 고르기 · 고치기 · 지우기 ──────────────────────

const generating = () => document.body.dataset.generating === 'true';
const coarse = () => window.matchMedia?.('(pointer: coarse)').matches ?? false;
const mesRendered = (idx) => !!document.querySelector(`#chat .mes[mesid="${idx}"]`);
const NOT_LOADED = '실리태번 화면에 불러오지 않은 오래된 메시지라 여기서는 할 수 없습니다';

// 지금 펼친 쪽에 걸친 메시지들
function visibleMsgs() {
    if (!st.geo) return [];
    const c0 = st.page * st.geo.cols;
    const c1 = c0 + st.geo.cols - 1;
    return (st.msgCols || []).filter((m) => m.start <= c1 && m.end >= c0);
}

function updateGenUi() {
    if (!dom) return;
    const gen = generating();
    dom.root.classList.toggle('pbk-gen', gen);
    dom.sendBtn.querySelector('i').className = `fa-solid ${gen ? 'fa-stop' : 'fa-paper-plane'}`;
    dom.sendBtn.title = gen ? '멈추기' : '보내기 (Enter)';
    dom.composeBtn.querySelector('i').className = `fa-solid ${gen ? 'fa-stop' : 'fa-pen-nib'}`;
    dom.composeBtn.title = gen ? '멈추기' : '메시지 쓰기 (I)';
    if (!gen) setTimeout(() => { if (!generating()) st.follow = null; }, 600);
}

// 쓰기

const stInput = () => /** @type {HTMLTextAreaElement} */ (document.getElementById('send_textarea'));

function growCompose() {
    const ta = dom.composeInput;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
}

// 실리태번 입력창과 같은 글을 쓴다. 책을 닫아도 쓰던 글이 남는다.
function mirrorDraft() {
    const ta = stInput();
    if (!ta || ta.value === dom.composeInput.value) return;
    ta.value = dom.composeInput.value;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
}

// 터치 기기에서 자판이 화면 아래를 가리면 입력창을 그만큼 올린다.
function syncKeyboard() {
    if (!dom || !st.open) return;
    const vv = window.visualViewport;
    let kb = 0;
    if (vv && coarse()) kb = Math.round(dom.root.getBoundingClientRect().bottom - (vv.offsetTop + vv.height));
    if (kb < 60) kb = 0;
    dom.root.style.setProperty('--pbk-kb', `${kb}px`);
    dom.root.classList.toggle('pbk-kb', kb > 0);
}

function openCompose() {
    if (!st.open) return;
    closeMenu();
    closePanel();
    dom.compose.hidden = false;
    dom.root.classList.add('pbk-composing');
    dom.composeInput.value = stInput()?.value || '';
    growCompose();
    syncKeyboard();
    dom.composeInput.focus({ preventScroll: true });
}

function closeCompose() {
    if (!dom || dom.compose.hidden) return;
    dom.compose.hidden = true;
    dom.root.classList.remove('pbk-composing');
    dom.root.focus({ preventScroll: true });
}

function toggleCompose() {
    if (dom.compose.hidden) openCompose(); else closeCompose();
}

async function sendFromBook() {
    if (generating()) { ctx().stopGeneration(); return; }
    const ta = stInput();
    const btn = document.getElementById('send_but');
    if (!ta || !btn || !sameChat()) return;
    mirrorDraft();
    const sent = ta.value;
    st.follow = ctx().chat.length;
    st.quietUntil = Date.now() + 3000;
    btn.click();
    // 실리태번이 받아 가면 그쪽 입력창이 빈다. 받지 못했으면(연결 없음 등) 글을 그대로 둔다.
    for (let n = 0; n < 30 && ta.value === sent && sent; n++) await new Promise((r) => setTimeout(r, 100));
    if (!st.open || dom.composeInput.value !== sent) return;
    if (!sent) return;
    if (ta.value === sent) { st.follow = null; return; }
    toast('보냈습니다');
    dom.composeInput.value = ta.value;
    growCompose();
}

// 버전(스와이프) 고르기: 펼친 쪽에서 버전이 여럿인 마지막 캐릭터 메시지, 또는 채팅의 마지막 메시지

function swipeTarget() {
    const { chat } = ctx();
    const pick = (idx) => {
        const m = chat[idx];
        if (!m || m.is_user) return null;
        const total = Array.isArray(m.swipes) && m.swipes.length ? m.swipes.length : 1;
        const last = idx === chat.length - 1;
        if (total < 2 && !last) return null;
        const cur = clamp(Number(m.swipe_id) || 0, 0, total - 1);
        // 채팅의 마지막 메시지에서 마지막 버전 다음은 새 응답 만들기 (인사말 제외)
        return { idx, total, cur, regen: last && idx > 0 && cur === total - 1 };
    };
    const list = visibleMsgs();
    // 버전을 바꾸면 글 길이가 달라져 다른 메시지가 같은 쪽에 들어올 수 있다. 고르던 메시지를 놓치지 않는다.
    if (st.swipePin != null && list.some((v) => v.idx === st.swipePin)) {
        const t = pick(st.swipePin);
        if (t) return t;
    }
    for (let n = list.length - 1; n >= 0; n--) {
        const t = pick(list[n].idx);
        if (t) return t;
    }
    return null;
}

function updateSwipeUi() {
    const t = swipeTarget();
    dom.swipe.hidden = !t || (t.total < 2 && !t.regen);
    if (!t) return;
    dom.swipeN.textContent = `${t.cur + 1}/${t.total}`;
    dom.swipePrev.disabled = t.total < 2;
    dom.swipeNext.querySelector('i').className = `fa-solid ${t.regen ? 'fa-rotate' : 'fa-chevron-right'}`;
    dom.swipeNext.title = t.regen ? '새 응답 만들기 (])' : '다음 버전 (])';
}

async function doSwipe(dir) {
    if (!st.open || st.busy) return;
    const t = swipeTarget();
    if (!t) return;
    const c = ctx();
    if (!c.swipe?.to) { toast('이 실리태번 버전에서는 버전을 바꿀 수 없습니다'); return; }
    if (generating()) { toast('응답을 쓰는 중에는 바꿀 수 없습니다'); return; }
    if (c.swipe.state && c.swipe.state() !== 'none') return;
    const regen = dir > 0 && t.regen;
    if (!regen && t.total < 2) return;
    if (!mesRendered(t.idx)) { toast(NOT_LOADED); return; }
    st.quietUntil = Date.now() + 3000;
    st.swipePin = t.idx;
    st.busy = true;
    try {
        if (regen) {
            // 새 응답은 다 써질 때까지 끝나지 않으므로 기다리지 않는다.
            c.swipe.to(null, 'right', { forceMesId: t.idx }).catch((err) => console.error('[Paperback]', err));
        } else {
            await c.swipe.to(null, dir > 0 ? 'right' : 'left', {
                source: 'swipe_picker',
                forceMesId: t.idx,
                forceSwipeId: (t.cur + dir + t.total) % t.total,
            });
        }
    } catch (err) {
        console.error('[Paperback]', err);
        toast('버전을 바꾸지 못했습니다');
    } finally {
        st.busy = false;
    }
}

// 메시지 메뉴 (고치기 · 지우기)

function renderMenu() {
    const { chat } = ctx();
    const rows = visibleMsgs().map((v) => {
        const m = chat[v.idx];
        if (!m) return '';
        return `<li data-idx="${v.idx}"><span class="pbk-toc-n">${esc(m.name || '')}</span>`
            + `<span class="pbk-toc-s">${esc(plainText(msgText(m)).slice(0, 60))}</span>`
            + '<span class="pbk-menu-acts">'
            + '<button data-act="msg-edit" title="고치기"><i class="fa-solid fa-pen"></i></button>'
            + '<button data-act="msg-del" title="지우기"><i class="fa-solid fa-trash-can"></i></button>'
            + '</span></li>';
    });
    dom.menuList.innerHTML = rows.join('') || '<li class="pbk-empty">이 쪽에는 메시지가 없습니다</li>';
}

function toggleMenu() {
    if (!dom.menu.hidden) { closeMenu(); return; }
    finishAnim();
    closePanel();
    renderMenu();
    dom.menu.hidden = false;
}

function closeMenu() {
    if (dom) dom.menu.hidden = true;
}

function openEditor(idx) {
    const m = ctx().chat[idx];
    if (!m) return;
    if (generating()) { toast('응답을 쓰는 중에는 고칠 수 없습니다'); return; }
    closeMenu();
    st.edit = { idx, key: msgKey(m, idx) };
    dom.editorHead.textContent = `${m.name || ''} · 메시지 고치기`;
    dom.editorInput.value = m.mes || '';
    dom.editor.hidden = false;
    syncKeyboard();
    dom.editorInput.focus({ preventScroll: true });
    dom.editorInput.setSelectionRange(0, 0);
    dom.editorInput.scrollTop = 0;
}

function closeEditor() {
    if (!dom || dom.editor.hidden) return;
    dom.editor.hidden = true;
    st.edit = null;
    dom.root.focus({ preventScroll: true });
}

// 실리태번의 메시지 고치기와 같은 순서: 본문·현재 버전 바꾸기 → MESSAGE_EDITED → 화면 갱신 → MESSAGE_UPDATED → 저장
async function saveEditor() {
    const e = st.edit;
    if (!e) return;
    const c = ctx();
    const m = c.chat[e.idx];
    if (!m || msgKey(m, e.idx) !== e.key || !sameChat()) {
        closeEditor();
        toast('그사이 메시지가 바뀌어 저장하지 못했습니다');
        return;
    }
    if (generating()) { toast('응답을 쓰는 중에는 고칠 수 없습니다'); return; }
    let text = dom.editorInput.value;
    if (c.powerUserSettings?.trim_spaces) text = text.trim();
    if (!text.trim()) { toast('빈 글로는 저장할 수 없습니다'); return; }
    closeEditor();
    if (text === m.mes) return;
    text = c.substituteParams ? c.substituteParams(text) : text;
    m.mes = text;
    if (m.swipe_id !== undefined && Array.isArray(m.swipes)) m.swipes[m.swipe_id] = text;
    if (m.extra && 'display_text' in m.extra) delete m.extra.display_text;
    c.chatMetadata.tainted = true;
    st.quietUntil = Date.now() + 3000;
    const { eventSource, eventTypes: E } = c;
    try {
        await eventSource.emit(E.MESSAGE_EDITED, e.idx);
        if (mesRendered(e.idx)) c.updateMessageBlock(e.idx, m);
        await eventSource.emit(E.MESSAGE_UPDATED, e.idx);
        await c.saveChat();
        toast('고쳤습니다');
    } catch (err) {
        console.error('[Paperback]', err);
        toast('저장하지 못했습니다');
    }
    rebuild();
}

// 실리태번의 확인 창을 그대로 쓴다. 버전이 여럿이면 '이 버전만'과 '메시지 전체' 가운데 고를 수 있다.
async function deleteFromBook(idx) {
    const c = ctx();
    const m = c.chat[idx];
    if (!m) return;
    closeMenu();
    st.swipePin = null;
    if (!c.deleteMessage) { toast('이 실리태번 버전에서는 지울 수 없습니다'); return; }
    if (generating()) { toast('응답을 쓰는 중에는 지울 수 없습니다'); return; }
    if (!mesRendered(idx)) { toast(NOT_LOADED); return; }
    const swipeId = !m.is_user && Array.isArray(m.swipes) && m.swipes.length > 1
        ? clamp(Number(m.swipe_id) || 0, 0, m.swipes.length - 1) : undefined;
    st.quietUntil = Date.now() + 3000;
    try {
        await c.deleteMessage(idx, swipeId, true);
    } catch (err) {
        console.error('[Paperback]', err);
        toast('지우지 못했습니다');
    }
    if (st.open) dom.root.focus({ preventScroll: true });
}

// ── 등록 ────────────────────────────────────────────────────────────────

function addMenuItem() {
    if (document.getElementById('pbk_wand')) return;
    const item = el('div', 'list-group-item flex-container flexGap5',
        '<div class="fa-solid fa-book-open extensionsMenuExtensionButton"></div><span>책으로 읽기</span>');
    item.id = 'pbk_wand';
    item.addEventListener('click', () => openBook());
    document.getElementById('extensionsMenu')?.appendChild(item);
}

function addSettingsDrawer() {
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host || document.getElementById('pbk_settings')) return;
    const box = el('div', 'pbk-st-settings', `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Paperback · 책으로 읽기</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <p>지금 채팅을 책처럼 쪽으로 나누어 읽습니다. 마법봉 메뉴의 <b>책으로 읽기</b>나 <code>/book</code> 명령으로도 열 수 있습니다.
                글꼴·테마·넘기는 모양 같은 설정은 책 안의 <i class="fa-solid fa-sliders"></i> 단추에 있습니다.</p>
                <div class="menu_button menu_button_icon" id="pbk_open_btn"><i class="fa-solid fa-book-open"></i><span>책 열기</span></div>
            </div>
        </div>`);
    box.id = 'pbk_settings';
    host.appendChild(box);
    box.querySelector('#pbk_open_btn').addEventListener('click', () => openBook());
}

function registerCommand() {
    const { SlashCommandParser, SlashCommand } = ctx();
    if (!SlashCommandParser || !SlashCommand) return;
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'book',
        aliases: ['paperback'],
        callback: async () => { await openBook(); return ''; },
        helpString: '지금 채팅을 책처럼 펼쳐 읽습니다 (Paperback).',
    }));
}

function bindEvents() {
    const { eventSource, eventTypes: E } = ctx();
    const refreshOn = [
        E.MESSAGE_RECEIVED, E.MESSAGE_SENT, E.MESSAGE_EDITED, E.MESSAGE_DELETED,
        E.MESSAGE_SWIPED, E.MESSAGE_UPDATED, E.MESSAGE_SWIPE_DELETED, E.GENERATION_ENDED,
    ].filter(Boolean);
    for (const ev of refreshOn) eventSource.on(ev, () => { if (st.open && sameChat()) scheduleRebuild(); });
    if (E.STREAM_TOKEN_RECEIVED) eventSource.on(E.STREAM_TOKEN_RECEIVED, onStreamToken);
    eventSource.on(E.CHAT_CHANGED, () => { if (st.open) closeBook(); });
    new MutationObserver(updateGenUi).observe(document.body, { attributes: true, attributeFilter: ['data-generating'] });
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden' && st.open && st.posDirty && sameChat()) {
            ctx().saveMetadataDebounced();
            st.posDirty = false;
        }
    });
}

jQuery(() => {
    S();
    addMenuItem();
    addSettingsDrawer();
    registerCommand();
    bindEvents();
});
