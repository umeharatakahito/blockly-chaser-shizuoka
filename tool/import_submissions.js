/**
 * DO 版(公開サイト)から、エントリーと提出プログラムを会場の Node 版へ取り込む。
 *
 *   DO_ADMIN_KEY=<DO版の運営の鍵> node tool/import_submissions.js
 *   DO_ADMIN_KEY=... node tool/import_submissions.js http://localhost:8787   別の DO 版から
 *
 * 取り込み先は load_data/contest/(参加者の名簿とプログラム)。何度実行してもよい。
 * 新しい提出があれば差し替え、会場で運営が差し替えたプログラムはそのまま残す。
 * 運営画面(/contest/admin)の「DO 版から取り込む」も同じ処理を行う。
 */

const { importFromDo, describeSummary, DEFAULT_URL } = require('../contest/importer.js');

const url = process.argv[2] || process.env.DO_URL || DEFAULT_URL;
const key = process.env.DO_ADMIN_KEY || '';

if (!key) {
  console.error('DO 版の運営の鍵を環境変数 DO_ADMIN_KEY で渡してください。');
  console.error('  DO_ADMIN_KEY=xxxxx node tool/import_submissions.js');
  process.exit(1);
}

importFromDo(url, key)
  .then((summary) => {
    console.log(`取り込み元: ${url}`);
    for (const line of describeSummary(summary)) console.log('  ' + line);
  })
  .catch((e) => { console.error('取り込めません: ' + e.message); process.exit(1); });
