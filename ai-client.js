const replies = {
  ChatGPT: (topic) => `テーマ「${topic}」を整理します。まずは目的を決めて、小さく動く最初の版を作りましょう。必要な機能を絞ってから、次の段階で拡張するのがよさそうです。`,
  Gemini: (topic, history) => {
    const previous = history.at(-1)?.name ?? "みんな";
    return `企画担当からアイデアです！「${topic}」をもっと楽しくする工夫を考えましょう。${previous}の意見も取り入れつつ、まずは使う人がワクワクする体験をひとつ加えたいです。`,
  },
  Copilot: (topic, history) => {
    const previous = history.at(-1)?.name ?? "チーム";
    return `開発担当です。${previous}の案を実現するなら、まず必要最小限の機能で試作するのが安全です。「${topic}」に合わせて、画面・動作・テストを順番に作り、動作確認してから機能を増やしましょう。`,
  },
};

export function getDemoReply(agentName, topic, history = []) {
  return replies[agentName]?.(topic, history) ?? "デモ用の返答がありません。";
}
