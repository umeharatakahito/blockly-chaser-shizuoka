/**
 * トーナメント表のデータモデルと永続化。
 *
 * 手動入力を正とする。試合結果の自動記録(result_log.js)は候補を出すだけで、
 * 対戦表へ反映するかどうかは必ず運営が判断する。
 * 大会中に自動反映が誤ると取り返しがつかないため。
 *
 * データは load_data/tournament/tournament.json に置く。
 * 書き込みは一時ファイル経由の置き換えにしてあるので、
 * 途中でサーバーが落ちても壊れた JSON は残らない。
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'load_data', 'tournament');
const DATA_FILE = path.join(DATA_DIR, 'tournament.json');

const DEFAULT_TITLE = 'U-16プログラミングコンテスト静岡大会';

/** 空のトーナメント */
function emptyTournament() {
  return { title: DEFAULT_TITLE, players: [], rounds: [] };
}

/* -------------------------------------------------- 読み書き */

/** 保存されたトーナメントを読む。無い・壊れている場合は空を返す */
function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return normalize(parsed);
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.error('tournament.json を読めません: ' + e.message);
    }
    return emptyTournament();
  }
}

/** 一時ファイルへ書いてから置き換える。書き込み中の破損を避ける */
function save(data) {
  const normalized = normalize(data);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, DATA_FILE);
  return normalized;
}

/**
 * 外から来たデータを既知の形に整える。
 * 画面や手書きの JSON から余計なキーが混ざっても、ここで落とす。
 */
function normalize(data) {
  const src = data && typeof data === 'object' ? data : {};

  const players = (Array.isArray(src.players) ? src.players : [])
    .filter((p) => p && typeof p === 'object')
    .map((p, i) => ({
      id: String(p.id || `p${i + 1}`),
      name: String(p.name || '').trim() || `選手${i + 1}`,
      school: String(p.school || '').trim(),
    }));

  const rounds = (Array.isArray(src.rounds) ? src.rounds : []).map((round, ri) => ({
    name: String((round && round.name) || `${ri + 1}回戦`),
    matches: (Array.isArray(round && round.matches) ? round.matches : []).map((m, mi) => ({
      id: String((m && m.id) || `r${ri + 1}m${mi + 1}`),
      coolId: m && m.coolId ? String(m.coolId) : null,
      hotId: m && m.hotId ? String(m.hotId) : null,
      winnerId: m && m.winnerId ? String(m.winnerId) : null,
      coolScore: Number.isFinite(Number(m && m.coolScore)) && m.coolScore !== null && m.coolScore !== '' ? Number(m.coolScore) : null,
      hotScore: Number.isFinite(Number(m && m.hotScore)) && m.hotScore !== null && m.hotScore !== '' ? Number(m.hotScore) : null,
      note: String((m && m.note) || '').trim(),
      roomId: String((m && m.roomId) || '').trim(),
      movieId: String((m && m.movieId) || '').trim(),
    })),
  }));

  return {
    title: String(src.title || DEFAULT_TITLE).trim() || DEFAULT_TITLE,
    players,
    rounds,
  };
}

/* -------------------------------------------------- 対戦表の組み立て */

const nextPowerOfTwo = (n) => {
  let size = 1;
  while (size < n) size *= 2;
  return size;
};

/**
 * 回戦名。残り回戦数から決める。
 * 決勝・準決勝・準々決勝は慣用の呼び方にし、それより前は「N回戦」とする。
 */
function roundName(index, total) {
  const remaining = total - index;
  if (remaining === 1) return '決勝';
  if (remaining === 2) return '準決勝';
  if (remaining === 3) return '準々決勝';
  return `${index + 1}回戦`;
}

/**
 * トーナメントの標準的なシード順を作る。
 *
 * size=8 なら [1, 8, 4, 5, 2, 7, 3, 6]。
 * 上位シードどうしが早い回戦で当たらないよう、山を分ける並びになる。
 * 空きスロット(不戦勝)は末尾のシードに割り当たるため、
 * この順に並べるだけで不戦勝が左右の山へ自然に分散する。
 */
function seedOrder(size) {
  let order = [1];
  while (order.length < size) {
    const pairSum = order.length * 2 + 1;
    const next = [];
    for (const seed of order) next.push(seed, pairSum - seed);
    order = next;
  }
  return order;
}

/**
 * 参加者から対戦表を作る。
 *
 * 人数を2のべき乗まで空きスロットで埋める。
 * 空きと当たった選手は不戦勝として次の回戦へ自動で進む。
 *
 * 名簿の順番はシード順として扱う。先頭の選手ほど有利な山に入り、
 * 不戦勝も先頭から順に割り当たる。抽選は運営が行い、
 * その結果の順に並べた名簿を渡す想定にしている。
 */
function buildBracket(data) {
  const playerIds = data.players.map((p) => p.id);
  if (playerIds.length < 2) {
    return Object.assign({}, data, { rounds: [] });
  }

  const size = nextPowerOfTwo(playerIds.length);
  // シード順に並べ替える。人数に足りないシードは空き(不戦勝)になる
  const slots = seedOrder(size).map((seed) => playerIds[seed - 1] || null);
  const totalRounds = Math.log2(size);

  const rounds = [];
  for (let ri = 0, n = size; n >= 2; ri++, n /= 2) {
    const matches = [];
    for (let mi = 0; mi < n / 2; mi++) {
      matches.push({
        id: `r${ri + 1}m${mi + 1}`,
        coolId: ri === 0 ? slots[mi * 2] : null,
        hotId: ri === 0 ? slots[mi * 2 + 1] : null,
        winnerId: null,
        coolScore: null,
        hotScore: null,
        note: '',
        roomId: '',
        movieId: '',
      });
    }
    rounds.push({ name: roundName(ri, totalRounds), matches });
  }

  const built = Object.assign({}, data, { rounds });
  applyByes(built);
  return built;
}

/**
 * 不戦勝を処理する。
 * 1回戦で相手がいない選手を、そのまま次の回戦へ進める。
 */
function applyByes(data) {
  const first = data.rounds[0];
  if (!first) return data;

  first.matches.forEach((match, mi) => {
    const hasCool = Boolean(match.coolId);
    const hasHot = Boolean(match.hotId);
    if (hasCool === hasHot) return;      // 両方いる、または両方いない

    match.winnerId = match.coolId || match.hotId;
    match.note = match.note || '不戦勝';
    placeWinner(data, 0, mi, match.winnerId);
  });

  return data;
}

/* -------------------------------------------------- 勝敗の記録 */

/**
 * 回戦 N の試合 i の勝者は、回戦 N+1 の試合 floor(i/2) に入る。
 * i が偶数なら cool 側、奇数なら hot 側。
 */
function placeWinner(data, roundIndex, matchIndex, winnerId) {
  const next = data.rounds[roundIndex + 1];
  if (!next) return;

  const target = next.matches[Math.floor(matchIndex / 2)];
  if (!target) return;

  if (matchIndex % 2 === 0) target.coolId = winnerId;
  else target.hotId = winnerId;
}

/** 試合の位置を id から探す */
function findMatch(data, matchId) {
  for (let ri = 0; ri < data.rounds.length; ri++) {
    const mi = data.rounds[ri].matches.findIndex((m) => m.id === matchId);
    if (mi >= 0) return { roundIndex: ri, matchIndex: mi, match: data.rounds[ri].matches[mi] };
  }
  return null;
}

/**
 * 試合結果を記録し、勝者を次の回戦へ進める。
 *
 * 勝者を変更した場合、以前の勝者が進んでいた先を上書きする。
 * それより先の回戦は運営が入れ直す。連鎖的に消すと、
 * 入力し直しのつもりが後半の記録まで消える事故になるため。
 *
 * @returns {{ok: boolean, error?: string}}
 */
function setResult(data, matchId, result) {
  const found = findMatch(data, matchId);
  if (!found) return { ok: false, error: 'その試合は見つかりませんでした' };

  const { roundIndex, matchIndex, match } = found;
  const winnerId = result.winnerId ? String(result.winnerId) : null;

  if (winnerId && winnerId !== match.coolId && winnerId !== match.hotId) {
    return { ok: false, error: '勝者はその試合の対戦者から選んでください' };
  }

  const toScore = (v) => (v === '' || v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));

  match.winnerId = winnerId;
  match.coolScore = toScore(result.coolScore);
  match.hotScore = toScore(result.hotScore);
  if (result.note !== undefined) match.note = String(result.note || '').trim();
  if (result.roomId !== undefined) match.roomId = String(result.roomId || '').trim();
  if (result.movieId !== undefined) match.movieId = String(result.movieId || '').trim();

  placeWinner(data, roundIndex, matchIndex, winnerId);
  return { ok: true };
}

/**
 * 自動記録された試合結果を対戦カードへ取り込む。
 *
 * 記録側はゲームサーバー上の名前(cool/hot)しか持たないため、
 * 対戦表のどちらの選手に対応するかを名前で突き合わせる。
 * ゲーム側の cool/hot と対戦表の cool/hot が逆のこともあるので、
 * 入れ替わりを検出してスコアも合わせて入れ替える。
 *
 * 名前が一致しない場合は取り込まない。誤った選手に記録するより、
 * 運営が手で入れ直すほうが安全なため。
 *
 * @returns {{ok: boolean, error?: string}}
 */
function applyRecordedResult(data, matchId, entry) {
  const found = findMatch(data, matchId);
  if (!found) return { ok: false, error: 'その試合は見つかりませんでした' };

  const { match } = found;
  const coolPlayer = findPlayer(data, match.coolId);
  const hotPlayer = findPlayer(data, match.hotId);
  if (!coolPlayer || !hotPlayer) {
    return { ok: false, error: '対戦者が両方とも決まっていません' };
  }

  const recCool = String(entry.coolName || '');
  const recHot = String(entry.hotName || '');

  let swapped;
  if (coolPlayer.name === recCool && hotPlayer.name === recHot) swapped = false;
  else if (coolPlayer.name === recHot && hotPlayer.name === recCool) swapped = true;
  else {
    return {
      ok: false,
      error: `選手名が一致しません (記録: ${recCool} と ${recHot} / 対戦表: ${coolPlayer.name} と ${hotPlayer.name})`,
    };
  }

  // 記録側の cool/hot を、対戦表側の cool/hot に読み替える
  const coolScore = swapped ? entry.hotScore : entry.coolScore;
  const hotScore = swapped ? entry.coolScore : entry.hotScore;

  let winnerId = null;
  if (entry.winner === 'cool') winnerId = swapped ? hotPlayer.id : coolPlayer.id;
  else if (entry.winner === 'hot') winnerId = swapped ? coolPlayer.id : hotPlayer.id;
  // 引き分け(draw)は勝者を決めない。再試合するかどうかは運営が判断する

  return setResult(data, matchId, {
    winnerId,
    coolScore,
    hotScore,
    note: entry.winner === 'draw' ? '引き分け' : String(entry.info || ''),
    roomId: entry.roomId,
    movieId: match.movieId,
  });
}

/* -------------------------------------------------- 参加者 */

/** 名簿に選手を追加する。id は使われていない番号から作る */
function addPlayer(data, name, school = '') {
  const used = new Set(data.players.map((p) => p.id));
  let n = data.players.length + 1;
  while (used.has(`p${n}`)) n++;

  data.players.push({
    id: `p${n}`,
    name: String(name || '').trim() || `選手${n}`,
    school: String(school || '').trim(),
  });
  return data;
}

/** 名簿から選手を外す。対戦表に入っている場合はその枠も空にする */
function removePlayer(data, playerId) {
  data.players = data.players.filter((p) => p.id !== playerId);

  for (const round of data.rounds) {
    for (const match of round.matches) {
      if (match.coolId === playerId) match.coolId = null;
      if (match.hotId === playerId) match.hotId = null;
      if (match.winnerId === playerId) match.winnerId = null;
    }
  }
  return data;
}

/** id から選手を引く。見つからなければ null */
const findPlayer = (data, playerId) => data.players.find((p) => p.id === playerId) || null;

/** 優勝者。決勝の勝者が決まっていれば返す */
function champion(data) {
  const final = data.rounds[data.rounds.length - 1];
  if (!final || final.matches.length !== 1) return null;
  return findPlayer(data, final.matches[0].winnerId);
}

module.exports = {
  DATA_DIR, DATA_FILE, DEFAULT_TITLE,
  emptyTournament, load, save, normalize,
  buildBracket, applyByes, roundName, nextPowerOfTwo, seedOrder,
  placeWinner, findMatch, setResult, applyRecordedResult,
  addPlayer, removePlayer, findPlayer, champion,
};
