/**
 * 静岡大会マップを DO 版(blockly-chaser-shizuoka-do)から取り込む。
 *
 * 大会マップの原本は DO 版の src/data/maps.json にある(設計図は同リポジトリの tool/shizuoka_maps.mjs)。
 * こちらは Node 版の体裁(load_data/game_server_data/game_server_XXX.json)に写すだけで、盤面は編集しない。
 *
 * 使い方:
 *   node tool/import_shizuoka_maps.js                     公開サイトの /api/game から取り込む
 *   node tool/import_shizuoka_maps.js <maps.json のパス>   DO 版リポジトリの maps.json から取り込む
 *   node tool/import_shizuoka_maps.js <URL>               別の DO 版サーバー(wrangler dev など)から取り込む
 *   node tool/import_shizuoka_maps.js --dry               書き出さずに結果だけ表示する
 *
 * 取り込むのは room_010〜014(CPU対戦)と room_110〜114(対人)の10ルーム。
 * 汎用マップ(001〜009 / 101〜109)は大会に依存しないので触らない。
 * room_id は参加者の .blch が保持しているため変えない。
 */

const fs = require('fs');
const path = require('path');

const { formatMapJson } = require('./generate_maps.js');
const { validateMap, MAP_DIR } = require('./validate_maps.js');

const DEFAULT_SOURCE = 'https://blockly-chaser-shizuoka-do.blockly-chaser-shizuoka-do.workers.dev/api/game';

const SHIZUOKA_NUMS = [10, 11, 12, 13, 14];
const roomId = (num) => `room_${String(num).padStart(3, '0')}`;
const fileName = (num) => `game_server_${String(num).padStart(3, '0')}.json`;

/** DO 版の maps.json(または /api/game の応答)を読む。URL ならダウンロードする */
async function loadSource(source = DEFAULT_SOURCE) {
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`${source} から取得できません (HTTP ${res.status})`);
    return res.json();
  }
  return JSON.parse(fs.readFileSync(source, 'utf8'));
}

/**
 * DO 版のマップ一覧から静岡大会の10ルームを取り出し、Node 版のファイル内容に整える。
 * 純粋関数なのでテストから直接呼べる。
 *
 * @param {Object} maps DO 版の maps.json と同じ形 ({ room_010: {...}, ... })
 * @returns {{fileName: string, map: Object}[]}
 */
function pickShizuokaMaps(maps) {
  const files = [];
  const problems = [];

  for (const num of SHIZUOKA_NUMS) {
    const cpuId = roomId(num);
    const vsId = roomId(num + 100);
    const cpu = maps[cpuId];
    const vs = maps[vsId];
    if (!cpu || !vs) { problems.push(`${cpuId} / ${vsId} が取り込み元にありません`); continue; }
    if (!Array.isArray(cpu.map_data) || cpu.map_data.length === 0) {
      problems.push(`${cpuId} は盤面を持たないマップです(自動生成マップは取り込めません)`); continue;
    }
    if (JSON.stringify(cpu.map_data) !== JSON.stringify(vs.map_data)) {
      problems.push(`${cpuId} と ${vsId} の盤面が違います`); continue;
    }
    if (!cpu.cpu) problems.push(`${cpuId} に cpu の設定がありません`);

    for (const [id, src] of [[cpuId, cpu], [vsId, vs]]) {
      const map = {
        name: src.name,
        room_id: id,
        map_size_x: src.map_size_x,
        map_size_y: src.map_size_y,
        map_data: src.map_data,
        cool: { status: false, turn: false, x: src.cool.x, y: src.cool.y },
        hot: { status: false, turn: false, x: src.hot.x, y: src.hot.y },
        turn: src.turn,
      };
      if (src.cpu) map.cpu = { level: src.cpu.level, turn: src.cpu.turn };

      const name = fileName(id === cpuId ? num : num + 100);
      const { errors } = validateMap(map, name);
      problems.push(...errors);
      files.push({ fileName: name, map });
    }
  }

  if (problems.length) throw new Error('取り込めません:\n  ' + problems.join('\n  '));
  return files;
}

module.exports = { DEFAULT_SOURCE, SHIZUOKA_NUMS, loadSource, pickShizuokaMaps };

if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry');
  const source = args.find((a) => !a.startsWith('--')) || DEFAULT_SOURCE;

  (async () => {
    console.log(`取り込み元: ${source}`);
    const files = pickShizuokaMaps(await loadSource(source));

    for (const { fileName: name, map } of files) {
      const flat = map.map_data.flat();
      const blocks = flat.filter((c) => c === 1).length;
      const items = flat.filter((c) => c === 2).length;
      const before = path.join(MAP_DIR, name);
      const changed = !fs.existsSync(before) || fs.readFileSync(before, 'utf8') !== formatMapJson(map);
      console.log(
        `${name}  ${map.name}  ターン${map.turn}  ブロック${blocks} アイテム${items}`
        + (map.cpu ? '  [CPU対戦]' : '  [対人]') + (changed ? '  ← 更新' : '  (変更なし)')
      );
      if (!dryRun) fs.writeFileSync(before, formatMapJson(map), 'utf8');
    }

    console.log(dryRun
      ? `\n--dry のため書き出していません (${files.length} ファイル)`
      : `\n${files.length} ファイルを書き出しました。npm test で検証してください`);
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
