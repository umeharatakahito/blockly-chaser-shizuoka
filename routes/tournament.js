/**
 * トーナメント表(参加者・観客向け)。認証は不要。
 *
 *   GET /tournament       対戦表
 *   GET /tournament/data  対戦表の JSON。画面が定期的に読んで更新を拾う
 */

const express = require('express');
const router = express.Router();

const store = require('../tournament/store.js');
const movieStore = require('../movies/store.js');
const languageLoad = require('../tool/language_load.js');

const CONFIG_LNG = languageLoad.loadLangJson('config.json');

/**
 * 画面に出す形へ整える。
 * ビュー側で選手 id を引き回さずに済むよう、ここで名前まで解決しておく。
 */
function toView(data) {
  const playerOf = (id) => {
    const p = store.findPlayer(data, id);
    return p ? { id: p.id, name: p.name, school: p.school } : null;
  };

  const movieIds = new Set(movieStore.listMovies().map((m) => m.id));

  return {
    title: data.title,
    playerCount: data.players.length,
    champion: store.champion(data),
    rounds: data.rounds.map((round) => ({
      name: round.name,
      matches: round.matches.map((m) => ({
        id: m.id,
        cool: playerOf(m.coolId),
        hot: playerOf(m.hotId),
        winnerId: m.winnerId,
        coolScore: m.coolScore,
        hotScore: m.hotScore,
        note: m.note,
        // 存在しない動画へのリンクを出さない
        movieId: m.movieId && movieIds.has(m.movieId) ? m.movieId : '',
      })),
    })),
  };
}

router.get('/', function (req, res, next) {
  try {
    const data = store.load();
    res.render('tournament', {
      title: '対戦表',
      C_LNG: languageLoad.pickByCookie(req, CONFIG_LNG),
      bracket: toView(data),
    });
  } catch (e) {
    next(e);
  }
});

router.get('/data', function (req, res, next) {
  try {
    res.json(toView(store.load()));
  } catch (e) {
    next(e);
  }
});

module.exports = router;
module.exports.toView = toView;
