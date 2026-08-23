/**
 * 言語ファイル(language/<lng>/<name>.json)の読み込みと、Cookie による言語選択。
 *
 * 既存ルートは各ファイルで同じ Cookie 分岐を書いているが、
 * 新しく足すページはここに集約する。
 *
 * ja   : 通常の日本語
 * ja-k : ひらがな中心。低学年の参加者向け
 */

const fs = require('fs');
const path = require('path');

const LANG_DIR = path.join(__dirname, '..', 'language');
const SUPPORTED = ['ja', 'ja-k'];
const DEFAULT_LNG = 'ja';

/**
 * 言語ごとの JSON をまとめて読む。
 * @returns {Object} { ja: {...}, 'ja-k': {...} }
 */
function loadLangJson(fileName) {
  const table = {};
  for (const lng of SUPPORTED) {
    try {
      table[lng] = JSON.parse(fs.readFileSync(path.join(LANG_DIR, lng, fileName), 'utf8'));
    } catch (e) {
      // 片方の言語ファイルが無くてもページは出したい。既定言語で埋める
      table[lng] = table[DEFAULT_LNG] || {};
    }
  }
  return table;
}

/** リクエストの Cookie から言語を選ぶ。未知の値や未設定なら既定言語 */
function pickByCookie(req, table) {
  const lng = req && req.cookies && req.cookies.lng;
  if (SUPPORTED.includes(lng) && table[lng]) return table[lng];
  return table[DEFAULT_LNG];
}

module.exports = { loadLangJson, pickByCookie, SUPPORTED, DEFAULT_LNG };
