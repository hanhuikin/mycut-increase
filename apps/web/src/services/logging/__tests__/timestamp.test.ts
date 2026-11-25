import { describe, expect, test } from "bun:test";
import { formatTimestamp } from "../logger";

/**
 * 日志时间戳用本机系统时间 + 明确的时区偏移。东八区的机器上应该是
 * 2026-11-25T15:22:33.324+08:00，而不是不带时区信息的 07:22:33.324Z——
 * 后者是 toISOString() 的 UTC 输出，看日志时容易误读成机器时间。
 */

describe("日志时间戳格式", () => {
	test("用本机时间，并带上本机时区偏移", () => {
		const date = new Date(2026, 10, 25, 15, 22, 33, 324);
		const stamp = formatTimestamp({ date });

		// 本地字段原样输出：不会再因为内部用 UTC 而差 8 小时
		expect(stamp.startsWith("2026-11-25T15:22:33.324")).toBe(true);

		// 偏移与运行环境的时区一致（东八区 +08:00，UTC +00:00）
		const offsetMinutes = -date.getTimezoneOffset();
		const sign = offsetMinutes >= 0 ? "+" : "-";
		const absolute = Math.abs(offsetMinutes);
		const expectedOffset = `${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
		expect(stamp.endsWith(expectedOffset)).toBe(true);
	});

	test("能被标准解析器还原成同一个绝对时刻", () => {
		const date = new Date(2026, 10, 25, 15, 22, 33, 324);
		const parsed = new Date(formatTimestamp({ date }));
		expect(parsed.getTime()).toBe(date.getTime());
	});

	test("不足两位的字段补零（含毫秒）", () => {
		const date = new Date(2026, 0, 5, 3, 4, 5, 6);
		const stamp = formatTimestamp({ date });
		expect(stamp.startsWith("2026-01-05T03:04:05.006")).toBe(true);
		expect(stamp).toMatch(/[+-]\d{2}:\d{2}$/);
	});

	test("跨年与年末时间不受影响", () => {
		for (const date of [
			new Date(2025, 11, 31, 23, 59, 59, 999),
			new Date(2026, 0, 1, 0, 0, 0, 0),
		]) {
			expect(new Date(formatTimestamp({ date })).getTime()).toBe(
				date.getTime(),
			);
		}
	});
});
