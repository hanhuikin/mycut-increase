import type { LocaleKey } from "@/locale";
import type { LocalizedParamDefinition } from "@/graphics/types";

/**
 * 转场预设的能力族：决定进度如何映射成两路画面。
 * 每一族只描述几何/透明度的表达式，具体用哪个渲染修饰由
 * `resolveTransitionModifiers` 统一实现（纯函数，可单测）。
 */
export type TransitionFamily =
	/** 交叉叠化：B 在 A 上淡入（A 保持不透明，天然得到 B*p + A*(1-p)） */
	| "dissolve"
	/** 经黑场：前半段 A 淡出到黑，后半段 B 从黑淡入 */
	| "fade-black"
	/** 经白场：同上，但中间叠一层白 */
	| "fade-white"
	/** 推移：A 向左/右/上/下滑出，B 从另一侧跟进，两块始终拼满画面 */
	| "push"
	/** 擦除：B 按方向被矩形蒙版逐渐揭开，A 留在下面 */
	| "wipe"
	/** 圆形扩展：B 被逐渐变大的椭圆揭开 */
	| "circle"
	/** 缩放：B 从放大（或缩小）状态淡入到原尺寸 */
	| "zoom"
	/** 旋转：B 带旋转淡入，A 轻微反方向旋转淡出 */
	| "rotate"
	/** 模糊：B 从模糊到清晰淡入，A 同时变模糊淡出 */
	| "blur";

export type TransitionDirection = "left" | "right" | "up" | "down";

export interface TransitionDefinition {
	type: string;
	/** 稳定标识，用于搜索与元素命名；展示用 `labelKey`。 */
	name: string;
	labelKey?: LocaleKey;
	keywords: string[];
	family: TransitionFamily;
	/** 插入时的默认时长（秒）。会按两侧片段长度钳制。 */
	defaultDurationSeconds: number;
	params: LocalizedParamDefinition[];
}

/** 转场元素在渲染期需要的全部信息（由元素本身 + 预设解析而来）。 */
export interface ResolvedTransition {
	kind: TransitionFamily;
	direction: TransitionDirection;
	/** 0..1，切点两侧各占一半窗口。 */
	progress: number;
	/** 羽化，仅 wipe / circle 使用，0..1 映射到画布比例。 */
	feather: number;
	/** 强度，仅 zoom / blur 使用，0..1。 */
	intensity: number;
}
