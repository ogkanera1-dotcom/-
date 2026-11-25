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
function saveTextToDrive(token, filename, content) {
  var account = requireAccount_(token);
  if (typeof filename !== 'string' || typeof content !== 'string') {
    throw new Error('ファイル名と内容を文字列で指定してください。');
  }
  var safeName = filename.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) || 'ruito-document.txt';
  if (content.length > 500000) throw new Error('ファイルが大きすぎます。');
  var file = DriveApp.createFile('RUITO_' + account.userId + '_' + safeName, content, MimeType.PLAIN_TEXT);
  return { id: file.getId(), name: file.getName(), url: file.getUrl() };
}

/**
 * OpenAI Responses API chat proxy.
 * Configure OPENAI_API_KEY in Apps Script > Project Settings > Script Properties.
 * Optional: OPENAI_MODEL (defaults to gpt-5.5).
 */
function sendChatMessage(token, messages) {
  requireAccount_(token);
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


/**
 * Multi-provider AUTO TALK.
 * ChatGPT uses OpenAI; Gemini uses Google's Gemini API when configured.
 * Copilot remains an explicitly labeled development-role simulation because
 * GitHub Copilot does not expose a general-purpose public chat API for this app.
 */
function runAutoTalk(token, topic) {
  requireAccount_(token);
  if (typeof topic !== 'string' || !topic.trim() || topic.length > 1000) {
    throw new Error('会議テーマを1〜1000文字で入力してください。');
  }
  var props = PropertiesService.getScriptProperties();
  var openAiKey = props.getProperty('OPENAI_API_KEY');
  var geminiKey = props.getProperty('GEMINI_API_KEY');
  if (!openAiKey) throw new Error('OPENAI_API_KEY が未設定です。GASのスクリプトプロパティに登録してください。');
  var openAiModel = props.getProperty('OPENAI_MODEL') || 'gpt-5.5';
  var geminiModel = props.getProperty('GEMINI_MODEL') || 'gemini-2.5-flash';
  var brief = '会議テーマ：' + topic.trim() + '\n日本語で具体的に回答。実装済みと未実装を混同せず、要点を簡潔に。';
  var chatgpt = callOpenAIText_(openAiKey, openAiModel,
    'あなたはルイトAI STUDIOの設計・統括担当。目的、要件、優先順位、全体設計を整理してください。', brief, 550);
  var gemini, geminiLive = false;
  if (geminiKey) {
    gemini = callGeminiText_(geminiKey, geminiModel,
      'あなたはルイトAI STUDIOの企画担当Geminiです。ユーザー体験、新しいアイデア、独自の改善案を提案してください。', brief, 550);
    geminiLive = true;
  } else {
    gemini = callOpenAIText_(openAiKey, openAiModel,
      'あなたはGeminiの企画視点を模擬する役割です。実際のGeminiではないことを踏まえ、ユーザー体験と新しいアイデアを提案してください。', brief, 450);
  }
  var copilot = callOpenAIText_(openAiKey, openAiModel,
    'あなたはCopilotの開発担当視点を模擬する役割です。実際のGitHub Copilotではないことを踏まえ、実装方法、対象ファイル、テスト、技術的リスクを提案してください。', brief, 450);
  var summary = callOpenAIText_(openAiKey, openAiModel,
    '次の会議発言を整理し、合意点・未決事項・次の作業を箇条書きでまとめてください。推測を事実として書かないでください。', 
    'テーマ：' + topic + '\n\nChatGPT：' + chatgpt + '\n\nGemini：' + gemini + '\n\nCopilot視点：' + copilot, 500);
  return {
    text: '【ChatGPT｜設計・統括｜OpenAI実接続】\n' + chatgpt +
      '\n\n【Gemini｜企画担当｜' + (geminiLive ? 'Gemini実接続' : '役割シミュレーション') + '】\n' + gemini +
      '\n\n【Copilot｜開発担当｜役割シミュレーション】\n' + copilot +
      '\n\n【会議まとめ】\n' + summary,
    providers: { openai: true, gemini: geminiLive, copilot: false },
    models: { openai: openAiModel, gemini: geminiLive ? geminiModel : 'simulation', copilot: 'simulation' }
  };
}

/** OpenAI Responses API helper. */
function callOpenAIText_(apiKey, model, instructions, input, maxTokens) {
  var response = UrlFetchApp.fetch('https://api.openai.com/v1/responses', {
    method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + apiKey },
    payload: JSON.stringify({ model: model, instructions: instructions, input: input, max_output_tokens: maxTokens }),
    muteHttpExceptions: true
  });
  var status = response.getResponseCode(), data;
  try { data = JSON.parse(response.getContentText()); } catch (e) { throw new Error('OpenAIから正しい応答を受け取れませんでした。'); }
  if (status < 200 || status >= 300) {
    var detail = data && data.error && data.error.message ? data.error.message : 'HTTP ' + status;
    throw new Error('OpenAI APIエラー: ' + detail.slice(0, 220));
  }
  var output = '';
  (data.output || []).forEach(function(item) {
    if (item.type === 'message' && Array.isArray(item.content)) item.content.forEach(function(part) {
      if (part.type === 'output_text' && typeof part.text === 'string') output += part.text;
    });
  });
  if (!output) throw new Error('OpenAIから文章の応答がありません。');
  return output;
}

/** Gemini REST generateContent helper (API key stays in Script Properties). */
function callGeminiText_(apiKey, model, systemInstruction, input, maxTokens) {
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(model) + ':generateContent';
  var response = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json',
    headers: { 'x-goog-api-key': apiKey },
    payload: JSON.stringify({
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents: [{ role: 'user', parts: [{ text: input }] }],
      generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 }
    }),
    muteHttpExceptions: true
  });
  var status = response.getResponseCode(), data;
  try { data = JSON.parse(response.getContentText()); } catch (e) { throw new Error('Geminiから正しい応答を受け取れませんでした。'); }
  if (status < 200 || status >= 300) {
    var detail = data && data.error && data.error.message ? data.error.message : 'HTTP ' + status;
    throw new Error('Gemini APIエラー: ' + detail.slice(0, 220));
  }
  var output = '';
  (((data.candidates || [])[0] || {}).content || {}).parts && data.candidates[0].content.parts.forEach(function(part) {
    if (typeof part.text === 'string') output += part.text;
  });
  if (!output) throw new Error('Geminiから文章の応答がありません。');
  return output;
}

/** Report which provider credentials are configured without exposing any secret. */
function getAiProviderStatus() {
  var props = PropertiesService.getScriptProperties();
  return {
    openai: !!props.getProperty('OPENAI_API_KEY'),
    gemini: !!props.getProperty('GEMINI_API_KEY'),
    copilot: false
  };
}

/** Save a workspace snapshot as a JSON file in the user's Google Drive. */
function saveWorkspaceToDrive(token, workspace) {
  var account = requireAccount_(token);
  if (!workspace || typeof workspace !== 'object') throw new Error('保存データが正しくありません。');
  var json = JSON.stringify(workspace);
  if (json.length > 500000) throw new Error('保存データが大きすぎます。');
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd_HHmmss');
  var file = DriveApp.createFile('RUITO_STUDIO_' + account.userId + '_' + stamp + '.json', json, MimeType.JSON);
  return { id: file.getId(), name: file.getName(), url: file.getUrl() };
}

/** List recent workspace snapshots created by this app. */
function listWorkspaceFiles(token) {
  var account = requireAccount_(token);
  var prefix = 'RUITO_STUDIO_' + account.userId + '_';
  var it = DriveApp.getFiles();
  var files = [];
  while (it.hasNext() && files.length < 30) {
    var f = it.next();
    if (f.getName().indexOf(prefix) === 0 && f.getName().slice(-5) === '.json') {
      files.push({ id: f.getId(), name: f.getName(), updated: f.getLastUpdated().toISOString() });
    }
  }
  files.sort(function(a, b) { return b.updated.localeCompare(a.updated); });
  return files;
}

/** Load only a workspace snapshot with the app's reserved filename prefix. */
function loadWorkspaceFromDrive(token, fileId) {
  var account = requireAccount_(token);
  if (typeof fileId !== 'string' || !fileId) throw new Error('ファイルIDがありません。');
  var file;
  try { file = DriveApp.getFileById(fileId); }
  catch (e) { throw new Error('ファイルを開けません。アクセス権を確認してください。'); }
  if (file.getName().indexOf('RUITO_STUDIO_' + account.userId + '_') !== 0 || file.getName().slice(-5) !== '.json') {
    throw new Error('ルイトAI STUDIOの保存ファイルではありません。');
  }
  var content = file.getBlob().getDataAsString('UTF-8');
  if (content.length > 500000) throw new Error('ファイルが大きすぎます。');
  var data;
  try { data = JSON.parse(content); } catch (e) { throw new Error('保存ファイルのJSONが壊れています。'); }
  return data;
}
