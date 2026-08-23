/**
 * 公開したサーバーで実際に試合ができるかを確認する。
 *
 * ページが開けても Socket.IO の WebSocket が通らなければ試合はできない。
 * Cloudflare Tunnel やリバースプロキシを挟んだあと、参加者に URL を配る前に実行する。
 *
 *   node tool/tunnel_check.js https://example.trycloudflare.com
 *
 * CPU 対戦ルームに入って決着まで進めば成功。
 * 対人ルーム(room_1xx)を指定すると相手待ちで止まるので、CPU ルーム(room_0xx)を使う。
 */

const { io: ioClient } = require('socket.io-client');
const URL = process.argv[2];
const BLOCK = 2;
const DIRS = [{n:'top',i:1},{n:'left',i:3},{n:'right',i:5},{n:'bottom',i:7}];

const socket = ioClient(URL, { transports: ['websocket'] });
let turns = 0, pending = null, poller = null, done = false;
const t0 = Date.now();

const finish = (msg, code) => { if(done) return; done=true; clearInterval(poller); socket.close();
  console.log(msg); process.exit(code); };

setTimeout(() => finish('✗ 60秒で決着しませんでした (ターン数: '+turns+')', 1), 60000);

socket.on('connect_error', e => finish('✗ 接続できません: '+e.message, 1));
socket.io.engine.on('upgrade', t => console.log('  transport:', t.name));

socket.on('connect', () => {
  console.log('  接続成功 transport=' + socket.io.engine.transport.name);
  socket.emit('player_join', { room_id: 'room_014', name: 'トンネル確認' });
  poller = setInterval(() => {
    if (done) return;
    if (pending) socket.emit(pending.e, pending.d); else socket.emit('get_ready');
  }, 100);
});

socket.on('get_ready_rec', m => {
  if (pending) return;
  const c = m && m.rec_data;
  if (!Array.isArray(c) || c.length < 9) return;
  const open = DIRS.filter(d => c[d.i] !== BLOCK);
  pending = open.length ? { e:'move_player', d: open[turns % open.length].n } : { e:'put_wall', d:'top' };
});
const acted = m => { if (!m || !Array.isArray(m.rec_data)) return; pending = null; turns++; };
socket.on('move_rec', acted);
socket.on('put_rec', acted);

socket.on('game_result', m => finish(
  `  ✓ 決着 winner=${m.winer} (${m.info}) / ${turns}ターン / ${((Date.now()-t0)/1000).toFixed(1)}秒`, 0));
