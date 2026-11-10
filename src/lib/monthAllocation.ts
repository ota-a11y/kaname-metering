export type MonthAllocationTarget = {
  id: string;
  ratio: MonthAllocationRatio;
  roundingMode: "floor" | "round" | "ceil";
};

export type MonthAllocationRatio =
  | { mode: "multiplier"; value: string }
  | { mode: "fraction"; numerator: string; denominator: string };
export type MonthAllocationMode = MonthAllocationRatio["mode"];

export function formatAllocationAmountInput(value: string) {
  return value.replace(/[,，]/g, "").replace(/\d+(?:\.\d*)?/g, (number) => {
    const [integer, decimal] = number.split(".");
    return `${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${decimal === undefined ? "" : `.${decimal}`}`;
  });
}

export function evaluateAllocationAmountExpression(input: string): number | null {
  const expression = input.replace(/[,，\s]/g, "").replace(/＋/g, "+").replace(/－/g, "-").replace(/[×＊]/g, "*").replace(/[÷／]/g, "/");
  if (!expression) return null;
  let position = 0;
  const atom = (): number => {
    if (expression[position] === "+") { position++; return atom(); }
    if (expression[position] === "-") { position++; return -atom(); }
    if (expression[position] === "(") {
      position++;
      const value = sum();
      if (expression[position++] !== ")") throw new Error("missing parenthesis");
      return value;
    }
    const match = /^(?:\d+(?:\.\d*)?|\.\d+)/.exec(expression.slice(position));
    if (!match) throw new Error("invalid number");
    position += match[0].length;
    return Number(match[0]);
  };
  const product = (): number => {
    let value = atom();
    while (expression[position] === "*" || expression[position] === "/") {
      const operator = expression[position++];
      const next = atom();
      value = operator === "*" ? value * next : value / next;
    }
    return value;
  };
  const sum = (): number => {
    let value = product();
    while (expression[position] === "+" || expression[position] === "-") {
      const operator = expression[position++];
      const next = product();
      value = operator === "+" ? value + next : value - next;
    }
    return value;
  };
  try {
    const result = sum();
    return position === expression.length && Number.isFinite(result) && result >= 0 ? result : null;
  } catch { return null; }
}

export function parseMonthAllocationRatio(value: unknown): MonthAllocationRatio {
  if (typeof value === "object" && value !== null) {
    const saved = value as Record<string, unknown>;
    if (saved.mode === "fraction") return { mode: "fraction", numerator: String(saved.numerator ?? ""), denominator: String(saved.denominator ?? "") };
    if (saved.mode === "multiplier") return { mode: "multiplier", value: String(saved.value ?? "") };
  }
  return { mode: "multiplier", value: value == null ? "" : String(value) };
}

export function allocationRatioValue(ratio: MonthAllocationRatio) {
  if (ratio.mode === "multiplier") {
    const value = Number(ratio.value || 0);
    if (!Number.isFinite(value) || value < 0) throw new Error("乗率は0以上の数値で入力してください。");
    return value;
  }
  if (ratio.numerator.trim() === "" && ratio.denominator.trim() === "") return 0;
  const numerator = Number(ratio.numerator);
  const denominator = Number(ratio.denominator);
  if (!Number.isFinite(numerator) || numerator < 0 || !Number.isFinite(denominator) || denominator <= 0) {
    throw new Error("割合は0以上の分子と、0より大きい分母で入力してください。");
  }
  return numerator / denominator;
}

export function ratioForAllocationMode(value: unknown, mode: MonthAllocationMode): MonthAllocationRatio {
  const parsed = parseMonthAllocationRatio(value);
  if (parsed.mode === mode) return parsed;
  if (mode === "fraction" && parsed.mode === "multiplier") return { mode, numerator: parsed.value, denominator: parsed.value === "" ? "" : "1" };
  if (parsed.mode !== "fraction") return { mode: "multiplier", value: "" };
  try { return { mode: "multiplier", value: parsed.numerator === "" && parsed.denominator === "" ? "" : String(allocationRatioValue(parsed)) }; }
  catch { return { mode: "multiplier", value: "" }; }
}

export function calculateMonthAllocation(amountInput: string, targets: MonthAllocationTarget[]) {
  const billedAmount = evaluateAllocationAmountExpression(amountInput);
  if (billedAmount == null) {
    throw new Error("請求額は0以上の数値で入力してください。");
  }
  const rows = targets.map((target) => {
    const ratio = allocationRatioValue(target.ratio);
    const raw = billedAmount * ratio;
    const amount = target.roundingMode === "ceil" ? Math.ceil(raw)
      : target.roundingMode === "round" ? Math.round(raw) : Math.floor(raw);
    return { id: target.id, ratio, amount };
  });
  return { billedAmount, rows };
}
