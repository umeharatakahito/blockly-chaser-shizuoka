const test = require('node:test');
const assert = require('node:assert');

const {
  validateMap, validateAll, findCells, mapKind,
  FLOOR, ITEM, BLOCK, COOL, HOT,
} = require('../tool/validate_maps.js');

/**
 * 検査用の最小マップを作る。
 * 既定は 5x5 の全面床で、cool(1,1) と hot(3,3) を置いた固定配置マップ。
 */
function makeMap(overrides = {}) {
  const size = 5;
  const map_data = Array.from({ length: size }, () => new Array(size).fill(FLOOR));
  map_data[1][1] = COOL;
  map_data[3][3] = HOT;

  return Object.assign({
    name: 'テストマップ',
    room_id: 'room_001',
    map_size_x: size,
    map_size_y: size,
    map_data,
    cool: { status: false, turn: false, x: 1, y: 1 },
    hot: { status: false, turn: false, x: 3, y: 3 },
    turn: 100,
  }, overrides);
}

const FILE = 'game_server_001.json';

test('正常なマップはエラーも警告も出さない', () => {
  const { errors, warnings } = validateMap(makeMap(), FILE);
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(warnings, []);
});

test('map_data の行数が map_size_y と食い違うと検出する', () => {
  const map = makeMap();
  map.map_data.pop();
  const { errors } = validateMap(map, FILE);
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0], /行数/);
});

test('map_data の列数が map_size_x と食い違うと検出する', () => {
  const map = makeMap();
  map.map_data[2].pop();
  const { errors } = validateMap(map, FILE);
  assert.match(errors[0], /列数/);
});

test('未定義のセル値を検出する', () => {
  const map = makeMap();
  map.map_data[2][2] = 9;
  const { errors } = validateMap(map, FILE);
  assert.match(errors[0], /不正な値/);
});

test('room_id がファイル名と一致しないと検出する', () => {
  const map = makeMap({ room_id: 'room_999' });
  const { errors } = validateMap(map, FILE);
  assert.match(errors[0], /room_id/);
});

test('turn が 0 以下だと検出する', () => {
  const { errors } = validateMap(makeMap({ turn: 0 }), FILE);
  assert.match(errors[0], /turn/);
});

test('初期座標が盤面外だと検出する', () => {
  const map = makeMap();
  map.cool = { x: 99, y: 99 };
  const { errors } = validateMap(map, FILE);
  assert.match(errors[0], /盤面外/);
});

test('初期座標と map_data 上のマーカー位置がずれていると検出する', () => {
  const map = makeMap();
  // cool の座標だけ動かし、マーカーは (1,1) に残す
  map.cool = { x: 2, y: 2 };
  const { errors } = validateMap(map, FILE);
  assert.match(errors[0], /一致しません/);
});

test('cool マーカーが複数あると検出する', () => {
  const map = makeMap();
  map.map_data[0][0] = COOL;
  const { errors } = validateMap(map, FILE);
  assert.match(errors[0], /マーカー/);
});

test('開始位置がブロックで分断されているとエラーにする', () => {
  const map = makeMap();
  // hot(3,3) を四方ブロックで囲って cool から到達できなくする
  map.map_data[2][3] = BLOCK;
  map.map_data[4][3] = BLOCK;
  map.map_data[3][2] = BLOCK;
  map.map_data[3][4] = BLOCK;
  const { errors } = validateMap(map, FILE);
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0], /到達できません/);
});

test('孤立したアイテムは警告に留め、エラーにはしない', () => {
  const map = makeMap();
  // 隅(0,0)にアイテムを置き、ブロックで封鎖する。囮アイテムを模した配置
  map.map_data[0][0] = ITEM;
  map.map_data[0][1] = BLOCK;
  map.map_data[1][0] = BLOCK;

  const { errors, warnings } = validateMap(map, FILE);
  assert.deepStrictEqual(errors, [], '囮アイテムはエラーにしない');
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /アイテム 1 個/);
});

test('ランダム配置マップは座標を検査せず、床の連結だけを見る', () => {
  const size = 5;
  const map_data = Array.from({ length: size }, () => new Array(size).fill(FLOOR));
  const map = makeMap({
    map_data,
    cool: { status: false, turn: false, x: -1, y: -1 },
    hot: { status: false, turn: false, x: -1, y: -1 },
  });

  assert.strictEqual(mapKind(map), 'random-spawn');
  const { errors } = validateMap(map, FILE);
  assert.deepStrictEqual(errors, []);
});

test('ランダム配置マップの床が分断されているとエラーにする', () => {
  const size = 5;
  const map_data = Array.from({ length: size }, () => new Array(size).fill(FLOOR));
  // 3行目を全部ブロックにして盤面を上下に割る
  map_data[2] = new Array(size).fill(BLOCK);

  const map = makeMap({
    map_data,
    cool: { status: false, turn: false, x: -1, y: -1 },
    hot: { status: false, turn: false, x: -1, y: -1 },
  });

  const { errors } = validateMap(map, FILE);
  assert.match(errors[0], /到達できません/);
});

test('ランダム配置マップにプレイヤーマーカーがあると検出する', () => {
  const size = 5;
  const map_data = Array.from({ length: size }, () => new Array(size).fill(FLOOR));
  map_data[1][1] = COOL;

  const map = makeMap({
    map_data,
    cool: { status: false, turn: false, x: -1, y: -1 },
    hot: { status: false, turn: false, x: -1, y: -1 },
  });

  const { errors } = validateMap(map, FILE);
  assert.match(errors[0], /マーカー/);
});

test('手続き生成マップは盤面を持たず、生成パラメータだけを検査する', () => {
  // 実際の room_001 と同じ 15x17 の盤面に、同じ生成パラメータを与える
  const map = makeMap({
    map_size_x: 15,
    map_size_y: 17,
    map_data: [],
    auto_block: 24,
    auto_point: 35,
    auto_symmetry: false,
    cool: { status: false, turn: false },
    hot: { status: false, turn: false },
  });

  assert.strictEqual(mapKind(map), 'procedural');
  const { errors } = validateMap(map, FILE);
  assert.deepStrictEqual(errors, []);
});

test('手続き生成マップの生成数が盤面に収まらないと検出する', () => {
  const map = makeMap({
    map_data: [],
    auto_block: 500,
    auto_point: 500,
    cool: { status: false, turn: false },
    hot: { status: false, turn: false },
  });

  const { errors } = validateMap(map, FILE);
  assert.match(errors[0], /収まりません/);
});

test('cpu.turn が cool/hot 以外だと検出する', () => {
  const map = makeMap({ cpu: { level: 2, turn: 'both' } });
  const { errors } = validateMap(map, FILE);
  assert.match(errors[0], /cpu\.turn/);
});

test('findCells は指定した値のセルをすべて返す', () => {
  const map = makeMap();
  assert.deepStrictEqual(findCells(map.map_data, COOL), [{ x: 1, y: 1 }]);
  assert.deepStrictEqual(findCells(map.map_data, HOT), [{ x: 3, y: 3 }]);
  assert.deepStrictEqual(findCells(map.map_data, BLOCK), []);
});

test('同梱されている全マップがエラーなしで通る', () => {
  const { files, errors } = validateAll();
  assert.strictEqual(errors.length, 0, '検出されたエラー:\n' + errors.join('\n'));
  assert.strictEqual(files.length, 28, 'マップは28ファイルあるはず');
});

test('room_id が重複していないこと', () => {
  const { errors } = validateAll();
  assert.ok(!errors.some((e) => /重複/.test(e)));
});
