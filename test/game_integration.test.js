/**
 * 実際に CPU 対戦を1試合走らせ、試合が最後まで進むことと
 * 結果が自動記録されることを確かめる。
 *
 * chaser/server.js は大会の中核なので、フックを足したあとも
 * 試合がこれまで通り終わることを機械で確認できるようにしておく。
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { io: ioClient } = require('socket.io-client');

const app = require('../app.js');
const chaser = require('../chaser/server.js');
const resultLog = require('../tournament/result_log.js');

const BLOCK = 2;
// get_ready / move が返す9マスのうち、上下左右の位置
const DIRECTIONS = [
  { name: 'top', index: 1 },
  { name: 'left', index: 3 },
  { name: 'right', index: 5 },
  { name: 'bottom', index: 7 },
];

let server;
let port;

test.before(async () => {
  server = http.createServer(app);
  chaser.io.attach(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

/**
 * CPU と1試合戦う。
 *
 * 本物のクライアント(public/javascripts/encode.js)と同じく、
 * 自分の番が来るまで get_ready を、行動が通るまで行動を送り続ける。
 */
function playCpuMatch({ roomId, playerName, timeoutMs = 60000 }) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(`http://127.0.0.1:${port}`, { transports: ['websocket'] });

    let finished = false;
    let turns = 0;
    let pending = null;          // 送り続けている行動。null なら get_ready 待ち
    let poller = null;

    const stop = (fn) => {
      if (finished) return;
      finished = true;
      clearInterval(poller);
      socket.close();
      fn();
    };

    const timer = setTimeout(
      () => stop(() => reject(new Error(`試合が ${timeoutMs}ms で終わりませんでした (${turns}ターン)`))),
      timeoutMs
    );

    socket.on('connect_error', (e) => stop(() => reject(e)));
    socket.on('error', (e) => stop(() => reject(new Error('サーバーエラー: ' + e))));

    socket.on('connect', () => {
      socket.emit('player_join', { room_id: roomId, name: playerName });
      // 本物のクライアントと同じ 100ms 間隔のポーリング
      poller = setInterval(() => {
        if (finished) return;
        if (pending) socket.emit(pending.event, pending.direction);
        else socket.emit('get_ready');
      }, 100);
    });

    // サーバーは自分の番でなくても get_ready_rec を返す。
    // その場合 rec_data が無いので、周囲9マスが届いたときだけ自分の番と判断する
    socket.on('get_ready_rec', (msg) => {
      if (pending) return;
      const cells = msg && msg.rec_data;
      if (!Array.isArray(cells) || cells.length < 9) return;

      const open = DIRECTIONS.filter((d) => cells[d.index] !== BLOCK);
      pending = open.length
        ? { event: 'move_player', direction: open[turns % open.length].name }
        : { event: 'put_wall', direction: 'top' };   // 動けないならブロックを置く
    });

    // 行動も同様に、結果が返ってきたときだけ次へ進む
    const actionDone = (msg) => {
      if (!msg || !Array.isArray(msg.rec_data)) return;
      pending = null;
      turns++;
    };
    socket.on('move_rec', actionDone);
    socket.on('put_rec', actionDone);

    socket.on('game_result', (msg) => {
      clearTimeout(timer);
      stop(() => resolve({ result: msg, turns }));
    });
  });
}

test('CPU と1試合戦って決着がつく', async () => {
  // listRecent() には既定の上限があるため、件数の増減では判定できない。
  // 空にしてから1試合戦い、記録された中身で確かめる
  resultLog.clear();

  const { result, turns } = await playCpuMatch({
    roomId: 'room_010',
    playerName: 'テスト選手',
  });

  assert.ok(turns > 0, '1ターンも進んでいません');
  assert.ok(['cool', 'hot', 'draw'].includes(result.winer),
    '勝敗が不正です: ' + JSON.stringify(result));

  // フックが動いて結果が記録されていること
  const after = resultLog.listRecent();
  assert.strictEqual(after.length, 1, '試合結果が記録されていません');

  const entry = after[0];
  assert.strictEqual(entry.roomId, 'room_010');
  assert.strictEqual(entry.winner, result.winer);
  assert.ok(
    entry.coolName === 'テスト選手' || entry.hotName === 'テスト選手',
    '選手名が記録されていません: ' + JSON.stringify(entry)
  );
  assert.ok(entry.coolName === 'cpu' || entry.hotName === 'cpu', 'CPU 側の名前がありません');
  assert.ok(Number.isFinite(entry.coolScore), 'スコアが記録されていません');
  assert.ok(entry.recordedAt, '記録時刻がありません');
});

test('決着後にルームが再利用できる', async () => {
  // 1試合目の後始末ができていないと、2試合目が始まらない
  resultLog.clear();
  const { result } = await playCpuMatch({ roomId: 'room_010', playerName: '2試合目' });
  assert.ok(['cool', 'hot', 'draw'].includes(result.winer));

  const entry = resultLog.listRecent()[0];
  assert.ok(entry.coolName === '2試合目' || entry.hotName === '2試合目');
});

/* --- セルの意味の回帰テスト --- */

/**
 * マップ JSON の内部表現から、サーバーがクライアントへ送る9マスの値を計算する。
 *
 * 内部: 0=床 1=ブロック 2=アイテム 3=cool 4=hot
 * 送信: 0=床/自分 1=相手 2=ブロック 3=アイテム   (盤外はブロック扱い)
 *
 * 変換は chaser/server.js の get_ready() に合わせている。
 */
function expectedNineCells(map, cx, cy) {
  const out = [];
  for (const dy of [-1, 0, 1]) {
    for (const dx of [-1, 0, 1]) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || x >= map.map_size_x || y < 0 || y >= map.map_size_y) {
        out.push(2);
        continue;
      }
      const v = map.map_data[y][x];
      if (v === 3) out.push(0);         // 自分
      else if (v === 4) out.push(1);    // 相手
      else if (v === 0) out.push(0);    // 床
      else if (v === 1) out.push(2);    // ブロック
      else out.push(3);                 // アイテム
    }
  }
  return out;
}

/** ルームに入り、最初に届いた周囲9マスを返して切断する */
function firstSurroundings({ roomId, playerName, timeoutMs = 30000 }) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
    let poller = null;
    let done = false;

    const finish = (fn) => {
      if (done) return;
      done = true;
      clearInterval(poller);
      socket.close();
      fn();
    };

    const timer = setTimeout(() => finish(() => reject(new Error('9マスが届きませんでした'))), timeoutMs);

    socket.on('connect', () => {
      socket.emit('player_join', { room_id: roomId, name: playerName });
      poller = setInterval(() => socket.emit('get_ready'), 100);
    });

    socket.on('get_ready_rec', (msg) => {
      const cells = msg && msg.rec_data;
      if (!Array.isArray(cells) || cells.length < 9) return;
      clearTimeout(timer);
      finish(() => resolve(cells));
    });

    socket.on('connect_error', (e) => finish(() => reject(e)));
  });
}

test('サーバーが送る9マスの値がマップ定義と一致する', async () => {
  // セル値 1 と 2 は直感と逆(1=ブロック, 2=アイテム)なので、
  // 取り違えるとマップの難易度も連結性の検査も静かに壊れる。
  // 実際の通信内容と突き合わせて固定する。
  const mapPath = path.join(__dirname, '..', 'load_data', 'game_server_data', 'game_server_010.json');
  const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));

  const cells = await firstSurroundings({ roomId: 'room_010', playerName: '9マス確認' });
  const expected = expectedNineCells(map, map.cool.x, map.cool.y);

  assert.deepStrictEqual(cells.slice(0, 9), expected,
    `マップ定義から期待される値と一致しません。\n`
    + `  マップ: ${map.name} cool=(${map.cool.x}, ${map.cool.y})\n`
    + `  期待  : ${expected.join(',')}\n`
    + `  実際  : ${cells.slice(0, 9).join(',')}`);
});

test('マップ定義とサーバーでブロックとアイテムの向きが揃っている', () => {
  // 静岡決勝マップは「ブロックが多く長期戦」という設計。
  // 値を取り違えるとアイテムだらけの別物になる
  const mapPath = path.join(__dirname, '..', 'load_data', 'game_server_data', 'game_server_014.json');
  const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));

  const flat = map.map_data.flat();
  const blocks = flat.filter((v) => v === 1).length;
  const items = flat.filter((v) => v === 2).length;

  assert.ok(blocks > items,
    `決勝マップはブロックのほうが多いはず (ブロック${blocks} / アイテム${items})`);
});
