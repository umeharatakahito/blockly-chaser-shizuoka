/**
 * 静岡大会の得点と勝敗の決め方。入出力を持たない純粋な関数だけを置く。
 *
 * 予選(対ボット戦) … 投影スライド「予選（対BOT戦）について」
 *   ボットを後攻にして1回対戦する。参加者は先攻(cool)。
 *   勝ち: アイテム数 × 3 + 残りターン数
 *   負け: アイテム数 × 3 − 残りターン数
 *   引き分け(スライドに記載なし): アイテム数 × 3
 *
 * 決勝トーナメント … 投影スライド「決勝トーナメント」「引き分けの場合」「獲得アイテム数」
 *   1試合は同じマップで先攻・後攻を入れ替えて2回対戦し、勝利数が多い方の勝ち。
 *   勝利数が同じなら獲得アイテム数の合計で決める。ただし
 *     Put された(アタック・ブロック閉じ込めで負けた)試合のアイテム数は 0
 *     自滅した(ブロック衝突・タイムアウトで負けた)試合は 0 − 残りターン数
 *   それでも同じならマップを変えて再試合する(2回1組をもう1組)。
 */

const QUALIFIER_DEFAULTS = Object.freeze({
  roomId: 'room_011',   // 静岡予選マップ(茶畑)。CPU 入りのルームでないとボットが入れない
  botLevel: 5,          // サンプルプログラムと互角のレベル
  seed: 20261012,       // ボットの乱数。全員が同じ目のボットと戦う
  advance: 11,          // 決勝トーナメントへ進む人数
});

/** 回戦ごとの既定のマップ(対人ルーム)。運営画面で変えられる */
const ROUND_ROOM_DEFAULTS = Object.freeze({
  '決勝': 'room_114',     // 逆さ富士
  '準決勝': 'room_113',   // 浜名湖
  other: 'room_112',      // 駿河湾(1回戦・準々決勝)
  replay: 'room_110',     // 再試合の既定。みかん畑
});

const defaultRoundRoom = (roundName) => ROUND_ROOM_DEFAULTS[roundName] || ROUND_ROOM_DEFAULTS.other;

const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : 0);

/**
 * 予選の得点。参加者は cool 側。
 * @param {{outcome: 'win'|'lose'|'draw', items: number, turnsLeft: number}} run
 */
function qualifierScore(run) {
  const base = num(run.items) * 3;
  const left = num(run.turnsLeft);
  if (run.outcome === 'win') return base + left;
  if (run.outcome === 'lose') return base - left;
  return base;
}

/** 試合結果(result_log の1件)を、参加者から見た予選の記録に直す */
function qualifierRunFromResult(entry, now = Date.now()) {
  const outcome = entry.winner === 'cool' ? 'win' : entry.winner === 'hot' ? 'lose' : 'draw';
  const run = {
    at: entry.recordedAt || new Date(now).toISOString(),
    outcome,
    info: String(entry.info || ''),
    items: num(entry.coolScore),
    botItems: num(entry.hotScore),
    turnsLeft: num(entry.turnsLeft),
    roomId: String(entry.roomId || ''),
  };
  run.score = qualifierScore(run);
  return run;
}

/** 採用する記録。最後に戦ったもの */
const adoptedRun = (runs) => (Array.isArray(runs) && runs.length ? runs[runs.length - 1] : null);

/**
 * 予選の順位表。得点 → アイテム数 → 残りターン数の順で比べ、すべて同じなら同順位。
 * まだ戦っていない参加者は末尾に順位なしで並べる。
 */
function qualifierRanking(participants, runsById) {
  const played = [];
  const waiting = [];
  for (const p of participants) {
    const run = adoptedRun(runsById[p.id]);
    if (run) played.push({ participant: p, run, tries: runsById[p.id].length });
    else waiting.push({ participant: p, run: null, tries: 0, rank: null });
  }

  const cmp = (a, b) => b.run.score - a.run.score || b.run.items - a.run.items || b.run.turnsLeft - a.run.turnsLeft;
  played.sort((a, b) => cmp(a, b) || a.participant.name.localeCompare(b.participant.name, 'ja'));

  played.forEach((row, i) => {
    row.rank = i > 0 && cmp(played[i - 1], row) === 0 ? played[i - 1].rank : i + 1;
  });
  return played.concat(waiting);
}

/* -------------------------------------------------- 決勝トーナメント */

const CRUSHED = /アタック|閉じ込め/;
const SELF_OUT = /衝突|タイムアウト/;

/**
 * 1回の対戦で、ある側が獲得したとみなすアイテム数。
 * @param {Object} game  { winner, info, coolItems, hotItems, turnsLeft }
 * @param {'cool'|'hot'} side
 */
function adjustedItems(game, side) {
  const items = num(side === 'cool' ? game.coolItems : game.hotItems);
  const other = side === 'cool' ? 'hot' : 'cool';
  const info = String(game.info || '');
  if (game.winner === other) {
    if (CRUSHED.test(info)) return 0;
    if (SELF_OUT.test(info)) return -num(game.turnsLeft);
    return items;
  }
  if (game.winner === 'draw' && CRUSHED.test(info)) return 0;
  return items;
}

/**
 * 1試合の予定(2回1組 × 組数)。記録済みの結果を重ねて返す。
 * 奇数番目は対戦表の cool 側が先攻、偶数番目は入れ替える。
 *
 * @param {Object} match  対戦表の試合。games / sets / replayRooms を持つ
 * @param {string} roundRoomId その回戦のマップ
 */
function planGames(match, roundRoomId) {
  const sets = Math.max(1, Math.floor(num(match.sets)) || 1);
  const recorded = new Map((match.games || []).map((g) => [g.no, g]));
  const plan = [];
  for (let s = 0; s < sets; s++) {
    const roomId = s === 0 ? roundRoomId : ((match.replayRooms || [])[s - 1] || ROUND_ROOM_DEFAULTS.replay);
    for (let k = 0; k < 2; k++) {
      const no = s * 2 + k + 1;
      const coolId = k === 0 ? match.coolId : match.hotId;
      const hotId = k === 0 ? match.hotId : match.coolId;
      const rec = recorded.get(no);
      plan.push(Object.assign({ no, set: s + 1, coolId, hotId, roomId }, rec ? { result: rec } : { result: null }));
    }
  }
  return plan;
}

/**
 * 試合の勝者を決める。
 * @returns {{status: 'pending'|'decided'|'replay', winnerId?: string, reason?: string,
 *            wins: Object, items: Object, set?: number}}
 */
function decideMatch(match, roundRoomId) {
  const a = match.coolId;
  const b = match.hotId;
  const plan = planGames(match, roundRoomId);
  const totalWins = { [a]: 0, [b]: 0 };
  const totalItems = { [a]: 0, [b]: 0 };

  for (let s = 0; s * 2 < plan.length; s++) {
    const pair = plan.slice(s * 2, s * 2 + 2);
    const wins = { [a]: 0, [b]: 0 };
    const items = { [a]: 0, [b]: 0 };

    for (const g of pair) {
      if (!g.result) return { status: 'pending', wins: totalWins, items: totalItems, set: s + 1 };
      const r = g.result;
      if (r.winner === 'cool') wins[g.coolId] += 1;
      if (r.winner === 'hot') wins[g.hotId] += 1;
      items[g.coolId] += adjustedItems(r, 'cool');
      items[g.hotId] += adjustedItems(r, 'hot');
    }
    for (const id of [a, b]) { totalWins[id] += wins[id]; totalItems[id] += items[id]; }

    if (wins[a] !== wins[b]) {
      const winnerId = wins[a] > wins[b] ? a : b;
      return { status: 'decided', winnerId, set: s + 1, wins, items, reason: `${Math.max(wins[a], wins[b])}勝${Math.min(wins[a], wins[b])}敗` };
    }
    if (items[a] !== items[b]) {
      const winnerId = items[a] > items[b] ? a : b;
      return {
        status: 'decided', winnerId, set: s + 1, wins, items,
        reason: `${wins[a]}勝${wins[b]}敗・アイテム ${Math.max(items[a], items[b])}対${Math.min(items[a], items[b])}`,
      };
    }
  }
  return { status: 'replay', wins: totalWins, items: totalItems, set: plan.length / 2 };
}

module.exports = {
  QUALIFIER_DEFAULTS, ROUND_ROOM_DEFAULTS, defaultRoundRoom,
  qualifierScore, qualifierRunFromResult, adoptedRun, qualifierRanking,
  adjustedItems, planGames, decideMatch,
};
