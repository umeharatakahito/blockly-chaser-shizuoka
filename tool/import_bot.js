/**
 * ボット対戦の思考(L1〜L30)を DO 版から写す。
 *
 * 原本は DO 版(blockly-chaser-shizuoka-do)の src/game/bot.js と constants.js。
 * 参加者はオンラインのボット対戦で練習しているので、予選でも同じボットと戦えるよう
 * ファイルを1文字も変えずに chaser/bot/ へ写す。chaser/bot/package.json で ES モジュールとして読む。
 *
 *   node tool/import_bot.js                        隣の ../blockly-chaser-shizuoka-do から写す
 *   node tool/import_bot.js <DO版リポジトリのパス>
 */

const fs = require('fs');
const path = require('path');

const FILES = ['bot.js', 'constants.js'];
const DEST = path.join(__dirname, '..', 'chaser', 'bot');

function importBot(doRepo) {
  const src = path.join(doRepo, 'src', 'game');
  fs.mkdirSync(DEST, { recursive: true });
  const changed = [];
  for (const f of FILES) {
    const from = path.join(src, f);
    if (!fs.existsSync(from)) throw new Error(`${from} がありません`);
    const to = path.join(DEST, f);
    const next = fs.readFileSync(from);
    if (!fs.existsSync(to) || !next.equals(fs.readFileSync(to))) {
      fs.writeFileSync(to, next);
      changed.push(f);
    }
  }
  fs.writeFileSync(path.join(DEST, 'package.json'), JSON.stringify({ type: 'module' }, null, 2) + '\n');
  return changed;
}

module.exports = { importBot, FILES, DEST };

if (require.main === module) {
  const repo = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', 'blockly-chaser-shizuoka-do'));
  const changed = importBot(repo);
  console.log(`取り込み元: ${repo}`);
  console.log(changed.length ? `更新: ${changed.join(', ')}` : '変更はありません');
}
