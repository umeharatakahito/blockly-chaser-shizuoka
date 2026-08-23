/**
 * 大会用マップを生成する。
 *
 * 手で盤面を書くと対称性の崩れや到達不能な開始位置が混入しやすいため、
 * パラメータとシードから決定的に生成する。同じシードからは常に同じ盤面が出る。
 *
 * 既存の大会マップ(一関23/24)はすべて盤面中心 (7, 8) に対する点対称だった。
 * mirror(x, y) = (sizeX - 1 - x, sizeY - 1 - y) が成り立つ。
 * 先手(cool)と後手(hot)の有利不利をなくすため、この性質を踏襲する。
 *
 * 使い方:
 *   node tool/generate_maps.js          静岡大会マップを生成して書き出す
 *   node tool/generate_maps.js --dry    書き出さずに結果だけ表示する
 */

const fs = require('fs');
const path = require('path');

const { checkConnectivity, FLOOR, ITEM, BLOCK, COOL, HOT, MAP_DIR } = require('./validate_maps.js');

/**
 * mulberry32 — 32bit のシード付き擬似乱数。
 * Math.random() と違い再現性があるので、生成したマップを後から再構成できる。
 */
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

/** Fisher-Yates。rng を渡すので結果は決定的 */
function shuffle(array, rng) {
  const a = array.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const mirror = (x, y, sizeX, sizeY) => [sizeX - 1 - x, sizeY - 1 - y];

/**
 * 点対称な盤面を1回だけ生成する。連結性は保証しない。
 */
function buildBoard({ sizeX, sizeY, blocks, items, spawn }, rng) {
  const board = Array.from({ length: sizeY }, () => new Array(sizeX).fill(FLOOR));

  const [cx, cy] = spawn;
  const [hx, hy] = mirror(cx, cy, sizeX, sizeY);

  // 自分自身が鏡像になるセル(盤面の中心)は対にできないので除外する。
  // 開始位置とその鏡像も配置対象から外す
  const reserved = new Set([`${cx},${cy}`, `${hx},${hy}`]);

  const pairs = [];
  for (let y = 0; y < sizeY; y++) {
    for (let x = 0; x < sizeX; x++) {
      const [mx, my] = mirror(x, y, sizeX, sizeY);
      if (x === mx && y === my) continue;              // 中心セル
      if (reserved.has(`${x},${y}`) || reserved.has(`${mx},${my}`)) continue;
      // 各無順序ペアを1回だけ拾う
      if (y > my || (y === my && x > mx)) continue;
      pairs.push([[x, y], [mx, my]]);
    }
  }

  const shuffled = shuffle(pairs, rng);
  const blockPairs = Math.floor(blocks / 2);
  const itemPairs = Math.floor(items / 2);

  if (blockPairs + itemPairs > shuffled.length) {
    throw new Error(`blocks(${blocks}) と items(${items}) が盤面に収まりません (配置可能なペアは ${shuffled.length} 組)`);
  }

  let i = 0;
  for (let n = 0; n < blockPairs; n++, i++) {
    for (const [x, y] of shuffled[i]) board[y][x] = BLOCK;
  }
  for (let n = 0; n < itemPairs; n++, i++) {
    for (const [x, y] of shuffled[i]) board[y][x] = ITEM;
  }

  board[cy][cx] = COOL;
  board[hy][hx] = HOT;

  return { board, cool: { x: cx, y: cy }, hot: { x: hx, y: hy } };
}

/**
 * 条件を満たす盤面が出るまでシードをずらしながら生成を繰り返す。
 *
 * @param {number} minReachableRatio 通行可能セルのうち、開始位置から到達できる割合の下限。
 *                                   これを下げすぎると死角だらけのマップになる
 */
function generateMap(spec) {
  const {
    sizeX = 15, sizeY = 17, blocks, items, spawn, seed,
    attempts = 500, minReachableRatio = 0.9,
  } = spec;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const rng = mulberry32(seed + attempt);
    const { board, cool, hot } = buildBoard({ sizeX, sizeY, blocks, items, spawn }, rng);

    const { seen, reached, total } = checkConnectivity(board, [cool.x, cool.y]);
    if (!seen[hot.y][hot.x]) continue;                       // 相手に到達できない
    if (reached / total < minReachableRatio) continue;        // 死角が多すぎる

    return { board, cool, hot, usedSeed: seed + attempt, reached, total, attempt };
  }

  throw new Error(`条件を満たす盤面を ${attempts} 回の試行で生成できませんでした (seed=${seed})`);
}

/**
 * 既存マップと同じ体裁で JSON 文字列に整形する。
 * map_data は1行1行を盤面の見た目どおりに並べたいので、汎用の JSON.stringify は使わない。
 */
function formatMapJson(map) {
  const rows = map.map_data.map((row) => '        [' + row.join(',') + ']').join(',\n');
  const lines = [
    '{',
    `    "name": ${JSON.stringify(map.name)},`,
    `    "room_id": ${JSON.stringify(map.room_id)},`,
    `    "map_size_x": ${map.map_size_x},`,
    `    "map_size_y": ${map.map_size_y},`,
    '    "map_data":[',
    rows,
    '    ],',
    `    "cool": ${JSON.stringify(map.cool)},`,
    `    "hot": ${JSON.stringify(map.hot)},`,
  ];
  if (map.cpu) lines.push(`    "cpu": ${JSON.stringify(map.cpu)},`);
  lines.push(`    "turn": ${map.turn}`);
  lines.push('}');
  return lines.join('\n') + '\n';
}

/**
 * 静岡大会のマップ定義。
 *
 * room_id は変更してはならない。参加者の .blch に含まれる server_join ブロックが
 * room_id をフィールド値として保持しており、変えるとマップ選択が失われる。
 * 変えるのは name と map_data だけにする。
 *
 * 汎用マップ(room_001〜009 / 101〜109)は大会に依存しないため対象外。
 */
const SHIZUOKA_MAPS = [
  {
    num: 10, name: '静岡練習マップ', turn: 100, seed: 20261001,
    blocks: 20, items: 30, spawn: [5, 4],
    note: '素直な構成。ブロックが少なく動きやすい',
  },
  {
    num: 11, name: '静岡予選マップ', turn: 150, seed: 20261002,
    blocks: 40, items: 40, spawn: [1, 1],
    note: 'アイテムが多い。探索と収集が効く',
  },
  {
    num: 12, name: '静岡初戦マップ', turn: 150, seed: 20261003,
    blocks: 56, items: 24, spawn: [7, 2],
    note: 'ブロックが増え通路が分かれる。経路選択が問われる',
  },
  {
    num: 13, name: '静岡準決マップ', turn: 150, seed: 20261004,
    blocks: 44, items: 44, spawn: [2, 8],
    note: 'ブロックもアイテムも多い。閉じ込め狙いが成立する',
  },
  {
    num: 14, name: '静岡決勝マップ', turn: 200, seed: 20261005,
    blocks: 62, items: 30, spawn: [4, 8],
    note: '最も複雑。長期戦を想定しターン数も多い',
  },
];

const CPU_SETTING = { level: 2, turn: 'hot' };

/**
 * 定義から実際のマップファイルの内容を組み立てる。
 * CPU対戦ルーム(0xx)と対人ルーム(1xx)は同じ盤面を共有し、cpu フィールドの有無だけが異なる。
 */
function buildAll(specs = SHIZUOKA_MAPS) {
  const files = [];

  for (const spec of specs) {
    const { board, cool, hot, usedSeed, reached, total } = generateMap(spec);

    for (const [prefix, withCpu] of [[0, true], [100, false]]) {
      const num = spec.num + prefix;
      const map = {
        name: spec.name,
        room_id: `room_${String(num).padStart(3, '0')}`,
        map_size_x: spec.sizeX || 15,
        map_size_y: spec.sizeY || 17,
        map_data: board,
        cool: { status: false, turn: false, x: cool.x, y: cool.y },
        hot: { status: false, turn: false, x: hot.x, y: hot.y },
        turn: spec.turn,
      };
      if (withCpu) map.cpu = { ...CPU_SETTING };

      files.push({
        fileName: `game_server_${String(num).padStart(3, '0')}.json`,
        map,
        meta: { usedSeed, reached, total, note: spec.note },
      });
    }
  }

  return files;
}

module.exports = { mulberry32, shuffle, buildBoard, generateMap, formatMapJson, buildAll, SHIZUOKA_MAPS, mirror };

if (require.main === module) {
  const dryRun = process.argv.includes('--dry');
  const files = buildAll();

  for (const { fileName, map, meta } of files) {
    const blocks = map.map_data.flat().filter((c) => c === BLOCK).length;
    const items = map.map_data.flat().filter((c) => c === ITEM).length;
    console.log(
      `${fileName}  ${map.name}  ターン${map.turn}  `
      + `ブロック${blocks} アイテム${items}  `
      + `到達 ${meta.reached}/${meta.total}  seed=${meta.usedSeed}`
      + (map.cpu ? '  [CPU対戦]' : '  [対人]')
    );

    if (!dryRun) {
      fs.writeFileSync(path.join(MAP_DIR, fileName), formatMapJson(map), 'utf8');
    }
  }

  console.log(dryRun
    ? `\n--dry のため書き出していません (${files.length} ファイル)`
    : `\n${files.length} ファイルを書き出しました。npm test で検証してください`);
}
