/**
 * マップ定義(load_data/game_server_data/*.json)の妥当性を検査する。
 *
 * 大会当日に壊れたマップで試合が始まると取り返しがつかないため、
 * テストから常時呼び、マップを差し替えたら必ず検査が走るようにしている。
 *
 * セルの数値体系 (chaser/server.js と同じ):
 *   0 = 床, 1 = アイテム, 2 = ブロック, 3 = cool, 4 = hot
 *
 * マップには3種類ある。検査項目は種類によって異なる。
 *   procedural   : map_data が空。auto_block / auto_point から起動時に生成される
 *   fixed-spawn  : map_data に盤面があり、cool/hot の初期座標が明示される(セルは 3 と 4)
 *   random-spawn : map_data に盤面があるが cool/hot は (-1,-1)。起動時に床へランダム配置される
 */

const fs = require('fs');
const path = require('path');

const FLOOR = 0;
const ITEM = 1;
const BLOCK = 2;
const COOL = 3;
const HOT = 4;
const CELL_VALUES = [FLOOR, ITEM, BLOCK, COOL, HOT];

const MAP_DIR = path.join(__dirname, '..', 'load_data', 'game_server_data');

const isPositiveInt = (v) => Number.isInteger(v) && v > 0;
const isNonNegativeInt = (v) => Number.isInteger(v) && v >= 0;

/** map_data のうち通行できるセル(ブロック以外)か */
const isPassable = (cell) => cell !== BLOCK;

/**
 * start から到達できる通行可能セルを幅優先探索で求める。
 *
 * @returns {{seen: boolean[][], reached: number, total: number}}
 *          total は盤面全体の通行可能セル数
 */
function checkConnectivity(mapData, start) {
  const height = mapData.length;
  const width = mapData[0].length;

  let total = 0;
  for (const row of mapData) {
    for (const cell of row) if (isPassable(cell)) total++;
  }

  const seen = Array.from({ length: height }, () => new Array(width).fill(false));
  const queue = [start];
  seen[start[1]][start[0]] = true;
  let reached = 1;

  // shift は O(n) なので読み出し位置を進める方式にする
  for (let head = 0; head < queue.length; head++) {
    const [x, y] = queue[head];
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      if (seen[ny][nx] || !isPassable(mapData[ny][nx])) continue;
      seen[ny][nx] = true;
      reached++;
      queue.push([nx, ny]);
    }
  }

  return { seen, reached, total, connected: reached === total };
}

/** map_data から指定した値を持つセルの座標をすべて集める */
function findCells(mapData, value) {
  const found = [];
  for (let y = 0; y < mapData.length; y++) {
    for (let x = 0; x < mapData[y].length; x++) {
      if (mapData[y][x] === value) found.push({ x, y });
    }
  }
  return found;
}

/** ファイル名 game_server_011.json から期待される room_id を求める */
function expectedRoomId(fileName) {
  const m = /^game_server_(\d+)\.json$/.exec(fileName);
  return m ? 'room_' + m[1] : null;
}

/** マップの種類を判定する */
function mapKind(map) {
  if (!Array.isArray(map.map_data) || map.map_data.length === 0) return 'procedural';
  const coolX = map.cool && map.cool.x;
  return Number.isInteger(coolX) && coolX >= 0 ? 'fixed-spawn' : 'random-spawn';
}

/**
 * マップ1件を検査する。
 *
 * errors   : 試合が成立しない致命的な問題。大会では使えない
 * warnings : 意図的な設計でありうる注意点。囮アイテムの封鎖など
 *
 * @returns {{errors: string[], warnings: string[]}}
 */
function validateMap(map, fileName) {
  const errors = [];
  const warnings = [];
  const push = (msg) => errors.push(`${fileName}: ${msg}`);
  const warn = (msg) => warnings.push(`${fileName}: ${msg}`);
  const done = () => ({ errors, warnings });

  if (typeof map.name !== 'string' || !map.name.trim()) push('name が空です');

  const wantRoomId = expectedRoomId(fileName);
  if (wantRoomId && map.room_id !== wantRoomId) {
    push(`room_id がファイル名と一致しません (期待 ${wantRoomId}, 実際 ${map.room_id})`);
  }

  if (!isPositiveInt(map.map_size_x)) push(`map_size_x が正の整数ではありません (${map.map_size_x})`);
  if (!isPositiveInt(map.map_size_y)) push(`map_size_y が正の整数ではありません (${map.map_size_y})`);
  if (!isPositiveInt(map.turn)) push(`turn が正の整数ではありません (${map.turn})`);

  if (!map.cool || !map.hot) {
    push('cool または hot がありません');
    return done();
  }

  // cpu を持つのは 0xx(CPU対戦ルーム)、持たないのは 1xx(対人ルーム)。どちらも正しい
  if (map.cpu !== undefined) {
    if (!isPositiveInt(map.cpu.level)) push(`cpu.level が正の整数ではありません (${map.cpu.level})`);
    if (map.cpu.turn !== 'cool' && map.cpu.turn !== 'hot') {
      push(`cpu.turn が cool/hot ではありません (${map.cpu.turn})`);
    }
  }

  if (!Array.isArray(map.map_data)) {
    push('map_data が配列ではありません');
    return done();
  }

  const kind = mapKind(map);

  if (kind === 'procedural') {
    if (!isNonNegativeInt(map.auto_block)) push(`auto_block が非負整数ではありません (${map.auto_block})`);
    if (!isNonNegativeInt(map.auto_point)) push(`auto_point が非負整数ではありません (${map.auto_point})`);

    if (isNonNegativeInt(map.auto_block) && isNonNegativeInt(map.auto_point)
        && isPositiveInt(map.map_size_x) && isPositiveInt(map.map_size_y)) {
      const cells = map.map_size_x * map.map_size_y;
      // ブロック・アイテム・プレイヤー2体が盤面に収まらないと生成が破綻する
      if (map.auto_block + map.auto_point + 2 > cells) {
        push(`auto_block(${map.auto_block}) + auto_point(${map.auto_point}) が盤面 ${cells} マスに収まりません`);
      }
    }
    return done();
  }

  // --- ここから盤面を持つマップ (fixed-spawn / random-spawn) ---

  if (map.map_data.length !== map.map_size_y) {
    push(`map_data の行数が map_size_y と一致しません (${map.map_data.length} != ${map.map_size_y})`);
    return done();
  }

  for (let y = 0; y < map.map_data.length; y++) {
    const row = map.map_data[y];
    if (!Array.isArray(row) || row.length !== map.map_size_x) {
      const actual = Array.isArray(row) ? row.length : '配列でない';
      push(`map_data[${y}] の列数が map_size_x と一致しません (${actual} != ${map.map_size_x})`);
      return done();
    }
    for (let x = 0; x < row.length; x++) {
      if (!CELL_VALUES.includes(row[x])) {
        push(`map_data[${y}][${x}] が不正な値です (${row[x]})。0/1/2/3/4 のいずれかである必要があります`);
        return done();
      }
    }
  }

  const coolCells = findCells(map.map_data, COOL);
  const hotCells = findCells(map.map_data, HOT);

  // プレイヤーが開始しうるセル。ここが互いに到達可能でないと試合が成立しない
  let spawnCells;

  if (kind === 'fixed-spawn') {
    for (const [chara, marker, cells] of [['cool', COOL, coolCells], ['hot', HOT, hotCells]]) {
      const pos = map[chara];
      if (!Number.isInteger(pos.x) || !Number.isInteger(pos.y)) {
        push(`${chara} の初期座標が整数ではありません (x=${pos.x}, y=${pos.y})`);
        return done();
      }
      if (pos.x < 0 || pos.x >= map.map_size_x || pos.y < 0 || pos.y >= map.map_size_y) {
        push(`${chara} の初期座標が盤面外です (x=${pos.x}, y=${pos.y})`);
        return done();
      }
      if (cells.length !== 1) {
        push(`${chara} のマーカー(${marker}) が ${cells.length} 個あります。1個である必要があります`);
        continue;
      }
      if (cells[0].x !== pos.x || cells[0].y !== pos.y) {
        push(`${chara} の初期座標 (${pos.x}, ${pos.y}) と map_data 上のマーカー位置 (${cells[0].x}, ${cells[0].y}) が一致しません`);
      }
    }

    if (map.cool.x === map.hot.x && map.cool.y === map.hot.y) {
      push('cool と hot の初期位置が同じです');
    }
    if (errors.length) return done();

    spawnCells = [{ x: map.cool.x, y: map.cool.y }, { x: map.hot.x, y: map.hot.y }];
  } else {
    // random-spawn。player_spon() が床(0)を探して配置するので、マーカーは存在してはならない
    if (coolCells.length || hotCells.length) {
      push(`ランダム配置マップに プレイヤーマーカー(3/4) が ${coolCells.length + hotCells.length} 個あります`);
    }
    spawnCells = findCells(map.map_data, FLOOR);
    if (spawnCells.length < 2) {
      push(`ランダム配置に必要な床(0)が ${spawnCells.length} マスしかありません。2マス以上必要です`);
    }
    if (errors.length) return done();
  }

  // 開始位置の相互到達性。これが破れると相手に接触できず必ずスコア勝負になる
  const { seen, reached, total } = checkConnectivity(map.map_data, [spawnCells[0].x, spawnCells[0].y]);
  const unreachableSpawns = spawnCells.filter((c) => !seen[c.y][c.x]);
  if (unreachableSpawns.length) {
    const where = unreachableSpawns.slice(0, 3).map((c) => `(${c.x}, ${c.y})`).join(', ');
    push(`開始位置が互いに到達できません。${unreachableSpawns.length} 箇所が分断されています: ${where}`);
  }

  // 孤立領域は「取れない囮アイテム」として意図的に置かれることがある。
  // 例: 一関24初戦マップは点対称に8個のアイテムを封鎖している。よって警告に留める
  if (reached !== total) {
    let orphanItems = 0;
    for (let y = 0; y < map.map_data.length; y++) {
      for (let x = 0; x < map.map_data[y].length; x++) {
        if (map.map_data[y][x] === ITEM && !seen[y][x]) orphanItems++;
      }
    }
    warn(`到達できない領域が ${total - reached} マスあります (うちアイテム ${orphanItems} 個)。囮として意図的なら問題ありません`);
  }

  return done();
}

/** ディレクトリ内の全マップを検査する */
function validateAll(dir = MAP_DIR) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  const errors = [];
  const warnings = [];
  const seenRoomIds = new Set();

  for (const file of files) {
    let map;
    try {
      map = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch (e) {
      errors.push(`${file}: JSON として読めません (${e.message})`);
      continue;
    }
    const result = validateMap(map, file);
    errors.push(...result.errors);
    warnings.push(...result.warnings);

    if (seenRoomIds.has(map.room_id)) {
      errors.push(`${file}: room_id ${map.room_id} が重複しています`);
    }
    seenRoomIds.add(map.room_id);
  }

  return { files, errors, warnings };
}

module.exports = {
  validateMap, validateAll, checkConnectivity, findCells, mapKind,
  MAP_DIR, FLOOR, ITEM, BLOCK, COOL, HOT,
};

if (require.main === module) {
  const { files, errors, warnings } = validateAll();
  if (warnings.length) {
    console.warn(`警告 ${warnings.length} 件:`);
    for (const w of warnings) console.warn('  ' + w);
    console.warn('');
  }
  if (errors.length) {
    console.error(`マップ検証に失敗しました (${files.length} ファイル中 ${errors.length} 件のエラー)\n`);
    for (const e of errors) console.error('  ' + e);
    process.exit(1);
  }
  console.log(`マップ検証に成功しました (${files.length} ファイル、エラーなし)`);
}
