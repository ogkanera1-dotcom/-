import { runMeeting } from "./ai-chat.js";

const STORAGE_KEY = "ruito-ai-auto-talk:meeting-log:v1";
const form = document.querySelector("#meeting-form");
const topicInput = document.querySelector("#topic");
const startButton = document.querySelector("#start-button");
const stopButton = document.querySelector("#stop-button");
const clearButton = document.querySelector("#clear-button");
const status = document.querySelector("#status");
const chatLog = document.querySelector("#chat-log");
const emptyState = document.querySelector("#empty-state");

// Create the export control in JavaScript, so no HTML edit is required.
const exportButton = document.createElement("button");
exportButton.id = "export-button";
exportButton.className = "button quiet";
exportButton.type = "button";
exportButton.textContent = "TXTで保存";
clearButton.insertAdjacentElement("afterend", exportButton);

let meetingController = null;
let messages = [];

function saveMessages() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
  } catch (error) {
    // Storage can be disabled or full; the in-memory meeting should still work.
    console.warn("会議ログをブラウザーに保存できませんでした。", error);
  }
}

function renderMessage(message, { scroll = false } = {}) {
  const { name, role, text, kind = "agent" } = message;
  const item = document.createElement("li");
  item.className = `message ${kind === "user" ? "user" : String(name).toLowerCase()}`;
  const header = document.createElement("header");
  const speaker = document.createElement("strong");
  speaker.textContent = name;
  const title = document.createElement("small");
  title.textContent = role;
  const body = document.createElement("p");
  body.textContent = text;
  header.append(speaker, title);
  item.append(header, body);
  chatLog.append(item);
  emptyState.hidden = true;
  if (scroll) item.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function addMessage(message) {
  messages.push(message);
  renderMessage(message, { scroll: true });
  saveMessages();
}

function restoreMessages() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return;
    const parsed = JSON.parse(saved);
    if (!Array.isArray(parsed)) throw new TypeError("Saved meeting log is not an array");
    messages = parsed.filter((message) =>
      message && typeof message.name === "string" &&
      typeof message.role === "string" && typeof message.text === "string"
    );
    for (const message of messages) renderMessage(message);
  } catch (error) {
    messages = [];
    console.warn("保存済みの会議ログを復元できませんでした。", error);
    status.textContent = "保存済みログを読み込めませんでした。新しい会議を始められます。";
  }
}

function setRunning(running) {
  startButton.disabled = running;
  stopButton.disabled = !running;
  topicInput.disabled = running;
}

function exportAsText() {
  if (messages.length === 0) {
    status.textContent = "保存する会議ログがありません";
    return;
  }

  const lines = [
    "ルイトAI AUTO TALK — 会議ログ",
    `出力日時: ${new Date().toLocaleString("ja-JP")}`,
    "",
  ];
  for (const message of messages) {
    lines.push(`【${message.name}／${message.role}】`, message.text, "");
  }

  const blob = new Blob(["\uFEFF", lines.join("\n")], { type: "text/plain;charset=utf-8" });
  const downloadUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = downloadUrl;
  link.download = `ruito-ai-meeting-${new Date().toISOString().slice(0, 10)}.txt`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(downloadUrl);
  status.textContent = "会議ログをTXTで保存しました";
}

restoreMessages();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const topic = topicInput.value.trim();
  if (!topic || meetingController) return;

  meetingController = new AbortController();
  const { signal } = meetingController;
  setRunning(true);
  addMessage({ name: "プロデューサー", role: "テーマ", text: topic, kind: "user" });
  status.textContent = "会議中 — ChatGPT → Gemini → Copilot";

  try {
    await runMeeting(topic, addMessage, signal);
    status.textContent = "会議終了 — デモ会話が完了しました";
  } catch (error) {
    if (error.name === "AbortError") {
      status.textContent = "会議を停止しました";
    } else {
      console.error(error);
      status.textContent = "エラーが発生しました。もう一度試してください";
    }
  } finally {
    meetingController = null;
    setRunning(false);
  }
});

stopButton.addEventListener("click", () => meetingController?.abort());
exportButton.addEventListener("click", exportAsText);

clearButton.addEventListener("click", () => {
  meetingController?.abort();
  messages = [];
  chatLog.replaceChildren();
  emptyState.hidden = false;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    console.warn("保存済みの会議ログを消去できませんでした。", error);
  }
  status.textContent = "待機中 — テーマを入力してね";
});
