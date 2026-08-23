/**
 * 運営向け動画管理の HTTP テスト。
 *
 * ADMIN_KEY は tool/admin_auth.js が呼び出しのたびに読むため、
 * テスト中に環境変数を切り替えて両方の運用形態を確かめられる。
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const app = require('../app.js');
const store = require('../movies/store.js');

let server;
let base;
const created = [];

/** テストで作ったファイルを消す */
function cleanup() {
  for (const file of created) {
    for (const dir of [store.MOVIE_DIR, store.HIDDEN_DIR]) {
      const p = path.join(dir, file);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  }
  created.length = 0;
}

/** 最小の mp4 相当のダミー。拡張子の判定しか見ないので中身は問わない */
const dummyVideo = () => new Blob([new Uint8Array(2048)], { type: 'video/mp4' });

test.before(async () => {
  delete process.env.ADMIN_KEY;
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  cleanup();
  delete process.env.ADMIN_KEY;
  await new Promise((resolve) => server.close(resolve));
});

/* --- 権限 --- */

test('ADMIN_KEY 未設定なら localhost から開ける', async () => {
  delete process.env.ADMIN_KEY;
  const res = await fetch(`${base}/movies/admin`);
  assert.strictEqual(res.status, 200);
  assert.match(await res.text(), /動画をアップロード/);
});

test('ADMIN_KEY 設定時は合言葉なしで拒否される', async () => {
  process.env.ADMIN_KEY = 'テスト合言葉';
  try {
    const res = await fetch(`${base}/movies/admin`);
    assert.strictEqual(res.status, 403);
    assert.match(await res.text(), /合言葉を入力してください/);
  } finally {
    delete process.env.ADMIN_KEY;
  }
});

test('ADMIN_KEY 設定時、正しい合言葉なら開ける', async () => {
  process.env.ADMIN_KEY = 'テスト合言葉';
  try {
    const res = await fetch(`${base}/movies/admin`, {
      headers: { Cookie: 'admin_key=' + encodeURIComponent('テスト合言葉') },
    });
    assert.strictEqual(res.status, 200);
  } finally {
    delete process.env.ADMIN_KEY;
  }
});

test('間違った合言葉は拒否される', async () => {
  process.env.ADMIN_KEY = 'テスト合言葉';
  try {
    const res = await fetch(`${base}/movies/admin`, {
      // HTTP ヘッダには非ASCIIを載せられないため、間違い側はASCIIで送る
      headers: { Cookie: 'admin_key=wrong-key' },
    });
    assert.strictEqual(res.status, 403);
  } finally {
    delete process.env.ADMIN_KEY;
  }
});

test('JSON を求めるリクエストには 403 を JSON で返す', async () => {
  process.env.ADMIN_KEY = 'テスト合言葉';
  try {
    const res = await fetch(`${base}/movies/admin`, {
      headers: { Accept: 'application/json' },
    });
    assert.strictEqual(res.status, 403);
    const body = await res.json();
    assert.strictEqual(body.ok, false);
    assert.match(body.error, /合言葉/);
  } finally {
    delete process.env.ADMIN_KEY;
  }
});

test('参加者向けページは権限の影響を受けない', async () => {
  process.env.ADMIN_KEY = 'テスト合言葉';
  try {
    for (const p of ['/', '/movies', '/movies/final-2025']) {
      const res = await fetch(`${base}${p}`);
      assert.strictEqual(res.status, 200, `${p} が ${res.status}`);
    }
  } finally {
    delete process.env.ADMIN_KEY;
  }
});

/* --- アップロード --- */

test('mp4 をアップロードすると一覧に出る', async () => {
  const form = new FormData();
  form.append('movie', dummyVideo(), 'テスト動画A.mp4');
  form.append('title', 'テスト動画A');

  const res = await fetch(`${base}/movies/admin/upload`, { method: 'POST', body: form });
  assert.strictEqual(res.status, 200);
  created.push('テスト動画A.mp4');

  assert.match(await res.text(), /アップロードしました/);
  assert.ok(store.listMovies().some((m) => m.file === 'テスト動画A.mp4'));
});

test('再生できない拡張子は拒否される', async () => {
  const form = new FormData();
  form.append('movie', new Blob([new Uint8Array(16)]), 'あぶない.exe');

  const res = await fetch(`${base}/movies/admin/upload`, { method: 'POST', body: form });
  assert.strictEqual(res.status, 400);
  assert.match(await res.text(), /mp4 \/ webm \/ m4v/);
  assert.ok(!fs.existsSync(path.join(store.MOVIE_DIR, 'あぶない.exe')));
});

test('ファイルを選ばずに送ると弾かれる', async () => {
  const form = new FormData();
  form.append('title', 'ファイルなし');

  const res = await fetch(`${base}/movies/admin/upload`, { method: 'POST', body: form });
  assert.strictEqual(res.status, 400);
  assert.match(await res.text(), /ファイルが選ばれていません/);
});

test('同名ファイルは上書きせず連番を付ける', async () => {
  const form = new FormData();
  form.append('movie', dummyVideo(), 'テスト動画A.mp4');

  const res = await fetch(`${base}/movies/admin/upload`, { method: 'POST', body: form });
  assert.strictEqual(res.status, 200);
  created.push('テスト動画A_2.mp4');

  assert.ok(fs.existsSync(path.join(store.MOVIE_DIR, 'テスト動画A.mp4')), '元のファイルが消えています');
  assert.ok(fs.existsSync(path.join(store.MOVIE_DIR, 'テスト動画A_2.mp4')), '連番ファイルがありません');
});

test('日本語のファイル名がそのまま保存される', async () => {
  // busboy は multipart のファイル名を latin1 として読むため、
  // 復号しないと「決勝戦.mp4」が「movie.mp4」に潰れてしまう
  const form = new FormData();
  form.append('movie', dummyVideo(), '決勝戦.mp4');

  const res = await fetch(`${base}/movies/admin/upload`, { method: 'POST', body: form });
  assert.strictEqual(res.status, 200);
  created.push('決勝戦.mp4');

  assert.ok(
    fs.existsSync(path.join(store.MOVIE_DIR, '決勝戦.mp4')),
    '実際に保存されたファイル: ' + fs.readdirSync(store.MOVIE_DIR).join(', ')
  );
});

test('パス区切りを含む名前でアップロードしてもディレクトリ外に出ない', async () => {
  const form = new FormData();
  form.append('movie', dummyVideo(), '../../のっとり.mp4');

  const res = await fetch(`${base}/movies/admin/upload`, { method: 'POST', body: form });
  assert.strictEqual(res.status, 200);
  created.push('のっとり.mp4');

  assert.ok(fs.existsSync(path.join(store.MOVIE_DIR, 'のっとり.mp4')));
  assert.ok(!fs.existsSync(path.join(store.MOVIE_DIR, '..', '..', 'のっとり.mp4')));
});

/* --- 非公開 --- */

test('非公開にするとファイルが _hidden へ移り、一覧から消える', async () => {
  const form = new FormData();
  form.append('movie', dummyVideo(), 'かくす動画.mp4');
  await fetch(`${base}/movies/admin/upload`, { method: 'POST', body: form });
  created.push('かくす動画.mp4');

  const target = store.listMovies().find((m) => m.file === 'かくす動画.mp4');
  assert.ok(target, 'アップロードできていません');

  const body = new URLSearchParams({ id: target.id });
  const res = await fetch(`${base}/movies/admin/hide`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  assert.strictEqual(res.status, 200);

  assert.ok(!fs.existsSync(path.join(store.MOVIE_DIR, 'かくす動画.mp4')), '元の場所にファイルが残っています');
  assert.ok(fs.existsSync(path.join(store.HIDDEN_DIR, 'かくす動画.mp4')), '_hidden に移動していません');
  assert.ok(!store.listMovies().some((m) => m.file === 'かくす動画.mp4'), '一覧に残っています');
});

test('存在しない動画の非公開は 404 になる', async () => {
  const res = await fetch(`${base}/movies/admin/hide`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id: 'ありえないid' }),
  });
  assert.strictEqual(res.status, 404);
});

/* --- メタデータの保存 --- */

test('タイトル・説明・並び順を保存できる', async () => {
  const before = store.readMeta();
  try {
    const body = new URLSearchParams();
    body.append('file', 'sample-final-2025.mp4');
    body.append('id', 'final-2025');
    body.append('title', '書き換えたタイトル');
    body.append('description', '書き換えた説明');
    body.append('date', '2026-10-12');
    body.append('order', '5');

    const res = await fetch(`${base}/movies/admin/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    assert.strictEqual(res.status, 200);

    const saved = store.getMovie('final-2025');
    assert.strictEqual(saved.title, '書き換えたタイトル');
    assert.strictEqual(saved.description, '書き換えた説明');
    assert.strictEqual(saved.order, 5);
  } finally {
    store.writeMeta(before);
  }
});

test('保存時に未知のキーは取り込まれない', async () => {
  const before = store.readMeta();
  try {
    const body = new URLSearchParams();
    body.append('file', 'sample-final-2025.mp4');
    body.append('id', 'final-2025');
    body.append('title', 'タイトル');
    body.append('order', '1');

    await fetch(`${base}/movies/admin/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    for (const entry of store.readMeta()) {
      assert.deepStrictEqual(
        Object.keys(entry).sort(),
        ['date', 'description', 'file', 'id', 'order', 'title']
      );
    }
  } finally {
    store.writeMeta(before);
  }
});
