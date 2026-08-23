/**
 * トーナメント表示ページの確認。
 * 参加者・観客向けなので、認証なしで見られることも確かめる。
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');

const app = require('../app.js');
const store = require('../tournament/store.js');
const { toView } = require('../routes/tournament.js');

let server;
let base;
let backup = null;

test.before(async () => {
  backup = fs.existsSync(store.DATA_FILE) ? fs.readFileSync(store.DATA_FILE, 'utf8') : null;
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (backup === null) fs.rmSync(store.DATA_FILE, { force: true });
  else fs.writeFileSync(store.DATA_FILE, backup, 'utf8');
  await new Promise((resolve) => server.close(resolve));
});

/** 4人の対戦表を作って保存する */
function seedBracket() {
  let data = store.emptyTournament();
  data.title = '表示テスト大会';
  for (const [name, school] of [['あおい', '第一中'], ['はると', '東中'], ['ゆい', '西中'], ['そら', '南中']]) {
    store.addPlayer(data, name, school);
  }
  data = store.buildBracket(data);
  const m = data.rounds[0].matches[0];
  store.setResult(data, m.id, {
    winnerId: m.coolId, coolScore: 14, hotScore: 9, note: 'アイテム数により', movieId: 'final-2025',
  });
  return store.save(data);
}

/* --- 表示用データの組み立て --- */

test('toView は選手 id を名前まで解決する', () => {
  const data = seedBracket();
  const view = toView(data);

  assert.strictEqual(view.title, '表示テスト大会');
  assert.strictEqual(view.playerCount, 4);
  const first = view.rounds[0].matches[0];
  assert.strictEqual(first.cool.name, 'あおい');
  assert.strictEqual(first.cool.school, '第一中');
  assert.strictEqual(first.coolScore, 14);
});

test('存在しない動画へのリンクは出さない', () => {
  let data = store.emptyTournament();
  for (const n of ['A', 'B']) store.addPlayer(data, n);
  data = store.buildBracket(data);
  store.setResult(data, data.rounds[0].matches[0].id, {
    winnerId: data.rounds[0].matches[0].coolId, movieId: 'この動画は存在しない',
  });

  assert.strictEqual(toView(data).rounds[0].matches[0].movieId, '');
});

test('存在する動画へのリンクは残す', () => {
  const view = toView(seedBracket());
  assert.strictEqual(view.rounds[0].matches[0].movieId, 'final-2025');
});

test('対戦者が未定の枠は null になる', () => {
  const view = toView(seedBracket());
  const final = view.rounds[1].matches[0];
  assert.strictEqual(final.hot, null, '勝者待ちの枠は null のはず');
});

/* --- HTTP --- */

test('GET /tournament は認証なしで見られる', async () => {
  seedBracket();
  const res = await fetch(`${base}/tournament`);
  assert.strictEqual(res.status, 200);

  const html = await res.text();
  assert.match(html, /表示テスト大会/);
  assert.match(html, /あおい/);
  assert.match(html, /準決勝|決勝/);
});

test('ADMIN_KEY を設定しても表示ページは誰でも見られる', async () => {
  process.env.ADMIN_KEY = 'ひみつ';
  try {
    const res = await fetch(`${base}/tournament`);
    assert.strictEqual(res.status, 200);
  } finally {
    delete process.env.ADMIN_KEY;
  }
});

test('GET /tournament/data は JSON を返す', async () => {
  seedBracket();
  const res = await fetch(`${base}/tournament/data`);
  assert.strictEqual(res.status, 200);

  const data = await res.json();
  assert.strictEqual(data.title, '表示テスト大会');
  assert.strictEqual(data.rounds.length, 2);
  assert.strictEqual(data.rounds[0].matches[0].cool.name, 'あおい');
});

test('対戦表が空でも 200 で案内を出す', async () => {
  store.save(store.emptyTournament());
  const res = await fetch(`${base}/tournament`);
  assert.strictEqual(res.status, 200);
  assert.match(await res.text(), /まだ作られていません/);
});

test('優勝が決まると表示に出る', async () => {
  let data = store.emptyTournament();
  for (const n of ['あおい', 'はると']) store.addPlayer(data, n);
  data = store.buildBracket(data);
  const m = data.rounds[0].matches[0];
  store.setResult(data, m.id, { winnerId: m.coolId, coolScore: 20, hotScore: 3 });
  store.save(data);

  const res = await fetch(`${base}/tournament`);
  const html = await res.text();
  assert.match(html, /bracket_champion/);
  assert.match(html, /優勝/);
});

test('トップページから対戦表へのリンクがある', async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /href="\/tournament"/);
});
