const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const t = require('../tournament/store.js');

/** 名前の配列からトーナメントを作る */
function bracketOf(names) {
  let data = t.emptyTournament();
  for (const name of names) t.addPlayer(data, name);
  return t.buildBracket(data);
}

const nameOf = (data, id) => {
  const p = t.findPlayer(data, id);
  return p ? p.name : null;
};

/* --- 参加者 --- */

test('選手を追加すると一意な id が振られる', () => {
  const data = t.emptyTournament();
  t.addPlayer(data, 'あおい', '第一中学校');
  t.addPlayer(data, 'はると');

  assert.strictEqual(data.players.length, 2);
  assert.strictEqual(data.players[0].name, 'あおい');
  assert.strictEqual(data.players[0].school, '第一中学校');
  assert.notStrictEqual(data.players[0].id, data.players[1].id);
});

test('名前が空でも既定の名前が入る', () => {
  const data = t.emptyTournament();
  t.addPlayer(data, '   ');
  assert.match(data.players[0].name, /選手/);
});

test('選手を外すと対戦表の枠も空になる', () => {
  const data = bracketOf(['A', 'B', 'C', 'D']);
  const target = data.players[0].id;

  t.removePlayer(data, target);

  assert.ok(!data.players.some((p) => p.id === target));
  for (const round of data.rounds) {
    for (const m of round.matches) {
      assert.notStrictEqual(m.coolId, target);
      assert.notStrictEqual(m.hotId, target);
      assert.notStrictEqual(m.winnerId, target);
    }
  }
});

/* --- 対戦表の組み立て --- */

test('シード順は上位どうしが早く当たらない並びになる', () => {
  assert.deepStrictEqual(t.seedOrder(2), [1, 2]);
  assert.deepStrictEqual(t.seedOrder(4), [1, 4, 2, 3]);
  assert.deepStrictEqual(t.seedOrder(8), [1, 8, 4, 5, 2, 7, 3, 6]);
  assert.strictEqual(t.seedOrder(16).length, 16);
  assert.deepStrictEqual([...t.seedOrder(16)].sort((a, b) => a - b), Array.from({ length: 16 }, (_, i) => i + 1));
});

test('人数に応じた回戦数になる', () => {
  assert.strictEqual(bracketOf(['A', 'B']).rounds.length, 1);
  assert.strictEqual(bracketOf(['A', 'B', 'C']).rounds.length, 2);
  assert.strictEqual(bracketOf(['A', 'B', 'C', 'D']).rounds.length, 2);
  assert.strictEqual(bracketOf(['A', 'B', 'C', 'D', 'E']).rounds.length, 3);
  assert.strictEqual(bracketOf(Array.from({ length: 16 }, (_, i) => 'P' + i)).rounds.length, 4);
});

test('参加者が1人以下なら対戦表は空になる', () => {
  assert.deepStrictEqual(bracketOf([]).rounds, []);
  assert.deepStrictEqual(bracketOf(['A']).rounds, []);
});

test('回戦名は決勝から遡って付く', () => {
  const d = bracketOf(Array.from({ length: 16 }, (_, i) => 'P' + i));
  assert.deepStrictEqual(d.rounds.map((r) => r.name), ['1回戦', '準々決勝', '準決勝', '決勝']);
});

test('1回戦の試合数は参加人数の切り上げ2のべき乗の半分', () => {
  assert.strictEqual(bracketOf(['A', 'B', 'C', 'D', 'E', 'F']).rounds[0].matches.length, 4);
});

test('不戦勝は左右の山に分散し、両方空の試合を作らない', () => {
  const data = bracketOf(['A', 'B', 'C', 'D', 'E', 'F']);
  for (const m of data.rounds[0].matches) {
    assert.ok(m.coolId || m.hotId, '対戦者のいない試合ができています');
  }
});

test('不戦勝の選手は次の回戦へ自動で進む', () => {
  const data = bracketOf(['A', 'B', 'C', 'D', 'E', 'F']);

  const byeMatches = data.rounds[0].matches.filter((m) => !m.coolId || !m.hotId);
  assert.strictEqual(byeMatches.length, 2, '6人なら不戦勝は2件');

  for (const m of byeMatches) {
    assert.ok(m.winnerId, '不戦勝の勝者が決まっていません');
    assert.strictEqual(m.note, '不戦勝');
  }

  const advanced = data.rounds[1].matches.flatMap((m) => [m.coolId, m.hotId]).filter(Boolean);
  assert.strictEqual(advanced.length, 2, '2人が準決勝へ進んでいるはず');
});

test('全員が揃っていれば不戦勝は発生しない', () => {
  const data = bracketOf(['A', 'B', 'C', 'D']);
  for (const m of data.rounds[0].matches) {
    assert.strictEqual(m.winnerId, null);
    assert.strictEqual(m.note, '');
  }
});

/* --- 勝敗の記録と繰り上がり --- */

test('偶数番の試合の勝者は次の回戦の cool 側に入る', () => {
  const data = bracketOf(['A', 'B', 'C', 'D']);
  const m1 = data.rounds[0].matches[0];

  const res = t.setResult(data, m1.id, { winnerId: m1.coolId, coolScore: 12, hotScore: 8 });
  assert.ok(res.ok);
  assert.strictEqual(data.rounds[1].matches[0].coolId, m1.coolId);
});

test('奇数番の試合の勝者は次の回戦の hot 側に入る', () => {
  const data = bracketOf(['A', 'B', 'C', 'D']);
  const m2 = data.rounds[0].matches[1];

  t.setResult(data, m2.id, { winnerId: m2.hotId });
  assert.strictEqual(data.rounds[1].matches[0].hotId, m2.hotId);
});

test('スコアと備考が記録される', () => {
  const data = bracketOf(['A', 'B']);
  const m = data.rounds[0].matches[0];

  t.setResult(data, m.id, {
    winnerId: m.coolId, coolScore: 15, hotScore: 9,
    note: 'アタックにより', roomId: 'room_114', movieId: 'final-2026',
  });

  assert.strictEqual(m.coolScore, 15);
  assert.strictEqual(m.hotScore, 9);
  assert.strictEqual(m.note, 'アタックにより');
  assert.strictEqual(m.roomId, 'room_114');
  assert.strictEqual(m.movieId, 'final-2026');
});

test('その試合の対戦者以外は勝者にできない', () => {
  const data = bracketOf(['A', 'B', 'C', 'D']);
  const m1 = data.rounds[0].matches[0];
  const outsider = data.rounds[0].matches[1].coolId;

  const res = t.setResult(data, m1.id, { winnerId: outsider });
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /対戦者から選んで/);
  assert.strictEqual(m1.winnerId, null, '失敗したのに記録されています');
});

test('存在しない試合の記録は失敗する', () => {
  const data = bracketOf(['A', 'B']);
  const res = t.setResult(data, 'r9m9', { winnerId: null });
  assert.strictEqual(res.ok, false);
});

test('勝者を入れ直すと次の回戦の枠も入れ替わる', () => {
  const data = bracketOf(['A', 'B', 'C', 'D']);
  const m1 = data.rounds[0].matches[0];

  t.setResult(data, m1.id, { winnerId: m1.coolId });
  assert.strictEqual(data.rounds[1].matches[0].coolId, m1.coolId);

  t.setResult(data, m1.id, { winnerId: m1.hotId });
  assert.strictEqual(data.rounds[1].matches[0].coolId, m1.hotId, '入れ直しが反映されていません');
});

test('勝者を空にすると次の回戦の枠も空になる', () => {
  const data = bracketOf(['A', 'B', 'C', 'D']);
  const m1 = data.rounds[0].matches[0];

  t.setResult(data, m1.id, { winnerId: m1.coolId });
  t.setResult(data, m1.id, { winnerId: null });
  assert.strictEqual(data.rounds[1].matches[0].coolId, null);
});

test('決勝まで勝ち上がると優勝者が決まる', () => {
  const data = bracketOf(['A', 'B', 'C', 'D']);

  for (const m of data.rounds[0].matches) t.setResult(data, m.id, { winnerId: m.coolId });
  const final = data.rounds[1].matches[0];
  t.setResult(data, final.id, { winnerId: final.coolId });

  const winner = t.champion(data);
  assert.ok(winner);
  assert.strictEqual(winner.id, final.coolId);
});

test('決勝が終わるまで優勝者は決まらない', () => {
  assert.strictEqual(t.champion(bracketOf(['A', 'B', 'C', 'D'])), null);
});

/* --- 正規化と永続化 --- */

test('未知のキーは normalize で落ちる', () => {
  const dirty = {
    title: '静岡大会',
    evil: 'あぶない値',
    players: [{ id: 'p1', name: 'A', school: '中学', extra: 'x' }],
    rounds: [{ name: '決勝', extra: 'y', matches: [{ id: 'r1m1', coolId: 'p1', junk: 'z' }] }],
  };
  const clean = t.normalize(dirty);

  assert.strictEqual(clean.evil, undefined);
  assert.deepStrictEqual(Object.keys(clean.players[0]).sort(), ['id', 'name', 'school']);
  assert.deepStrictEqual(Object.keys(clean.rounds[0]).sort(), ['matches', 'name']);
  assert.deepStrictEqual(
    Object.keys(clean.rounds[0].matches[0]).sort(),
    ['coolId', 'coolScore', 'hotId', 'hotScore', 'id', 'movieId', 'note', 'roomId', 'winnerId']
  );
});

test('normalize は壊れた入力でも既定の形を返す', () => {
  for (const bad of [null, undefined, 'ただの文字列', 42, []]) {
    const clean = t.normalize(bad);
    assert.ok(Array.isArray(clean.players));
    assert.ok(Array.isArray(clean.rounds));
    assert.ok(clean.title);
  }
});

test('保存して読み直すと内容が一致する', () => {
  const backup = fs.existsSync(t.DATA_FILE) ? fs.readFileSync(t.DATA_FILE, 'utf8') : null;
  try {
    const data = bracketOf(['あおい', 'はると', 'ゆい', 'そら']);
    data.title = '保存テスト大会';
    t.setResult(data, data.rounds[0].matches[0].id, {
      winnerId: data.rounds[0].matches[0].coolId, coolScore: 10, hotScore: 3,
    });

    const saved = t.save(data);
    const loaded = t.load();
    assert.deepStrictEqual(loaded, saved);
    assert.strictEqual(loaded.title, '保存テスト大会');
    assert.strictEqual(loaded.rounds[0].matches[0].coolScore, 10);

    // 一時ファイルが残らないこと
    assert.ok(!fs.existsSync(t.DATA_FILE + '.tmp'));
  } finally {
    if (backup === null) fs.rmSync(t.DATA_FILE, { force: true });
    else fs.writeFileSync(t.DATA_FILE, backup, 'utf8');
  }
});

test('保存ファイルが無ければ空のトーナメントを返す', () => {
  const backup = fs.existsSync(t.DATA_FILE) ? fs.readFileSync(t.DATA_FILE, 'utf8') : null;
  try {
    fs.rmSync(t.DATA_FILE, { force: true });
    const loaded = t.load();
    assert.deepStrictEqual(loaded.players, []);
    assert.deepStrictEqual(loaded.rounds, []);
  } finally {
    if (backup !== null) fs.writeFileSync(t.DATA_FILE, backup, 'utf8');
  }
});

test('壊れた保存ファイルでも例外を投げず空を返す', () => {
  const backup = fs.existsSync(t.DATA_FILE) ? fs.readFileSync(t.DATA_FILE, 'utf8') : null;
  try {
    fs.mkdirSync(t.DATA_DIR, { recursive: true });
    fs.writeFileSync(t.DATA_FILE, '{ 壊れたJSON', 'utf8');
    const loaded = t.load();
    assert.deepStrictEqual(loaded.rounds, []);
  } finally {
    if (backup === null) fs.rmSync(t.DATA_FILE, { force: true });
    else fs.writeFileSync(t.DATA_FILE, backup, 'utf8');
  }
});
