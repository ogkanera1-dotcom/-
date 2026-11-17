import { runMeeting } from "./ai-chat.js";

const form = document.querySelector("#meeting-form");
const topicInput = document.querySelector("#topic");
const startButton = document.querySelector("#start-button");
const stopButton = document.querySelector("#stop-button");
const clearButton = document.querySelector("#clear-button");
const status = document.querySelector("#status");
const chatLog = document.querySelector("#chat-log");
const emptyState = document.querySelector("#empty-state");

let meetingController = null;

function addMessage({ name, role, text, kind = "agent" }) {
  const item = document.createElement("li");
  item.className = `message ${kind === "user" ? "user" : name.toLowerCase()}`;
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
  item.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function setRunning(running) {
  startButton.disabled = running;
  stopButton.disabled = !running;
  topicInput.disabled = running;
}

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
    await runMeeting(topic, (message) => addMessage(message), signal);
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

clearButton.addEventListener("click", () => {
  meetingController?.abort();
  chatLog.replaceChildren();
  emptyState.hidden = false;
  status.textContent = "待機中 — テーマを入力してね";
});
