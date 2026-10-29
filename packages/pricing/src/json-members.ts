const QUOTE = 34;
const BACKSLASH = 92;
const OPEN_OBJECT = 123;
const CLOSE_OBJECT = 125;
const OPEN_ARRAY = 91;
const CLOSE_ARRAY = 93;
const COLON = 58;
const COMMA = 44;

export type JsonMemberEvent =
  | { kind: "member"; path: number; key: string; json: string | undefined }
  | { kind: "end"; path: number };

type Frame = { array: boolean; key: string | undefined; expectKey: boolean };

type Capture = {
  path: number;
  key: string;
  keep: boolean;
  parts: string[];
  depth: number;
  inString: boolean;
  escaped: boolean;
};

export class JsonMemberScanner {
  private readonly stack: Frame[] = [];
  private readonly deepest: number;
  private inString = false;
  private escaped = false;
  private key: { frame: Frame; parts: string[] } | undefined;
  private capture: Capture | undefined;

  constructor(
    private readonly paths: readonly (readonly string[])[],
    private readonly want: (path: number, key: string) => boolean = () => true,
  ) {
    this.deepest = Math.max(...paths.map((path) => path.length)) + 1;
  }

  *push(text: string): Generator<JsonMemberEvent> {
    const length = text.length;
    let i = 0;
    while (i < length) {
      if (this.capture) {
        const captured = this.captured(text, i);
        i = captured.next;
        if (captured.event) yield captured.event;
        continue;
      }
      if (this.inString) {
        i = this.stringFrom(text, i);
        continue;
      }
      const code = text.charCodeAt(i);
      const top = this.stack[this.stack.length - 1];
      switch (code) {
        case QUOTE:
          this.inString = true;
          if (top && !top.array && top.expectKey && this.stack.length <= this.deepest) {
            this.key = { frame: top, parts: [] };
          }
          i += 1;
          break;
        case OPEN_OBJECT:
        case OPEN_ARRAY: {
          const path = top && !top.array && !top.expectKey ? this.target() : -1;
          if (path >= 0 && top?.key !== undefined) {
            this.capture = {
              path,
              key: top.key,
              keep: this.want(path, top.key),
              parts: [],
              depth: 0,
              inString: false,
              escaped: false,
            };
            break;
          }
          this.stack.push({
            array: code === OPEN_ARRAY,
            key: undefined,
            expectKey: code === OPEN_OBJECT,
          });
          i += 1;
          break;
        }
        case CLOSE_OBJECT:
        case CLOSE_ARRAY: {
          const path = this.target();
          if (!this.stack.pop()) throw new Error("the JSON closes a value it never opened");
          i += 1;
          if (path >= 0) yield { kind: "end", path };
          break;
        }
        case COLON:
          if (top) top.expectKey = false;
          i += 1;
          break;
        case COMMA:
          if (top && !top.array) top.expectKey = true;
          i += 1;
          break;
        default:
          i += 1;
      }
    }
  }

  finish(): void {
    if (this.stack.length > 0 || this.capture || this.inString) {
      throw new Error("the JSON ends before its last value closes");
    }
  }

  private target(): number {
    const depth = this.stack.length;
    for (let p = 0; p < this.paths.length; p += 1) {
      const path = this.paths[p] as readonly string[];
      if (depth !== path.length + 1) continue;
      let matches = true;
      for (let level = 0; level < path.length; level += 1) {
        const frame = this.stack[level] as Frame;
        if (frame.array || frame.key !== path[level]) {
          matches = false;
          break;
        }
      }
      if (matches && !(this.stack[depth - 1] as Frame).array) return p;
    }
    return -1;
  }

  private stringFrom(text: string, start: number): number {
    const length = text.length;
    let escaped = this.escaped;
    let i = start;
    for (; i < length; i += 1) {
      const code = text.charCodeAt(i);
      if (escaped) escaped = false;
      else if (code === BACKSLASH) escaped = true;
      else if (code === QUOTE) break;
    }
    this.escaped = escaped;
    const key = this.key;
    if (key) key.parts.push(text.slice(start, i));
    if (i === length) return i;
    this.inString = false;
    if (key) {
      key.frame.key = JSON.parse(`"${key.parts.join("")}"`) as string;
      this.key = undefined;
    }
    return i + 1;
  }

  private captured(text: string, start: number): { next: number; event?: JsonMemberEvent } {
    const capture = this.capture as Capture;
    const length = text.length;
    let { depth, inString, escaped } = capture;
    let done = false;
    let i = start;
    for (; i < length; i += 1) {
      const code = text.charCodeAt(i);
      if (inString) {
        if (escaped) escaped = false;
        else if (code === BACKSLASH) escaped = true;
        else if (code === QUOTE) inString = false;
      } else if (code === QUOTE) {
        inString = true;
      } else if (code === OPEN_OBJECT || code === OPEN_ARRAY) {
        depth += 1;
      } else if (code === CLOSE_OBJECT || code === CLOSE_ARRAY) {
        depth -= 1;
        if (depth === 0) {
          i += 1;
          done = true;
          break;
        }
      }
    }
    if (capture.keep) capture.parts.push(text.slice(start, i));
    if (done) {
      this.capture = undefined;
      return {
        next: i,
        event: {
          kind: "member",
          path: capture.path,
          key: capture.key,
          json: capture.keep ? capture.parts.join("") : undefined,
        },
      };
    }
    capture.depth = depth;
    capture.inString = inString;
    capture.escaped = escaped;
    return { next: i };
  }
}

export async function* jsonMembers(
  text: AsyncIterable<string>,
  paths: readonly (readonly string[])[],
  want?: (path: number, key: string) => boolean,
): AsyncGenerator<JsonMemberEvent> {
  const scanner = new JsonMemberScanner(paths, want);
  for await (const chunk of text) {
    yield* scanner.push(chunk);
  }
  scanner.finish();
}

export async function* decodeText(bytes: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for await (const chunk of bytes) {
    const text = decoder.decode(chunk, { stream: true });
    if (text) yield text;
  }
  const tail = decoder.decode();
  if (tail) yield tail;
}
