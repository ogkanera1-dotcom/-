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
