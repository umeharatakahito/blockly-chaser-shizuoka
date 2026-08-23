/**
 * 試合結果の自動記録。
 *
 * chaser/server.js が勝敗を確定したときに recordResult() を呼び、
 * 直近の結果をためておく。トーナメント管理画面がこれを候補として表示し、
 * 対戦表へ反映するかどうかは運営が判断する。自動では反映しない。
 *
 * ここでの失敗が試合進行を止めてはならない。
 * recordResult() は決して例外を投げず、失敗はログに残すだけにする。
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'load_data', 'tournament');
const LOG_FILE = path.join(DATA_DIR, 'results.jsonl');

// 画面に出すのは直近のものだけでよい。メモリを無制限に伸ばさない
const MAX_IN_MEMORY = 200;

const recent = [];

/** 1件を組み立てる。server_store の中身に依存する箇所をここに閉じ込める */
function buildEntry(roomId, room, winner, info, now) {
  const cool = (room && room.cool) || {};
  const hot = (room && room.hot) || {};

  return {
    recordedAt: new Date(now).toISOString(),
    roomId: String(roomId || ''),
    roomName: String((room && room.name) || ''),
    coolName: String(cool.name || ''),
    hotName: String(hot.name || ''),
    coolScore: Number.isFinite(cool.score) ? cool.score : null,
    hotScore: Number.isFinite(hot.score) ? hot.score : null,
    winner: winner === 'cool' || winner === 'hot' || winner === 'draw' ? winner : null,
    info: String(info || ''),
  };
}

/**
 * 試合結果を記録する。
 *
 * @param {string} roomId  ルームID
 * @param {Object} room    server_store[roomId]。cool/hot の name と score を読む
 * @param {string} winner  'cool' | 'hot' | 'draw'
 * @param {string} info    勝因の説明。「アタックにより」など
 */
function recordResult(roomId, room, winner, info) {
  try {
    const entry = buildEntry(roomId, room, winner, info, Date.now());

    recent.unshift(entry);
    if (recent.length > MAX_IN_MEMORY) recent.length = MAX_IN_MEMORY;

    // ファイルへの追記は失敗しても構わない。メモリ上の記録は既に残っている
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n', 'utf8');
    } catch (e) {
      console.error('試合結果をファイルに書けません: ' + e.message);
    }

    return entry;
  } catch (e) {
    // ここで投げると試合が止まる。記録できないほうがまだ軽い
    console.error('試合結果を記録できません: ' + (e && e.message));
    return null;
  }
}

/** 直近の結果。新しい順 */
function listRecent(limit = 50) {
  return recent.slice(0, Math.max(0, limit));
}

/** 起動時に results.jsonl から直近を読み戻す。サーバー再起動で候補が消えないように */
function restore() {
  try {
    const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean);
    const tail = lines.slice(-MAX_IN_MEMORY);
    recent.length = 0;
    for (let i = tail.length - 1; i >= 0; i--) {
      try {
        recent.push(JSON.parse(tail[i]));
      } catch (e) {
        // 壊れた行は飛ばす。追記中に落ちると最終行が欠けることがある
      }
    }
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('results.jsonl を読めません: ' + e.message);
  }
  return recent.length;
}

/** テスト用。メモリ上の記録を空にする */
function clear() {
  recent.length = 0;
}

module.exports = { DATA_DIR, LOG_FILE, MAX_IN_MEMORY, recordResult, listRecent, restore, clear, buildEntry };
