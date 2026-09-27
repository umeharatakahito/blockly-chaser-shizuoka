/**
 * 大会当日の運営画面。参加者の取り込みから予選、決勝トーナメントの対戦までをここで回す。
 *
 *   GET  /contest/admin                         運営画面
 *   POST /contest/admin/import                  DO 版からエントリーと提出を取り込む
 *   POST /contest/admin/participants/add        参加者を手で足す(プログラムも一緒に渡せる)
 *   POST /contest/admin/participants/program    プログラムを差し替える(USB で持ち込まれた場合など)
 *   POST /contest/admin/participants/remove     参加者を外す
 *   GET  /contest/admin/program/:id             プログラム本体(対戦画面が読み込む)
 *   POST /contest/admin/qualifier/config        予選の設定(マップ・ボットの強さ・進出人数)
 *   POST /contest/admin/qualifier/remove-run    予選の記録を1件消す
 *   POST /contest/admin/tournament/build        予選の上位で決勝トーナメントを作る
 *   POST /contest/admin/tournament/round-room   回戦のマップを変える
 *   POST /contest/admin/tournament/replay       再試合(2回1組)を足す
 *   POST /contest/admin/tournament/clear-game   1回の対戦記録を消す
 *   POST /contest/admin/tournament/confirm      勝者を確定して次の回戦へ進める
 *
 * 操作のあとは必ずリダイレクトする。再読み込みで同じ操作が二重に走らないようにするため。
 */

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const store = require('../contest/store.js');
const rules = require('../contest/rules.js');
const importer = require('../contest/importer.js');
const recorder = require('../contest/recorder.js');
const tournament = require('../tournament/store.js');
const { requireAdmin } = require('../tool/admin_auth.js');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: store.MAX_PROGRAM_BYTES } });

/** busboy はファイル名を latin1 として読むので UTF-8 に戻す */
const fixName = (name) => Buffer.from(String(name || ''), 'latin1').toString('utf8');

function back(res, { ok, err, hash } = {}) {
  const params = new URLSearchParams();
  if (ok) params.set('ok', ok);
  if (err) params.set('err', err);
  const q = params.toString();
  res.redirect('/contest/admin' + (q ? '?' + q : '') + (hash ? '#' + hash : ''));
}

/** 公開中の大会マップ(合言葉つきの使い捨てルームは除く) */
function listRooms() {
  const dir = path.join(__dirname, '..', 'load_data', 'game_server_data');
  const rooms = [];
  for (const f of fs.readdirSync(dir)) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (/^room_\d{3}$/.test(m.room_id)) rooms.push({ id: m.room_id, name: m.name, turn: m.turn, cpu: Boolean(m.cpu) });
    } catch (e) { /* 読めないマップは出さない */ }
  }
  return rooms.sort((a, b) => a.id.localeCompare(b.id));
}

const matchUrl = (params) => '/match?' + Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

router.use(requireAdmin);

/* -------------------------------------------------- 画面 */

router.get('/', function (req, res, next) {
  try {
    const people = store.loadParticipants();
    const q = store.loadQualifier();
    const rooms = listRooms();
    const roomName = (id) => (rooms.find((r) => r.id === id) || { name: id }).name;
    const ranking = rules.qualifierRanking(people.participants, q.runs);
    const playedCount = ranking.filter((r) => r.run).length;

    // 進出ラインで同点になっていないか
    const cut = ranking.filter((r) => r.run);
    const tieAtCut = cut.length > q.config.advance && cut[q.config.advance - 1].rank === cut[q.config.advance].rank;

    const qualifierBack = '/contest/admin#qualifier';
    const qualifierRows = ranking.map((row) => Object.assign({}, row, {
      runs: q.runs[row.participant.id] || [],
      playUrl: row.participant.program ? matchUrl({
        room_id: q.config.roomId,
        room_token: recorder.qualifierToken(row.participant.id),
        prog_cool: row.participant.id,
        bot: q.config.botLevel,
        seed: q.config.seed,
        back: qualifierBack,
      }) : null,
    }));

    const t = tournament.load();
    const find = (id) => tournament.findPlayer(t, id);
    const rounds = t.rounds.map((round, ri) => ({
      index: ri,
      name: round.name,
      roomId: round.roomId,
      matches: round.matches.map((m) => {
        const ready = Boolean(m.coolId && m.hotId);
        const plan = ready ? rules.planGames(m, round.roomId).map((g) => Object.assign(g, {
          coolName: (find(g.coolId) || {}).name || '?',
          hotName: (find(g.hotId) || {}).name || '?',
          // 対戦表を手で作った場合など、参加者の名簿にプログラムが無い選手がいると対戦を始められない
          missing: [g.coolId, g.hotId].filter((id) => !store.programPath(store.findParticipant(people, id)))
            .map((id) => (find(id) || { name: id }).name),
          roomName: roomName(g.roomId),
          playUrl: matchUrl({
            room_id: g.roomId,
            room_token: recorder.tournamentToken(m.id, g.no),
            prog_cool: g.coolId,
            prog_hot: g.hotId,
            back: '/contest/admin#' + m.id,
          }),
        })) : [];
        return {
          id: m.id,
          cool: find(m.coolId),
          hot: find(m.hotId),
          winner: find(m.winnerId),
          note: m.note,
          ready,
          plan,
          decision: ready ? rules.decideMatch(m, round.roomId) : null,
        };
      }),
    }));

    res.render('contest-admin', {
      title: '大会当日の運営',
      people,
      config: q.config,
      qualifierRows,
      playedCount,
      tieAtCut,
      rounds,
      tournamentTitle: t.title,
      hasTournament: t.rounds.length > 0,
      rooms,
      roomName,
      doUrl: people.importSource || importer.DEFAULT_URL,
      message: typeof req.query.ok === 'string' ? req.query.ok : null,
      error: typeof req.query.err === 'string' ? req.query.err : null,
    });
  } catch (e) {
    next(e);
  }
});

/* -------------------------------------------------- 参加者 */

router.post('/import', async function (req, res) {
  try {
    const summary = await importer.importFromDo(req.body.url, req.body.key);
    back(res, { ok: importer.describeSummary(summary).join(' / '), hash: 'participants' });
  } catch (e) {
    back(res, { err: '取り込めません: ' + e.message, hash: 'participants' });
  }
});

router.post('/participants/add', upload.single('file'), function (req, res) {
  try {
    const data = store.loadParticipants();
    const p = store.addParticipant(data, { name: req.body.name, school: req.body.school });
    if (req.file) store.setProgram(data, p.id, req.file.buffer, { name: fixName(req.file.originalname), source: 'local' });
    store.saveParticipants(data);
    back(res, { ok: `${p.name} を追加しました`, hash: 'participants' });
  } catch (e) {
    back(res, { err: e.message, hash: 'participants' });
  }
});

router.post('/participants/program', upload.single('file'), function (req, res) {
  try {
    if (!req.file) throw new Error('ファイルを選んでください');
    const data = store.loadParticipants();
    const p = store.setProgram(data, String(req.body.id || ''), req.file.buffer, { name: fixName(req.file.originalname), source: 'local' });
    store.saveParticipants(data);
    back(res, { ok: `${p.name} のプログラムを差し替えました`, hash: 'participants' });
  } catch (e) {
    back(res, { err: e.message, hash: 'participants' });
  }
});

router.post('/participants/remove', function (req, res) {
  const data = store.loadParticipants();
  const p = store.removeParticipant(data, String(req.body.id || ''));
  if (!p) return back(res, { err: 'その参加者は見つかりませんでした', hash: 'participants' });
  store.saveParticipants(data);
  back(res, { ok: `${p.name} を外しました`, hash: 'participants' });
});

router.get('/program/:id', function (req, res) {
  const data = store.loadParticipants();
  const p = store.findParticipant(data, req.params.id);
  const full = store.programPath(p);
  if (!full) return res.status(404).send('プログラムがありません');
  res.set('Content-Type', 'application/octet-stream');
  res.set('Cache-Control', 'no-store');
  res.set('X-Program-Name', encodeURIComponent(p.program.name));
  res.set('X-Player-Name', encodeURIComponent(p.name));
  res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(p.name + '_' + p.program.name)}`);
  res.sendFile(full);
});

/* -------------------------------------------------- 予選 */

router.post('/qualifier/config', function (req, res) {
  const q = store.loadQualifier();
  q.config = store.normalizeQualifierConfig(Object.assign({}, q.config, req.body));
  store.saveQualifier(q);
  back(res, { ok: '予選の設定を保存しました', hash: 'qualifier' });
});

router.post('/qualifier/remove-run', function (req, res) {
  const q = store.loadQualifier();
  const ok = store.removeRun(q, String(req.body.id || ''), Number(req.body.index));
  if (!ok) return back(res, { err: 'その記録は見つかりませんでした', hash: 'qualifier' });
  store.saveQualifier(q);
  back(res, { ok: '予選の記録を1件消しました', hash: 'qualifier' });
});

/* -------------------------------------------------- 決勝トーナメント */

router.post('/tournament/build', function (req, res) {
  const people = store.loadParticipants();
  const q = store.loadQualifier();
  const ranked = rules.qualifierRanking(people.participants, q.runs).filter((r) => r.run);
  const chosen = ranked.slice(0, q.config.advance).map((r) => r.participant);
  if (chosen.length < 2) return back(res, { err: '予選を終えた人が2人以上必要です', hash: 'tournament' });

  const current = tournament.load();
  const data = tournament.buildBracket(tournament.normalize({
    title: current.title,
    players: chosen.map((p) => ({ id: p.id, name: p.name, school: p.school })),
  }));
  tournament.save(data);
  back(res, { ok: `予選の上位 ${chosen.length} 人で決勝トーナメントを作りました`, hash: 'tournament' });
});

router.post('/tournament/round-room', function (req, res) {
  const data = tournament.load();
  const r = tournament.setRoundRoom(data, Number(req.body.round), req.body.roomId);
  if (!r.ok) return back(res, { err: r.error, hash: 'tournament' });
  tournament.save(data);
  back(res, { ok: `${data.rounds[Number(req.body.round)].name} のマップを変更しました`, hash: 'tournament' });
});

router.post('/tournament/replay', function (req, res) {
  const data = tournament.load();
  const r = tournament.addReplaySet(data, String(req.body.matchId || ''), req.body.roomId);
  if (!r.ok) return back(res, { err: r.error, hash: 'tournament' });
  tournament.save(data);
  back(res, { ok: '再試合を2回足しました', hash: String(req.body.matchId || 'tournament') });
});

router.post('/tournament/clear-game', function (req, res) {
  const data = tournament.load();
  const r = tournament.clearGame(data, String(req.body.matchId || ''), Number(req.body.no));
  if (!r.ok) return back(res, { err: r.error, hash: 'tournament' });
  tournament.save(data);
  back(res, { ok: `${req.body.no} 回目の記録を消しました`, hash: String(req.body.matchId || 'tournament') });
});

router.post('/tournament/confirm', function (req, res) {
  const data = tournament.load();
  const matchId = String(req.body.matchId || '');
  const found = tournament.findMatch(data, matchId);
  if (!found) return back(res, { err: 'その試合は見つかりませんでした', hash: 'tournament' });
  const m = found.match;
  const d = rules.decideMatch(m, data.rounds[found.roundIndex].roomId);
  if (d.status !== 'decided') return back(res, { err: 'まだ勝者が決まっていません', hash: matchId });

  const r = tournament.setResult(data, matchId, {
    winnerId: d.winnerId,
    coolScore: d.wins[m.coolId],
    hotScore: d.wins[m.hotId],
    note: d.reason,
  });
  if (!r.ok) return back(res, { err: r.error, hash: matchId });
  tournament.save(data);
  const w = tournament.findPlayer(data, d.winnerId);
  back(res, { ok: `${w ? w.name : '勝者'} の勝ちで確定しました`, hash: matchId });
});

module.exports = router;
