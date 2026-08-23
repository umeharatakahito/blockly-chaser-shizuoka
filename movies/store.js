/**
 * 試合動画のメタデータ管理。
 *
 * 動画ファイルは load_data/movie_data/ に置く。
 * 同ディレクトリの movies.json にタイトルや説明を書く。
 *
 * movies.json に載っていないファイルがディレクトリにあった場合は、
 * ファイル名からエントリを自動生成して一覧に出す。
 * 運営がファイルを置くだけで公開でき、サーバーの再起動もいらない。
 *
 * メタデータはリクエストのたびに読み直す。大会中の動画本数はたかが知れており、
 * キャッシュの無効化を考えるより読み直すほうが事故が少ない。
 */

const fs = require('fs');
const path = require('path');

const MOVIE_DIR = path.join(__dirname, '..', 'load_data', 'movie_data');
const META_FILE = path.join(MOVIE_DIR, 'movies.json');
// 非公開にした動画の置き場。listFiles は直下しか見ないので一覧から消える。
// 削除ではなく退避にしているのは、誤操作から戻せるようにするため
const HIDDEN_DIR = path.join(MOVIE_DIR, '_hidden');

// ブラウザの <video> がそのまま再生できる形式だけを扱う。
// これ以外の拡張子はディレクトリにあっても一覧に出さない
const ALLOWED_EXT = ['.mp4', '.webm', '.m4v'];

const MIME_TYPES = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
};

/**
 * multipart で届いたファイル名を UTF-8 として読み直す。
 *
 * busboy(multer が内部で使う)は multipart のファイル名を latin1 として解釈する。
 * そのため「決勝戦.mp4」の UTF-8 バイト列が1バイトずつ別の文字として届き、
 * そのまま sanitizeFileName に渡すと日本語がすべて _ に潰れてしまう。
 * latin1 として書き戻してから UTF-8 で読み直すことで元の名前を復元する。
 *
 * ASCII だけの名前はこの変換で何も変わらない。
 * 復元に失敗した場合(U+FFFD が出る)は元の文字列をそのまま返す。
 */
function decodeUploadFileName(name) {
  const raw = String(name || '');
  try {
    const decoded = Buffer.from(raw, 'latin1').toString('utf8');
    return decoded.includes('\uFFFD') ? raw : decoded;
  } catch (e) {
    return raw;
  }
}

/**
 * アップロードされたファイル名を安全な形に直す。
 *
 * パス区切りを含む名前をそのまま使うと、意図しない場所へ書き込まれる。
 * ディレクトリ部分を捨てたうえで、扱いにくい文字を _ に潰す。
 */
function sanitizeFileName(name) {
  const base = path.basename(String(name || ''));
  // 先頭のドットを落として隠しファイル化を防ぐ
  const noDot = base.replace(/^\.+/, '');
  const ext = path.extname(noDot).toLowerCase();
  const stem = path.basename(noDot, path.extname(noDot));

  // 英数字・ひらがな・カタカナ・漢字・長音・ハイフン・アンダースコアだけ残す
  const safeStem = stem
    .replace(/[^\w\-ぁ-んァ-ヶー一-龠]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '');

  return (safeStem || 'movie') + ext;
}

/** URL に載せる id を安全な形に直す */
function sanitizeId(id) {
  const safe = String(id || '')
    .replace(/[^\w\-ぁ-んァ-ヶー一-龠]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '');
  return safe || 'movie';
}

const isAllowedFile = (fileName) => ALLOWED_EXT.includes(path.extname(fileName).toLowerCase());

const mimeTypeFor = (fileName) => MIME_TYPES[path.extname(fileName).toLowerCase()] || 'application/octet-stream';

/** movie_data ディレクトリにある再生可能なファイル名の一覧 */
function listFiles() {
  try {
    return fs.readdirSync(MOVIE_DIR).filter(isAllowedFile).sort();
  } catch (e) {
    // ディレクトリが無い場合は「動画なし」として扱う。運営が作り忘れても落とさない
    return [];
  }
}

/** movies.json を読む。壊れていても例外は投げず、空として扱う */
function readMeta() {
  try {
    const parsed = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
    return Array.isArray(parsed.movies) ? parsed.movies : [];
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.error('movies.json を読めません: ' + e.message);
    }
    return [];
  }
}

/** movies.json を書く。一時ファイル経由で置き換え、書き込み中の破損を避ける */
function writeMeta(movies) {
  fs.mkdirSync(MOVIE_DIR, { recursive: true });
  const tmp = META_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ movies }, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, META_FILE);
}

/**
 * メタデータとディレクトリの実体を突き合わせて一覧を作る。
 *
 * - movies.json にあってファイルが無いものは除外する(消された動画)
 * - ファイルがあって movies.json に無いものは自動でエントリを作る
 */
function listMovies() {
  const files = listFiles();
  const fileSet = new Set(files);
  const meta = readMeta();

  const result = [];
  const claimed = new Set();
  const usedIds = new Set();

  for (const entry of meta) {
    if (!entry || typeof entry.file !== 'string') continue;
    const file = path.basename(entry.file);
    if (!fileSet.has(file)) continue;

    let id = sanitizeId(entry.id || path.basename(file, path.extname(file)));
    while (usedIds.has(id)) id += '_';
    usedIds.add(id);
    claimed.add(file);

    result.push({
      id,
      file,
      title: (typeof entry.title === 'string' && entry.title.trim()) || file,
      description: typeof entry.description === 'string' ? entry.description : '',
      date: typeof entry.date === 'string' ? entry.date : '',
      order: Number.isFinite(entry.order) ? entry.order : Number.MAX_SAFE_INTEGER,
      registered: true,
    });
  }

  // movies.json に載っていないファイル。運営が置いただけの動画もそのまま見せる
  for (const file of files) {
    if (claimed.has(file)) continue;
    let id = sanitizeId(path.basename(file, path.extname(file)));
    while (usedIds.has(id)) id += '_';
    usedIds.add(id);

    result.push({
      id,
      file,
      title: path.basename(file, path.extname(file)),
      description: '',
      date: '',
      order: Number.MAX_SAFE_INTEGER,
      registered: false,
    });
  }

  // order 昇順。同じなら日付の新しい順、それも同じならタイトル順
  result.sort((a, b) => (
    a.order - b.order
    || String(b.date).localeCompare(String(a.date))
    || String(a.title).localeCompare(String(b.title), 'ja')
  ));

  return result;
}

/** id から1件取り出す。無ければ null */
function getMovie(id) {
  const wanted = sanitizeId(id);
  return listMovies().find((m) => m.id === wanted) || null;
}

/** 動画ファイルの絶対パス。ディレクトリ外を指していたら null */
function resolveFilePath(movie) {
  const full = path.join(MOVIE_DIR, path.basename(movie.file));
  const root = path.resolve(MOVIE_DIR);
  // path.basename で潰しているので通常ここは通るが、二重の歯止めとして確認する
  return path.resolve(full).startsWith(root + path.sep) ? full : null;
}

/**
 * 一覧の編集内容を movies.json に保存する。
 * 画面から送られてくる値だけを取り込み、余計なキーは持ち込ませない。
 */
function saveMovieMeta(entries) {
  const movies = [];
  for (const entry of entries) {
    if (!entry || typeof entry.file !== 'string') continue;
    const file = path.basename(entry.file);
    if (!isAllowedFile(file)) continue;

    movies.push({
      id: sanitizeId(entry.id || path.basename(file, path.extname(file))),
      file,
      title: String(entry.title || '').trim() || file,
      description: String(entry.description || '').trim(),
      date: String(entry.date || '').trim(),
      order: Number.isFinite(Number(entry.order)) ? Number(entry.order) : 999,
    });
  }
  movies.sort((a, b) => a.order - b.order);
  writeMeta(movies);
  return movies;
}

/**
 * 動画を非公開にする。ファイルを _hidden/ へ移し、movies.json からも外す。
 * 戻したい場合は _hidden/ から1つ上へ移動すればよい。
 */
function hideMovie(id) {
  const movie = getMovie(id);
  if (!movie) return false;

  const from = resolveFilePath(movie);
  if (!from || !fs.existsSync(from)) return false;

  fs.mkdirSync(HIDDEN_DIR, { recursive: true });

  // 同名のファイルが既に退避されている場合は上書きせず、連番を足す
  let to = path.join(HIDDEN_DIR, path.basename(movie.file));
  if (fs.existsSync(to)) {
    const ext = path.extname(to);
    const stem = path.basename(to, ext);
    let n = 2;
    while (fs.existsSync(path.join(HIDDEN_DIR, `${stem}_${n}${ext}`))) n++;
    to = path.join(HIDDEN_DIR, `${stem}_${n}${ext}`);
  }

  fs.renameSync(from, to);
  writeMeta(readMeta().filter((e) => path.basename(String(e.file || '')) !== movie.file));
  return true;
}

module.exports = {
  MOVIE_DIR, META_FILE, HIDDEN_DIR, ALLOWED_EXT,
  saveMovieMeta, hideMovie,
  decodeUploadFileName, sanitizeFileName, sanitizeId, isAllowedFile, mimeTypeFor,
  listFiles, readMeta, writeMeta, listMovies, getMovie, resolveFilePath,
};
