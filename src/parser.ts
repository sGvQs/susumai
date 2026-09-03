// NDJSON ストリームパーサ + thinking/content 分離。ランタイム依存ゼロ。

export interface OllamaMessage {
  role?: string;
  thinking?: string;
  content?: string;
}

export interface OllamaChunk {
  message?: OllamaMessage;
  done?: boolean;
  /** Ollama がストリーム途中で返すランタイムエラー（OOM・コンテキスト超過等）。HTTP は 200 のまま。 */
  error?: string;
  [key: string]: unknown;
}

export interface Fragment {
  thinking?: string;
  content?: string;
  done?: boolean;
  /** サーバ由来のランタイムエラー。呼び出し側が 1 行メッセージとして表面化させる。 */
  error?: string;
}

// --- NDJSON パーサ ----------------------------------------------------------
// 入力: Uint8Array チャンク列。チャンク境界は行にもマルチバイト文字にも揃わない。
// TextDecoder のストリーミングデコードで継ぎ、バッファに貯めて \n 分割、残余保持。
// CRLF・空行・末尾部分行を吸収。stream:false の単一オブジェクトも flush() で処理。
export class NdjsonParser {
  private decoder = new TextDecoder('utf-8');
  private buf = '';
  /** JSON.parse に失敗してスキップした行数。 */
  skipped = 0;

  push(chunk: Uint8Array): OllamaChunk[] {
    this.buf += this.decoder.decode(chunk, { stream: true });
    return this.drain(false);
  }

  /** ストリーム終了時に呼ぶ。デコーダの未確定バイトをフラッシュし、残余も処理する。 */
  flush(): OllamaChunk[] {
    this.buf += this.decoder.decode();
    return this.drain(true);
  }

  private drain(final: boolean): OllamaChunk[] {
    const parts = this.buf.split('\n');
    this.buf = final ? '' : (parts.pop() ?? '');
    const out: OllamaChunk[] = [];
    for (const part of parts) {
      const line = part.trim(); // CRLF・前後空白を落とす。空行はスキップ。
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as OllamaChunk);
      } catch {
        this.skipped += 1; // 不正行はスキップ（数える）
      }
    }
    return out;
  }
}

// --- thinking / content 分離 ----------------------------------------------
// 主経路は message.thinking / message.content の別フィールド（StreamInterpreter が担当）。
// 本クラスは message.content に <think> タグが出るモデル/経路のためのフォールバック状態機械。
const OPEN = '<think>';
const CLOSE = '</think>';

/** s の末尾が OPEN/CLOSE の途中（プレフィックス）なら、その長さを返す。タグはチャンク跨ぎで割れる前提。 */
function partialTagSuffixLen(s: string): number {
  const max = Math.min(s.length, CLOSE.length - 1);
  for (let n = max; n > 0; n -= 1) {
    const suf = s.slice(s.length - n);
    if (OPEN.startsWith(suf) || CLOSE.startsWith(suf)) return n;
  }
  return 0;
}

export class ThinkSplitter {
  private carry = '';
  private inThink = false;
  private sawOpen = false;
  private settled = false;

  /**
   * message.thinking が別フィールドで届くモデルだと判明したら呼ぶ。
   * 以後、content はプレーンテキストとして即時に流す（保留しない）。
   */
  markPlaintext(): void {
    this.settled = true;
  }

  /** content フィールドの生断片を食わせ、thinking / content に分けて返す。 */
  feed(text: string): Fragment {
    if (!text) return {};
    this.carry += text;
    let thinking = '';
    let content = '';

    for (;;) {
      const iOpen = this.carry.indexOf(OPEN);
      const iClose = this.carry.indexOf(CLOSE);
      let idx = -1;
      let isOpen = false;
      if (iOpen !== -1 && (iClose === -1 || iOpen < iClose)) {
        idx = iOpen;
        isOpen = true;
      } else if (iClose !== -1) {
        idx = iClose;
        isOpen = false;
      }
      if (idx === -1) break;

      const before = this.carry.slice(0, idx);
      if (this.inThink) {
        thinking += before;
      } else if (!isOpen && !this.sawOpen) {
        // (b) 開始タグ欠落の </think>: ターン先頭〜そこまでを thinking 扱い
        thinking += before;
      } else {
        content += before;
      }

      if (isOpen) {
        this.carry = this.carry.slice(idx + OPEN.length);
        this.inThink = true;
        this.sawOpen = true;
      } else {
        this.carry = this.carry.slice(idx + CLOSE.length);
        this.inThink = false;
      }
      this.settled = true;
    }

    // carry に完全なタグは無い。末尾が割れたタグの可能性があれば保持する。
    const hold = partialTagSuffixLen(this.carry);
    const emit = hold ? this.carry.slice(0, this.carry.length - hold) : this.carry;
    this.carry = hold ? this.carry.slice(this.carry.length - hold) : '';

    if (this.inThink) {
      thinking += emit;
    } else {
      // 緩和（QA 提案対応）: message.thinking も <think> タグも無いプレーンな content。
      // 以前はこの先に「開始タグ欠落の単独 </think>」が来て全体が thinking 化する可能性に備え、
      // 1024 字まで carry に留保していた。その結果、1024 字未満の応答（＝大半の短い返答）は
      // done まで一切ストリーミングされず、一括表示になっていた。
      // 開始タグ欠落の </think> は実運用の Ollama /api/chat 経路では発生しない（thinking は
      // 別フィールド、<think> を出す経路は対タグで出す）ため、即座に content として確定する。
      // 万一そのあと単独 </think> が来ても、先行テキストは thinking ではなく content として
      // 流れ、タグは落とされる（stripThink と同じ穏当な劣化）。
      this.settled = true;
      content += emit;
    }

    const out: Fragment = {};
    if (thinking) out.thinking = thinking;
    if (content) out.content = content;
    return out;
  }

  /** ストリーム終了。保留中のテキストを確定させる。 (c) <think> 未終了は残り全部 thinking。 */
  end(): Fragment {
    const out: Fragment = {};
    if (!this.carry) return out;
    if (this.inThink) out.thinking = this.carry;
    else out.content = this.carry;
    this.carry = '';
    return out;
  }
}

// --- NDJSON + 分離をまとめた上位パーサ -----------------------------------
export class StreamInterpreter {
  private ndjson = new NdjsonParser();
  private splitter = new ThinkSplitter();

  /** JSON.parse に失敗してスキップした行数。 */
  get skipped(): number {
    return this.ndjson.skipped;
  }

  private handle(obj: OllamaChunk): Fragment[] {
    // Ollama は OOM 等のランタイムエラーを HTTP 200 のまま {"error":"..."} で返すことがある。
    // これを無視すると空ターンだけが残るので、error フラグメントとして表面化させる。
    if (typeof obj.error === 'string' && obj.error.length > 0) {
      return [{ error: obj.error }];
    }
    const out: Fragment[] = [];
    const msg = obj.message;
    if (msg && typeof msg.thinking === 'string' && msg.thinking.length > 0) {
      this.splitter.markPlaintext();
      out.push({ thinking: msg.thinking });
    }
    if (msg && typeof msg.content === 'string' && msg.content.length > 0) {
      const frag = this.splitter.feed(msg.content);
      if (frag.thinking !== undefined || frag.content !== undefined) out.push(frag);
    }
    if (obj.done === true) {
      const tail = this.splitter.end();
      if (tail.thinking !== undefined || tail.content !== undefined) out.push(tail);
      out.push({ done: true });
    }
    return out;
  }

  push(chunk: Uint8Array): Fragment[] {
    const out: Fragment[] = [];
    for (const obj of this.ndjson.push(chunk)) {
      for (const f of this.handle(obj)) out.push(f);
    }
    return out;
  }

  flush(): Fragment[] {
    const out: Fragment[] = [];
    for (const obj of this.ndjson.flush()) {
      for (const f of this.handle(obj)) out.push(f);
    }
    const tail = this.splitter.end();
    if (tail.thinking !== undefined || tail.content !== undefined) out.push(tail);
    return out;
  }
}
