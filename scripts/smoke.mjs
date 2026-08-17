const BASE = 'http://localhost:8787';
let pass = 0;
let fail = 0;

async function call(method, path, { body, token, headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function check(label, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  ✅ ${label}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${label} ${detail}`);
  }
}

const email = `long+${Date.now()}@example.com`;
const password = 'mat-khau-rat-dai-2026';

console.log('\n── AUTH ──');
const reg = await call('POST', '/v1/auth/register', { body: { email, password, displayName: 'Thanh Long' } });
check('register → 201', reg.status === 201, JSON.stringify(reg.body));
let access = reg.body?.tokens?.accessToken;
let refresh = reg.body?.tokens?.refreshToken;

const dup = await call('POST', '/v1/auth/register', { body: { email, password } });
check('register trùng email → 409 email_taken', dup.status === 409 && dup.body?.error?.code === 'email_taken');

const badLogin = await call('POST', '/v1/auth/login', { body: { email, password: 'sai-mat-khau-roi' } });
check('login sai mật khẩu → 401', badLogin.status === 401 && badLogin.body?.error?.code === 'invalid_credentials');

const login = await call('POST', '/v1/auth/login', { body: { email, password } });
check('login đúng → 200', login.status === 200 && Boolean(login.body?.tokens?.accessToken));

const me = await call('GET', '/v1/auth/me', { token: access });
check('me → đúng email', me.body?.user?.email === email);

const noAuth = await call('GET', '/v1/auth/me');
check('me không token → 401', noAuth.status === 401);

const badAuth = await call('GET', '/v1/auth/me', { token: 'khong-phai-token' });
check('me token rác → 401', badAuth.status === 401);

console.log('\n── SYNC PUSH ──');
const now = Date.now();
const changes = [
  { table: 'wallets', id: 'w1', payload: { name: 'Tiền mặt', kind: 'cash', currency: 'VND' }, updatedAt: now, deletedAt: null },
  { table: 'transactions', id: 't1', payload: { walletId: 'w1', amountMinor: 50000, note: 'Đi chợ' }, updatedAt: now, deletedAt: null },
  { table: 'transactions', id: 't2', payload: { walletId: 'w1', amountMinor: 100000, note: 'Ăn uống' }, updatedAt: now, deletedAt: null },
  { table: 'transactions', id: 't3', payload: { walletId: 'w1', amountMinor: 90000, note: 'Đổ xăng' }, updatedAt: now, deletedAt: null },
];

const push = await call('POST', '/v1/sync/push', { token: access, body: { changes } });
check('push 4 bản ghi → applied 4', push.body?.applied?.length === 4, JSON.stringify(push.body));
check('push trả cursor > 0', push.body?.cursor > 0);

const dupPush = await call('POST', '/v1/sync/push', {
  token: access,
  body: { changes: [
    { table: 'transactions', id: 't9', payload: { v: 1 }, updatedAt: now, deletedAt: null },
    { table: 'transactions', id: 't9', payload: { v: 2 }, updatedAt: now + 10, deletedAt: null },
  ] },
});
check('cùng id 2 lần trong 1 push → không lỗi', dupPush.status === 200, JSON.stringify(dupPush.body));

console.log('\n── SYNC PULL ──');
const pull = await call('POST', '/v1/sync/pull', { token: access, body: { since: 0 } });
check('pull từ 0 → 5 bản ghi', pull.body?.changes?.length === 5, JSON.stringify(pull.body?.changes?.length));
check('payload giữ nguyên tiếng Việt', pull.body?.changes?.find((r) => r.id === 't1')?.payload?.note === 'Đi chợ');
check('hasMore = false', pull.body?.hasMore === false);

const pullAgain = await call('POST', '/v1/sync/pull', { token: access, body: { since: pull.body.cursor } });
check('pull lại từ cursor → rỗng', pullAgain.body?.changes?.length === 0);

const pullFiltered = await call('POST', '/v1/sync/pull', { token: access, body: { since: 0, tables: ['wallets'] } });
check('pull lọc theo bảng → chỉ wallets', pullFiltered.body?.changes?.length === 1 && pullFiltered.body.changes[0].table === 'wallets');

console.log('\n── XUNG ĐỘT (last-write-wins) ──');
const stale = await call('POST', '/v1/sync/push', {
  token: access,
  body: { changes: [{ table: 'transactions', id: 't1', payload: { note: 'BẢN CŨ' }, updatedAt: now - 5000, deletedAt: null }] },
});
check('đẩy bản cũ hơn → applied rỗng', stale.body?.applied?.length === 0);
check('đẩy bản cũ hơn → trả về bản thắng', stale.body?.conflicts?.[0]?.payload?.note === 'Đi chợ', JSON.stringify(stale.body?.conflicts));

const fresh = await call('POST', '/v1/sync/push', {
  token: access,
  body: { changes: [{ table: 'transactions', id: 't1', payload: { note: 'BẢN MỚI' }, updatedAt: now + 5000, deletedAt: null }] },
});
check('đẩy bản mới hơn → applied', fresh.body?.applied?.length === 1);

const afterUpdate = await call('POST', '/v1/sync/pull', { token: access, body: { since: 0 } });
const t1 = afterUpdate.body.changes.find((r) => r.id === 't1');
check('pull thấy bản mới', t1?.payload?.note === 'BẢN MỚI');
check('bản sửa được đẩy lên cuối hàng đợi', t1.serverSeq === Math.max(...afterUpdate.body.changes.map((r) => r.serverSeq)));

console.log('\n── XOÁ (tombstone) ──');
const del = await call('POST', '/v1/sync/push', {
  token: access,
  body: { changes: [{ table: 'transactions', id: 't2', payload: {}, updatedAt: now + 9000, deletedAt: now + 9000 }] },
});
check('đẩy tombstone → applied', del.body?.applied?.length === 1);
const afterDelete = await call('POST', '/v1/sync/pull', { token: access, body: { since: 0 } });
check('tombstone về client kèm deletedAt', afterDelete.body.changes.find((r) => r.id === 't2')?.deletedAt !== null);

console.log('\n── CÁCH LY GIỮA NGƯỜI DÙNG ──');
const other = await call('POST', '/v1/auth/register', { body: { email: `khac+${Date.now()}@example.com`, password } });
const otherPull = await call('POST', '/v1/sync/pull', { token: other.body.tokens.accessToken, body: { since: 0 } });
check('user khác không thấy dữ liệu → rỗng', otherPull.body?.changes?.length === 0, JSON.stringify(otherPull.body));

console.log('\n── STATUS ──');
const status = await call('GET', '/v1/sync/status?since=0', { token: access });
check('status đếm đúng', status.body?.total === 5, JSON.stringify(status.body));

console.log('\n── VALIDATION ──');
const badTable = await call('POST', '/v1/sync/push', {
  token: access,
  body: { changes: [{ table: 'bang_khong_ton_tai', id: 'x', payload: {}, updatedAt: now }] },
});
check('bảng ngoài whitelist → 400', badTable.status === 400 && badTable.body?.error?.code === 'validation_error');

console.log('\n── REFRESH TOKEN ──');
const refreshed = await call('POST', '/v1/auth/refresh', { body: { refreshToken: refresh } });
check('refresh → cấp token mới', refreshed.status === 200 && Boolean(refreshed.body?.tokens?.accessToken));
const reused = await call('POST', '/v1/auth/refresh', { body: { refreshToken: refresh } });
check('dùng lại refresh cũ → 401 (đã xoay vòng)', reused.status === 401, JSON.stringify(reused.body));

const newRefresh = refreshed.body.tokens.refreshToken;
const logout = await call('POST', '/v1/auth/logout', { body: { refreshToken: newRefresh } });
check('logout → 204', logout.status === 204);
const afterLogout = await call('POST', '/v1/auth/refresh', { body: { refreshToken: newRefresh } });
check('refresh sau logout → 401', afterLogout.status === 401);

console.log('\n── AI ──');
const ai = await call('POST', '/v1/ai/categorize', {
  token: access,
  body: { text: 'Hôm nay đi chợ hết 50k, ăn uống 100k, đổ xăng 90k', categories: [{ id: 'c1', name: 'Đi chợ', kind: 'expense' }] },
});
// Three outcomes are all correct, and the client treats them identically:
//   200 → extraction worked
//   503 → no API key configured on this server
//   502 → upstream refused us (no credit, rate limited, outage)
// The contract being asserted is that the endpoint never returns a malformed
// body and never 500s, so the app can always fall back to its offline parser.
const aiOk =
  (ai.status === 200 && Array.isArray(ai.body?.transactions)) ||
  (ai.status === 503 && ai.body?.error?.code === 'ai_unavailable') ||
  (ai.status === 502 && ai.body?.error?.code === 'ai_failed');
check(`AI trả kết quả hợp lệ (HTTP ${ai.status})`, aiOk, JSON.stringify(ai.body));

console.log('\n── RATE LIMIT ──');
// Loopback is exempt outside production, so a forged x-forwarded-for is what
// puts this request on the same path a real internet caller takes.
const attacker = { 'x-forwarded-for': `203.0.113.${Date.now() % 250}` };
let blockedAt = 0;
for (let i = 1; i <= 13; i += 1) {
  const attempt = await call('POST', '/v1/auth/login', {
    headers: attacker,
    body: { email: 'nobody@example.com', password: 'doanmatkhau123' },
  });
  if (attempt.status === 429) { blockedAt = i; break; }
}
check('chặn dò mật khẩu sau ~10 lần', blockedAt > 0 && blockedAt <= 12, `chặn ở lần ${blockedAt}`);

const blocked = await call('POST', '/v1/auth/login', {
  headers: attacker,
  body: { email: 'nobody@example.com', password: 'doanmatkhau123' },
});
check('trả mã rate_limited', blocked.body?.error?.code === 'rate_limited', JSON.stringify(blocked.body));

// A different address must not inherit the block.
const otherIp = await call('POST', '/v1/auth/login', {
  headers: { 'x-forwarded-for': `198.51.100.${Date.now() % 250}` },
  body: { email: 'nobody@example.com', password: 'doanmatkhau123' },
});
check('IP khác không bị vạ lây', otherIp.status === 401, `HTTP ${otherIp.status}`);

console.log(`\n${'─'.repeat(40)}\nĐạt: ${pass}   Hỏng: ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
