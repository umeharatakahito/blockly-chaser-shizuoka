const test = require('node:test');
const assert = require('node:assert');

const rules = require('../contest/rules.js');

/* --- 予選 --- */

test('予選の得点: 勝ちはアイテム×3＋残りターン、負けはアイテム×3−残りターン', () => {
  assert.strictEqual(rules.qualifierScore({ outcome: 'win', items: 5, turnsLeft: 20 }), 35);
  assert.strictEqual(rules.qualifierScore({ outcome: 'lose', items: 5, turnsLeft: 20 }), -5);
  assert.strictEqual(rules.qualifierScore({ outcome: 'draw', items: 5, turnsLeft: 0 }), 15);
});

test('試合結果を参加者(cool)から見た予選の記録に直す', () => {
  const run = rules.qualifierRunFromResult({
    roomId: 'room_011?q-e1-x', winner: 'hot', info: 'アタックにより', coolScore: 4, hotScore: 2, turnsLeft: 30,
  });
  assert.strictEqual(run.outcome, 'lose');
  assert.strictEqual(run.items, 4);
  assert.strictEqual(run.botItems, 2);
  assert.strictEqual(run.score, 4 * 3 - 30);
});

test('順位は得点→アイテム→残りターンで決まり、すべて同じなら同順位。未対戦は末尾', () => {
  const people = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, name: id.toUpperCase() }));
  const runs = {
    a: [{ score: 10, items: 3, turnsLeft: 1 }],
    b: [{ score: 30, items: 10, turnsLeft: 0 }],
    c: [{ score: 10, items: 3, turnsLeft: 1 }],
    d: [{ score: -40, items: 0, turnsLeft: 99 }, { score: 12, items: 4, turnsLeft: 0 }],   // やり直し: 最後を採用
  };
  const r = rules.qualifierRanking(people, runs);
  assert.deepStrictEqual(r.map((x) => x.participant.id), ['b', 'd', 'a', 'c', 'e']);
  assert.deepStrictEqual(r.map((x) => x.rank), [1, 2, 3, 3, null]);
  assert.strictEqual(r[1].run.score, 12);
});

/* --- 決勝トーナメント --- */

const match = (games, extra = {}) => Object.assign({ id: 'r1m1', coolId: 'A', hotId: 'B', games, sets: 1, replayRooms: [] }, extra);
const g = (no, winner, info, coolItems, hotItems, turnsLeft = 0) => ({ no, winner, info, coolItems, hotItems, turnsLeft });

test('1試合は2回。2回目は先攻と後攻を入れ替える', () => {
  const plan = rules.planGames(match([]), 'room_112');
  assert.deepStrictEqual(plan.map((x) => [x.no, x.coolId, x.hotId, x.roomId]), [[1, 'A', 'B', 'room_112'], [2, 'B', 'A', 'room_112']]);
});

test('勝利数が多い方の勝ち', () => {
  // 1回目: A(cool)の勝ち、2回目: A(hot)の勝ち
  const d = rules.decideMatch(match([g(1, 'cool', 'スコアより', 5, 3), g(2, 'hot', 'スコアより', 2, 6)]), 'room_112');
  assert.strictEqual(d.status, 'decided');
  assert.strictEqual(d.winnerId, 'A');
  assert.strictEqual(d.reason, '2勝0敗');
});

test('2回目が終わっていなければ保留', () => {
  const d = rules.decideMatch(match([g(1, 'cool', 'スコアより', 5, 3)]), 'room_112');
  assert.strictEqual(d.status, 'pending');
});

test('1勝1敗ならアイテム数の合計。Put された回は 0、自滅した回は 0−残りターン', () => {
  // 1回目: A が B をアタックで倒す(B は 7 個持っていたが 0 扱い)。A は 2 個
  // 2回目: B(cool) が勝つが、A(hot) はブロック衝突の自滅で 0−10
  const d = rules.decideMatch(match([
    g(1, 'cool', 'アタックにより', 2, 7, 40),
    g(2, 'cool', 'ブロック衝突により', 1, 9, 10),
  ]), 'room_112');
  assert.deepStrictEqual(d.items, { A: 2 + -10, B: 0 + 1 });
  assert.strictEqual(d.winnerId, 'B');
  assert.match(d.reason, /1勝1敗・アイテム 1対-8/);
});

test('タイムアウトは自滅として扱う', () => {
  assert.strictEqual(rules.adjustedItems(g(1, 'hot', 'タイムアウトより', 6, 1, 25), 'cool'), -25);
  assert.strictEqual(rules.adjustedItems(g(1, 'hot', 'タイムアウトより', 6, 1, 25), 'hot'), 1);
});

test('勝利数もアイテム数も同じなら再試合。再試合は別のマップで2回足す', () => {
  const tied = [g(1, 'cool', 'スコアより', 5, 3), g(2, 'cool', 'スコアより', 5, 3)];
  assert.strictEqual(rules.decideMatch(match(tied), 'room_112').status, 'replay');

  const m = match(tied.concat([g(3, 'draw', 'スコアより', 4, 4), g(4, 'hot', 'スコアより', 1, 2)]), { sets: 2, replayRooms: ['room_110'] });
  const plan = rules.planGames(m, 'room_112');
  assert.deepStrictEqual(plan.slice(2).map((x) => [x.no, x.coolId, x.roomId]), [[3, 'A', 'room_110'], [4, 'B', 'room_110']]);
  const d = rules.decideMatch(m, 'room_112');
  assert.strictEqual(d.status, 'decided');
  assert.strictEqual(d.winnerId, 'A');   // 4回目は hot 側の A の勝ち
  assert.strictEqual(d.set, 2);
});

test('回戦の既定のマップ: 決勝は逆さ富士、準決勝は浜名湖、それ以外は駿河湾', () => {
  assert.strictEqual(rules.defaultRoundRoom('決勝'), 'room_114');
  assert.strictEqual(rules.defaultRoundRoom('準決勝'), 'room_113');
  assert.strictEqual(rules.defaultRoundRoom('準々決勝'), 'room_112');
  assert.strictEqual(rules.defaultRoundRoom('1回戦'), 'room_112');
});
