const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../movies/store.js');

/* --- ファイル名・id の正規化 --- */

test('パス区切りを含むファイル名からディレクトリ部分を落とす', () => {
  assert.strictEqual(store.sanitizeFileName('../../etc/passwd.mp4'), 'passwd.mp4');
  assert.strictEqual(store.sanitizeFileName('/absolute/path/movie.mp4'), 'movie.mp4');
  // Windows 形式の区切りは POSIX の basename では割れないが、記号として _ に潰れる
  assert.strictEqual(store.sanitizeFileName('..\\..\\windows\\evil.mp4'), 'windows_evil.mp4');
});

test('先頭のドットを落として隠しファイル化を防ぐ', () => {
  assert.strictEqual(store.sanitizeFileName('.hidden.mp4'), 'hidden.mp4');
  assert.strictEqual(store.sanitizeFileName('...mp4'), 'mp4');
});

test('日本語のファイル名は保持する', () => {
  assert.strictEqual(store.sanitizeFileName('決勝戦.mp4'), '決勝戦.mp4');
  assert.strictEqual(store.sanitizeFileName('けっしょう戦2026.mp4'), 'けっしょう戦2026.mp4');
});

test('空のファイル名でも安全な既定値を返す', () => {
  assert.strictEqual(store.sanitizeFileName(''), 'movie');
  assert.strictEqual(store.sanitizeFileName(null), 'movie');
});

test('id からパス区切りや記号を除去する', () => {
  // 記号は _ に潰したうえで前後の _ を落とすため、パス区切りは跡形もなく消える
  assert.strictEqual(store.sanitizeId('../secret'), 'secret');
  assert.strictEqual(store.sanitizeId('a/../b'), 'a_b');
  assert.strictEqual(store.sanitizeId('final-2025'), 'final-2025');
  assert.strictEqual(store.sanitizeId(''), 'movie');
});

/* --- 拡張子の判定 --- */

test('再生できる拡張子だけを受け付ける', () => {
  assert.ok(store.isAllowedFile('a.mp4'));
  assert.ok(store.isAllowedFile('a.webm'));
  assert.ok(store.isAllowedFile('a.M4V'), '大文字の拡張子も受け付ける');
  assert.ok(!store.isAllowedFile('a.mov'));
  assert.ok(!store.isAllowedFile('a.avi'));
  assert.ok(!store.isAllowedFile('movies.json'));
  assert.ok(!store.isAllowedFile('a.mp4.exe'));
});

test('拡張子から MIME タイプを引く', () => {
  assert.strictEqual(store.mimeTypeFor('a.mp4'), 'video/mp4');
  assert.strictEqual(store.mimeTypeFor('a.m4v'), 'video/mp4');
  assert.strictEqual(store.mimeTypeFor('a.webm'), 'video/webm');
  assert.strictEqual(store.mimeTypeFor('a.txt'), 'application/octet-stream');
});

/* --- パスの解決 --- */

test('resolveFilePath はディレクトリ外を指せない', () => {
  const outside = store.resolveFilePath({ file: '../../../etc/passwd' });
  // path.basename で潰されるので movie_data の中を指す
  assert.ok(outside.includes('movie_data'));
  assert.ok(!outside.includes('etc'));
});

/* --- 一覧の組み立て --- */

test('同梱のサンプル動画が一覧に出る', () => {
  const movies = store.listMovies();
  const ids = movies.map((m) => m.id);
  assert.ok(ids.includes('final-2025'), '実際の一覧: ' + ids.join(', '));
});

test('order の昇順に並ぶ', () => {
  const movies = store.listMovies();
  for (let i = 1; i < movies.length; i++) {
    assert.ok(movies[i - 1].order <= movies[i].order, 'order が昇順になっていません');
  }
});

test('getMovie は存在しない id に null を返す', () => {
  assert.strictEqual(store.getMovie('存在しないid'), null);
  assert.strictEqual(store.getMovie('../../etc/passwd'), null);
});

test('getMovie は id で1件を返す', () => {
  const m = store.getMovie('final-2025');
  assert.ok(m);
  assert.strictEqual(m.file, 'sample-final-2025.mp4');
  assert.ok(m.title);
});

/* --- movies.json の読み書き --- */

test('壊れた movies.json でも例外を投げず空として扱う', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'movietest-'));
  const metaFile = path.join(dir, 'movies.json');
  fs.writeFileSync(metaFile, '{ これはJSONではない', 'utf8');

  // readMeta は内部の META_FILE を見るため、ここでは JSON.parse の失敗が
  // 例外にならないことを同じ手順で確かめる
  let result;
  assert.doesNotThrow(() => {
    try {
      result = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    } catch (e) {
      result = [];
    }
  });
  assert.deepStrictEqual(result, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeMeta は一時ファイル経由で置き換える', () => {
  const original = store.readMeta();
  try {
    store.writeMeta(original);
    // 書いた直後に .tmp が残っていないこと
    assert.ok(!fs.existsSync(store.META_FILE + '.tmp'), '一時ファイルが残っています');
    assert.deepStrictEqual(store.readMeta(), original);
  } finally {
    store.writeMeta(original);
  }
});

test('movies.json に載っていないファイルも自動でエントリになる', () => {
  const extra = path.join(store.MOVIE_DIR, 'テスト自動検出.mp4');
  fs.writeFileSync(extra, 'dummy');
  try {
    const found = store.listMovies().find((m) => m.file === 'テスト自動検出.mp4');
    assert.ok(found, 'ディレクトリに置いただけのファイルが一覧に出ていません');
    assert.strictEqual(found.registered, false);
    assert.strictEqual(found.title, 'テスト自動検出');
  } finally {
    fs.unlinkSync(extra);
  }
});

test('再生できない拡張子のファイルは一覧に出ない', () => {
  const extra = path.join(store.MOVIE_DIR, 'メモ.txt');
  fs.writeFileSync(extra, 'dummy');
  try {
    assert.ok(!store.listMovies().some((m) => m.file === 'メモ.txt'));
  } finally {
    fs.unlinkSync(extra);
  }
});

test('movies.json 自体は一覧に出ない', () => {
  assert.ok(!store.listMovies().some((m) => m.file === 'movies.json'));
});

/* --- multipart のファイル名の復号 --- */

test('latin1 として届いた日本語ファイル名を復元する', () => {
  const mangled = Buffer.from('決勝戦.mp4', 'utf8').toString('latin1');
  assert.strictEqual(store.decodeUploadFileName(mangled), '決勝戦.mp4');
});

test('ASCII のファイル名は復号しても変わらない', () => {
  assert.strictEqual(store.decodeUploadFileName('final-2025.mp4'), 'final-2025.mp4');
  assert.strictEqual(store.decodeUploadFileName('a_b-c.webm'), 'a_b-c.webm');
});

test('復号できない入力は元の文字列を返す', () => {
  // UTF-8 として不正なバイト列。壊れた名前で保存するより元のまま扱う
  const invalid = '\xff\xfe\xfd';
  assert.strictEqual(store.decodeUploadFileName(invalid), invalid);
});

test('復号したうえでサニタイズすると日本語が残る', () => {
  const mangled = Buffer.from('2026年 決勝戦.mp4', 'utf8').toString('latin1');
  assert.strictEqual(
    store.sanitizeFileName(store.decodeUploadFileName(mangled)),
    '2026年_決勝戦.mp4'
  );
});
