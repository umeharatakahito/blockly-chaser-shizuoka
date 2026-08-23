# U15静岡プロコンサーバー
Combine Google Blockly and Procon Game Server.

U15静岡プロコンサーバーは U-16プログラミングコンテスト静岡大会 での使用を想定したサーバです。

ビジュアルプログラミングの一つである[blockly](https://github.com/google/blockly)を用いて、
プログラミング初学者が気軽にプログラミングコンテストに参加できる環境づくりを目指しています。
ゲーム仕様は[AsahikawaProcon-Server](https://github.com/hal1437/AsahikawaProcon-Server)を参考に、
ブラウザ上でゲームの実行が可能です。

## 派生元

本リポジトリは以下の系譜のフォークです。

U15長野プロコンサーバー
→ [U15一関プロコンサーバー](https://github.com/U15-Ichinoseki/blockly-chaser-ichinoseki) (v4.5.0)
→ 本リポジトリ（静岡大会仕様）

参加者が練習に使用する [chaser.u15-ichinoseki.org](https://chaser.u15-ichinoseki.org/) は
一関版 v4.5.0 が稼働しており、本リポジトリはその配信ファイルと同一の内容から分岐しています。
そのため、参加者が練習環境で保存した `.blch` ファイルをそのまま読み込めます。

上流の更新を取り込む場合:

```bash
git fetch upstream
git merge upstream/master
```

<img width="960" alt="Screen_Shot" src="./ScreenShot.png">

## 機能
- プログラミング
	- プログラムの実行・停止
	- ゲーム用ブロックの追加
	- エラー表示
	- プログラムの保存
		- 保存ボタンによる手動保存(JSON圧縮形式 `.blch`)
		- プログラム実行時の自動保存
	- プログラムのロード
		- 開くボタンによる任意プログラムのロード
		- 前回実行したプログラムのロード
	- コードの表示
		- Python
		- JavaScript
	- 上級編
- チュートリアル
	- 操作方法等のチュートリアルページ
- ゲーム
    - ゲームの開始・終了
    - マップ自動生成
    - CPU対戦
    - 他プレイヤー同士のゲーム観戦

## 動作環境
- Windows 11 / macOS 14
- Node.js 18 以上を推奨（開発時の確認は Node.js 25 系）

## セットアップ

```bash
git clone <本リポジトリのURL> blockly-chaser-shizuoka
cd blockly-chaser-shizuoka
npm install
npm start
```

## 動作確認
- サーバー機のブラウザから `http://localhost:3000/`
- 参加者端末からは `http://<サーバー機のIPアドレス>:3000/`

ポートは環境変数 `PORT` で変更できます。

```bash
PORT=8080 npm start
```

## 大会運営時の注意

- **会場LAN内で完結させることを推奨します。** インターネットに公開すると、
  合言葉が推測された場合に部外者が試合に乱入できます。
- 対戦状態はすべてサーバープロセスのメモリ上に保持されます。
  サーバーを再起動すると進行中の試合は失われます。
- `node_modules` は同期フォルダ（Google Drive / iCloud 等）に置かないでください。

## アプリ化方法

|OS|コマンド|
|--|--|
|Windows|`npm run dist-win`|
|macOS|`npm run dist-mac`|

`dist` フォルダにアプリ化されたファイルが生成されます。

## Licence
[LICENSE](LICENSE) (MIT License / Copyright (c) 2020 kuropengin)
