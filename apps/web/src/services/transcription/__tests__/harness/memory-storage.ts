/**
 * 用内存 Map 顶替 localStorage。strategy.ts 的手动选择和失败记忆都存在
 * 这里，测试之间清空即可；隐私模式下访问 localStorage 会抛，生产代码对此
 * 有兜底，所以安装失败也不用管。
 */
export function installMemoryStorage(): Map<string, string> {
	const storage = new Map<string, string>();
	Object.defineProperty(globalThis, "localStorage", {
		value: {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => void storage.set(key, value),
			removeItem: (key: string) => void storage.delete(key),
		},
		configurable: true,
	});
	return storage;
}
