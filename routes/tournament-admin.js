/**
 * トーナメントの管理(運営向け)。
 *
 *   GET  /tournament/admin                 管理画面
 *   POST /tournament/admin/title           大会名の変更
 *   POST /tournament/admin/players/add     参加者の追加
 *   POST /tournament/admin/players/remove  参加者の削除
 *   POST /tournament/admin/build           対戦表の作成
 *   POST /tournament/admin/result          勝敗の手入力
 *   POST /tournament/admin/import          自動記録された結果の取り込み
 *   POST /tournament/admin/reset           対戦表の破棄
 *
 * 操作のあとは必ずリダイレクトする。画面を再読み込みしたときに
 * 同じ操作が二重に走らないようにするため。
 */

const express = require('express');
const router = express.Router();

const store = require('../tournament/store.js');
const resultLog = require('../tournament/result_log.js');
const movieStore = require('../movies/store.js');
const { requireAdmin } = require('../tool/admin_auth.js');

// 再起動しても直前の試合結果を候補として出せるように読み戻しておく
resultLog.restore();

const RECENT_LIMIT = 30;

/** 操作結果を伝えつつ管理画面へ戻す */
function back(res, { ok, err } = {}) {
  const params = new URLSearchParams();
  if (ok) params.set('ok', ok);
  if (err) params.set('err', err);
  const query = params.toString();
  res.redirect('/tournament/admin' + (query ? '?' + query : ''));
}

router.use(requireAdmin);

router.get('/', function (req, res, next) {
  try {
    const data = store.load();

    // 試合を選ぶプルダウン用に、対戦者が両方決まっている試合を平らに並べる
    const selectableMatches = [];
    for (const round of data.rounds) {
      for (const m of round.matches) {
        if (!m.coolId || !m.hotId) continue;
        const cool = store.findPlayer(data, m.coolId);
        const hot = store.findPlayer(data, m.hotId);
        selectableMatches.push({
          id: m.id,
          label: `${round.name}: ${cool ? cool.name : '?'} vs ${hot ? hot.name : '?'}`,
        });
      }
    }

    res.render('tournament-admin', {
      title: 'トーナメントの管理',
      data,
      findPlayer: (id) => store.findPlayer(data, id),
      champion: store.champion(data),
      selectableMatches,
      recentResults: resultLog.listRecent(RECENT_LIMIT),
      movies: movieStore.listMovies(),
      message: typeof req.query.ok === 'string' ? req.query.ok : null,
      error: typeof req.query.err === 'string' ? req.query.err : null,
    });
  } catch (e) {
    next(e);
  }
});

router.post('/title', function (req, res, next) {
  try {
    const data = store.load();
    data.title = String(req.body.title || '').trim() || store.DEFAULT_TITLE;
    store.save(data);
    back(res, { ok: '大会名を変更しました' });
  } catch (e) {
    next(e);
  }
});

router.post('/players/add', function (req, res, next) {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return back(res, { err: '名前を入力してください' });

    const data = store.load();
    store.addPlayer(data, name, req.body.school);
    store.save(data);
    back(res, { ok: `${name} を追加しました` });
  } catch (e) {
    next(e);
  }
});

router.post('/players/remove', function (req, res, next) {
  try {
    const data = store.load();
    const player = store.findPlayer(data, String(req.body.id || ''));
    if (!player) return back(res, { err: 'その参加者は見つかりませんでした' });

    store.removePlayer(data, player.id);
    store.save(data);
    back(res, { ok: `${player.name} を外しました` });
  } catch (e) {
    next(e);
  }
});

router.post('/build', function (req, res, next) {
  try {
    const data = store.load();
    if (data.players.length < 2) {
      return back(res, { err: '対戦表を作るには2人以上の参加者が必要です' });
    }

    store.save(store.buildBracket(data));
    back(res, { ok: '対戦表を作りました。これまでの勝敗は消えています' });
  } catch (e) {
    next(e);
  }
});

router.post('/result', function (req, res, next) {
  try {
    const data = store.load();
    const result = store.setResult(data, String(req.body.matchId || ''), {
      winnerId: req.body.winnerId,
      coolScore: req.body.coolScore,
      hotScore: req.body.hotScore,
      note: req.body.note,
      roomId: req.body.roomId,
      movieId: req.body.movieId,
    });

    if (!result.ok) return back(res, { err: result.error });

    store.save(data);
    back(res, { ok: '結果を記録しました' });
  } catch (e) {
    next(e);
  }
});

router.post('/import', function (req, res, next) {
  try {
    const index = Number(req.body.index);
    const entry = resultLog.listRecent(RECENT_LIMIT)[index];
    if (!entry) return back(res, { err: 'その試合結果は見つかりませんでした' });

    const data = store.load();
    const result = store.applyRecordedResult(data, String(req.body.matchId || ''), entry);
    if (!result.ok) return back(res, { err: result.error });

    store.save(data);
    back(res, { ok: `${entry.coolName} 対 ${entry.hotName} の結果を取り込みました` });
  } catch (e) {
    next(e);
  }
});

router.post('/reset', function (req, res, next) {
  try {
    const data = store.load();
    data.rounds = [];
    store.save(data);
    back(res, { ok: '対戦表を破棄しました。参加者名簿は残っています' });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
