/**
 * 試合が終わったら、予選の記録とトーナメントの対戦記録へ自動で書き込む。
 *
 * どの試合かは、運営画面が対戦を始めるときに付ける合言葉で見分ける。名前の突き合わせはしない。
 *   予選           room_011?q-<参加者id>-<乱数>
 *   トーナメント   room_112?t-<試合id>-<何回目>-<乱数>
 *
 * 予選は最後に戦った記録を採用する(やり直したら置き換わる)。
 * トーナメントは対戦記録を書くだけで、勝者の確定と次の回戦への繰り上げは運営が押す。
 */

const resultLog = require('../tournament/result_log.js');
const tournament = require('../tournament/store.js');
const store = require('./store.js');
const rules = require('./rules.js');

const QUALIFIER = /^q-([a-z0-9]+)-[a-z0-9]+$/i;
const TOURNAMENT = /^t-([a-z0-9]+)-(\d+)-[a-z0-9]+$/i;

/** ルームID(合言葉つき)から、どの試合かを読む */
function parseRoom(roomId) {
  const [base, token = ''] = String(roomId || '').split('?');
  let m = QUALIFIER.exec(token);
  if (m) return { kind: 'qualifier', base, participantId: m[1] };
  m = TOURNAMENT.exec(token);
  if (m) return { kind: 'tournament', base, matchId: m[1], no: Number(m[2]) };
  return null;
}

/** 合言葉を作る。英数字とハイフンだけ */
const nonce = () => Math.random().toString(36).slice(2, 8);
const qualifierToken = (participantId) => `q-${participantId}-${nonce()}`;
const tournamentToken = (matchId, no) => `t-${matchId}-${no}-${nonce()}`;

/** result_log の1件を受け取って書き込む。何を書いたかを返す(テスト用) */
function handleResult(entry) {
  const target = parseRoom(entry.roomId);
  if (!target) return null;

  if (target.kind === 'qualifier') {
    const people = store.loadParticipants();
    if (!store.findParticipant(people, target.participantId)) return null;
    const q = store.loadQualifier();
    const run = rules.qualifierRunFromResult(entry);
    store.addRun(q, target.participantId, run);
    store.saveQualifier(q);
    return { kind: 'qualifier', participantId: target.participantId, run };
  }

  const data = tournament.load();
  const found = tournament.findMatch(data, target.matchId);
  if (!found) return null;
  const round = data.rounds[found.roundIndex];
  const planned = rules.planGames(found.match, round.roomId).find((g) => g.no === target.no);
  if (!planned) return null;

  const game = {
    no: target.no,
    coolId: planned.coolId,
    hotId: planned.hotId,
    roomId: target.base,
    winner: entry.winner,
    info: entry.info,
    coolItems: entry.coolScore,
    hotItems: entry.hotScore,
    turnsLeft: entry.turnsLeft,
    recordedAt: entry.recordedAt,
  };
  tournament.recordGame(data, target.matchId, game);
  tournament.save(data);
  return { kind: 'tournament', matchId: target.matchId, game };
}

let installed = false;
/** サーバー起動時に1度だけ呼ぶ */
function install() {
  if (installed) return;
  installed = true;
  resultLog.onResult(handleResult);
}

module.exports = { parseRoom, qualifierToken, tournamentToken, handleResult, install };
