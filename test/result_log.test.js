const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const log = require('../tournament/result_log.js');

/** 実際の server_store[room] に近い形 */
const roomState = (overrides = {}) => Object.assign({
  name: '静岡決勝マップ',
  cool: { name: 'あおい', score: 12 },
  hot: { name: 'はると', score: 8 },
}, overrides);

/** LOG_FILE を退避して、後で戻す */
function withBackedUpLog(fn) {
  const existed = fs.existsSync(log.LOG_FILE);
  const backup = existed ? fs.readFileSync(log.LOG_FILE) : null;
  try {
    return fn();
  } finally {
    fs.rmSync(log.LOG_FILE, { recursive: true, force: true });
    if (backup !== null) fs.writeFileSync(log.LOG_FILE, backup);
  }
}

test.beforeEach(() => log.clear());

test('試合結果を組み立てて記録する', () => {
  withBackedUpLog(() => {
    const entry = log.recordResult('room_114', roomState(), 'cool', 'アタックにより');

    assert.strictEqual(entry.roomId, 'room_114');
    assert.strictEqual(entry.roomName, '静岡決勝マップ');
    assert.strictEqual(entry.coolName, 'あおい');
    assert.strictEqual(entry.hotName, 'はると');
    assert.strictEqual(entry.coolScore, 12);
    assert.strictEqual(entry.hotScore, 8);
    assert.strictEqual(entry.winner, 'cool');
    assert.strictEqual(entry.info, 'アタックにより');
    assert.match(entry.recordedAt, /^\d{4}-\d{2}-\d{2}T/);
  });
});

test('新しい結果が先頭に来る', () => {
  withBackedUpLog(() => {
    log.recordResult('room_111', roomState(), 'cool', '1件目');
    log.recordResult('room_112', roomState(), 'hot', '2件目');

    const recent = log.listRecent();
    assert.strictEqual(recent[0].info, '2件目');
    assert.strictEqual(recent[1].info, '1件目');
  });
});

test('winner は cool / hot / draw だけを受け付ける', () => {
  withBackedUpLog(() => {
    assert.strictEqual(log.recordResult('r', roomState(), 'cool', '').winner, 'cool');
    assert.strictEqual(log.recordResult('r', roomState(), 'hot', '').winner, 'hot');
    assert.strictEqual(log.recordResult('r', roomState(), 'draw', '').winner, 'draw');
    assert.strictEqual(log.recordResult('r', roomState(), 'でたらめ', '').winner, null);
  });
});

test('スコアが数値でなければ null にする', () => {
  withBackedUpLog(() => {
    const entry = log.recordResult('r', roomState({
      cool: { name: 'A', score: undefined },
      hot: { name: 'B', score: 'よん' },
    }), 'cool', '');

    assert.strictEqual(entry.coolScore, null);
    assert.strictEqual(entry.hotScore, null);
  });
});

test('room が null でも例外を投げない', () => {
  withBackedUpLog(() => {
    let entry;
    assert.doesNotThrow(() => { entry = log.recordResult('room_x', null, 'cool', ''); });
    assert.strictEqual(entry.coolName, '');
    assert.strictEqual(entry.roomId, 'room_x');
  });
});

test('引数がすべて未指定でも例外を投げない', () => {
  withBackedUpLog(() => {
    assert.doesNotThrow(() => log.recordResult());
  });
});

test('ファイルに書けなくても例外を投げず、記録は残る', () => {
  withBackedUpLog(() => {
    // LOG_FILE の場所をディレクトリにして appendFileSync を失敗させる
    fs.rmSync(log.LOG_FILE, { force: true });
    fs.mkdirSync(log.LOG_FILE, { recursive: true });

    let entry;
    assert.doesNotThrow(() => { entry = log.recordResult('room_114', roomState(), 'cool', '書けない状況'); });
    assert.ok(entry, '戻り値がありません');
    assert.strictEqual(log.listRecent()[0].info, '書けない状況', 'メモリ上の記録が残っていません');
  });
});

test('メモリ上の保持件数に上限がある', () => {
  withBackedUpLog(() => {
    for (let i = 0; i < log.MAX_IN_MEMORY + 50; i++) {
      log.recordResult('room_111', roomState(), 'cool', 'no' + i);
    }
    assert.strictEqual(log.listRecent(10000).length, log.MAX_IN_MEMORY);
    assert.strictEqual(log.listRecent()[0].info, 'no' + (log.MAX_IN_MEMORY + 49), '最新が先頭にありません');
  });
});

test('listRecent は件数を絞れる', () => {
  withBackedUpLog(() => {
    for (let i = 0; i < 10; i++) log.recordResult('r', roomState(), 'cool', 'no' + i);
    assert.strictEqual(log.listRecent(3).length, 3);
    assert.strictEqual(log.listRecent(0).length, 0);
  });
});

test('restore はファイルから直近を読み戻す', () => {
  withBackedUpLog(() => {
    fs.rmSync(log.LOG_FILE, { recursive: true, force: true });
    log.recordResult('room_111', roomState(), 'cool', '再起動前1');
    log.recordResult('room_112', roomState(), 'hot', '再起動前2');

    log.clear();
    assert.strictEqual(log.listRecent().length, 0);

    const n = log.restore();
    assert.strictEqual(n, 2);
    assert.strictEqual(log.listRecent()[0].info, '再起動前2', '新しい順になっていません');
  });
});

test('restore は壊れた行を飛ばす', () => {
  withBackedUpLog(() => {
    fs.rmSync(log.LOG_FILE, { recursive: true, force: true });
    fs.mkdirSync(log.DATA_DIR, { recursive: true });
    fs.writeFileSync(log.LOG_FILE,
      JSON.stringify({ info: '正常1' }) + '\n'
      + '{ 途中で切れた行\n'
      + JSON.stringify({ info: '正常2' }) + '\n', 'utf8');

    assert.strictEqual(log.restore(), 2);
  });
});

test('ログファイルが無くても restore は失敗しない', () => {
  withBackedUpLog(() => {
    fs.rmSync(log.LOG_FILE, { recursive: true, force: true });
    assert.doesNotThrow(() => assert.strictEqual(log.restore(), 0));
  });
});

test('chaser/server.js のフックが 2 箇所とも入っている', () => {
  const src = fs.readFileSync(require('node:path').join(__dirname, '..', 'chaser', 'server.js'), 'utf8');
  const calls = src.match(/resultLog\.recordResult\(/g) || [];
  assert.strictEqual(calls.length, 2, '記録の呼び出しは2箇所のはず');
  assert.match(src, /require\('\.\.\/tournament\/result_log\.js'\)/);
});
