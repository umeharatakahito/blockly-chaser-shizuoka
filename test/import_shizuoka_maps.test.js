const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { pickShizuokaMaps, SHIZUOKA_NUMS } = require('../tool/import_shizuoka_maps.js');
const { formatMapJson } = require('../tool/generate_maps.js');
const { MAP_DIR } = require('../tool/validate_maps.js');

/** いま load_data にある静岡マップを DO 版の maps.json の形に戻して、取り込み元の代わりにする */
function currentAsSource() {
  const maps = {};
  for (const num of SHIZUOKA_NUMS) {
    for (const n of [num, num + 100]) {
      const id = `room_${String(n).padStart(3, '0')}`;
      maps[id] = JSON.parse(fs.readFileSync(path.join(MAP_DIR, `game_server_${String(n).padStart(3, '0')}.json`), 'utf8'));
    }
  }
  return maps;
}

test('静岡大会の10ルームを CPU対戦と対人のペアで取り出す', () => {
  const files = pickShizuokaMaps(currentAsSource());
  assert.deepStrictEqual(files.map((f) => f.map.room_id).sort(), [
    'room_010', 'room_011', 'room_012', 'room_013', 'room_014',
    'room_110', 'room_111', 'room_112', 'room_113', 'room_114',
  ]);
  assert.strictEqual(files.filter((f) => f.map.cpu).length, 5);
  assert.strictEqual(files.filter((f) => !f.map.cpu).length, 5);
});

test('取り込んだ内容は load_data の静岡マップと一致する(原本は DO 版)', () => {
  for (const { fileName, map } of pickShizuokaMaps(currentAsSource())) {
    const onDisk = fs.readFileSync(path.join(MAP_DIR, fileName), 'utf8');
    assert.strictEqual(formatMapJson(map), onDisk, `${fileName} が取り込み結果と違います。node tool/import_shizuoka_maps.js を実行してください`);
  }
});

test('DO 版にしかない項目(auto_* など)は持ち込まない', () => {
  const src = currentAsSource();
  src.room_010.auto_symmetry = true;
  src.room_010.cool.name = 'ごみ';
  const { map } = pickShizuokaMaps(src).find((f) => f.map.room_id === 'room_010');
  assert.deepStrictEqual(Object.keys(map).sort(), ['cool', 'cpu', 'hot', 'map_data', 'map_size_x', 'map_size_y', 'name', 'room_id', 'turn']);
  assert.deepStrictEqual(map.cool, { status: false, turn: false, x: src.room_010.cool.x, y: src.room_010.cool.y });
});

test('CPU対戦と対人で盤面が違えば取り込まない', () => {
  const src = currentAsSource();
  src.room_112.map_data = src.room_112.map_data.map((r) => r.slice());
  src.room_112.map_data[0][0] = src.room_112.map_data[0][0] === 0 ? 1 : 0;
  assert.throws(() => pickShizuokaMaps(src), /room_012 と room_112 の盤面が違います/);
});

test('ルームが欠けていれば取り込まない', () => {
  const src = currentAsSource();
  delete src.room_113;
  assert.throws(() => pickShizuokaMaps(src), /room_013 \/ room_113 が取り込み元にありません/);
});

test('自動生成マップ(盤面なし)は取り込まない', () => {
  const src = currentAsSource();
  src.room_011.map_data = [];
  src.room_111.map_data = [];
  assert.throws(() => pickShizuokaMaps(src), /盤面を持たないマップ/);
});
