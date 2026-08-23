/**
 * 試合動画ページの HTTP レベルの確認。
 * アプリを一時ポートで起動して実際にリクエストを投げる。
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const app = require('../app.js');

let server;
let base;

test.before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('GET /movies は一覧を返す', async () => {
  const res = await fetch(`${base}/movies`);
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.match(html, /2025年 決勝戦/);
  assert.match(html, /movie_list/);
});

test('GET /movies/:id は再生ページを返す', async () => {
  const res = await fetch(`${base}/movies/final-2025`);
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.match(html, /<video/);
  assert.match(html, /\/movies\/file\/final-2025/);
});

test('存在しない動画は 404 を返す', async () => {
  const res = await fetch(`${base}/movies/no-such-movie`);
  assert.strictEqual(res.status, 404);
  const html = await res.text();
  assert.match(html, /見つかりませんでした/);
});

test('動画ファイルを正しい MIME タイプで返す', async () => {
  const res = await fetch(`${base}/movies/file/final-2025`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('content-type'), 'video/mp4');
  const buf = await res.arrayBuffer();
  assert.ok(buf.byteLength > 1000, '中身が空です');
});

test('Range リクエストに 206 で応答する (シーク可能)', async () => {
  const res = await fetch(`${base}/movies/file/final-2025`, {
    headers: { Range: 'bytes=100-999' },
  });
  assert.strictEqual(res.status, 206);
  assert.match(res.headers.get('content-range') || '', /^bytes 100-999\//);
  const buf = await res.arrayBuffer();
  assert.strictEqual(buf.byteLength, 900);
});

test('movies.json は配信されない', async () => {
  // /movies/file/:id は id で引くため、メタデータファイルには到達できない
  for (const p of ['/movies/file/movies', '/movies/file/movies.json']) {
    const res = await fetch(`${base}${p}`);
    assert.strictEqual(res.status, 404, `${p} が配信されています`);
  }
});

test('パストラバーサルで外のファイルを取れない', async () => {
  const targets = [
    '/movies/file/..%2F..%2Fpackage.json',
    '/movies/file/%2E%2E%2F%2E%2E%2Fapp.js',
  ];
  for (const p of targets) {
    const res = await fetch(`${base}${p}`);
    assert.ok(res.status === 404 || res.status === 400, `${p} が ${res.status} を返しました`);
    if (res.status === 200) assert.fail('外部ファイルが読めています');
  }
});

test('トップページから試合動画へのリンクがある', async () => {
  const res = await fetch(`${base}/`);
  const html = await res.text();
  assert.match(html, /href="\/movies"/);
});
