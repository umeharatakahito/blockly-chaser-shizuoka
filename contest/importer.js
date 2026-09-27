/**
 * DO 版(公開サイト)から、エントリーと提出プログラムを取り込む。
 *
 * DO 版の運営用 API をそのまま使うので、DO 版側に手を入れる必要はない。
 *   POST /admin/login        {key}  → 運営の Cookie
 *   GET  /entry/admin-list          エントリー(非表示も含む)
 *   GET  /upload/admin-list         提出の一覧
 *   GET  /upload/file?id=…          提出ファイル本体
 *
 * 1人が何度も提出した場合は、いちばん新しい提出を使う。
 * 会場で運営が差し替えたプログラム(source = local)は、取り込みで上書きしない。
 */

const store = require('./store.js');

const DEFAULT_URL = 'https://blockly-chaser-shizuoka-do.blockly-chaser-shizuoka-do.workers.dev';

/** DO 版から生のデータを取ってくる */
async function fetchFromDo(baseUrl, key, fetchImpl = fetch) {
  const base = String(baseUrl || DEFAULT_URL).replace(/\/+$/, '');
  if (!key) throw new Error('DO 版の運営の鍵(ADMIN_KEY)を入れてください');

  const login = await fetchImpl(`${base}/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  });
  if (login.status === 403) throw new Error('DO 版の運営の鍵が違います');
  if (!login.ok) throw new Error(`DO 版にログインできません (HTTP ${login.status})`);
  const setCookie = login.headers.get('set-cookie') || '';
  const cookie = (/chaser_admin=[^;]+/.exec(setCookie) || [''])[0];
  if (!cookie) throw new Error('DO 版からログインの Cookie が返りませんでした');

  const get = async (p) => {
    const res = await fetchImpl(base + p, { headers: { Cookie: cookie } });
    if (!res.ok) throw new Error(`${p} を読めません (HTTP ${res.status})`);
    return res;
  };

  const entries = (await (await get('/entry/admin-list')).json()).entries || [];
  const uploads = (await (await get('/upload/admin-list')).json()).uploads || [];

  // 使うのは各選手のいちばん新しい提出だけなので、それ以外はダウンロードしない
  const latest = latestUploads(uploads);
  for (const u of latest.values()) {
    const res = await get(`/upload/file?id=${encodeURIComponent(u.id)}`);
    u.content = Buffer.from(await res.arrayBuffer());
  }
  return { base, entries, uploads, latest };
}

/** 選手名ごとのいちばん新しい提出 */
function latestUploads(uploads) {
  const latest = new Map();
  for (const u of uploads) {
    const name = String(u.entry_name || '').trim();
    if (!name) continue;
    const cur = latest.get(name);
    if (!cur || String(u.created_at) > String(cur.created_at)) latest.set(name, Object.assign({}, u));
  }
  return latest;
}

/** エントリー id から参加者 id を作る。英数字だけにして、合言葉にそのまま入れられるようにする */
const participantIdFor = (entryId) => 'e' + String(entryId).replace(/[^a-z0-9]/gi, '').slice(0, 10).toLowerCase();

/**
 * 取ってきたデータを名簿へ反映する。ファイルの書き込みも行う。
 * @param {Object} data     store.loadParticipants() の結果(書き換える)
 * @param {Object} remote   fetchFromDo() の結果
 * @returns {Object} 何をしたかのまとめ
 */
function mergeIntoParticipants(data, remote) {
  const summary = { added: [], updated: [], programs: [], keptLocal: [], noProgram: [], hiddenOnDo: [], orphanUploads: [], errors: [] };
  const visible = remote.entries.filter((e) => !e.hidden);
  const visibleNames = new Set(visible.map((e) => String(e.name).trim()));

  for (const e of visible) {
    const name = store.cleanName(e.name);
    let p = data.participants.find((x) => x.entryId === e.id) || data.participants.find((x) => x.name === name);
    if (!p) {
      try {
        p = store.addParticipant(data, { name, school: e.school, grade: e.grade, entryId: e.id, id: participantIdFor(e.id) });
        summary.added.push(p.name);
      } catch (err) {
        summary.errors.push(`${name}: ${err.message}`);
        continue;
      }
    } else if (p.name !== name || p.school !== String(e.school || '') || p.entryId !== e.id) {
      p.name = name;
      p.school = String(e.school || '');
      p.grade = String(e.grade || '');
      p.entryId = e.id;
      summary.updated.push(p.name);
    }

    const up = remote.latest.get(String(e.name).trim());
    if (!up) {
      if (!p.program) summary.noProgram.push(p.name);
      continue;
    }
    if (p.program && p.program.source === 'local') {
      summary.keptLocal.push(p.name);
      continue;
    }
    if (p.program && p.program.uploadId === up.id) continue;
    try {
      store.setProgram(data, p.id, up.content, { name: up.file_name, uploadedAt: up.created_at, source: 'do', uploadId: up.id });
      summary.programs.push(p.name);
    } catch (err) {
      summary.errors.push(`${p.name} のプログラム: ${err.message}`);
    }
  }

  // DO 側で非表示・削除になったエントリー。自動では消さず、運営に知らせるだけにする
  const liveIds = new Set(remote.entries.filter((e) => !e.hidden).map((e) => e.id));
  for (const p of data.participants) {
    if (p.entryId && !liveIds.has(p.entryId)) summary.hiddenOnDo.push(p.name);
  }
  for (const name of remote.latest.keys()) {
    if (!visibleNames.has(name)) summary.orphanUploads.push(name);
  }

  data.importedAt = new Date().toISOString();
  data.importSource = remote.base || '';
  return summary;
}

/** 取り込みの一連の流れ。画面とコマンドの両方から呼ぶ */
async function importFromDo(baseUrl, key, fetchImpl = fetch) {
  const remote = await fetchFromDo(baseUrl, key, fetchImpl);
  const data = store.loadParticipants();
  const summary = mergeIntoParticipants(data, remote);
  store.saveParticipants(data);
  return Object.assign(summary, { total: data.participants.length, entries: remote.entries.length, uploads: remote.uploads.length });
}

/** まとめを人が読める行にする */
function describeSummary(s) {
  const lines = [`参加者 ${s.total} 人 (DO 版: エントリー ${s.entries} 件 / 提出 ${s.uploads} 件)`];
  const list = (label, names) => { if (names.length) lines.push(`${label}: ${names.join('、')}`); };
  list('新しく追加', s.added);
  list('名前・所属を更新', s.updated);
  list('プログラムを取り込み', s.programs);
  list('会場で差し替え済みのため据え置き', s.keptLocal);
  list('まだ提出がない', s.noProgram);
  list('DO 版で非表示・削除 (こちらには残しています)', s.hiddenOnDo);
  list('エントリーに無い名前の提出 (取り込んでいません)', s.orphanUploads);
  list('失敗', s.errors);
  return lines;
}

module.exports = { DEFAULT_URL, fetchFromDo, latestUploads, participantIdFor, mergeIntoParticipants, importFromDo, describeSummary };
