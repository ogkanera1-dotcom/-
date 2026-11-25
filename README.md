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
