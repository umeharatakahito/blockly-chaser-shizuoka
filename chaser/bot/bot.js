/**
 * ボット対戦の思考。L1〜L30 の30段階。
 *
 * 本家の CPU(cpu.js)は周囲9マスだけを見る固定のルールで、強さは3段階しかない。
 * ここでは「知っている範囲」「迷いの多さ」「先読み」をレベルで段階的に変え、
 * 上のレベルほど安定して強くなるようにした。
 *
 * 強さを決める要素(レベルが上がると順に解放される):
 *   - 迷い      : ランダムに動く確率。L1 で 9割、L10 で 0
 *   - うっかり  : ブロックへ突っ込む確率。L1 で 15%、L5 で 0
 *   - 攻撃      : 隣に相手がいたら put で叩く。L3 から徐々に、L8 で必ず
 *   - 危険回避  : 相手の隣で手番を終えない(叩かれるため)。L6 から
 *   - 記憶      : 見たマスを覚えて、知っている範囲でアイテムまでの道を探す。L6 から
 *   - 索敵      : 未知の方向を search で調べる。L6 から
 *   - 袋小路回避: 3方向が塞がったマスへ入らない。L8 から
 *   - 察知      : 相手の位置を常に知っている。L10 から
 *   - 追跡      : 点差で負けているとき相手へ寄る。L12 から
 *   - 閉じ込め  : 相手の逃げ道が少ないとき put で塞ぐ。L15 から
 *   - 全知      : 盤面と相手の位置を常に知っている。L20 から
 *   - 先読み    : 移動先で相手に挟まれないかを2手先まで見る。L25 から
 *
 * 思考は「ボットの知識」(known / enemy)だけを使う。全知でないレベルでは、
 * 実際に見えたマスだけが知識に入る。参加者のプログラムと同じ条件に近づけるため。
 *
 * 周囲9マスの値は本家の形 (0=床, 1=相手, 2=ブロック, 3=アイテム)。
 */

import { FLOOR, BLOCK, ITEM, BOTH, charaNum, charaNumDiff, opponentOf } from './constants.js';

export const MIN_LEVEL = 1;
export const MAX_LEVEL = 30;

const UNKNOWN = -1;

const DIRS = ['top', 'bottom', 'left', 'right'];
const DELTA = { top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0] };
const OPPOSITE = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

/** レベルを 1〜30 の整数に丸める */
export function clampLevel(level) {
  const n = Math.round(Number(level));
  if (!Number.isFinite(n)) return MIN_LEVEL;
  return Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, n));
}

/** レベルから思考のパラメータを作る。すべて単調に強くなるよう決めてある */
export function levelParams(level) {
  const L = clampLevel(level);
  const ramp = (from, to) => Math.min(1, Math.max(0, (L - from) / (to - from)));

  return {
    level: L,
    random: Math.max(0, 0.9 * (1 - ramp(1, 10))),
    blunder: Math.max(0, 0.15 * (1 - ramp(1, 5))),
    attack: L < 3 ? 0 : ramp(2, 8),
    danger: L >= 6,
    memory: L >= 6,
    scout: L >= 6,
    deadEnd: L >= 8,
    radar: L >= 10,
    chase: L >= 12,
    enclose: L >= 15,
    omniscient: L >= 20,
    lookahead: L >= 25,
    // 相手の位置を覚えておく長さ(手数)。全知なら常に最新
    enemyMemory: L >= 10 ? 12 : 4,
  };
}

/** レベルの説明。メニューに出す */
export function describeLevel(level) {
  const L = clampLevel(level);
  if (L <= 2) return 'ふらふら歩くだけ。攻撃はしない';
  if (L <= 5) return 'たまに攻撃する。まだよく迷う';
  if (L <= 7) return '見たマスを覚え、相手の隣には立たない';
  if (L <= 9) return '迷わなくなり、袋小路を避ける';
  if (L <= 11) return '相手の位置を常に察知している';
  if (L <= 14) return '負けていると追いかけてくる';
  if (L <= 19) return '逃げ道を塞ぎにくる';
  if (L <= 24) return '盤面全体と相手の位置を知っている';
  return '全知に加えて2手先まで読む';
}

/**
 * ボットの記憶を作る。試合のあいだ持ち越す(JSON にして保存できる形)。
 */
export function createBot(level, sizeX, sizeY) {
  const params = levelParams(level);
  return {
    kind: 'bot',
    level: params.level,
    sizeX,
    sizeY,
    known: Array.from({ length: sizeY }, () => new Array(sizeX).fill(UNKNOWN)),
    enemy: null,          // { x, y, age }
    lastDir: null,
    visits: {},           // "x,y" -> 回数。同じ場所をぐるぐる回るのを防ぐ
    turn: 0,
  };
}

/* ------------------------------------------------------------ 知識の更新 */

const inBounds = (bot, x, y) => x >= 0 && x < bot.sizeX && y >= 0 && y < bot.sizeY;

/** 盤面の1マスを「ボットの知識」として取り込む */
function learnCell(bot, state, side, x, y) {
  if (!inBounds(bot, x, y)) return;
  const v = state.map[y][x];
  const theirs = charaNumDiff[side];

  if (v === theirs || v === BOTH) {
    bot.enemy = { x, y, age: 0 };
    bot.known[y][x] = FLOOR;
  } else if (v === charaNum[side]) {
    bot.known[y][x] = FLOOR;
  } else {
    bot.known[y][x] = v;
  }
}

/** 周囲9マスを見る(get_ready 相当) */
export function perceiveAround(bot, state, side) {
  const me = state[side];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) learnCell(bot, state, side, me.x + dx, me.y + dy);
  }
}

/** look の結果を取り込む(指定方向の 3x3) */
export function perceiveLook(bot, state, side, direction) {
  const me = state[side];
  const [dx, dy] = DELTA[direction] || DELTA.right;
  for (let n = 1; n <= 3; n++) {
    for (let w = -1; w <= 1; w++) {
      const x = me.x + dx * n + (dx === 0 ? w : 0);
      const y = me.y + dy * n + (dy === 0 ? w : 0);
      learnCell(bot, state, side, x, y);
    }
  }
}

/** search の結果を取り込む(指定方向の直線9マス) */
export function perceiveSearch(bot, state, side, direction) {
  const me = state[side];
  const [dx, dy] = DELTA[direction] || DELTA.right;
  for (let n = 1; n <= 9; n++) learnCell(bot, state, side, me.x + dx * n, me.y + dy * n);
}

/** 全知: 盤面全体を取り込む */
function perceiveAll(bot, state, side) {
  for (let y = 0; y < bot.sizeY; y++) {
    for (let x = 0; x < bot.sizeX; x++) learnCell(bot, state, side, x, y);
  }
  const them = state[opponentOf[side]];
  bot.enemy = { x: them.x, y: them.y, age: 0 };
}

/* ------------------------------------------------------------ 盤面の見方 */

/** 知識上でそのマスへ入れるか。未知のマスは入れるものとして扱う */
function passable(bot, x, y) {
  if (!inBounds(bot, x, y)) return false;
  const v = bot.known[y][x];
  return v !== BLOCK;
}

/** 相手と上下左右で隣り合う位置か */
function adjacentToEnemy(bot, x, y) {
  if (!bot.enemy) return false;
  return Math.abs(bot.enemy.x - x) + Math.abs(bot.enemy.y - y) === 1;
}

/**
 * 相手に叩かれうる位置か。
 * 最後に見てから相手も動いているので、見てからの手数ぶんだけ範囲を広げて見る。
 */
function reachableByEnemy(bot, x, y) {
  if (!bot.enemy || bot.enemy.age > 1) return false;
  const dist = Math.abs(bot.enemy.x - x) + Math.abs(bot.enemy.y - y);
  return dist >= 1 && dist <= 1 + bot.enemy.age;
}

/** そのマスの、通れる上下左右の数 */
function openSides(bot, x, y, extraBlocks = []) {
  let n = 0;
  for (const d of DIRS) {
    const [dx, dy] = DELTA[d];
    const nx = x + dx;
    const ny = y + dy;
    if (extraBlocks.some(([bx, by]) => bx === nx && by === ny)) continue;
    if (passable(bot, nx, ny)) n++;
  }
  return n;
}

/**
 * 幅優先で、いちばん近い目標までの最初の一歩を求める。
 *
 * @param {Function} isGoal   (x, y) => boolean
 * @param {Function} canEnter (x, y) => boolean 通ってよいマス
 * @returns {{dir: string, dist: number}|null}
 */
function bfsFirstStep(bot, startX, startY, isGoal, canEnter) {
  const seen = new Set([`${startX},${startY}`]);
  let frontier = [];

  for (const d of DIRS) {
    const [dx, dy] = DELTA[d];
    const x = startX + dx;
    const y = startY + dy;
    if (!canEnter(x, y)) continue;
    if (isGoal(x, y)) return { dir: d, dist: 1 };
    seen.add(`${x},${y}`);
    frontier.push({ x, y, first: d });
  }

  let dist = 1;
  while (frontier.length && dist < 400) {
    dist++;
    const next = [];
    for (const node of frontier) {
      for (const d of DIRS) {
        const [dx, dy] = DELTA[d];
        const x = node.x + dx;
        const y = node.y + dy;
        const key = `${x},${y}`;
        if (seen.has(key) || !canEnter(x, y)) continue;
        if (isGoal(x, y)) return { dir: node.first, dist };
        seen.add(key);
        next.push({ x, y, first: node.first });
      }
    }
    frontier = next;
  }
  return null;
}

/* ------------------------------------------------------------ 判断 */

const pick = (list, rng) => list[Math.floor(rng() * list.length)];

/**
 * 次の一手を決める。
 *
 * @param {Object} state  試合の状態(engine.createState の形)
 * @param {string} side   ボットの側 'cool' | 'hot'
 * @param {Object} bot    createBot で作った記憶
 * @param {Function} rng  乱数
 * @returns {[string, string]} [行動, 向き]。行動は move / put_wall / look / search
 */
export function decideBotAction(state, side, bot, rng = Math.random) {
  const p = levelParams(bot.level);
  const me = state[side];
  const them = state[opponentOf[side]];
  bot.turn += 1;

  if (bot.enemy) bot.enemy.age += 1;
  if (bot.enemy && bot.enemy.age > p.enemyMemory) bot.enemy = null;

  if (p.omniscient) {
    perceiveAll(bot, state, side);
  } else {
    perceiveAround(bot, state, side);
    if (p.radar) bot.enemy = { x: them.x, y: them.y, age: 0 };
  }

  // 全知でなくても、隣にいる相手は9マスで見えている
  const key = `${me.x},${me.y}`;
  bot.visits[key] = (bot.visits[key] || 0) + 1;

  /* 1. 隣に相手がいれば叩く。これで勝ちになる */
  if (bot.enemy && bot.enemy.age === 0 && adjacentToEnemy(bot, me.x, me.y) && rng() < p.attack) {
    const dir = DIRS.find((d) => me.x + DELTA[d][0] === bot.enemy.x && me.y + DELTA[d][1] === bot.enemy.y);
    return ['put_wall', dir];
  }

  /* 2. 動ける向きを洗い出す */
  const moves = [];
  for (const d of DIRS) {
    const [dx, dy] = DELTA[d];
    const x = me.x + dx;
    const y = me.y + dy;
    if (!inBounds(bot, x, y)) continue;
    const cell = bot.known[y][x];
    const real = state.map[y][x];
    // 隣は必ず見えているので実際の値で判断する
    if (real === BLOCK) continue;

    const info = { dir: d, x, y, cell: real, score: 0 };

    // アイテムを取ると元いたマスがブロックになる。そのぶん出口が減る
    const extra = real === ITEM ? [[me.x, me.y]] : [];
    info.exits = openSides(bot, x, y, extra);

    // 相手の隣で手番を終えると叩かれる
    info.dangerous = p.danger && reachableByEnemy(bot, x, y);

    // 先読み: 相手が1歩でこちらの隣に来られる位置でも危ない(相手の次の手で隣接される)
    if (p.lookahead && bot.enemy && !info.dangerous) {
      const ex = bot.enemy.x;
      const ey = bot.enemy.y;
      const dist = Math.abs(ex - x) + Math.abs(ey - y);
      // 距離2で出口が1つしかないマスは、寄られてから塞がれる
      if (dist === 2 && info.exits <= 1) info.dangerous = true;
    }

    info.deadEnd = p.deadEnd && info.exits === 0;
    moves.push(info);
  }

  /* 3. うっかり: 低レベルは時々ブロックへ突っ込む */
  if (rng() < p.blunder) {
    return ['move', pick(DIRS, rng)];
  }

  const safe = moves.filter((m) => !m.dangerous && !m.deadEnd);
  const notDeadEnd = moves.filter((m) => !m.deadEnd);

  // 安全に動ける先が無く、今いる場所は安全なら、動かずに相手が隣へ来るのを待つ。
  // 隣へ来れば次の手で叩ける
  if (safe.length === 0 && p.danger && moves.length > 0 && !reachableByEnemy(bot, me.x, me.y)) {
    const toward = bot.enemy
      ? (Math.abs(bot.enemy.x - me.x) >= Math.abs(bot.enemy.y - me.y)
        ? (bot.enemy.x > me.x ? 'right' : 'left')
        : (bot.enemy.y > me.y ? 'bottom' : 'top'))
      : pick(DIRS, rng);
    return ['look', toward];
  }

  const candidates = safe.length ? safe : notDeadEnd.length ? notDeadEnd : moves;

  if (candidates.length === 0) {
    // どこにも動けない。負けているが、向きを変えてあがく
    return ['look', pick(DIRS, rng)];
  }

  /* 4. 迷い: 低レベルはランダムに歩く */
  if (rng() < p.random) {
    const m = pick(candidates, rng);
    bot.lastDir = m.dir;
    return ['move', m.dir];
  }

  /* 5. 閉じ込め: 相手の逃げ道が少なく、その出口がこちらの隣なら塞ぐ */
  if (p.enclose && bot.enemy && bot.enemy.age === 0) {
    const exits = [];
    for (const d of DIRS) {
      const [dx, dy] = DELTA[d];
      const x = bot.enemy.x + dx;
      const y = bot.enemy.y + dy;
      if (passable(bot, x, y) && !(x === me.x && y === me.y)) exits.push([x, y]);
    }
    if (exits.length > 0 && exits.length <= 2) {
      for (const [x, y] of exits) {
        const d = DIRS.find((dd) => me.x + DELTA[dd][0] === x && me.y + DELTA[dd][1] === y);
        if (d && !adjacentToEnemy(bot, me.x, me.y)) return ['put_wall', d];
      }
    }
  }

  /* 6. 目標を決める: 近いアイテム */
  const canEnter = (x, y) => passable(bot, x, y) && !(p.danger && reachableByEnemy(bot, x, y));
  // 取ったあと閉じ込められるアイテム(袋小路の奥)は目標にしない
  const itemHere = (x, y) => bot.known[y][x] === ITEM && (!p.deadEnd || openSides(bot, x, y) >= 2);

  const path = p.memory
    ? bfsFirstStep(bot, me.x, me.y, itemHere, canEnter)
    : null;

  // 追跡: 負けているとき、相手の「隣の隣」へ寄る(隣で止まると叩かれるため)
  let chase = null;
  if (p.chase && bot.enemy && me.score < them.score && bot.enemy.age <= 2) {
    const ex = bot.enemy.x;
    const ey = bot.enemy.y;
    chase = bfsFirstStep(
      bot, me.x, me.y,
      (x, y) => Math.abs(ex - x) + Math.abs(ey - y) === 2,
      canEnter
    );
  }

  /* 7. 向きごとの点数 */
  for (const m of candidates) {
    if (m.cell === ITEM) m.score += 100;
    if (path && path.dir === m.dir) m.score += 100;
    if (chase && chase.dir === m.dir && !(path && path.dist <= 3)) m.score += 40;

    // 斜めのアイテムへ寄る
    for (const [ox, oy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const x = me.x + ox;
      const y = me.y + oy;
      if (inBounds(bot, x, y) && bot.known[y][x] === ITEM) {
        if ((ox === m.x - me.x) || (oy === m.y - me.y)) m.score += 25;
      }
    }

    // 出口の多いマスを好む。袋小路は避ける
    m.score += m.exits * 8;

    // 同じ場所を往復しない(目標へ向かう途中なら気にしない)
    if (!(path && path.dir === m.dir)) m.score -= Math.min(30, (bot.visits[`${m.x},${m.y}`] || 0) * 6);

    // 来た道を戻りにくく、同じ向きを続けやすく
    if (bot.lastDir && OPPOSITE[bot.lastDir] === m.dir) m.score -= 10;
    if (bot.lastDir === m.dir) m.score += 4;

    // 未知のマスへ向かう(探索)
    if (p.memory) {
      let unknown = 0;
      const [dx, dy] = DELTA[m.dir];
      for (let n = 1; n <= 5; n++) {
        const x = me.x + dx * n;
        const y = me.y + dy * n;
        if (!inBounds(bot, x, y)) break;
        if (bot.known[y][x] === UNKNOWN) unknown++;
        if (bot.known[y][x] === BLOCK) break;
      }
      m.score += unknown * 3;
    }
  }

  /* 8. 索敵: 知っているアイテムが無く、未知が多い向きがあれば search で調べる */
  if (p.scout && !path && !chase && bot.turn % 3 === 0) {
    let bestDir = null;
    let bestUnknown = 2;
    for (const d of DIRS) {
      const [dx, dy] = DELTA[d];
      let unknown = 0;
      for (let n = 1; n <= 9; n++) {
        const x = me.x + dx * n;
        const y = me.y + dy * n;
        if (!inBounds(bot, x, y)) break;
        if (bot.known[y][x] === UNKNOWN) unknown++;
      }
      if (unknown > bestUnknown) { bestUnknown = unknown; bestDir = d; }
    }
    if (bestDir) return ['search', bestDir];
  }

  const best = candidates.reduce((a, b) => (b.score > a.score ? b : a));
  const tied = candidates.filter((m) => m.score === best.score);
  const chosen = pick(tied, rng);
  bot.lastDir = chosen.dir;
  return ['move', chosen.dir];
}

/**
 * 行動のあとに呼ぶ。look / search で見えたぶんを知識に足す。
 */
export function afterBotAction(bot, state, side, kind, direction) {
  if (kind === 'look') perceiveLook(bot, state, side, direction);
  else if (kind === 'search') perceiveSearch(bot, state, side, direction);
}
