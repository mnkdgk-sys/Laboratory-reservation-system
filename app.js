'use strict';

// CONFIG は config.js で定義されています（.gitignore 対象）
// config.example.js をコピーして config.js を作成し、実際の値を入力してください

if (typeof CONFIG === 'undefined' || CONFIG.supabaseUrl === 'YOUR_SUPABASE_URL') {
  document.body.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;height:100dvh;
                flex-direction:column;gap:12px;font-family:sans-serif;padding:24px;text-align:center;
                background:#1e293b;color:#fff">
      <div style="font-size:40px">⚙️</div>
      <h1 style="font-size:20px">初回設定が必要です</h1>
      <p style="color:#94a3b8;line-height:1.6">
        <code style="background:#334155;padding:2px 6px;border-radius:4px">config.example.js</code> を
        <code style="background:#334155;padding:2px 6px;border-radius:4px">config.js</code> にコピーして<br>
        Supabase の URL と anon key を入力してください。<br>
        <small style="color:#64748b">詳細は セットアップ手順.md を参照</small>
      </p>
    </div>`;
  throw new Error('config.js が設定されていません');
}

// ============================================================
// 定数
// ============================================================
const PX_PER_MIN_DAY  = 2;   // 日ビュー: 1分 = 2px, 1時間 = 120px
const PX_PER_MIN_WEEK = 1;   // 週ビュー: 1分 = 1px, 1時間 = 60px
const ROOM_HDR_H = 36;
const SLOT_MIN   = 10;

const COLORS = [
  '#3b82f6','#f97316','#22c55e','#a855f7',
  '#ef4444','#14b8a6','#eab308','#64748b',
];

const DAYS_JA = ['日','月','火','水','木','金','土'];

// ============================================================
// Supabase クライアント
// ============================================================
const { createClient } = supabase;
const db = createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey);

// ============================================================
// 認証状態
// ============================================================
let currentUser    = null;
let currentProfile = null; // { id, email, role }

async function initAuth() {
  // 招待リンク / パスワードリセットリンクからの場合
  const hash  = window.location.hash.slice(1);
  const params = new URLSearchParams(hash);
  const type  = params.get('type');

  if (type === 'invite' || type === 'recovery') {
    // Supabase が hash のトークンを使ってセッションを作る
    showScreen('set-password');
    // SIGNED_IN イベントが来たときはパスワード設定後なので無視してよい
    db.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_IN' && session) {
        // パスワード設定完了後にアプリへ遷移するのはボタンハンドラ側で行う
      } else if (event === 'SIGNED_OUT') {
        resetAppState();
        showScreen('login');
      }
    });
    return;
  }

  // 既存セッションを確認
  const { data: { session } } = await db.auth.getSession();
  if (session?.user) {
    await onSignedIn(session.user);
  } else {
    showScreen('login');
  }

  db.auth.onAuthStateChange(async (event, session) => {
    if (event === 'SIGNED_IN' && session?.user) {
      history.replaceState(null, '', window.location.pathname + window.location.search);
      await onSignedIn(session.user);
    } else if (event === 'SIGNED_OUT') {
      resetAppState();
      showScreen('login');
    }
  });
}

async function onSignedIn(user) {
  currentUser = user;
  const { data } = await db.from('profiles').select('*').eq('id', user.id).single();
  currentProfile = data;
  updateHeaderDisplay();
  // 管理者でなければ設定ボタンを非表示
  document.getElementById('btn-settings').classList.toggle('hidden', !isAdmin());
  await loadAll();
  showScreen('app');
  setupRealtime();
}

function updateHeaderDisplay() {
  const name = currentProfile?.display_name || currentUser?.email || '';
  document.getElementById('header-user-name').textContent = name;
}

function resetAppState() {
  currentUser    = null;
  currentProfile = null;
  state.rooms        = [];
  state.reservations = [];
}

function showScreen(name) {
  const screens = { login: 'screen-login', 'set-password': 'screen-set-password', app: 'screen-app' };
  for (const [key, id] of Object.entries(screens)) {
    document.getElementById(id).classList.toggle('hidden', key !== name);
  }
}

function isAdmin() {
  return currentProfile?.role === 'admin';
}

// ============================================================
// ログイン
// ============================================================
document.getElementById('btn-login').addEventListener('click', handleLogin);
document.getElementById('login-password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') handleLogin();
});

async function handleLogin() {
  const email    = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl    = document.getElementById('login-error');

  if (!email || !password) {
    showInline(errEl, 'メールアドレスとパスワードを入力してください');
    return;
  }

  const btn = document.getElementById('btn-login');
  btn.disabled    = true;
  btn.textContent = 'ログイン中…';

  const { error } = await db.auth.signInWithPassword({ email, password });
  if (error) {
    showInline(errEl, 'メールアドレスまたはパスワードが正しくありません');
    btn.disabled    = false;
    btn.textContent = 'ログイン';
  }
  // 成功時は onAuthStateChange → onSignedIn() が動く
}

// ============================================================
// パスワード設定（招待後の初回ログイン）
// ============================================================
document.getElementById('btn-set-password').addEventListener('click', handleSetPassword);
document.getElementById('new-password-confirm').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') handleSetPassword();
});

async function handleSetPassword() {
  const pw1   = document.getElementById('new-password').value;
  const pw2   = document.getElementById('new-password-confirm').value;
  const errEl = document.getElementById('setpw-error');

  if (pw1.length < 8) { showInline(errEl, 'パスワードは8文字以上にしてください'); return; }
  if (pw1 !== pw2)    { showInline(errEl, 'パスワードが一致しません'); return; }

  const btn = document.getElementById('btn-set-password');
  btn.disabled    = true;
  btn.textContent = '設定中…';

  const { data: { user }, error } = await db.auth.updateUser({ password: pw1 });
  if (error) {
    showInline(errEl, 'パスワードの設定に失敗しました: ' + error.message);
    btn.disabled    = false;
    btn.textContent = '設定してログイン';
    return;
  }
  // updateUser 後に SIGNED_IN が来るが、profile が既にあればアプリへ遷移する
  if (user) {
    await onSignedIn(user);
  }
}

// ============================================================
// ログアウト
// ============================================================
document.getElementById('btn-logout').addEventListener('click', async () => {
  await db.auth.signOut();
});

// ============================================================
// アプリ状態
// ============================================================
const state = {
  viewMode: 'day',   // 'day' | 'week' | 'month'
  currentDate: todayMidnight(),
  rooms: [],
  reservations: [],
  settings: loadSettingsFromStorage(),
  ui: {
    selectedRoomId:      null,
    selectedStartTime:   null,
    selectedReservation: null,
    submitting:          false,
  },
};

function todayMidnight() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function loadSettingsFromStorage() {
  const defaults = { labName: '実験室予約システム', startHour: 0, endHour: 24 };
  try {
    const raw = localStorage.getItem('labReservationSettings');
    return raw ? { ...defaults, ...JSON.parse(raw) } : defaults;
  } catch { return defaults; }
}

function saveSettingsToStorage() {
  localStorage.setItem('labReservationSettings', JSON.stringify(state.settings));
}

// ============================================================
// ユーティリティ
// ============================================================
function pad2(n) { return String(n).padStart(2, '0'); }

function formatDateJa(date) {
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日(${DAYS_JA[date.getDay()]})`;
}

function formatHHMM(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function minutesToHHMM(m) {
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
}

function HHMMToMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function dateString(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function buildISODateTime(date, hhmm) {
  if (hhmm === '24:00') {
    const next = new Date(date);
    next.setDate(next.getDate() + 1);
    return `${dateString(next)}T00:00:00+09:00`;
  }
  return `${dateString(date)}T${hhmm}:00+09:00`;
}

// ============================================================
// 週・月ビュー ヘルパー
// ============================================================
function getWeekStart(date) {
  const d = new Date(date);
  const day = d.getDay();
  d.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
  d.setHours(0, 0, 0, 0);
  return d;
}

function getWeekDays(date) {
  const start = getWeekStart(date);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

function getMonthStart(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function getMonthEnd(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

function getCalendarWeeks(date) {
  const ms = getMonthStart(date);
  const me = getMonthEnd(date);
  const gridStart = new Date(ms);
  const sd = gridStart.getDay();
  gridStart.setDate(gridStart.getDate() - (sd === 0 ? 6 : sd - 1));
  const gridEnd = new Date(me);
  const ed = gridEnd.getDay();
  if (ed !== 0) gridEnd.setDate(gridEnd.getDate() + (7 - ed));

  const weeks = [];
  const cur = new Date(gridStart);
  while (cur <= gridEnd) {
    const week = [];
    for (let i = 0; i < 7; i++) {
      week.push(new Date(cur));
      cur.setDate(cur.getDate() + 1);
    }
    weeks.push(week);
  }
  return weeks;
}

function formatViewTitle() {
  const d = state.currentDate;
  if (state.viewMode === 'day') {
    return formatDateJa(d);
  } else if (state.viewMode === 'week') {
    const days = getWeekDays(d);
    const s = days[0], e = days[6];
    if (s.getMonth() === e.getMonth()) {
      return `${s.getFullYear()}年${s.getMonth()+1}月${s.getDate()}日 〜 ${e.getDate()}日`;
    }
    return `${s.getFullYear()}年${s.getMonth()+1}月${s.getDate()}日 〜 ${e.getMonth()+1}月${e.getDate()}日`;
  } else {
    return `${d.getFullYear()}年${d.getMonth()+1}月`;
  }
}

function updateViewButtons() {
  document.querySelectorAll('.view-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.view === state.viewMode);
  });
}

// 重なり検出：複数予約を横に並べるレーン計算
function assignLanes(reservations) {
  if (!reservations.length) return [];
  const sorted = [...reservations].sort((a, b) =>
    new Date(a.start_time) - new Date(b.start_time)
  );
  const laneEnds = [];
  const assigned = sorted.map(res => {
    const start = new Date(res.start_time).getTime();
    const end   = new Date(res.end_time).getTime();
    let lane = laneEnds.findIndex(e => e <= start);
    if (lane === -1) { lane = laneEnds.length; }
    laneEnds[lane] = end;
    return { res, lane };
  });
  return assigned.map(({ res, lane }) => {
    const start = new Date(res.start_time).getTime();
    const end   = new Date(res.end_time).getTime();
    const totalLanes = assigned
      .filter(({ res: o }) =>
        new Date(o.start_time).getTime() < end &&
        new Date(o.end_time).getTime()   > start
      )
      .reduce((mx, { lane: l }) => Math.max(mx, l + 1), 1);
    return { res, lane, totalLanes };
  });
}

function colorForId(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = ((h << 5) - h) + id.charCodeAt(i);
    h |= 0;
  }
  return COLORS[Math.abs(h) % COLORS.length];
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ============================================================
// データ層
// ============================================================
async function fetchRooms() {
  const { data, error } = await db.from('rooms').select('*').order('display_order');
  if (error) throw error;
  return data;
}

async function fetchReservationsForDate(date) {
  const ds = dateString(date);
  const { data, error } = await db
    .from('reservations')
    .select('*')
    .lt('start_time', `${ds}T23:59:59+09:00`)
    .gt('end_time',   `${ds}T00:00:00+09:00`)
    .order('start_time');
  if (error) throw error;
  return data;
}

async function fetchReservationsForRange(startDate, endDate) {
  const { data, error } = await db
    .from('reservations')
    .select('*')
    .lt('start_time', `${dateString(endDate)}T23:59:59+09:00`)
    .gt('end_time',   `${dateString(startDate)}T00:00:00+09:00`)
    .order('start_time');
  if (error) throw error;
  return data;
}

async function loadReservationsForView() {
  if (state.viewMode === 'day') {
    state.reservations = await fetchReservationsForDate(state.currentDate);
  } else if (state.viewMode === 'week') {
    const days = getWeekDays(state.currentDate);
    state.reservations = await fetchReservationsForRange(days[0], days[6]);
  } else {
    state.reservations = await fetchReservationsForRange(
      getMonthStart(state.currentDate),
      getMonthEnd(state.currentDate)
    );
  }
}

async function insertReservation({ roomId, name, purpose, startTime, endTime }) {
  const { data, error } = await db
    .from('reservations')
    .insert([{
      room_id: roomId, name, purpose,
      start_time: startTime, end_time: endTime,
      created_by: currentUser?.id ?? null,
    }])
    .select();
  if (error) throw error;
  return data[0];
}

async function deleteReservation(id) {
  const { error } = await db.from('reservations').delete().eq('id', id);
  if (error) throw error;
}

async function updateRoomName(id, name) {
  const { error } = await db.from('rooms').update({ name }).eq('id', id);
  if (error) throw error;
}

async function insertRoom(name, order) {
  const { data, error } = await db
    .from('rooms')
    .insert([{ name, display_order: order }])
    .select();
  if (error) throw error;
  return data[0];
}

async function deleteRoom(id) {
  const { error } = await db.from('rooms').delete().eq('id', id);
  if (error) throw error;
}

async function fetchProfiles() {
  const { data, error } = await db.from('profiles').select('*').order('created_at');
  if (error) throw error;
  return data ?? [];
}

async function updateMemberRole(userId, role) {
  const { error } = await db.from('profiles').update({ role }).eq('id', userId);
  if (error) throw error;
}

// 管理者専用: Edge Function 経由で招待メールを送信
// Edge Function がデプロイ済みの場合は USE_EDGE_FUNCTION を true にする
const USE_EDGE_FUNCTION = true;

async function sendInvite(email) {
  if (!USE_EDGE_FUNCTION) {
    // Edge Function 未デプロイ時は Supabase 管理画面を開く
    const projectRef = CONFIG.supabaseUrl.replace('https://', '').split('.')[0];
    window.open(
      `https://supabase.com/dashboard/project/${projectRef}/auth/users`,
      '_blank'
    );
    throw new Error(
      `Edge Function が未デプロイです。\n` +
      `開いた Supabase 管理画面の「Invite user」から\n${email} を招待してください。`
    );
  }
  const { data: { session } } = await db.auth.getSession();
  const res = await fetch(`${CONFIG.supabaseUrl}/functions/v1/invite-user`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`,
      'apikey': CONFIG.supabaseKey,
    },
    body: JSON.stringify({ email }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? '招待に失敗しました');
  return json;
}

// 管理者専用: Edge Function 経由でユーザーを削除
async function sendDeleteUser(userId) {
  const { data: { session } } = await db.auth.getSession();
  const res = await fetch(`${CONFIG.supabaseUrl}/functions/v1/delete-user`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`,
      'apikey': CONFIG.supabaseKey,
    },
    body: JSON.stringify({ userId }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? '削除に失敗しました');
  return json;
}

// ============================================================
// ロード & レンダ
// ============================================================
async function loadAll() {
  state.rooms = await fetchRooms();
  await loadReservationsForView();
  render();
}

function render() {
  applySettings();
  renderDateNav();
  if (state.viewMode === 'day')        renderCalendar();
  else if (state.viewMode === 'week')  renderWeekly();
  else                                 renderMonthly();
}

function applySettings() {
  const name = state.settings.labName;
  document.getElementById('lab-name').textContent = name;
  document.title = name;
}

function renderDateNav() {
  document.getElementById('current-date').textContent = formatViewTitle();
  updateViewButtons();
}

function renderCalendar() {
  const container = document.getElementById('calendar-container');
  const { startHour, endHour } = state.settings;
  const totalMin = (endHour - startHour) * 60;
  const totalPx  = totalMin * PX_PER_MIN_DAY;

  const grid = document.createElement('div');
  grid.className = 'cal-grid';

  // 時刻列
  const timeCol = document.createElement('div');
  timeCol.className = 'cal-time-col';

  const corner = document.createElement('div');
  corner.className = 'cal-corner';
  corner.style.height = `${ROOM_HDR_H}px`;
  timeCol.appendChild(corner);

  const timeBody = document.createElement('div');
  timeBody.className = 'cal-time-body';
  timeBody.style.height = `${totalPx}px`;

  for (let h = startHour; h <= endHour; h++) {
    const topPx = (h - startHour) * 60 * PX_PER_MIN_DAY;
    if (topPx > totalPx) break;
    const label = document.createElement('div');
    label.className = 'cal-time-label';
    label.style.top = `${topPx}px`;
    label.textContent = `${pad2(h)}:00`;
    timeBody.appendChild(label);
  }
  timeCol.appendChild(timeBody);
  grid.appendChild(timeCol);

  // 部屋列
  for (const room of state.rooms) {
    const col = document.createElement('div');
    col.className = 'cal-room-col';

    const header = document.createElement('div');
    header.className = 'cal-room-header';
    header.style.height = `${ROOM_HDR_H}px`;
    header.textContent = room.name;
    col.appendChild(header);

    const body = document.createElement('div');
    body.className = 'cal-room-body';
    body.style.height = `${totalPx}px`;
    body.dataset.roomId = room.id;

    for (let min = 0; min < totalMin; min += SLOT_MIN) {
      const slot = document.createElement('div');
      slot.className = 'cal-slot'
        + (min % 60 === 0 ? ' hour-line' : min % 30 === 0 ? ' half-line' : '');
      slot.style.top    = `${min * PX_PER_MIN_DAY}px`;
      slot.style.height = `${SLOT_MIN * PX_PER_MIN_DAY}px`;
      slot.dataset.time = minutesToHHMM(startHour * 60 + min);
      body.appendChild(slot);
    }

    const roomRes = state.reservations.filter(r => r.room_id === room.id);
    for (const res of roomRes) {
      const sd   = new Date(res.start_time);
      const ed   = new Date(res.end_time);
      const sMin = sd.getHours() * 60 + sd.getMinutes() - startHour * 60;
      const eMin = ed.getHours() * 60 + ed.getMinutes() - startHour * 60;
      const cs   = Math.max(0, sMin);
      const ce   = Math.min(totalMin, eMin);
      if (ce <= cs) continue;

      const block = document.createElement('div');
      block.className        = 'cal-res-block';
      block.style.top        = `${cs * PX_PER_MIN_DAY}px`;
      block.style.height     = `${(ce - cs) * PX_PER_MIN_DAY}px`;
      block.style.background = colorForId(res.id);
      block.style.minHeight  = '20px';
      block.dataset.resId    = res.id;

      const nm = document.createElement('div');
      nm.className   = 'res-name';
      nm.textContent = res.name;
      const pu = document.createElement('div');
      pu.className   = 'res-purpose';
      pu.textContent = res.purpose;
      block.appendChild(nm);
      block.appendChild(pu);
      body.appendChild(block);
    }

    body.addEventListener('click', (e) => {
      const rb = e.target.closest('.cal-res-block');
      if (rb) { openDetailModal(rb.dataset.resId); return; }
      const sl = e.target.closest('.cal-slot');
      if (sl)  { openReserveModal(room.id, sl.dataset.time); }
    });

    col.appendChild(body);
    grid.appendChild(col);
  }

  // 現在時刻ライン（今日のみ）
  const today = todayMidnight();
  if (state.currentDate.getTime() === today.getTime()) {
    const now    = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes() - startHour * 60;
    if (nowMin >= 0 && nowMin <= totalMin) {
      grid.querySelectorAll('.cal-room-body').forEach(b => {
        const line = document.createElement('div');
        line.className = 'cal-now-line';
        line.style.top = `${nowMin * PX_PER_MIN_DAY}px`;
        b.appendChild(line);
      });
    }
  }

  container.innerHTML = '';
  container.appendChild(grid);

  if (state.currentDate.getTime() === today.getTime()) {
    const now    = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes() - startHour * 60;
    if (nowMin > 0) container.scrollTop = Math.max(0, nowMin * PX_PER_MIN_DAY - 120);
  }
}

// ============================================================
// 週ビュー
// ============================================================
function renderWeekly() {
  const container = document.getElementById('calendar-container');
  const { startHour, endHour } = state.settings;
  const totalMin = (endHour - startHour) * 60;
  const totalPx  = totalMin * PX_PER_MIN_WEEK;
  const days     = getWeekDays(state.currentDate);
  const today    = todayMidnight();
  const now      = new Date();

  const grid = document.createElement('div');
  grid.className = 'cal-grid';

  // 時刻列
  const timeCol = document.createElement('div');
  timeCol.className = 'cal-time-col';
  const corner = document.createElement('div');
  corner.className = 'cal-corner';
  corner.style.height = `${ROOM_HDR_H}px`;
  timeCol.appendChild(corner);
  const timeBody = document.createElement('div');
  timeBody.className = 'cal-time-body';
  timeBody.style.height = `${totalPx}px`;
  for (let h = startHour; h <= endHour; h++) {
    const topPx = (h - startHour) * 60 * PX_PER_MIN_WEEK;
    if (topPx > totalPx) break;
    const label = document.createElement('div');
    label.className = 'cal-time-label';
    label.style.top = `${topPx}px`;
    label.textContent = `${pad2(h)}:00`;
    timeBody.appendChild(label);
  }
  timeCol.appendChild(timeBody);
  grid.appendChild(timeCol);

  // 曜日列
  for (const day of days) {
    const isToday = day.getTime() === today.getTime();
    const col = document.createElement('div');
    col.className = 'cal-room-col' + (isToday ? ' cal-today-col' : '');
    col.style.minWidth = '110px';

    // ヘッダー
    const header = document.createElement('div');
    header.className = 'cal-room-header' + (isToday ? ' cal-today-header' : '');
    header.style.height = `${ROOM_HDR_H}px`;
    const dowNames = ['日','月','火','水','木','金','土'];
    const dowClass = day.getDay() === 0 ? 'sun' : day.getDay() === 6 ? 'sat' : '';
    header.innerHTML = `<span>${day.getMonth()+1}/${day.getDate()}</span><span class="dow-label ${dowClass}">${dowNames[day.getDay()]}</span>`;
    col.appendChild(header);

    // ボディ
    const body = document.createElement('div');
    body.className = 'cal-room-body';
    body.style.height = `${totalPx}px`;

    // 時間グリッド線
    for (let min = 0; min < totalMin; min += 60) {
      const ln = document.createElement('div');
      ln.className = 'cal-slot hour-line';
      ln.style.top = `${min * PX_PER_MIN_WEEK}px`;
      ln.style.height = `${60 * PX_PER_MIN_WEEK}px`;
      body.appendChild(ln);
    }
    for (let min = 30; min < totalMin; min += 60) {
      const ln = document.createElement('div');
      ln.className = 'cal-slot half-line';
      ln.style.top = `${min * PX_PER_MIN_WEEK}px`;
      ln.style.height = `${30 * PX_PER_MIN_WEEK}px`;
      body.appendChild(ln);
    }

    // この日の予約（全部屋）
    const dayRes = state.reservations.filter(r => {
      return new Date(r.start_time).toDateString() === day.toDateString();
    });
    const laned = assignLanes(dayRes);

    for (const { res, lane, totalLanes } of laned) {
      const sd   = new Date(res.start_time);
      const ed   = new Date(res.end_time);
      const sMin = sd.getHours() * 60 + sd.getMinutes() - startHour * 60;
      const eMin = ed.getHours() * 60 + ed.getMinutes() - startHour * 60;
      const cs   = Math.max(0, sMin);
      const ce   = Math.min(totalMin, eMin);
      if (ce <= cs) continue;

      const pct   = 100 / totalLanes;
      const block = document.createElement('div');
      block.className        = 'cal-res-block';
      block.style.top        = `${cs * PX_PER_MIN_WEEK}px`;
      block.style.height     = `${Math.max((ce - cs) * PX_PER_MIN_WEEK, 14)}px`;
      block.style.background = colorForId(res.id);
      block.style.left       = `${lane * pct}%`;
      block.style.right      = 'auto';
      block.style.width      = `calc(${pct}% - 3px)`;
      block.style.minHeight  = '14px';
      block.dataset.resId    = res.id;

      const nm = document.createElement('div');
      nm.className   = 'res-name';
      nm.style.fontSize = '10px';
      nm.textContent = res.name;
      block.appendChild(nm);
      body.appendChild(block);
    }

    // 現在時刻ライン
    if (isToday) {
      const nowMin = now.getHours() * 60 + now.getMinutes() - startHour * 60;
      if (nowMin >= 0 && nowMin <= totalMin) {
        const line = document.createElement('div');
        line.className = 'cal-now-line';
        line.style.top = `${nowMin * PX_PER_MIN_WEEK}px`;
        body.appendChild(line);
      }
    }

    // クリック: 予約詳細 or 日ビューへ遷移
    body.addEventListener('click', async (e) => {
      const rb = e.target.closest('.cal-res-block');
      if (rb) { openDetailModal(rb.dataset.resId); return; }
      state.currentDate = new Date(day);
      state.viewMode = 'day';
      state.reservations = await fetchReservationsForDate(state.currentDate);
      render();
    });

    col.appendChild(body);
    grid.appendChild(col);
  }

  container.innerHTML = '';
  container.appendChild(grid);

  // 今週なら現在時刻付近にスクロール
  if (days.some(d => d.getTime() === today.getTime())) {
    const nowMin = now.getHours() * 60 + now.getMinutes() - startHour * 60;
    if (nowMin > 0) container.scrollTop = Math.max(0, nowMin * PX_PER_MIN_WEEK - 100);
  }
}

// ============================================================
// 月ビュー
// ============================================================
function renderMonthly() {
  const container = document.getElementById('calendar-container');
  const weeks     = getCalendarWeeks(state.currentDate);
  const today     = todayMidnight();
  const curMonth  = state.currentDate.getMonth();

  const wrapper = document.createElement('div');
  wrapper.className = 'month-wrapper';

  // 曜日ヘッダー
  const dowRow = document.createElement('div');
  dowRow.className = 'month-dow-row';
  ['月','火','水','木','金','土','日'].forEach((d, i) => {
    const cell = document.createElement('div');
    cell.className = 'month-dow-cell' + (i === 5 ? ' sat' : i === 6 ? ' sun' : '');
    cell.textContent = d;
    dowRow.appendChild(cell);
  });
  wrapper.appendChild(dowRow);

  const weeksEl = document.createElement('div');
  weeksEl.className = 'month-weeks';

  for (const week of weeks) {
    const weekRow = document.createElement('div');
    weekRow.className = 'month-week-row';

    for (const day of week) {
      const isCurrentMonth = day.getMonth() === curMonth;
      const isToday        = day.getTime() === today.getTime();
      const dowClass       = day.getDay() === 6 ? ' sat' : day.getDay() === 0 ? ' sun' : '';

      const dayRes = state.reservations.filter(r =>
        new Date(r.start_time).toDateString() === day.toDateString()
      );

      const cell = document.createElement('div');
      cell.className = 'month-day-cell'
        + (isCurrentMonth ? '' : ' other-month')
        + (isToday ? ' is-today' : '')
        + dowClass;
      cell.dataset.date = dateString(day);

      const dayNum = document.createElement('div');
      dayNum.className = 'month-day-num';
      dayNum.textContent = day.getDate();
      cell.appendChild(dayNum);

      const visible = dayRes.slice(0, 3);
      const hidden  = dayRes.length - 3;
      for (const res of visible) {
        const chip = document.createElement('div');
        chip.className      = 'month-res-chip';
        chip.style.background = colorForId(res.id);
        chip.dataset.resId  = res.id;
        chip.textContent    = `${formatHHMM(new Date(res.start_time))} ${res.name}`;
        cell.appendChild(chip);
      }
      if (hidden > 0) {
        const more = document.createElement('div');
        more.className   = 'month-more';
        more.textContent = `+${hidden} 件`;
        cell.appendChild(more);
      }

      cell.addEventListener('click', async (e) => {
        const chip = e.target.closest('.month-res-chip');
        if (chip) { openDetailModal(chip.dataset.resId); return; }
        state.currentDate = new Date(day);
        state.viewMode = 'day';
        state.reservations = await fetchReservationsForDate(state.currentDate);
        render();
      });

      weekRow.appendChild(cell);
    }
    weeksEl.appendChild(weekRow);
  }

  wrapper.appendChild(weeksEl);
  container.innerHTML = '';
  container.appendChild(wrapper);
}

// ============================================================
// モーダル
// ============================================================
const overlay = document.getElementById('modal-overlay');

function showModal(id) {
  overlay.classList.remove('hidden');
  document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
  document.getElementById(id).classList.remove('hidden');
}

function closeModal() {
  overlay.classList.add('hidden');
}

// 予約モーダル
function openReserveModal(roomId, timeStr) {
  state.ui.selectedRoomId = roomId;

  const room = state.rooms.find(r => r.id === roomId);
  document.getElementById('modal-res-room').textContent = room?.name ?? '';

  // 表示名が設定されていれば自動入力
  document.getElementById('modal-res-name').value    = currentProfile?.display_name ?? '';
  document.getElementById('modal-res-purpose').value = '';
  document.getElementById('modal-res-error').classList.add('hidden');

  buildStartTimeSelect(timeStr);

  showModal('modal-reserve');
  // 表示名あり → 用途にフォーカス、なし → 名前にフォーカス
  const focusId = currentProfile?.display_name ? 'modal-res-purpose' : 'modal-res-name';
  setTimeout(() => document.getElementById(focusId).focus(), 80);
}

function buildStartTimeSelect(selectedTime) {
  const startSelect = document.getElementById('modal-res-start-select');
  startSelect.innerHTML = '';
  const minMin = state.settings.startHour * 60;
  const maxMin = state.settings.endHour * 60 - SLOT_MIN;

  for (let m = minMin; m <= maxMin; m += SLOT_MIN) {
    const hhmm      = minutesToHHMM(m);
    const opt       = document.createElement('option');
    opt.value       = hhmm;
    opt.textContent = hhmm;
    if (hhmm === selectedTime) opt.selected = true;
    startSelect.appendChild(opt);
  }
  // 選択時刻が範囲外のときは先頭を選択
  if (!startSelect.value) startSelect.options[0].selected = true;

  buildEndTimeSelect(HHMMToMinutes(startSelect.value));
}

function buildEndTimeSelect(startMinutes) {
  const endSelect  = document.getElementById('modal-res-end');
  const prevValue  = endSelect.value;
  endSelect.innerHTML = '';
  const maxMin = state.settings.endHour * 60;

  for (let m = startMinutes + SLOT_MIN; m <= maxMin; m += SLOT_MIN) {
    const hhmm      = minutesToHHMM(m);
    const opt       = document.createElement('option');
    opt.value       = hhmm;
    opt.textContent = hhmm;
    endSelect.appendChild(opt);
  }

  // 前の終了時刻を維持 or デフォルト +1時間
  const defaultEnd = minutesToHHMM(Math.min(startMinutes + 60, maxMin));
  const target = (prevValue && HHMMToMinutes(prevValue) > startMinutes) ? prevValue : defaultEnd;
  for (const opt of endSelect.options) {
    if (opt.value === target) { opt.selected = true; break; }
  }
  if (!endSelect.value && endSelect.options.length) endSelect.options[0].selected = true;
}

// 開始時刻変更 → 終了時刻を再構築
document.getElementById('modal-res-start-select').addEventListener('change', (e) => {
  buildEndTimeSelect(HHMMToMinutes(e.target.value));
});

// 詳細モーダル
function openDetailModal(resId) {
  const res = state.reservations.find(r => r.id === resId);
  if (!res) return;
  state.ui.selectedReservation = res;

  const room = state.rooms.find(r => r.id === res.room_id);
  const sd   = new Date(res.start_time);
  const ed   = new Date(res.end_time);

  document.getElementById('detail-room').textContent    = room?.name ?? '';
  document.getElementById('detail-time').textContent    = `${formatHHMM(sd)} 〜 ${formatHHMM(ed)}`;
  document.getElementById('detail-name').textContent    = res.name;
  document.getElementById('detail-purpose').textContent = res.purpose;

  // 管理者 or 自分が作成した予約のみ削除可
  const canDelete = isAdmin() || res.created_by === currentUser?.id;
  document.getElementById('btn-detail-delete').classList.toggle('hidden', !canDelete);

  showModal('modal-detail');
}

// 設定モーダル
function openSettingsModal() {
  document.getElementById('setting-lab-name').value = state.settings.labName;

  ['setting-start-hour', 'setting-end-hour'].forEach((selId, idx) => {
    const sel = document.getElementById(selId);
    sel.innerHTML = '';
    for (let h = 0; h <= 24; h++) {
      const opt       = document.createElement('option');
      opt.value       = h;
      opt.textContent = `${pad2(h)}:00`;
      const target    = idx === 0 ? state.settings.startHour : state.settings.endHour;
      if (h === target) opt.selected = true;
      sel.appendChild(opt);
    }
  });

  // 管理者タブの表示制御
  document.querySelectorAll('.tab-admin-only').forEach(el => {
    el.classList.toggle('hidden', !isAdmin());
  });

  // 最初のタブをアクティブに
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
  document.querySelector('.tab-btn[data-tab="tab-general"]').classList.add('active');
  document.getElementById('tab-general').classList.remove('hidden');

  renderRoomSettingsList();
  showModal('modal-settings');
}

function renderRoomSettingsList() {
  const list = document.getElementById('rooms-setting-list');
  list.innerHTML = '';
  state.rooms.forEach(room => {
    const row = document.createElement('div');
    row.className = 'room-setting-row';
    row.innerHTML = `
      <input type="text" class="room-name-input" data-id="${room.id}" value="${escHtml(room.name)}" placeholder="部屋名">
      <button class="btn-icon btn-delete-room" data-id="${room.id}"
        ${state.rooms.length <= 1 ? 'disabled title="最低1部屋必要です"' : ''}>✕</button>
    `;
    list.appendChild(row);
  });
}

// 設定タブ切り替え
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.tab).classList.remove('hidden');

    if (btn.dataset.tab === 'tab-members') loadMembersTab();
  });
});

async function loadMembersTab() {
  const list = document.getElementById('members-list');
  list.innerHTML = '<span class="loading-text">読み込み中…</span>';
  try {
    const members = await fetchProfiles();
    if (members.length === 0) {
      list.innerHTML = '<span class="loading-text">メンバーがいません</span>';
      return;
    }
    list.innerHTML = '';
    for (const m of members) {
      const isSelf = m.id === currentUser?.id;
      const row = document.createElement('div');
      row.className = 'member-row';
      row.innerHTML = `
        <div style="min-width:0;flex:1">
          <div class="member-email">${escHtml(m.display_name || m.email || '')}</div>
          ${m.display_name ? `<div class="member-meta">${escHtml(m.email ?? '')}</div>` : ''}
          ${isSelf ? '<div class="member-meta">（あなた）</div>' : ''}
        </div>
        <div class="member-actions" style="display:flex;align-items:center;gap:6px;flex-shrink:0">
          ${isSelf
            ? `<span class="role-badge ${m.role}">${m.role === 'admin' ? '管理者' : 'メンバー'}</span>`
            : `<select class="role-select" data-user-id="${m.id}">
                 <option value="member" ${m.role === 'member' ? 'selected' : ''}>メンバー</option>
                 <option value="admin"  ${m.role === 'admin'  ? 'selected' : ''}>管理者</option>
               </select>
               <button class="btn-icon btn-delete-member" data-user-id="${m.id}" data-name="${escHtml(m.display_name || m.email || '')}" title="削除">✕</button>`
          }
        </div>
      `;
      list.appendChild(row);
    }

    // 権限変更
    list.querySelectorAll('.role-select').forEach(sel => {
      sel.addEventListener('change', async () => {
        const userId = sel.dataset.userId;
        const role   = sel.value;
        try {
          await updateMemberRole(userId, role);
        } catch (err) {
          alert('権限の変更に失敗しました: ' + err.message);
          await loadMembersTab();
        }
      });
    });

    // メンバー削除
    list.querySelectorAll('.btn-delete-member').forEach(btn => {
      btn.addEventListener('click', async () => {
        const userId = btn.dataset.userId;
        const name   = btn.dataset.name;
        if (!confirm(`「${name}」を削除しますか？\nこの操作は取り消せません。`)) return;
        try {
          await sendDeleteUser(userId);
          await loadMembersTab();
        } catch (err) {
          alert('削除に失敗しました: ' + err.message);
        }
      });
    });
  } catch (err) {
    list.innerHTML = `<span class="loading-text" style="color:#ef4444">読み込みに失敗しました: ${err.message}</span>`;
  }
}

// 招待ボタン
document.getElementById('btn-invite').addEventListener('click', async () => {
  const email  = document.getElementById('invite-email').value.trim();
  const msgEl  = document.getElementById('invite-msg');
  const btn    = document.getElementById('btn-invite');

  if (!email) {
    showFeedback(msgEl, 'メールアドレスを入力してください', 'err');
    return;
  }

  btn.disabled    = true;
  btn.textContent = '送信中…';

  try {
    await sendInvite(email);
    document.getElementById('invite-email').value = '';
    showFeedback(msgEl, `${email} に招待メールを送りました`, 'ok');
    await loadMembersTab();
  } catch (err) {
    showFeedback(msgEl, err.message, 'err');
  } finally {
    btn.disabled    = false;
    btn.textContent = '招待メール送信';
  }
});

// ============================================================
// リアルタイム
// ============================================================
let realtimeChannel = null;

function setupRealtime() {
  if (realtimeChannel) {
    db.removeChannel(realtimeChannel);
  }
  realtimeChannel = db.channel('lab-realtime')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'reservations' }, async () => {
      await loadReservationsForView();
      render();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms' }, async () => {
      state.rooms = await fetchRooms();
      await loadReservationsForView();
      render();
    })
    .subscribe();
}

// ============================================================
// イベントハンドラ — 日付ナビ & ビュー切り替え
// ============================================================
document.getElementById('btn-today').addEventListener('click', async () => {
  state.currentDate = todayMidnight();
  await loadReservationsForView();
  render();
});

document.getElementById('btn-prev').addEventListener('click', async () => {
  if (state.viewMode === 'day') {
    state.currentDate.setDate(state.currentDate.getDate() - 1);
  } else if (state.viewMode === 'week') {
    state.currentDate.setDate(state.currentDate.getDate() - 7);
  } else {
    state.currentDate.setMonth(state.currentDate.getMonth() - 1);
  }
  await loadReservationsForView();
  render();
});

document.getElementById('btn-next').addEventListener('click', async () => {
  if (state.viewMode === 'day') {
    state.currentDate.setDate(state.currentDate.getDate() + 1);
  } else if (state.viewMode === 'week') {
    state.currentDate.setDate(state.currentDate.getDate() + 7);
  } else {
    state.currentDate.setMonth(state.currentDate.getMonth() + 1);
  }
  await loadReservationsForView();
  render();
});

document.querySelectorAll('.view-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    state.viewMode = btn.dataset.view;
    await loadReservationsForView();
    render();
  });
});

document.getElementById('btn-settings').addEventListener('click', openSettingsModal);
document.getElementById('btn-account').addEventListener('click', openAccountModal);

function openAccountModal() {
  document.getElementById('account-email').textContent = currentUser?.email ?? '';
  document.getElementById('account-display-name').value = currentProfile?.display_name ?? '';
  document.getElementById('account-new-pw').value = '';
  document.getElementById('account-new-pw-confirm').value = '';
  document.getElementById('account-error').classList.add('hidden');
  document.getElementById('account-success').classList.add('hidden');
  showModal('modal-account');
}

document.getElementById('btn-account-close').addEventListener('click', closeModal);

document.getElementById('btn-account-save').addEventListener('click', async () => {
  const displayName = document.getElementById('account-display-name').value.trim();
  const pw1   = document.getElementById('account-new-pw').value;
  const pw2   = document.getElementById('account-new-pw-confirm').value;
  const errEl = document.getElementById('account-error');
  const okEl  = document.getElementById('account-success');

  errEl.classList.add('hidden');
  okEl.classList.add('hidden');

  if (pw1 || pw2) {
    if (pw1.length < 8) { showInline(errEl, 'パスワードは8文字以上にしてください'); return; }
    if (pw1 !== pw2)    { showInline(errEl, 'パスワードが一致しません'); return; }
  }

  const btn = document.getElementById('btn-account-save');
  btn.disabled    = true;
  btn.textContent = '保存中…';

  try {
    // 表示名の更新
    await db.from('profiles')
      .update({ display_name: displayName || null })
      .eq('id', currentUser.id);
    currentProfile = { ...currentProfile, display_name: displayName || null };
    updateHeaderDisplay();

    // パスワードの更新
    if (pw1) {
      const { error } = await db.auth.updateUser({ password: pw1 });
      if (error) throw error;
      document.getElementById('account-new-pw').value = '';
      document.getElementById('account-new-pw-confirm').value = '';
    }

    okEl.textContent = '保存しました';
    okEl.classList.remove('hidden');
    setTimeout(() => okEl.classList.add('hidden'), 3000);
  } catch (err) {
    showInline(errEl, '保存に失敗しました: ' + err.message);
  } finally {
    btn.disabled    = false;
    btn.textContent = '保存';
  }
});

overlay.addEventListener('click', (e) => {
  if (e.target === overlay) closeModal();
});

// 予約モーダル
document.getElementById('btn-reserve-cancel').addEventListener('click', closeModal);

document.getElementById('btn-reserve-submit').addEventListener('click', async () => {
  if (state.ui.submitting) return;

  const name    = document.getElementById('modal-res-name').value.trim();
  const purpose = document.getElementById('modal-res-purpose').value.trim();
  const endStr  = document.getElementById('modal-res-end').value;
  const errEl   = document.getElementById('modal-res-error');

  if (!name)    { showInline(errEl, '名前を入力してください'); return; }
  if (!purpose) { showInline(errEl, '用途を入力してください'); return; }

  const startStr  = document.getElementById('modal-res-start-select').value;
  const startTime = buildISODateTime(state.currentDate, startStr);
  const endTime   = buildISODateTime(state.currentDate, endStr);

  state.ui.submitting = true;
  const btn = document.getElementById('btn-reserve-submit');
  btn.disabled    = true;
  btn.textContent = '処理中…';

  try {
    await insertReservation({
      roomId: state.ui.selectedRoomId,
      name, purpose, startTime, endTime,
    });
    closeModal();
    await loadReservationsForView();
    render();
  } catch (err) {
    const msg = (err.message ?? '').includes('RESERVATION_OVERLAP')
      ? 'その時間帯はすでに予約されています'
      : `予約に失敗しました: ${err.message}`;
    showInline(errEl, msg);
  } finally {
    state.ui.submitting = false;
    btn.disabled    = false;
    btn.textContent = '予約する';
  }
});

// 詳細モーダル
document.getElementById('btn-detail-close').addEventListener('click', closeModal);

document.getElementById('btn-detail-delete').addEventListener('click', async () => {
  if (!confirm('この予約を削除しますか？')) return;
  try {
    await deleteReservation(state.ui.selectedReservation.id);
    closeModal();
    await loadReservationsForView();
    render();
  } catch (err) {
    alert('削除に失敗しました: ' + err.message);
  }
});

// 設定モーダル
document.getElementById('btn-settings-close').addEventListener('click', closeModal);

document.getElementById('btn-add-room').addEventListener('click', async () => {
  const name = prompt('新しい部屋の名前:', `部屋 ${state.rooms.length + 1}`);
  if (!name?.trim()) return;
  try {
    await insertRoom(name.trim(), state.rooms.length);
    state.rooms = await fetchRooms();
    renderRoomSettingsList();
    render();
  } catch (err) {
    alert('追加に失敗しました: ' + err.message);
  }
});

document.getElementById('rooms-setting-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('.btn-delete-room');
  if (!btn || btn.disabled) return;
  const id = parseInt(btn.dataset.id);
  if (state.rooms.length <= 1) return;
  if (!confirm('この部屋を削除しますか？\n（この部屋の予約もすべて削除されます）')) return;
  try {
    await deleteRoom(id);
    state.rooms = await fetchRooms();
    await loadReservationsForView();
    renderRoomSettingsList();
    render();
  } catch (err) {
    alert('削除に失敗しました: ' + err.message);
  }
});

document.getElementById('btn-settings-save').addEventListener('click', async () => {
  const labName   = document.getElementById('setting-lab-name').value.trim() || '実験室予約システム';
  const startHour = parseInt(document.getElementById('setting-start-hour').value);
  const endHour   = parseInt(document.getElementById('setting-end-hour').value);

  if (startHour >= endHour) {
    alert('終了時刻は開始時刻より後にしてください');
    return;
  }

  const inputs = document.querySelectorAll('.room-name-input');
  try {
    for (const input of inputs) {
      const rid  = parseInt(input.dataset.id);
      const name = input.value.trim();
      if (name) await updateRoomName(rid, name);
    }
  } catch (err) {
    alert('部屋名の保存に失敗しました: ' + err.message);
    return;
  }

  state.settings = { labName, startHour, endHour };
  saveSettingsToStorage();
  state.rooms = await fetchRooms();
  await loadReservationsForView();
  closeModal();
  render();
});

// ============================================================
// UI ヘルパー
// ============================================================
function showInline(el, msg) {
  el.textContent = msg;
  el.classList.remove('hidden');
}

function showFeedback(el, msg, type) {
  el.textContent = msg;
  el.className = `invite-feedback ${type}`;
  el.classList.remove('hidden');
  if (type === 'ok') setTimeout(() => el.classList.add('hidden'), 5000);
}

// ============================================================
// 起動
// ============================================================
initAuth();
