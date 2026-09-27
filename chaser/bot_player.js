/**
 * ボット対戦の思考(chaser/bot/bot.js, DO 版と同一)を Node 版のゲームサーバーで動かすための橋渡し。
 *
 * bot.js は ES モジュールなので import() で読む。サーバー起動直後に読み終わるため、
 * 試合が始まるころには使える。読み終わる前に呼ばれた場合は null を返し、呼び出し側が本家の CPU に任せる。
 *
 * bot.js が盤面から読むのは state.map と state.cool / state.hot の x, y だけで、
 * セル値の体系(0=床 1=ブロック 2=アイテム 3=cool 4=hot 34=重なり)も server.js と同じ。
 * そのため server_store の中身をそのまま渡せる。
 */

let lib = null;
const ready = import('./bot/bot.js')
  .then((m) => { lib = m; return m; })
  .catch((e) => { console.error('ボットの思考を読めません: ' + e.message); return null; });

/** mulberry32。シードを固定すると、どの参加者も同じ「サイコロの目」のボットと戦える */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 本家のイベント名へ読み替える */
const ACTION = { move: 'move_player', move_player: 'move_player', attack: 'put_wall', put_wall: 'put_wall', look: 'look', search: 'search' };

const clampLevel = (level) => {
  const n = Math.round(Number(level));
  if (!Number.isFinite(n)) return 1;
  return Math.min(30, Math.max(1, n));
};

/** server_store[room] を bot.js が読む形に見せる。中身は複製しない(盤面は常に最新) */
const view = (room) => ({
  map: room.map_data,
  cool: room.cool,
  hot: room.hot,
  sizeX: room.map_size_x,
  sizeY: room.map_size_y,
  turn: room.turn,
});

/**
 * 試合ごとの思考の状態を作る。まだ読み込みが終わっていなければ null。
 * @param {Object} room  server_store[room]
 */
function createBrain(room, level, seed) {
  if (!lib) return null;
  const hasSeed = seed !== undefined && seed !== null && seed !== '' && Number.isFinite(Number(seed));
  return {
    bot: lib.createBot(clampLevel(level), room.map_size_x, room.map_size_y),
    rng: hasSeed ? mulberry32(Number(seed)) : Math.random,
  };
}

/**
 * 1手を決める。
 * @returns {{action: string, direction: string, kind: string}} action は server.js の関数名
 */
function decide(room, side, brain) {
  const [kind, direction] = lib.decideBotAction(view(room), side, brain.bot, brain.rng);
  return { action: ACTION[kind] || 'look', direction, kind };
}

/** 行動のあとに呼ぶ。look / search で見えたぶんを記憶に足す */
function after(room, side, brain, kind, direction) {
  try {
    lib.afterBotAction(brain.bot, view(room), side, kind, direction);
  } catch (e) {
    // 試合が終わって盤面が消えていることがある。記憶の更新だけなので無視してよい
  }
}

module.exports = { ready, createBrain, decide, after, clampLevel, mulberry32, isReady: () => lib !== null };
