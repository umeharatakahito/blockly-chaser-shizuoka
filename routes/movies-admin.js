/**
 * 試合動画の管理(運営向け)。
 *
 *   GET  /movies/admin          管理画面
 *   POST /movies/admin/upload   動画のアップロード
 *   POST /movies/admin/save     タイトル・説明・並び順の保存
 *   POST /movies/admin/hide     動画を非公開にする(_hidden/ へ退避)
 *
 * 権限は tool/admin_auth.js に任せる。
 * ADMIN_KEY 未設定なら localhost からのみ、設定済みなら合言葉が必要。
 */

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const router = express.Router();
const store = require('../movies/store.js');
const { requireAdmin } = require('../tool/admin_auth.js');

// 1ファイルあたりの上限。試合動画としては十分で、
// 会場のディスクを一度に食い潰さない程度に抑える
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    try {
      fs.mkdirSync(store.MOVIE_DIR, { recursive: true });
      cb(null, store.MOVIE_DIR);
    } catch (e) {
      cb(e);
    }
  },
  filename: function (req, file, cb) {
    // 元のファイル名は信用しない。UTF-8 として読み直したうえで安全な形に直す
    let name = store.sanitizeFileName(store.decodeUploadFileName(file.originalname));

    // 既にあるファイルを黙って上書きしない。連番を足して両方残す
    const ext = path.extname(name);
    const stem = path.basename(name, ext);
    let n = 2;
    while (fs.existsSync(path.join(store.MOVIE_DIR, name))) {
      name = `${stem}_${n}${ext}`;
      n++;
    }
    cb(null, name);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: function (req, file, cb) {
    // 拡張子で弾く。ブラウザが再生できない形式を受け取っても意味がない
    if (!store.isAllowedFile(store.sanitizeFileName(store.decodeUploadFileName(file.originalname)))) {
      return cb(new UploadError('mp4 / webm / m4v のいずれかを選んでください'));
    }
    cb(null, true);
  },
});

class UploadError extends Error {}

const MAX_UPLOAD_MB = Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024);

/** 管理画面を描画する。成功・失敗のどちらでも同じ画面に戻す */
function render(res, { message = null, error = null, status = 200 } = {}) {
  return res.status(status).render('movies-admin', {
    title: '試合動画の管理',
    movies: store.listMovies(),
    maxUploadMb: MAX_UPLOAD_MB,
    message,
    error,
  });
}

/** multer が返したエラーを利用者に見せる文言へ直す */
function uploadErrorMessage(err) {
  if (err instanceof UploadError) return err.message;
  if (err.code === 'LIMIT_FILE_SIZE') return `ファイルが大きすぎます (上限 ${MAX_UPLOAD_MB}MB)`;
  return 'アップロードに失敗しました: ' + err.message;
}

router.use(requireAdmin);

router.get('/', function (req, res, next) {
  try {
    render(res);
  } catch (e) {
    next(e);
  }
});

router.post('/upload', function (req, res, next) {
  upload.single('movie')(req, res, function (err) {
    try {
      if (err) return render(res, { error: uploadErrorMessage(err), status: 400 });
      if (!req.file) return render(res, { error: 'ファイルが選ばれていません', status: 400 });

      // タイトルが入力されていれば movies.json にも反映する。
      // 未入力ならファイル名がそのままタイトルになる(自動検出の扱い)
      const title = String(req.body.title || '').trim();
      if (title) {
        const meta = store.readMeta();
        meta.push({
          id: store.sanitizeId(path.basename(req.file.filename, path.extname(req.file.filename))),
          file: req.file.filename,
          title,
          description: String(req.body.description || '').trim(),
          date: String(req.body.date || '').trim(),
          order: meta.length + 1,
        });
        store.writeMeta(meta);
      }

      render(res, { message: `${req.file.filename} をアップロードしました` });
    } catch (e) {
      next(e);
    }
  });
});

router.post('/save', function (req, res, next) {
  try {
    // express.urlencoded({extended:false}) は同名フィールドを配列にする。
    // 1件だけのときは文字列で来るので concat で必ず配列に揃える
    const asArray = (v) => [].concat(v === undefined ? [] : v);
    const files = asArray(req.body.file);
    const ids = asArray(req.body.id);
    const titles = asArray(req.body.title);
    const descriptions = asArray(req.body.description);
    const dates = asArray(req.body.date);
    const orders = asArray(req.body.order);

    store.saveMovieMeta(files.map((file, i) => ({
      file,
      id: ids[i],
      title: titles[i],
      description: descriptions[i],
      date: dates[i],
      order: orders[i],
    })));

    render(res, { message: '保存しました' });
  } catch (e) {
    next(e);
  }
});

router.post('/hide', function (req, res, next) {
  try {
    if (!store.hideMovie(String(req.body.id || ''))) {
      return render(res, { error: 'その動画は見つかりませんでした', status: 404 });
    }
    render(res, { message: '非公開にしました (load_data/movie_data/_hidden/ へ移動しました)' });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
module.exports.MAX_UPLOAD_BYTES = MAX_UPLOAD_BYTES;
