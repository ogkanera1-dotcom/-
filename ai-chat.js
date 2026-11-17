import { getDemoReply } from "./ai-client.js";

// Gemini is intentionally reserved as an absent participant; only active agents speak.
const participants = [
  { name: "ChatGPT", role: "設計担当" },
  { name: "Copilot", role: "開発担当" },
];

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("会議を停止しました", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new DOMException("会議を停止しました", "AbortError"));
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function runMeeting(topic, onMessage, signal) {
  const history = [{ name: "プロデューサー", text: topic }];
  for (const participant of participants) {
    await wait(850, signal);
    const text = getDemoReply(participant.name, topic, history);
    const message = { ...participant, text };
    history.push(message);
    onMessage(message);
  }
}
