const DECIMAL = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;
const CANONICAL = /^(0|[1-9]\d*)(\.\d*[1-9])?$/;

export function canonicalDecimal(value: string | number): string {
  const text = typeof value === "number" ? numberText(value) : value.trim();
  const match = DECIMAL.exec(text);
  if (!match) throw new Error(`${JSON.stringify(text)} is not a non-negative decimal`);
  let digits = `${match[1]}${match[2] ?? ""}`;
  let point = (match[1] ?? "").length + Number(match[3] ?? 0);
  if (point < 0) {
    digits = "0".repeat(-point) + digits;
    point = 0;
  }
  if (point > digits.length) digits += "0".repeat(point - digits.length);
  const whole = digits.slice(0, point).replace(/^0+/, "") || "0";
  const fraction = digits.slice(point).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

export function isCanonicalDecimal(value: string): boolean {
  return CANONICAL.test(value);
}

export function compareDecimals(a: string, b: string): number {
  const [aWhole = "", aFraction = ""] = canonicalDecimal(a).split(".");
  const [bWhole = "", bFraction = ""] = canonicalDecimal(b).split(".");
  if (aWhole.length !== bWhole.length) return aWhole.length - bWhole.length;
  if (aWhole !== bWhole) return aWhole < bWhole ? -1 : 1;
  const width = Math.max(aFraction.length, bFraction.length);
  const left = aFraction.padEnd(width, "0");
  const right = bFraction.padEnd(width, "0");
  return left === right ? 0 : left < right ? -1 : 1;
}

export function unitsAndNanos(units: string | number, nanos: number): string {
  const whole = canonicalDecimal(String(units));
  if (!Number.isInteger(nanos) || nanos < 0 || nanos >= 1e9) {
    throw new Error(`nanos ${nanos} is not in [0, 1e9)`);
  }
  if (whole.includes(".")) throw new Error(`units ${units} is not a whole number`);
  return canonicalDecimal(`${whole}.${String(nanos).padStart(9, "0")}`);
}

function numberText(value: number): string {
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`${value} is not a non-negative decimal`);
  return String(value);
}
