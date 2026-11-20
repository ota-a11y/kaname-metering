export type SplitInputMode = "reading" | "usage";
export type TurnoverBreak = { date: string; reading: number | null; usage: number | null };
export type MeterSegment = {
  start: string;
  end: string;
  label: string;
  previousReading: number | null;
  currentReading: number | null;
  usage: number;
};

const utc = (date: string) => {
  const [year, month, day] = date.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
};
const addDay = (date: string) => new Date(utc(date) + 86_400_000).toISOString().slice(0, 10);
const shortDate = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;

// 入居日は後半の開始日、退去日は前半の最終日として扱う。
export function turnoverBoundary(date: string, kind: "move_in" | "move_out") {
  return kind === "move_in" ? new Date(utc(date) - 86_400_000).toISOString().slice(0, 10) : date;
}

export function splitMeterReading(
  mode: SplitInputMode,
  period: { start: string; end: string },
  previousReading: number | null,
  currentReading: number | null,
  breaks: TurnoverBreak[],
): MeterSegment[] {
  const sorted = [...breaks].sort((left, right) => left.date.localeCompare(right.date));
  if (new Set(sorted.map((row) => row.date)).size !== sorted.length) throw new Error("中間検針日が重複しています。");
  let start = period.start;
  let previous = previousReading;
  const segments: MeterSegment[] = [];
  for (const row of sorted) {
    if (row.date < start || row.date >= period.end) throw new Error("中間検針日は請求期間の途中にしてください。");
    const value = mode === "reading" ? row.reading : row.usage;
    if (value == null || !Number.isFinite(value) || value < 0) throw new Error("入退去境界の中間検針値または使用量を入力してください。");
    if (mode === "reading" && previous == null) throw new Error("前月検針値を入力してください。");
    const usage = mode === "reading" ? value - previous! : value;
    if (usage < 0) throw new Error("中間検針値は前月検針値以上で入力してください。");
    segments.push({ start, end: row.date, label: `※～${shortDate(row.date)}`, previousReading: mode === "reading" ? previous : null, currentReading: mode === "reading" ? value : null, usage });
    previous = mode === "reading" ? value : null;
    start = addDay(row.date);
  }
  if (mode === "reading" && (previous == null || currentReading == null)) throw new Error("当月検針値を入力してください。");
  const lastUsage = mode === "reading" ? currentReading! - previous! : null;
  if (mode === "reading" && lastUsage! < 0) throw new Error("当月検針値は中間検針値以上で入力してください。");
  // 使用量入力では最終区間も担当者が入力する。月全体の使用量からの自動差引はしない。
  if (mode === "usage" && (currentReading == null || !Number.isFinite(currentReading) || currentReading < 0)) throw new Error("後半の使用量を入力してください。");
  segments.push({ start, end: period.end, label: `※${shortDate(start)}～`, previousReading: mode === "reading" ? previous : null, currentReading: mode === "reading" ? currentReading : null, usage: mode === "reading" ? lastUsage! : currentReading! });
  return segments;
}
