/**
 * 試合動画の閲覧。
 *
 *   GET /movies           一覧
 *   GET /movies/file/:id  動画ファイル本体(シーク可能)
 *   GET /movies/:id       再生ページ
 *
 * ファイル配信に express.static を使わないのは、
 * 同じディレクトリにある movies.json まで配ってしまうため。
 * id からエントリを引いて、登録済みのファイルだけを返す。
 */

const express = require('express');
const router = express.Router();

const store = require('../movies/store.js');
const languageLoad = require('../tool/language_load.js');

const LNG = languageLoad.loadLangJson('movies.json');
const CONFIG_LNG = languageLoad.loadLangJson('config.json');

const locals = (req) => ({
  LNG: languageLoad.pickByCookie(req, LNG),
  C_LNG: languageLoad.pickByCookie(req, CONFIG_LNG),
});

/* 一覧 */
router.get('/', function (req, res, next) {
  try {
    res.render('movies', Object.assign({ title: '試合動画', movies: store.listMovies() }, locals(req)));
  } catch (e) {
    next(e);
  }
});

/*
 * 動画ファイル本体。
 * /movies/:id より先に定義する。後にすると "file" が id として解釈される
 */
router.get('/file/:id', function (req, res, next) {
  try {
    const movie = store.getMovie(req.params.id);
    if (!movie) return res.status(404).send('Not Found');

    const filePath = store.resolveFilePath(movie);
    if (!filePath) return res.status(404).send('Not Found');

    res.type(store.mimeTypeFor(movie.file));
    // sendFile は Range リクエストに対応しているので、シークがそのまま効く
    res.sendFile(filePath, { dotfiles: 'deny' }, (err) => {
      if (err && !res.headersSent) res.status(err.status || 404).end();
    });
  } catch (e) {
    next(e);
  }
});

/* 再生ページ */
router.get('/:id', function (req, res, next) {
  try {
    const movie = store.getMovie(req.params.id);
    if (!movie) {
      return res.status(404).render('movie-player', Object.assign(
        { title: '試合動画', movie: null }, locals(req)
      ));
    }
    res.render('movie-player', Object.assign({ title: movie.title, movie }, locals(req)));
  } catch (e) {
    next(e);
  }
});

module.exports = router;
