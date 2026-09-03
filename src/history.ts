export type Role = 'user' | 'assistant';

export interface Turn {
  role: Role;
  content: string;
}

// 16ターン上限はトークン予算の保証ではなく、UX/コストのヒューリスティック。
// この上限を超えたぶん（および num_ctx を超えるぶん）は Ollama が左トランケートする。
export const MAX_TURNS = 16;

const THINK_PAIR = /<think\b[^>]*>[\s\S]*?<\/think>/gi;
const THINK_OPEN_REST = /<think\b[^>]*>[\s\S]*$/i;
const THINK_STRAY_TAG = /<\/?think\b[^>]*>/gi;

/** content から <think>...</think> を無条件除去する（未終了・迷子タグも落とす）。 */
export function stripThink(text: string): string {
  return text
    .replace(THINK_PAIR, '')
    .replace(THINK_OPEN_REST, '')
    .replace(THINK_STRAY_TAG, '')
    .trim();
}

export class History {
  private turns: Turn[] = [];
  private onTrim: (() => void) | undefined;

  constructor(onTrim?: () => void) {
    this.onTrim = onTrim;
  }

  pushUser(content: string): void {
    this.turns.push({ role: 'user', content });
    this.trim();
  }

  /** アシスタント応答は積む前に <think>...</think> を除去（thinking フィールドは最初から積まない）。 */
  pushAssistant(content: string): void {
    this.turns.push({ role: 'assistant', content: stripThink(content) });
    this.trim();
  }

  /**
   * 1 ラウンド（user 発話 ＋ assistant 応答）をまとめて確定する。
   * trim は 2 ターン積んでから 1 回だけ走らせるので、onTrim 通知はラウンドにつき最大 1 回。
   * （pushUser→trim・pushAssistant→trim と個別に呼ぶと 1 ラウンドで通知が二重に出る。）
   */
  pushRound(userContent: string, assistantContent: string): void {
    this.turns.push({ role: 'user', content: userContent });
    this.turns.push({ role: 'assistant', content: stripThink(assistantContent) });
    this.trim();
  }

  messages(): Turn[] {
    return this.turns.map((t) => ({ ...t }));
  }

  get length(): number {
    return this.turns.length;
  }

  private trim(): void {
    let trimmed = false;
    while (this.turns.length > MAX_TURNS) {
      this.turns.shift();
      trimmed = true;
    }
    if (trimmed && this.onTrim) this.onTrim();
  }
}
