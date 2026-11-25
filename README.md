# ルイトAI STUDIO

Google Apps Script（GAS）で起動するブラウザー型の制作ワークスペース。

## Stage 1 実装
- GAS Webアプリ入口（Code.gs / doGet）
- index・style・scriptの分離
- ホームと8ツール画面の切り替え
- 文章・コードエディターとlocalStorage自動保存
- TXT / コード / JSON書き出しとJSON読み込み
- 画像・動画・音声ファイルのローカルプレビュー
- GASサーバー接続確認
- Drive保存用サーバー関数（UIからは未接続）

## GASへの配置
1. Google Apps Scriptで新しいプロジェクトを作成。
2. Code.gsを貼り付ける。
3. HTMLファイルを3つ作成し、ファイル名を index / style / script にする。
4. 各HTMLファイルに同名ファイルの内容を貼り付ける。
5. 「デプロイ」→「新しいデプロイ」→「ウェブアプリ」でテストする。

## 注意
- GitHubの変更はGASへ自動同期されません。現段階では手動反映です。
- AIチャット/AUTO TALKは画面の土台で、まだAI APIには接続していません。
- ブラウザー内保存は同じブラウザー内です。Drive保存UIは次段階で追加します。
- 動画編集は未実装。iPadのメモリや対応コーデックを検証しながら開発します。
- APIキーをHTML/クライアントJSに書かず、AI接続時はGASサーバー側で管理します。

## Stage 2: AIチャット接続
1. GASプロジェクトの「プロジェクトの設定」→「スクリプト プロパティ」を開きます。
2. `OPENAI_API_KEY` に自分のOpenAI APIキーを登録します。
3. 必要なら `OPENAI_MODEL` に利用可能なモデルIDを登録します（未設定時は `gpt-5.5`）。
4. GASウェブアプリを新しいバージョンとして再デプロイします。
5. ウェブアプリを開いてAIチャットを試します。

APIキーはHTMLやブラウザー側JavaScriptに保存しません。API利用にはOpenAI API側の利用設定・残高/請求設定が必要になる場合があります。API料金はChatGPTのサブスクリプションとは別です。


## Stage 3: AUTO TALK（役割シミュレーション）
- 会議テーマを送信し、ChatGPT（設計・統括）→ Gemini（企画視点）→ Copilot（開発視点）→ 会議まとめの順で出力
- 会議ログをブラウザー内に保存し、消去可能
- **重要:** 現段階では1つの設定済みOpenAIモデルが3つの役割を演じます。Gemini / Copilotの実API接続ではありません。各社APIキー・接続先を設定した後に本当の複数AI通信へ拡張します。
- 実行にはStage 2と同じ `OPENAI_API_KEY` の登録が必要です。


## Stage 4: Google Drive保存
- ファイル管理画面から文章・コードのスナップショットをDriveへJSON保存
- アプリが作成した `RUITO_STUDIO_*.json` の一覧表示と読み込み
- 初回利用時にGoogleアカウントのDriveアクセス権限の承認が必要
- DriveアクセスはGASサーバー側で実行。保存・読み込みはユーザー操作時のみ
- 既存ファイルの上書きではなく、毎回新しいスナップショットを作成


## Stage 5: AUTO TALKの複数プロバイダー対応
- ChatGPT役：OpenAI Responses APIで実接続
- Gemini役：`GEMINI_API_KEY` がある場合にGemini APIへ実接続。未設定時は役割シミュレーション
- Copilot役：現状は開発担当視点のシミュレーション。GitHub Copilotそのものへの接続ではありません
- APIキーはGASのスクリプトプロパティに保存し、ブラウザーへ返しません

### 追加設定
GAS「プロジェクトの設定」→「スクリプト プロパティ」に以下を追加：
- `GEMINI_API_KEY`：Google AI Studioで発行したGemini APIキー
- `GEMINI_MODEL`：任意。未設定時は `gemini-2.5-flash`
- 既存の `OPENAI_API_KEY` / `OPENAI_MODEL` も引き続き必要

※Gemini APIの利用条件・モデル提供状況・料金はGoogle側の設定に依存します。Copilot役の実接続は別途公式に利用可能な連携手段の確認が必要です。
