/**
 * 大会当日の流れを実際のゲームサーバーで通す。
 *   予選: 参加者(cool) 対 ボット(hot)。終わると qualifier.json に参加者の記録が入る
 *   決勝: 2人の参加者の1回目の対戦。終わると tournament.json の試合に対戦記録が入る
 *
 * 運営画面の「対戦」ボタンと同じく、対戦画面の流れ(match_init → player_join_match → match_start)で戦う。
 * 参加者のプログラムの代わりに、空いている方向へ動くだけの簡単なクライアントを使う。
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { io: ioClient } = require('socket.io-client');

const app = require('../app.js');
const chaser = require('../chaser/server.js');
const botPlayer = require('../chaser/bot_player.js');
const resultLog = require('../tournament/result_log.js');
const tournament = require('../tournament/store.js');
const store = require('../contest/store.js');
const recorder = require('../contest/recorder.js');

const BLOCK = 2;
const DIRS = [['top', 1], ['left', 3], ['right', 5], ['bottom', 7]];

let server;
let port;
let dir;
let tournamentBackup;

test.before(async () => {
  await botPlayer.ready;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contest-match-'));
  store.setDataDir(dir);
  tournamentBackup = fs.existsSync(tournament.DATA_FILE) ? fs.readFileSync(tournament.DATA_FILE, 'utf8') : null;
  recorder.install();

  server = http.createServer(app);
  chaser.io.attach(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
  if (tournamentBackup === null) fs.rmSync(tournament.DATA_FILE, { force: true });
  else fs.writeFileSync(tournament.DATA_FILE, tournamentBackup, 'utf8');
});

const connect = () => new Promise((resolve, reject) => {
  const s = ioClient(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
  s.once('connect', () => resolve(s));
  s.once('connect_error', reject);
});

const once = (socket, event) => new Promise((resolve) => socket.once(event, resolve));

/** 参加者の代わり。自分の番が来たら空いている方向へ動く */
function autoPlayer(socket, roomId, key, chara, name) {
  let pending = null;
  let turns = 0;
  socket.on('get_ready_rec', (msg) => {
    const cells = msg && msg.rec_data;
    if (pending || !Array.isArray(cells) || cells.length < 9) return;
    const open = DIRS.filter(([, i]) => cells[i] !== BLOCK);
    pending = open.length ? ['move_player', open[turns % open.length][0]] : ['put_wall', 'top'];
  });
  const done = (msg) => { if (msg && Array.isArray(msg.rec_data)) { pending = null; turns++; } };
  socket.on('move_rec', done);
  socket.on('put_rec', done);
  const timer = setInterval(() => {
    if (pending) socket.emit(pending[0], pending[1]);
    else socket.emit('get_ready');
  }, 20);
  socket.emit('player_join_match', { room_id: roomId, name, chara, key });
  return () => clearInterval(timer);
}

/** 対戦画面と同じ手順で1試合。players は { cool?: name, hot?: name } */
async function playMatch(roomId, players, extra = {}) {
  const operator = await connect();
  operator.emit('match_init', Object.assign({ room_id: roomId }, extra));
  const init = await once(operator, 'match_init_rec');
  assert.ok(init.key, '対戦画面の準備ができません: ' + JSON.stringify(init));

  const sockets = [];
  const stops = [];
  for (const side of ['cool', 'hot']) {
    if (!players[side]) continue;
    const s = await connect();
    sockets.push(s);
    stops.push(autoPlayer(s, roomId, init.key, side, players[side]));
  }
  await new Promise((r) => setTimeout(r, 300));
  const result = once(sockets[0], 'game_result');
  operator.emit('match_start', { room_id: roomId, key: init.key });
  const res = await Promise.race([result, new Promise((_, rej) => setTimeout(() => rej(new Error('試合が終わりません')), 120000))]);
  stops.forEach((f) => f());
  sockets.concat(operator).forEach((s) => s.close());
  return res;
}

test('予選: ボットと戦った結果が参加者の記録になり、得点が付く', async () => {
  const data = store.loadParticipants();
  const p = store.addParticipant(data, { name: 'よせんくん' });
  store.saveParticipants(data);
  resultLog.clear();

  const roomId = 'room_011?' + recorder.qualifierToken(p.id);
  const res = await playMatch(roomId, { cool: 'よせんくん' }, { bot: 5, bot_seed: 20261012 });
  assert.ok(['cool', 'hot', 'draw'].includes(res.winer));

  const entry = resultLog.listRecent(1)[0];
  assert.strictEqual(entry.roomId, roomId);
  assert.strictEqual(entry.hotName, 'ボット L5', 'hot 側に本家の CPU ではなくボットが入る');
  assert.ok(Number.isInteger(entry.turnsLeft));

  const runs = store.loadQualifier().runs[p.id];
  assert.strictEqual(runs.length, 1);
  const run = runs[0];
  const sign = run.outcome === 'win' ? 1 : run.outcome === 'lose' ? -1 : 0;
  assert.strictEqual(run.score, entry.coolScore * 3 + sign * entry.turnsLeft);
});

test('決勝: 2人の対戦の1回目が、対戦表の試合に記録される', async () => {
  const data = tournament.buildBracket(tournament.normalize({
    title: 'テスト大会',
    players: [{ id: 'ea1', name: 'あおい' }, { id: 'eb2', name: 'はると' }],
  }));
  tournament.save(data);
  const m = data.rounds[0].matches[0];
  assert.strictEqual(data.rounds[0].roomId, 'room_114', '2人なら最初から決勝で、マップは逆さ富士');

  const roomId = 'room_114?' + recorder.tournamentToken(m.id, 1);
  await playMatch(roomId, { cool: 'あおい', hot: 'はると' });

  const after = tournament.load();
  const games = after.rounds[0].matches[0].games;
  assert.strictEqual(games.length, 1);
  assert.strictEqual(games[0].no, 1);
  assert.strictEqual(games[0].coolId, m.coolId);
  assert.strictEqual(games[0].roomId, 'room_114');
  assert.strictEqual(after.rounds[0].matches[0].winnerId, null, '勝者の確定は運営が押すまでしない');
});
