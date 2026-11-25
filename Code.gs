/** ルイトAI STUDIO - Google Apps Script server entry */
function doGet() {
  return HtmlService.createTemplateFromFile('index')
    .evaluate()
    .setTitle('ルイトAI STUDIO')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

/** HTML partial loader used by index.html */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/** Lightweight connection check for the client. */
function getAppInfo() {
  return {
    app: 'ルイトAI STUDIO',
    status: 'ok',
    version: '0.1.0',
    serverTime: new Date().toISOString()
  };
}

/**
 * Store a text export in the user's Google Drive.
 * This function is intentionally not called automatically; the UI will ask
 * for an explicit save action in a later step.
 */
function saveTextToDrive(filename, content) {
  if (typeof filename !== 'string' || typeof content !== 'string') {
    throw new Error('ファイル名と内容を文字列で指定してください。');
  }
  var safeName = filename.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) || 'ruito-document.txt';
  if (content.length > 500000) throw new Error('ファイルが大きすぎます。');
  var file = DriveApp.createFile(safeName, content, MimeType.PLAIN_TEXT);
  return { id: file.getId(), name: file.getName(), url: file.getUrl() };
}

/**
 * OpenAI Responses API chat proxy.
 * Configure OPENAI_API_KEY in Apps Script > Project Settings > Script Properties.
 * Optional: OPENAI_MODEL (defaults to gpt-5.5).
 */
function sendChatMessage(messages) {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 12) {
    throw new Error('会話履歴が正しくありません。');
  }
  var props = PropertiesService.getScriptProperties();
  var apiKey = props.getProperty('OPENAI_API_KEY');
  if (!apiKey) throw new Error('APIキーが未設定です。GASのスクリプトプロパティに OPENAI_API_KEY を登録してください。');
  var model = props.getProperty('OPENAI_MODEL') || 'gpt-5.5';
  var safeMessages = messages.map(function(item) {
    if (!item || (item.role !== 'user' && item.role !== 'assistant') ||
        typeof item.content !== 'string' || item.content.length > 6000) {
      throw new Error('メッセージの形式または長さが正しくありません。');
    }
    return { role: item.role, content: item.content };
  });
  var payload = {
    model: model,
    instructions: 'あなたは「ルイトAI」。日本語を基本に、正確で実用的に回答してください。不明なことは不明と伝えてください。',
    input: safeMessages,
    max_output_tokens: 900
  };
  var response = UrlFetchApp.fetch('https://api.openai.com/v1/responses', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + apiKey },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  var status = response.getResponseCode();
  var body = response.getContentText();
  var data;
  try { data = JSON.parse(body); } catch (e) { throw new Error('AI APIから正しい応答を受け取れませんでした。'); }
  if (status < 200 || status >= 300) {
    var detail = data && data.error && data.error.message ? data.error.message : 'HTTP ' + status;
    throw new Error('AI APIエラー: ' + detail.slice(0, 240));
  }
  var answer = '';
  (data.output || []).forEach(function(item) {
    if (item.type === 'message' && Array.isArray(item.content)) {
      item.content.forEach(function(part) {
        if (part.type === 'output_text' && typeof part.text === 'string') answer += part.text;
      });
    }
  });
  if (!answer) throw new Error('AIから文章の応答がありませんでした。');
  return { text: answer, model: data.model || model };
}
