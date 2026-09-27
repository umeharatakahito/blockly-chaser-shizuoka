const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../contest/store.js');
const importer = require('../contest/importer.js');
const recorder = require('../contest/recorder.js');

let dir;
test.beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contest-'));
  store.setDataDir(dir);
});
test.afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

test('参加者を足してプログラムを結びつけ、読み戻せる', () => {
  const data = store.loadParticipants();
  const p = store.addParticipant(data, { name: 'しずか"\\ちゃん', school: '静岡中' });
  assert.strictEqual(p.name, 'しずかちゃん', '引用符とバックスラッシュは落とす(プログラムへ埋め込むため)');
  store.setProgram(data, p.id, Buffer.from('PK...'), { name: 'my.blch', source: 'local' });
  store.saveParticipants(data);

  const again = store.loadParticipants();
  const q = store.findParticipant(again, p.id);
  assert.strictEqual(q.program.name, 'my.blch');
  assert.strictEqual(q.program.source, 'local');
  assert.strictEqual(fs.readFileSync(store.programPath(q), 'utf8'), 'PK...');
});

test('同じ名前は二重に登録できない', () => {
  const data = store.loadParticipants();
  store.addParticipant(data, { name: 'あおい' });
  assert.throws(() => store.addParticipant(data, { name: 'あおい' }), /もう登録/);
});

test('プログラムは .blch / .zip / .json / .xml だけ', () => {
  const data = store.loadParticipants();
  const p = store.addParticipant(data, { name: 'はると' });
  assert.throws(() => store.setProgram(data, p.id, Buffer.from('x'), { name: 'a.exe' }), /だけ使えます/);
});

test('参加者を外すとプログラムのファイルも消える', () => {
  const data = store.loadParticipants();
  const p = store.addParticipant(data, { name: 'ゆい' });
  store.setProgram(data, p.id, Buffer.from('x'), { name: 'a.xml' });
  const file = store.programPath(p);
  store.removeParticipant(data, p.id);
  assert.ok(!fs.existsSync(file));
  assert.strictEqual(data.participants.length, 0);
});

test('予選の設定は範囲に丸める。ボットの入れない対人ルームは選べない', () => {
  const c = store.normalizeQualifierConfig({ roomId: 'room_111', botLevel: 99, advance: 1 });
  assert.strictEqual(c.roomId, 'room_011');
  assert.strictEqual(c.botLevel, 30);
  assert.strictEqual(c.advance, 2);
});

/* --- DO 版からの取り込み --- */

function remote({ entries, uploads }) {
  const latest = importer.latestUploads(uploads);
  for (const u of latest.values()) u.content = Buffer.from('program of ' + u.id);
  return { base: 'https://example.test', entries, uploads, latest };
}

test('取り込み: エントリーごとに一番新しい提出を使い、非表示のエントリーは入れない', () => {
  const data = store.loadParticipants();
  const s = importer.mergeIntoParticipants(data, remote({
    entries: [
      { id: 'aaaa-1111', name: 'あおい', school: '静岡第一中', hidden: 0 },
      { id: 'bbbb-2222', name: 'はると', school: '浜松東中', hidden: 0 },
      { id: 'cccc-3333', name: 'テスト', school: '', hidden: 1 },
    ],
    uploads: [
      { id: 'u1', entry_name: 'あおい', file_name: 'old.blch', created_at: '2026-10-01T00:00:00Z' },
      { id: 'u2', entry_name: 'あおい', file_name: 'new.blch', created_at: '2026-10-05T00:00:00Z' },
      { id: 'u3', entry_name: 'だれか', file_name: 'x.blch', created_at: '2026-10-05T00:00:00Z' },
    ],
  }));

  assert.deepStrictEqual(data.participants.map((p) => p.name), ['あおい', 'はると']);
  const aoi = data.participants[0];
  assert.strictEqual(aoi.program.name, 'new.blch');
  assert.strictEqual(aoi.program.uploadId, 'u2');
  assert.match(aoi.id, /^[a-z0-9]+$/, '参加者 id は合言葉に入れるので英数字だけ');
  assert.deepStrictEqual(s.noProgram, ['はると']);
  assert.deepStrictEqual(s.orphanUploads, ['だれか']);
});

test('取り込み: 会場で差し替えたプログラムは上書きしない。新しい提出があれば差し替える', () => {
  const data = store.loadParticipants();
  const entries = [{ id: 'aaaa', name: 'あおい', hidden: 0 }, { id: 'bbbb', name: 'はると', hidden: 0 }];
  importer.mergeIntoParticipants(data, remote({ entries, uploads: [
    { id: 'u1', entry_name: 'あおい', file_name: 'a.blch', created_at: '2026-10-01' },
    { id: 'u2', entry_name: 'はると', file_name: 'h.blch', created_at: '2026-10-01' },
  ] }));
  const aoi = data.participants[0];
  store.setProgram(data, aoi.id, Buffer.from('usb'), { name: 'usb.blch', source: 'local' });

  const s = importer.mergeIntoParticipants(data, remote({ entries, uploads: [
    { id: 'u3', entry_name: 'あおい', file_name: 'a2.blch', created_at: '2026-10-09' },
    { id: 'u4', entry_name: 'はると', file_name: 'h2.blch', created_at: '2026-10-09' },
  ] }));
  assert.strictEqual(data.participants[0].program.name, 'usb.blch');
  assert.strictEqual(data.participants[1].program.name, 'h2.blch');
  assert.deepStrictEqual(s.keptLocal, ['あおい']);
  assert.deepStrictEqual(s.programs, ['はると']);
});

test('取り込み: DO 版で消えたエントリーは自動では消さず、知らせるだけ', () => {
  const data = store.loadParticipants();
  importer.mergeIntoParticipants(data, remote({ entries: [{ id: 'aaaa', name: 'あおい', hidden: 0 }], uploads: [] }));
  const s = importer.mergeIntoParticipants(data, remote({ entries: [], uploads: [] }));
  assert.strictEqual(data.participants.length, 1);
  assert.deepStrictEqual(s.hiddenOnDo, ['あおい']);
});

test('取り込み: DO 版の運営 API をログインしてから読む', async () => {
  const calls = [];
  const fakeFetch = async (url, opts = {}) => {
    calls.push([url.replace('https://do.test', ''), (opts.headers || {}).Cookie || '']);
    const json = (body) => ({ ok: true, status: 200, json: async () => body, headers: new Map() });
    if (url.endsWith('/admin/login')) {
      assert.strictEqual(JSON.parse(opts.body).key, 'secret');
      return { ok: true, status: 204, headers: { get: () => 'chaser_admin=abc; Path=/; HttpOnly' } };
    }
    if (url.endsWith('/entry/admin-list')) return json({ entries: [{ id: 'aaaa', name: 'あおい', hidden: 0 }] });
    if (url.endsWith('/upload/admin-list')) return json({ uploads: [{ id: 'u1', entry_name: 'あおい', file_name: 'a.blch', created_at: '1' }] });
    if (url.includes('/upload/file?id=u1')) return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('ZIP').buffer };
    throw new Error('想定外の要求 ' + url);
  };
  const s = await importer.importFromDo('https://do.test/', 'secret', fakeFetch);
  assert.strictEqual(s.total, 1);
  assert.ok(calls.slice(1).every(([, cookie]) => cookie === 'chaser_admin=abc'), 'ログイン後は Cookie を付ける');
  const p = store.loadParticipants().participants[0];
  assert.strictEqual(fs.readFileSync(store.programPath(p), 'utf8'), 'ZIP');
});

test('取り込み: 鍵が違えば分かる言葉で止まる', async () => {
  const fakeFetch = async () => ({ ok: false, status: 403, headers: { get: () => '' } });
  await assert.rejects(importer.importFromDo('https://do.test', 'wrong', fakeFetch), /鍵が違います/);
});

/* --- 試合結果の自動記録(予選) --- */

test('予選の合言葉の試合が終わると、その参加者の記録になる', () => {
  const data = store.loadParticipants();
  const p = store.addParticipant(data, { name: 'あおい' });
  store.saveParticipants(data);

  const roomId = 'room_011?' + recorder.qualifierToken(p.id);
  const out = recorder.handleResult({ roomId, winner: 'cool', info: 'スコアより', coolScore: 6, hotScore: 2, turnsLeft: 0 });
  assert.strictEqual(out.kind, 'qualifier');
  const q = store.loadQualifier();
  assert.strictEqual(q.runs[p.id].length, 1);
  assert.strictEqual(q.runs[p.id][0].score, 18);
});

test('合言葉のない試合や知らない参加者の試合は記録しない', () => {
  assert.strictEqual(recorder.handleResult({ roomId: 'room_011?abc', winner: 'cool' }), null);
  assert.strictEqual(recorder.handleResult({ roomId: 'room_011?q-nobody-x1', winner: 'cool' }), null);
  assert.deepStrictEqual(store.loadQualifier().runs, {});
});
