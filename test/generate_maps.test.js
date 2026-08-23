const test = require('node:test');
const assert = require('node:assert');

const {
  mulberry32, buildBoard, generateMap, formatMapJson, buildAll, mirror, SHIZUOKA_MAPS,
} = require('../tool/generate_maps.js');
const { validateMap, checkConnectivity, BLOCK, ITEM, COOL, HOT } = require('../tool/validate_maps.js');

const SPEC = { sizeX: 15, sizeY: 17, blocks: 40, items: 30, spawn: [1, 1], seed: 12345 };

test('mulberry32 は同じシードから同じ数列を返す', () => {
  const a = Array.from({ length: 10 }, mulberry32(42));
  const b = Array.from({ length: 10 }, mulberry32(42));
  assert.deepStrictEqual(a, b);
});

test('mulberry32 は違うシードからは違う数列を返す', () => {
  const a = mulberry32(1)();
  const b = mulberry32(2)();
  assert.notStrictEqual(a, b);
});

test('同じシードからは同じ盤面が生成される', () => {
  const a = generateMap(SPEC);
  const b = generateMap(SPEC);
  assert.deepStrictEqual(a.board, b.board);
  assert.strictEqual(a.usedSeed, b.usedSeed);
});

test('違うシードからは違う盤面が生成される', () => {
  const a = generateMap(SPEC);
  const b = generateMap({ ...SPEC, seed: SPEC.seed + 1000 });
  assert.notDeepStrictEqual(a.board, b.board);
});

test('生成した盤面は中心に対して点対称である', () => {
  const { board } = generateMap(SPEC);
  const sizeY = board.length;
  const sizeX = board[0].length;

  // プレイヤーは cool(3)/hot(4) と値が異なるので、対称性は「両方ともプレイヤー」で判定する
  const isPlayer = (v) => v === COOL || v === HOT;

  for (let y = 0; y < sizeY; y++) {
    for (let x = 0; x < sizeX; x++) {
      const [mx, my] = mirror(x, y, sizeX, sizeY);
      const a = board[y][x];
      const b = board[my][mx];
      if (isPlayer(a) || isPlayer(b)) {
        assert.ok(isPlayer(a) && isPlayer(b), `(${x},${y}) と (${mx},${my}) の対称が崩れています`);
      } else {
        assert.strictEqual(a, b, `(${x},${y})=${a} と (${mx},${my})=${b} が対称ではありません`);
      }
    }
  }
});

test('cool と hot は互いに鏡像の位置にある', () => {
  const { board, cool, hot } = generateMap(SPEC);
  const [mx, my] = mirror(cool.x, cool.y, board[0].length, board.length);
  assert.deepStrictEqual({ x: mx, y: my }, { x: hot.x, y: hot.y });
});

test('生成した盤面では cool から hot へ到達できる', () => {
  const { board, cool, hot } = generateMap(SPEC);
  const { seen } = checkConnectivity(board, [cool.x, cool.y]);
  assert.ok(seen[hot.y][hot.x], 'hot に到達できません');
});

test('指定した個数のブロックとアイテムが配置される', () => {
  const { board } = generateMap(SPEC);
  const flat = board.flat();
  assert.strictEqual(flat.filter((c) => c === BLOCK).length, SPEC.blocks);
  assert.strictEqual(flat.filter((c) => c === ITEM).length, SPEC.items);
});

test('盤面に収まらない個数を指定すると例外になる', () => {
  assert.throws(
    () => buildBoard({ sizeX: 5, sizeY: 5, blocks: 100, items: 100, spawn: [0, 0] }, mulberry32(1)),
    /収まりません/
  );
});

test('minReachableRatio を満たせないと例外になる', () => {
  // 到達率100%を要求しつつブロックを敷き詰めれば、必ず死角が出て失敗する
  assert.throws(
    () => generateMap({ ...SPEC, blocks: 180, items: 2, attempts: 5, minReachableRatio: 1.0 }),
    /生成できませんでした/
  );
});

test('buildAll は CPU対戦と対人のペアを生成する', () => {
  const files = buildAll();
  assert.strictEqual(files.length, SHIZUOKA_MAPS.length * 2);

  const cpuFiles = files.filter((f) => f.map.cpu);
  const vsFiles = files.filter((f) => !f.map.cpu);
  assert.strictEqual(cpuFiles.length, SHIZUOKA_MAPS.length);
  assert.strictEqual(vsFiles.length, SHIZUOKA_MAPS.length);
});

test('CPU対戦ルームと対人ルームは同じ盤面を共有する', () => {
  const files = buildAll();
  for (const spec of SHIZUOKA_MAPS) {
    const cpu = files.find((f) => f.map.room_id === `room_0${spec.num}`);
    const vs = files.find((f) => f.map.room_id === `room_1${spec.num}`);
    assert.deepStrictEqual(cpu.map.map_data, vs.map.map_data, `${spec.name} の盤面が一致しません`);
    assert.deepStrictEqual(cpu.map.cool, vs.map.cool);
    assert.deepStrictEqual(cpu.map.hot, vs.map.hot);
    assert.strictEqual(cpu.map.turn, vs.map.turn);
  }
});

test('生成したマップはすべて検証を通る', () => {
  for (const { fileName, map } of buildAll()) {
    const { errors } = validateMap(map, fileName);
    assert.deepStrictEqual(errors, [], `${fileName}:\n` + errors.join('\n'));
  }
});

test('formatMapJson の出力は JSON として読み戻せる', () => {
  const { fileName, map } = buildAll()[0];
  const parsed = JSON.parse(formatMapJson(map));
  assert.deepStrictEqual(parsed, map);
  assert.ok(fileName.endsWith('.json'));
});

test('formatMapJson は map_data を1行1行で出力する', () => {
  const { map } = buildAll()[0];
  const text = formatMapJson(map);
  // 盤面の行数だけ "        [" で始まる行があるはず
  const rowLines = text.split('\n').filter((l) => l.startsWith('        ['));
  assert.strictEqual(rowLines.length, map.map_size_y);
});

test('静岡大会マップの room_id は 010〜014 / 110〜114 のまま変わらない', () => {
  // 参加者の .blch が保持する room_id を壊さないための確認
  const ids = buildAll().map((f) => f.map.room_id).sort();
  assert.deepStrictEqual(ids, [
    'room_010', 'room_011', 'room_012', 'room_013', 'room_014',
    'room_110', 'room_111', 'room_112', 'room_113', 'room_114',
  ]);
});
