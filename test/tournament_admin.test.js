/**
 * トーナメント管理画面の HTTP テスト。
 * 操作はすべてリダイレクトを挟むので、fetch の追従先の内容で結果を確かめる。
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');

const app = require('../app.js');
const store = require('../tournament/store.js');
const resultLog = require('../tournament/result_log.js');

let server;
let base;
let backup = null;

const form = (obj) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(obj),
});

const post = (path, obj) => fetch(`${base}${path}`, form(obj));
const adminHtml = async () => (await fetch(`${base}/tournament/admin`)).text();

test.before(async () => {
  delete process.env.ADMIN_KEY;
  backup = fs.existsSync(store.DATA_FILE) ? fs.readFileSync(store.DATA_FILE, 'utf8') : null;
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  delete process.env.ADMIN_KEY;
  if (backup === null) fs.rmSync(store.DATA_FILE, { force: true });
  else fs.writeFileSync(store.DATA_FILE, backup, 'utf8');
  await new Promise((resolve) => server.close(resolve));
});

/** 4人の対戦表を作った状態にする */
function seed() {
  let data = store.emptyTournament();
  data.title = '管理テスト大会';
  for (const n of ['あおい', 'はると', 'ゆい', 'そら']) store.addPlayer(data, n);
  return store.save(store.buildBracket(data));
}

/* --- 権限 --- */

test('ADMIN_KEY 設定時、管理画面は合言葉なしで拒否される', async () => {
  process.env.ADMIN_KEY = 'ひみつ';
  try {
    const res = await fetch(`${base}/tournament/admin`);
    assert.strictEqual(res.status, 403);
  } finally {
    delete process.env.ADMIN_KEY;
  }
});

test('ADMIN_KEY 設定時、更新操作も拒否される', async () => {
  seed();
  process.env.ADMIN_KEY = 'ひみつ';
  try {
    const res = await post('/tournament/admin/title', { title: '乗っ取り' });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(store.load().title, '管理テスト大会', '拒否されたのに変更されています');
  } finally {
    delete process.env.ADMIN_KEY;
  }
});

/* --- 大会名 --- */

test('大会名を変更できる', async () => {
  seed();
  const res = await post('/tournament/admin/title', { title: '静岡大会 2026' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(store.load().title, '静岡大会 2026');
});

test('大会名を空にすると既定名に戻る', async () => {
  seed();
  await post('/tournament/admin/title', { title: '   ' });
  assert.strictEqual(store.load().title, store.DEFAULT_TITLE);
});

/* --- 参加者 --- */

test('参加者を追加できる', async () => {
  store.save(store.emptyTournament());
  await post('/tournament/admin/players/add', { name: 'あたらしい選手', school: '静岡中' });

  const data = store.load();
  assert.strictEqual(data.players.length, 1);
  assert.strictEqual(data.players[0].name, 'あたらしい選手');
  assert.strictEqual(data.players[0].school, '静岡中');
});

test('名前が空の追加は拒否される', async () => {
  store.save(store.emptyTournament());
  const res = await post('/tournament/admin/players/add', { name: '  ' });
  assert.match(await res.text(), /名前を入力してください/);
  assert.strictEqual(store.load().players.length, 0);
});

test('参加者を外すと対戦表からも消える', async () => {
  const data = seed();
  const target = data.players[0];

  await post('/tournament/admin/players/remove', { id: target.id });

  const after = store.load();
  assert.ok(!after.players.some((p) => p.id === target.id));
  for (const round of after.rounds) {
    for (const m of round.matches) {
      assert.notStrictEqual(m.coolId, target.id);
      assert.notStrictEqual(m.hotId, target.id);
    }
  }
});

test('存在しない参加者を外そうとするとエラーになる', async () => {
  seed();
  const res = await post('/tournament/admin/players/remove', { id: 'いない人' });
  assert.match(await res.text(), /見つかりませんでした/);
});

/* --- 対戦表 --- */

test('参加者が1人だと対戦表を作れない', async () => {
  const data = store.emptyTournament();
  store.addPlayer(data, 'ひとり');
  store.save(data);

  const res = await post('/tournament/admin/build', {});
  assert.match(await res.text(), /2人以上/);
  assert.strictEqual(store.load().rounds.length, 0);
});

test('対戦表を作れる', async () => {
  const data = store.emptyTournament();
  for (const n of ['A', 'B', 'C', 'D']) store.addPlayer(data, n);
  store.save(data);

  await post('/tournament/admin/build', {});
  assert.strictEqual(store.load().rounds.length, 2);
});

test('対戦表を破棄しても参加者名簿は残る', async () => {
  seed();
  await post('/tournament/admin/reset', {});

  const after = store.load();
  assert.strictEqual(after.rounds.length, 0);
  assert.strictEqual(after.players.length, 4);
});

/* --- 勝敗の手入力 --- */

test('勝敗とスコアを記録し、勝者が次の回戦へ進む', async () => {
  const data = seed();
  const m = data.rounds[0].matches[0];

  await post('/tournament/admin/result', {
    matchId: m.id, winnerId: m.coolId, coolScore: '14', hotScore: '9',
    note: 'アイテム数により', roomId: 'room_111', movieId: 'final-2025',
  });

  const after = store.load();
  const saved = after.rounds[0].matches[0];
  assert.strictEqual(saved.winnerId, m.coolId);
  assert.strictEqual(saved.coolScore, 14);
  assert.strictEqual(saved.hotScore, 9);
  assert.strictEqual(saved.note, 'アイテム数により');
  assert.strictEqual(after.rounds[1].matches[0].coolId, m.coolId, '次の回戦へ進んでいません');
});

test('対戦者でない選手を勝者にできない', async () => {
  const data = seed();
  const m = data.rounds[0].matches[0];
  const outsider = data.rounds[0].matches[1].coolId;

  const res = await post('/tournament/admin/result', { matchId: m.id, winnerId: outsider });
  assert.match(await res.text(), /対戦者から選んで/);
  assert.strictEqual(store.load().rounds[0].matches[0].winnerId, null);
});

test('スコアを空にすると未入力として保存される', async () => {
  const data = seed();
  const m = data.rounds[0].matches[0];

  await post('/tournament/admin/result', { matchId: m.id, winnerId: '', coolScore: '', hotScore: '' });
  const saved = store.load().rounds[0].matches[0];
  assert.strictEqual(saved.coolScore, null);
  assert.strictEqual(saved.hotScore, null);
});

/* --- 自動記録の取り込み --- */

test('記録された結果を対戦カードへ取り込める', async () => {
  const data = seed();
  const m = data.rounds[0].matches[0];
  const cool = store.findPlayer(data, m.coolId);
  const hot = store.findPlayer(data, m.hotId);

  resultLog.clear();
  resultLog.recordResult('room_111', {
    name: '静岡予選マップ',
    cool: { name: cool.name, score: 13 },
    hot: { name: hot.name, score: 6 },
  }, 'cool', 'アイテム数により');

  const res = await post('/tournament/admin/import', { index: '0', matchId: m.id });
  assert.match(await res.text(), /取り込みました/);

  const saved = store.load().rounds[0].matches[0];
  assert.strictEqual(saved.winnerId, cool.id);
  assert.strictEqual(saved.coolScore, 13);
  assert.strictEqual(saved.hotScore, 6);
  assert.strictEqual(saved.note, 'アイテム数により');
  assert.strictEqual(saved.roomId, 'room_111');
});

test('ゲーム側と対戦表で cool/hot が逆でも正しく取り込む', async () => {
  const data = seed();
  const m = data.rounds[0].matches[0];
  const cool = store.findPlayer(data, m.coolId);
  const hot = store.findPlayer(data, m.hotId);

  resultLog.clear();
  // ゲーム側では対戦表と逆の割り当てになった場合
  resultLog.recordResult('room_112', {
    name: '静岡初戦マップ',
    cool: { name: hot.name, score: 15 },
    hot: { name: cool.name, score: 2 },
  }, 'cool', 'アタックにより');

  await post('/tournament/admin/import', { index: '0', matchId: m.id });

  const saved = store.load().rounds[0].matches[0];
  assert.strictEqual(saved.winnerId, hot.id, '勝者が入れ替わっていません');
  assert.strictEqual(saved.coolScore, 2, '対戦表側の cool のスコアが違います');
  assert.strictEqual(saved.hotScore, 15);
});

test('選手名が一致しない結果は取り込まない', async () => {
  const data = seed();
  const m = data.rounds[0].matches[0];

  resultLog.clear();
  resultLog.recordResult('room_111', {
    cool: { name: '知らない人', score: 1 },
    hot: { name: 'もっと知らない人', score: 2 },
  }, 'hot', '');

  const res = await post('/tournament/admin/import', { index: '0', matchId: m.id });
  assert.match(await res.text(), /選手名が一致しません/);
  assert.strictEqual(store.load().rounds[0].matches[0].winnerId, null, '取り込まれてしまっています');
});

test('引き分けは勝者を決めずに備考だけ残す', async () => {
  const data = seed();
  const m = data.rounds[0].matches[0];
  const cool = store.findPlayer(data, m.coolId);
  const hot = store.findPlayer(data, m.hotId);

  resultLog.clear();
  resultLog.recordResult('room_111', {
    cool: { name: cool.name, score: 7 },
    hot: { name: hot.name, score: 7 },
  }, 'draw', 'スコアより');

  await post('/tournament/admin/import', { index: '0', matchId: m.id });

  const saved = store.load().rounds[0].matches[0];
  assert.strictEqual(saved.winnerId, null, '引き分けなのに勝者が決まっています');
  assert.strictEqual(saved.note, '引き分け');
});

test('対戦者が未定の試合には取り込めない', async () => {
  const data = seed();
  const finalMatch = data.rounds[1].matches[0];

  resultLog.clear();
  resultLog.recordResult('room_111', { cool: { name: 'A', score: 1 }, hot: { name: 'B', score: 0 } }, 'cool', '');

  const res = await post('/tournament/admin/import', { index: '0', matchId: finalMatch.id });
  assert.match(await res.text(), /対戦者が両方とも決まっていません/);
});

test('存在しない記録の取り込みはエラーになる', async () => {
  seed();
  resultLog.clear();
  const res = await post('/tournament/admin/import', { index: '99', matchId: 'r1m1' });
  assert.match(await res.text(), /見つかりませんでした/);
});

/* --- 画面 --- */

test('管理画面に各セクションが出る', async () => {
  seed();
  const html = await adminHtml();
  for (const heading of ['大会名', '参加者', '対戦表', '勝敗の入力', 'サーバーが記録した試合結果']) {
    assert.ok(html.includes(heading), `${heading} が見当たりません`);
  }
});

test('自動では反映しないことが画面に書かれている', async () => {
  seed();
  assert.match(await adminHtml(), /自動で反映されません/);
});
