/**
 * 大会の公開ページ(認証不要)。
 *
 *   GET /contest/qualifier   予選の順位表。会場のスクリーンに映す想定で、10秒ごとに更新する
 */

const express = require('express');
const store = require('../contest/store.js');
const rules = require('../contest/rules.js');
const tournament = require('../tournament/store.js');

const router = express.Router();

router.get('/qualifier', function (req, res, next) {
  try {
    const people = store.loadParticipants();
    const q = store.loadQualifier();
    const rows = rules.qualifierRanking(people.participants.filter((p) => p.program), q.runs);
    res.render('contest-qualifier', {
      title: tournament.load().title,
      rows,
      advance: q.config.advance,
    });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
