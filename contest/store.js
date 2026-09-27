/**
 * 大会当日のデータ。参加者・提出プログラム・予選の記録を load_data/contest/ に置く。
 *
 *   participants.json  参加者の名簿と、どのプログラムを使うか
 *   programs/<id>.blch 参加者のプログラム本体(拡張子は提出されたものに合わせる)
 *   qualifier.json     予選の設定と、参加者ごとの対戦記録
 *
 * 参加者の個人情報とプログラムなので、リポジトリには入れない(.gitignore 済み)。
 * 書き込みは一時ファイル経由の置き換えにして、途中で落ちても壊れた JSON を残さない。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { QUALIFIER_DEFAULTS } = require('./rules.js');

// リハーサルで本番のデータを汚さないよう、環境変数 CONTEST_DATA_DIR で置き場所を変えられる
let dataDir = process.env.CONTEST_DATA_DIR || path.join(__dirname, '..', 'load_data', 'contest');

/** テスト用。保存先を差し替える */
function setDataDir(dir) { dataDir = dir; }
const getDataDir = () => dataDir;

const file = (name) => path.join(dataDir, name);
const programDir = () => path.join(dataDir, 'programs');

const PROGRAM_EXT = /\.(blch|zip|json|xml)$/i;
const MAX_PROGRAM_BYTES = 1024 * 1024;

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`${name} を読めません: ${e.message}`);
    return fallback;
  }
}

function writeJson(name, data) {
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = file(name) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file(name));
  return data;
}

/* -------------------------------------------------- 参加者 */

/** 名前は試合のプログラムへ文字列として埋め込まれるので、引用符や改行を落とす */
const cleanName = (s) => String(s || '').replace(/["\\\r\n\t]/g, '').trim().slice(0, 40);
const cleanText = (s, max) => String(s || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, max);

function normalizeParticipant(p) {
  const program = p.program && typeof p.program === 'object' ? {
    file: String(p.program.file || ''),
    name: String(p.program.name || ''),
    size: Number(p.program.size) || 0,
    uploadedAt: String(p.program.uploadedAt || ''),
    source: p.program.source === 'local' ? 'local' : 'do',
    uploadId: String(p.program.uploadId || ''),
  } : null;
  return {
    id: String(p.id),
    name: cleanName(p.name) || '名前なし',
    school: cleanText(p.school, 50),
    grade: cleanText(p.grade, 20),
    entryId: String(p.entryId || ''),
    program: program && program.file ? program : null,
  };
}

function loadParticipants() {
  const data = readJson('participants.json', {});
  return {
    participants: (Array.isArray(data.participants) ? data.participants : []).filter((p) => p && p.id).map(normalizeParticipant),
    importedAt: String(data.importedAt || ''),
    importSource: String(data.importSource || ''),
  };
}

function saveParticipants(data) {
  return writeJson('participants.json', {
    participants: data.participants.map(normalizeParticipant),
    importedAt: data.importedAt || '',
    importSource: data.importSource || '',
  });
}

const findParticipant = (data, id) => data.participants.find((p) => p.id === id) || null;

/** 新しい参加者の id。英数字だけにする(対戦の合言葉に入れるため) */
function newId(prefix = 'p') {
  return prefix + crypto.randomBytes(4).toString('hex');
}

function addParticipant(data, { name, school = '', grade = '', entryId = '', id = null }) {
  const clean = cleanName(name);
  if (!clean) throw new Error('名前を入れてください');
  if (data.participants.some((p) => p.name === clean)) throw new Error(`${clean} はもう登録されています`);
  const used = new Set(data.participants.map((p) => p.id));
  let pid = id && /^[a-z0-9]+$/i.test(id) && !used.has(id) ? id : newId();
  while (used.has(pid)) pid = newId();
  const p = normalizeParticipant({ id: pid, name: clean, school, grade, entryId });
  data.participants.push(p);
  return p;
}

/**
 * プログラム本体を保存して、参加者に結びつける。
 * @param {Buffer} buffer
 * @param {{name: string, uploadedAt?: string, source?: 'do'|'local', uploadId?: string}} meta
 */
function setProgram(data, id, buffer, meta) {
  const p = findParticipant(data, id);
  if (!p) throw new Error('その参加者は見つかりませんでした');
  const originalName = String(meta.name || 'program.blch');
  const ext = (PROGRAM_EXT.exec(originalName) || [null, 'blch'])[1].toLowerCase();
  if (!PROGRAM_EXT.test(originalName)) throw new Error('.blch / .zip / .json / .xml のファイルだけ使えます');
  if (!buffer || !buffer.length) throw new Error('ファイルが空です');
  if (buffer.length > MAX_PROGRAM_BYTES) throw new Error('ファイルが大きすぎます (1MB まで)');

  fs.mkdirSync(programDir(), { recursive: true });
  // 以前のファイルは拡張子が違うことがあるので消しておく
  if (p.program && p.program.file) {
    try { fs.unlinkSync(path.join(programDir(), p.program.file)); } catch (e) { /* 無ければよい */ }
  }
  const fileName = `${p.id}.${ext}`;
  fs.writeFileSync(path.join(programDir(), fileName), buffer);
  p.program = {
    file: fileName,
    name: originalName,
    size: buffer.length,
    uploadedAt: meta.uploadedAt || new Date().toISOString(),
    source: meta.source === 'do' ? 'do' : 'local',
    uploadId: String(meta.uploadId || ''),
  };
  return p;
}

/** プログラムのパス。無ければ null */
function programPath(p) {
  if (!p || !p.program || !p.program.file) return null;
  const full = path.join(programDir(), path.basename(p.program.file));
  return fs.existsSync(full) ? full : null;
}

function removeParticipant(data, id) {
  const p = findParticipant(data, id);
  if (!p) return null;
  const full = programPath(p);
  if (full) { try { fs.unlinkSync(full); } catch (e) { /* 無ければよい */ } }
  data.participants = data.participants.filter((x) => x.id !== id);
  return p;
}

/* -------------------------------------------------- 予選 */

function normalizeQualifierConfig(c) {
  const src = c && typeof c === 'object' ? c : {};
  const int = (v, d, lo, hi) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
  };
  const roomId = /^room_0\d\d$/.test(String(src.roomId || '')) ? String(src.roomId) : QUALIFIER_DEFAULTS.roomId;
  return {
    roomId,
    botLevel: int(src.botLevel, QUALIFIER_DEFAULTS.botLevel, 1, 30),
    seed: int(src.seed, QUALIFIER_DEFAULTS.seed, 0, 2 ** 31 - 1),
    advance: int(src.advance, QUALIFIER_DEFAULTS.advance, 2, 64),
  };
}

function loadQualifier() {
  const data = readJson('qualifier.json', {});
  const runs = {};
  for (const [id, list] of Object.entries(data.runs && typeof data.runs === 'object' ? data.runs : {})) {
    if (Array.isArray(list)) runs[id] = list.filter((r) => r && typeof r === 'object');
  }
  return { config: normalizeQualifierConfig(data.config), runs };
}

function saveQualifier(data) {
  return writeJson('qualifier.json', { config: normalizeQualifierConfig(data.config), runs: data.runs || {} });
}

function addRun(data, id, run) {
  if (!data.runs[id]) data.runs[id] = [];
  data.runs[id].push(run);
  return data;
}

function removeRun(data, id, index) {
  const list = data.runs[id];
  if (!list || index < 0 || index >= list.length) return false;
  list.splice(index, 1);
  if (!list.length) delete data.runs[id];
  return true;
}

module.exports = {
  setDataDir, getDataDir, PROGRAM_EXT, MAX_PROGRAM_BYTES,
  cleanName, loadParticipants, saveParticipants, findParticipant, addParticipant, setProgram, programPath,
  removeParticipant, newId,
  normalizeQualifierConfig, loadQualifier, saveQualifier, addRun, removeRun,
};
