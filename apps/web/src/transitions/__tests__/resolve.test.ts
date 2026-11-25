import { describe, expect, test } from "bun:test";

import type { CutTracks, TransitionCandidate } from "../resolve";
import {
	findCutNear,
	findCutPoints,
	resolveTransitionCut,
	resolveTransitionModifiers,
	resolveTransitionProgress,
	resolveTransitionWindow,
} from "../resolve";

/**
 * 转场纯逻辑：切点查找、窗口钳制、进度 → 渲染修饰。
 *
 * 这些函数只读「标识 + 起点 + 时长」，入参已收窄成结构类型，所以这里用普通
 * 数字构造即可——不碰 @/wasm（bun 多文件同跑时那里会 TDZ）。
 */

const SECOND = 120_000;

function ticks({ seconds }: { seconds: number }): number {
	return Math.round(seconds * SECOND);
}

function candidate({
	id,
	startSeconds,
	durationSeconds,
}: {
	id: string;
	startSeconds: number;
	durationSeconds: number;
}): TransitionCandidate {
	return {
		id,
		startTime: ticks({ seconds: startSeconds }),
		duration: ticks({ seconds: durationSeconds }),
	};
}

function tracksWith({
	elements,
}: {
	elements: TransitionCandidate[];
}): CutTracks {
	return { lanes: [{ elements }] };
}

/** 两段相接的片段：0-4s 与 4-8s，切点在 4s。 */
function twoAdjacentClips(): CutTracks {
	return tracksWith({
		elements: [
			candidate({ id: "a", startSeconds: 0, durationSeconds: 4 }),
			candidate({ id: "b", startSeconds: 4, durationSeconds: 4 }),
		],
	});
}

describe("切点查找", () => {
	test("相邻片段之间算切点，留空隙的不算", () => {
		const tracks = tracksWith({
			elements: [
				candidate({ id: "a", startSeconds: 0, durationSeconds: 2 }),
				candidate({ id: "b", startSeconds: 2, durationSeconds: 2 }),
				candidate({ id: "c", startSeconds: 5, durationSeconds: 1 }),
			],
		});
		const cuts = findCutPoints({ tracks });
		expect(cuts).toHaveLength(1);
		expect(cuts[0].time).toBe(ticks({ seconds: 2 }));
		expect(cuts[0].before.id).toBe("a");
		expect(cuts[0].after.id).toBe("b");
	});

	test("单个片段没有切点", () => {
		const tracks = tracksWith({
			elements: [candidate({ id: "a", startSeconds: 0, durationSeconds: 2 })],
		});
		expect(findCutPoints({ tracks })).toEqual([]);
	});

	test("按距离吸附：容差内选中切点，超出容差返回 null", () => {
		const tracks = twoAdjacentClips();
		expect(findCutNear({ tracks, time: ticks({ seconds: 4.3 }) })?.time).toBe(
			ticks({ seconds: 4 }),
		);
		const atFour = findCutNear({ tracks, time: ticks({ seconds: 4.3 }) });
		expect(atFour?.time).toBe(ticks({ seconds: 4 }));
		expect(findCutNear({ tracks, time: ticks({ seconds: 4.8 }) })).toBeNull();
	});
});

describe("转场窗口", () => {
	test("以切点为中心，两侧各半", () => {
		const cut = findCutPoints({ tracks: twoAdjacentClips() })[0];
		const window = resolveTransitionWindow({
			transition: { duration: ticks({ seconds: 1 }) },
			cut,
		});
		expect(window.start).toBe(ticks({ seconds: 3.5 }));
		expect(window.end).toBe(ticks({ seconds: 4.5 }));
		expect(window.duration).toBe(ticks({ seconds: 1 }));
	});

	test("时长被较短一侧片段钳制", () => {
		const tracks = tracksWith({
			elements: [
				candidate({ id: "a", startSeconds: 0, durationSeconds: 0.6 }),
				candidate({ id: "b", startSeconds: 0.6, durationSeconds: 4 }),
			],
		});
		const cut = findCutPoints({ tracks })[0];
		const window = resolveTransitionWindow({
			transition: { duration: ticks({ seconds: 2 }) },
			cut,
		});
		// 短的一侧只有 0.6s，最多各吃 0.6s
		expect(window.duration).toBeCloseTo(ticks({ seconds: 1.2 }), -1);
	});

	test("块中心在切点上才绑定；拖离切点后不再绑定", () => {
		const tracks = twoAdjacentClips();
		expect(
			resolveTransitionCut({
				tracks,
				transition: {
					startTime: ticks({ seconds: 3.5 }),
					duration: ticks({ seconds: 1 }),
				},
			})?.time,
		).toBe(ticks({ seconds: 4 }));

		expect(
			resolveTransitionCut({
				tracks,
				transition: {
					startTime: ticks({ seconds: 6.5 }),
					duration: ticks({ seconds: 1 }),
				},
			}),
		).toBeNull();
	});
});

describe("进度 → 渲染修饰", () => {
	const base = {
		direction: "left" as const,
		feather: 8,
		intensity: 40,
	};

	test("进度两端与中点有界", () => {
		for (const role of ["from", "to"] as const) {
			expect(
				resolveTransitionModifiers({
					...base,
					kind: "dissolve",
					role,
					progress: 0,
				}).opacity,
			).toBe(role === "from" ? 1 : 0);
			const mid = resolveTransitionModifiers({
				...base,
				kind: "dissolve",
				role,
				progress: 0.5,
			});
			expect(mid.opacity).toBeGreaterThanOrEqual(0);
			expect(mid.opacity).toBeLessThanOrEqual(1);
		}
	});

	test("叠化：出画保持不透明，入画从 0 到 1", () => {
		const start = resolveTransitionModifiers({
			...base,
			kind: "dissolve",
			role: "to",
			progress: 0,
		});
		const end = resolveTransitionModifiers({
			...base,
			kind: "dissolve",
			role: "to",
			progress: 1,
		});
		expect(start.opacity).toBe(0);
		expect(end.opacity).toBe(1);
		expect(
			resolveTransitionModifiers({
				...base,
				kind: "dissolve",
				role: "from",
				progress: 0.99,
			}).opacity,
		).toBe(1);
	});

	test("黑场 / 白场：两段各自在前后半场淡出淡入", () => {
		for (const kind of ["fade-black", "fade-white"] as const) {
			// 前半场：出画片段从不透明淡到 0
			expect(
				resolveTransitionModifiers({ ...base, kind, role: "from", progress: 0 })
					.opacity,
			).toBe(1);
			expect(
				resolveTransitionModifiers({
					...base,
					kind,
					role: "from",
					progress: 0.5,
				}).opacity,
			).toBe(0);
			// 后半场：入画片段从 0 淡到不透明
			expect(
				resolveTransitionModifiers({ ...base, kind, role: "to", progress: 0.5 })
					.opacity,
			).toBe(0);
			expect(
				resolveTransitionModifiers({ ...base, kind, role: "to", progress: 1 })
					.opacity,
			).toBe(1);
		}
	});

	test("推移：两块反向位移，拼满画面", () => {
		const fromStart = resolveTransitionModifiers({
			...base,
			kind: "push",
			role: "from",
			progress: 0,
		});
		const fromEnd = resolveTransitionModifiers({
			...base,
			kind: "push",
			role: "from",
			progress: 1,
		});
		const toStart = resolveTransitionModifiers({
			...base,
			kind: "push",
			role: "to",
			progress: 0,
		});
		const toEnd = resolveTransitionModifiers({
			...base,
			kind: "push",
			role: "to",
			progress: 1,
		});
		// 向左推：出画从 0 到 -1，入画从 +1 到 0
		expect(fromStart.translateX).toBe(0);
		expect(fromEnd.translateX).toBeLessThan(0);
		expect(toStart.translateX).toBeGreaterThan(0);
		expect(toEnd.translateX).toBe(0);
		// 两块位移之和恒为 0，任何进度下都拼满画面
		const mid = resolveTransitionModifiers({
			...base,
			kind: "push",
			role: "from",
			progress: 0.5,
		});
		const midTo = resolveTransitionModifiers({
			...base,
			kind: "push",
			role: "to",
			progress: 0.5,
		});
		expect(mid.translateX + midTo.translateX).toBeCloseTo(0, 5);
	});

	test("推移方向决定位移轴与符号", () => {
		const right = resolveTransitionModifiers({
			...base,
			direction: "right",
			kind: "push",
			role: "from",
			progress: 1,
		});
		expect(right.translateX).toBeGreaterThan(0);

		const down = resolveTransitionModifiers({
			...base,
			direction: "down",
			kind: "push",
			role: "to",
			progress: 0,
		});
		expect(down.translateY).toBeLessThan(0);
		expect(down.translateX).toBe(0);
	});

	test("擦除：只有入画片段带蒙版，出画不带", () => {
		const from = resolveTransitionModifiers({
			...base,
			kind: "wipe",
			role: "from",
			progress: 0.5,
		});
		const to = resolveTransitionModifiers({
			...base,
			kind: "wipe",
			role: "to",
			progress: 0.5,
		});
		expect(from.mask).toBeNull();
		expect(to.mask).toMatchObject({ shape: "rectangle", direction: "left" });
	});

	test("圆形扩展：入画片段带椭圆蒙版", () => {
		const to = resolveTransitionModifiers({
			...base,
			kind: "circle",
			role: "to",
			progress: 0.5,
		});
		expect(to.mask).toMatchObject({ shape: "ellipse" });
	});

	test("缩放 / 旋转 / 模糊：强度按 0..100 归一", () => {
		const zoom = resolveTransitionModifiers({
			...base,
			kind: "zoom",
			role: "to",
			progress: 0,
		});
		expect(zoom.scale).toBeGreaterThan(1);

		const rotate = resolveTransitionModifiers({
			...base,
			kind: "rotate",
			role: "to",
			progress: 0,
		});
		expect(rotate.rotateDegrees).toBeGreaterThan(0);

		const blur = resolveTransitionModifiers({
			...base,
			kind: "blur",
			role: "to",
			progress: 0,
		});
		expect(blur.blur).toBeGreaterThan(0);
		expect(blur.blur).toBeLessThanOrEqual(1);
		// 强度为 0 也保留一点，否则预设看起来像没生效
		const zero = resolveTransitionModifiers({
			...base,
			intensity: 0,
			kind: "blur",
			role: "to",
			progress: 0,
		});
		expect(zero.blur).toBeGreaterThan(0);
	});
});

describe("进度计算", () => {
	test("窗口内线性映射，窗口外钳制", () => {
		const windowStart = 100;
		const windowEnd = 200;
		expect(
			resolveTransitionProgress({ time: 100, windowStart, windowEnd }),
		).toBe(0);
		expect(
			resolveTransitionProgress({ time: 150, windowStart, windowEnd }),
		).toBe(0.5);
		expect(
			resolveTransitionProgress({ time: 200, windowStart, windowEnd }),
		).toBe(1);
		expect(
			resolveTransitionProgress({ time: 90, windowStart, windowEnd }),
		).toBe(0);
		expect(
			resolveTransitionProgress({ time: 260, windowStart, windowEnd }),
		).toBe(1);
	});

	test("零宽窗口不除以零", () => {
		expect(
			resolveTransitionProgress({ time: 5, windowStart: 5, windowEnd: 5 }),
		).toBe(0);
	});
});
