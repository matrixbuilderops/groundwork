// Fixture for braceBlockEnd and the outlineJS pattern table.
// Every construct here broke one of them at some point.

export function plainFunction(a: number): number {
  if (a > 0) {
    for (let i = 0; i < a; i++) {
      // `if` and `for` used to be emitted as methods.
    }
  }
  return a;
}

export class Widget {
  private count = 0;

  // A method whose TS return annotation sits between ) and {.
  render(scale: number): string {
    return `w${this.count * scale}`;
  }

  async load(): Promise<void> {
    this.count = 1;
  }

  get size(): number {
    return this.count;
  }
}

// A type annotation whose braces open AND close on the signature line. Settling
// mid-line here truncated the block to its first line.
export const arrayToEnum = <T extends string>(
  items: T[]
): { [k in string]: string } => {
  const out: Record<string, string> = {};
  for (const i of items) out[i] = i;
  return out;
};

// Expression-bodied arrow: no brace at all, body on the next line.
export const errToObj = (message?: string): { message?: string } =>
  typeof message === "string" ? { message } : {};

export namespace util {
  // Indented const arrow — the old pattern was anchored at column 0.
  export const assertNever = (x: never): never => {
    throw new Error(String(x));
  };
}

const template = `a ${1 + 1} b { not a brace } c`;

export default class Trailing {
  last(): void {}
}
