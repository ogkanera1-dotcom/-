/** ルイトAI STUDIO - username/password authentication
 * Run setupAuthDatabase() manually once as the project owner BEFORE deployment.
 * Do not put passwords, password hashes, or session tokens in client-visible files.
 */
function setupAuthDatabase() {
  var activeEmail = Session.getActiveUser().getEmail();
  var ownerEmail = Session.getEffectiveUser().getEmail();
  if (!activeEmail || activeEmail !== ownerEmail) {
    throw new Error('認証データベースの初期設定は、GASプロジェクト所有者がエディタから実行してください。');
  }
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('RUITO_AUTH_DB_ID')) {
    throw new Error('認証データベースは設定済みです。');
  }
  var ss = SpreadsheetApp.create('RUITO AI STUDIO - private auth database');
  var users = ss.getSheets()[0];
  users.setName('Users');
  users.clear();
  users.appendRow(['userId', 'usernameKey', 'username', 'salt', 'passwordHash', 'createdAt']);
  var data = ss.insertSheet('UserData');
  data.clear();
  data.appendRow(['userId', 'dataKey', 'jsonValue', 'updatedAt']);
  props.setProperty('RUITO_AUTH_DB_ID', ss.getId());
  props.setProperty('RUITO_AUTH_PEPPER', Utilities.getUuid() + Utilities.getUuid());
  return '認証データベースを作成しました。スプレッドシートは公開しないでください。';
}

function registerAccount(username, password) {
  var name = normalizeUsername_(username);
  validatePassword_(password);
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = authSheet_('Users');
    var rows = sheet.getDataRange().getValues();
    for (var i = 1; i < rows.length; i++) {
      if (String(rows[i][1]) === name.key) throw new Error('このユーザー名はすでに使われています。');
    }
    if (rows.length > 200) throw new Error('現在、新しいアカウントを作成できません。');
    var userId = Utilities.getUuid();
    var salt = Utilities.getUuid() + Utilities.getUuid();
    var hash = passwordHash_(password, salt);
    sheet.appendRow([userId, name.key, name.display, salt, hash, new Date()]);
    return createSession_(userId, name.display);
  } finally {
    lock.releaseLock();
  }
}

function loginAccount(username, password) {
  var name = normalizeUsername_(username);
  if (typeof password !== 'string' || password.length > 128) throw new Error('ユーザー名またはパスワードが違います。');
  var rows = authSheet_('Users').getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][1]) === name.key) {
      var expected = String(rows[i][4]);
      var actual = passwordHash_(password, String(rows[i][3]));
      if (!constantTimeEqual_(expected, actual)) break;
      return createSession_(String(rows[i][0]), String(rows[i][2]));
    }
  }
  throw new Error('ユーザー名またはパスワードが違います。');
}

function getAccountSession(token) {
  var user = requireAccount_(token);
  return { username: user.username };
}

function logoutAccount(token) {
  if (typeof token === 'string' && token) {
    CacheService.getScriptCache().remove(sessionCacheKey_(token));
  }
  return true;
}

function loadAccountChat(token) {
  var user = requireAccount_(token);
  var value = getUserData_(user.userId, 'chatHistory');
  if (!Array.isArray(value)) return [];
  return value.filter(function(m) {
    return m && (m.role === 'user' || m.role === 'assistant') &&
      typeof m.content === 'string' && m.content.length <= 6000;
  }).slice(-12);
}

function saveAccountChat(token, history) {
  var user = requireAccount_(token);
  if (!Array.isArray(history) || history.length > 12) throw new Error('チャット履歴が正しくありません。');
  var safe = history.map(function(m) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') ||
        typeof m.content !== 'string' || m.content.length > 6000) {
      throw new Error('チャット履歴が正しくありません。');
    }
    return { role: m.role, content: m.content };
  });
  setUserData_(user.userId, 'chatHistory', safe);
  return true;
}

function clearAccountChat(token) {
  var user = requireAccount_(token);
  setUserData_(user.userId, 'chatHistory', []);
  return true;
}

function requireAccount_(token) {
  if (typeof token !== 'string' || token.length < 30 || token.length > 200) {
    throw new Error('ログインしてください。');
  }
  var raw = CacheService.getScriptCache().get(sessionCacheKey_(token));
  if (!raw) throw new Error('ログインの有効期限が切れました。もう一度ログインしてください。');
  var session;
  try { session = JSON.parse(raw); } catch (e) { throw new Error('ログイン状態を確認できません。'); }
  return session;
}

function createSession_(userId, username) {
  var token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  var session = { userId: userId, username: username };
  CacheService.getScriptCache().put(sessionCacheKey_(token), JSON.stringify(session), 21600);
  return { token: token, username: username, expiresIn: 21600 };
}

function sessionCacheKey_(token) {
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token);
  return 'ruito_session_' + digest.map(function(b) {
    var n = (b + 256) % 256;
    return ('0' + n.toString(16)).slice(-2);
  }).join('');
}

function normalizeUsername_(username) {
  if (typeof username !== 'string') throw new Error('ユーザー名を入力してください。');
  var display = username.trim();
  if (!/^[A-Za-z0-9_-]{3,24}$/.test(display)) {
    throw new Error('ユーザー名は半角英数字・_・- の3〜24文字にしてください。');
  }
  return { display: display, key: display.toLowerCase() };
}

function validatePassword_(password) {
  if (typeof password !== 'string' || password.length < 10 || password.length > 128) {
    throw new Error('パスワードは10〜128文字にしてください。');
  }
}

function passwordHash_(password, salt) {
  var pepper = PropertiesService.getScriptProperties().getProperty('RUITO_AUTH_PEPPER');
  if (!pepper) throw new Error('認証データベースの初期設定が必要です。');
  var value = salt + ':' + password;
  for (var i = 0; i < 10000; i++) {
    var bytes = Utilities.computeHmacSha256Signature(value, pepper);
    value = bytes.map(function(b) {
      var n = (b + 256) % 256;
      return ('0' + n.toString(16)).slice(-2);
    }).join('');
  }
  return value;
}

function constantTimeEqual_(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authSpreadsheet_() {
  var id = PropertiesService.getScriptProperties().getProperty('RUITO_AUTH_DB_ID');
  if (!id) throw new Error('管理者による認証データベースの初期設定が必要です。');
  return SpreadsheetApp.openById(id);
}

function authSheet_(name) {
  var sheet = authSpreadsheet_().getSheetByName(name);
  if (!sheet) throw new Error('認証データベースの構成が正しくありません。');
  return sheet;
}

function getUserData_(userId, key) {
  var rows = authSheet_('UserData').getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === userId && String(rows[i][1]) === key) {
      try { return JSON.parse(String(rows[i][2])); } catch (e) { return null; }
    }
  }
  return null;
}

function setUserData_(userId, key, value) {
  var sheet = authSheet_('UserData');
  var rows = sheet.getDataRange().getValues();
  var json = JSON.stringify(value);
  if (json.length > 100000) throw new Error('保存データが大きすぎます。');
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === userId && String(rows[i][1]) === key) {
      sheet.getRange(i + 1, 3, 1, 2).setValues([[json, new Date()]]);
      return;
    }
  }
  sheet.appendRow([userId, key, json, new Date()]);
}
