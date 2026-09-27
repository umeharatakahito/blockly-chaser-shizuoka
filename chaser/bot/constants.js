/**
 * CHaser のセル値と方向。
 *
 * Node 版 (chaser/server.js) と完全に同じ体系を使う。
 * 参加者のプログラムの挙動を変えないことが最優先なので、
 * 「きれいな設計」より「本家と1つも違わないこと」を採る。
 *
 * 1 と 2 は直感と逆なので注意。本家で確認できる。
 *   - create_map():        auto_block が 1 を、auto_point が 2 を書き込む
 *   - move_player():       値 2 のマスへ入るとスコアが増える(アイテム)
 *   - game_result_check(): 四方が 1 に囲まれると「ブロック閉じ込め」で負け
 */

/* 盤面(サーバー内部)の値 */
export const FLOOR = 0;
export const BLOCK = 1;
export const ITEM = 2;
export const COOL = 3;
export const HOT = 4;
/** cool と hot が同じマスに重なった状態 */
export const BOTH = 34;

/* クライアントへ返す9マスの値。pychaser の Floor/Enemy/Block/Item と対応する */
export const REC_FLOOR = 0;
export const REC_ENEMY = 1;
export const REC_BLOCK = 2;
export const REC_ITEM = 3;

export const DIRECTIONS = ['top', 'bottom', 'left', 'right'];

/** 自分の駒の値 */
export const charaNum = { cool: COOL, hot: HOT };
/** 相手の駒の値 */
export const charaNumDiff = { cool: HOT, hot: COOL };
/** 相手の名前 */
export const opponentOf = { cool: 'hot', hot: 'cool' };

/**
 * 盤面の値を、クライアントへ返す値へ変換する。
 * 自分・相手の判定が必要なので chara を渡す。
 */
export function toRec(cell, chara) {
  if (cell === charaNumDiff[chara] || cell === BOTH) return REC_ENEMY;
  if (cell === FLOOR || cell === charaNum[chara]) return REC_FLOOR;
  if (cell === BLOCK) return REC_BLOCK;
  return REC_ITEM;
}
