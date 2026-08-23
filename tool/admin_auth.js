/**
 * 運営操作用の最小限の権限管理。
 *
 * 元のコードベースに認証機構は無い。参加者向けのページはこれまで通り誰でも見られる。
 * 動画のアップロードやトーナメント表の編集など、運営だけが行う操作にだけ関門を置く。
 *
 * 動作は環境変数 ADMIN_KEY の有無で変わる。
 *
 *   ADMIN_KEY 未設定: localhost からのアクセスだけを通す。
 *                     運営がサーバー機の前にいる前提の、設定不要な既定動作
 *   ADMIN_KEY 設定済: 合言葉が一致した場合だけ通す。Cookie に保存する
 *
 * これは大会運営上の仕切りであって、強度のある認証ではない。
 * 会場LAN内での運用を前提としている。インターネットに公開する場合は
 * ADMIN_KEY を必ず設定し、十分に長い文字列にすること。
 */

const crypto = require('crypto');

const COOKIE_NAME = 'admin_key';
// 大会の1日を通してログインし直さずに済む長さ
const COOKIE_MAX_AGE = 12 * 60 * 60 * 1000;

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

const adminKey = () => process.env.ADMIN_KEY || '';
const isAdminKeySet = () => adminKey().length > 0;

/** 長さの違いから合言葉を推測されないよう、比較時間を一定にする */
function safeEquals(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) {
    // 長さが違う時点で不一致だが、早期 return による時間差をなくすためダミー比較を行う
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/** リクエスト元が localhost か */
function isLoopback(req) {
  const ip = (req.ip || req.connection?.remoteAddress || '').trim();
  return LOOPBACK.has(ip);
}

/** リクエストから合言葉を取り出す。Cookie / フォーム / ヘッダの順に見る */
function presentedKey(req) {
  return (req.cookies && req.cookies[COOKIE_NAME])
    || (req.body && req.body[COOKIE_NAME])
    || req.get('X-Admin-Key')
    || '';
}

/** 現在のリクエストが運営として通るか */
function isAdmin(req) {
  if (!isAdminKeySet()) return isLoopback(req);
  const key = presentedKey(req);
  return key.length > 0 && safeEquals(key, adminKey());
}

/**
 * 運営ページを守るミドルウェア。
 * 通らない場合、ページ要求にはログイン画面、API 要求には 403 を返す。
 */
function requireAdmin(req, res, next) {
  if (isAdmin(req)) return next();

  const wantsJson = req.xhr
    || req.is('application/json')
    || (req.get('Accept') || '').includes('application/json');

  if (wantsJson) {
    return res.status(403).json({
      ok: false,
      error: isAdminKeySet()
        ? '合言葉が違います'
        : 'ADMIN_KEY が未設定のため、localhost からのみ操作できます',
    });
  }

  return res.status(403).render('admin-login', {
    title: '運営ページ',
    keyRequired: isAdminKeySet(),
    // 直前に合言葉を送ってきた場合だけ「違います」と出す。初回表示では出さない
    failed: Boolean(req.body && req.body[COOKIE_NAME]),
    returnTo: req.originalUrl,
  });
}

/** ログインフォームの送信先。合言葉が合っていれば Cookie を発行する */
function loginHandler(req, res) {
  const returnTo = typeof req.body.returnTo === 'string' && req.body.returnTo.startsWith('/')
    ? req.body.returnTo
    : '/';

  if (!isAdminKeySet()) {
    // 合言葉が設定されていない運用では、localhost 判定だけで通す
    return res.redirect(returnTo);
  }

  if (safeEquals(req.body[COOKIE_NAME] || '', adminKey())) {
    res.cookie(COOKIE_NAME, adminKey(), {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: COOKIE_MAX_AGE,
    });
    return res.redirect(returnTo);
  }

  return res.status(403).render('admin-login', {
    title: '運営ページ',
    keyRequired: true,
    failed: true,
    returnTo,
  });
}

function logoutHandler(req, res) {
  res.clearCookie(COOKIE_NAME);
  res.redirect('/');
}

module.exports = {
  COOKIE_NAME, requireAdmin, isAdmin, isAdminKeySet, isLoopback,
  loginHandler, logoutHandler, safeEquals,
};
