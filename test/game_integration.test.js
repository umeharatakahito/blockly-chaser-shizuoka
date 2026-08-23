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
