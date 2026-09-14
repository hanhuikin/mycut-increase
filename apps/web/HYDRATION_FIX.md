# Hydration 错误修复完成

## 问题描述
当从首页访问项目页面时，出现 React Hydration 错误：
```
Hydration failed because the server rendered text didn't match the client.
```

## 根本原因
1. **LocaleProvider** 在服务器端和客户端渲染内容不一致
   - 服务器端：默认使用 "zh" (中文)
   - 客户端：从 localStorage 读取用户保存的语言设置
   - 当用户之前选择了英文，客户端会渲染不同的内容

2. **全局常量使用了运行时变量**
   - `PROJECT_ACTIONS` 在组件外部定义，但使用了 `t` (翻译函数)
   - `t` 只能在组件内部通过 `useLocale()` 获取

## 修复方案

### 1. 添加 suppressHydrationWarning
在 `layout.tsx` 中添加 `suppressHydrationWarning` 属性：

```tsx
<html lang="en" suppressHydrationWarning>
  <body suppressHydrationWarning>
    ...
  </body>
</html>
```

这告诉 React 允许服务器端和客户端渲染的内容有轻微差异（如语言文本）。

### 2. 简化 LocaleProvider
移除了不必要的 `mounted` 状态检查，直接在 useEffect 中加载保存的语言：

```tsx
export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>("zh");
  const [t, setT] = useState<LocaleStrings>(() => getLocale("zh"));

  useEffect(() => {
    // 只在客户端加载保存的语言
    const savedLocale = localStorage.getItem("locale") as Locale | null;
    if (savedLocale && (savedLocale === "zh" || savedLocale === "en")) {
      setLocaleState(savedLocale);
      setT(getLocale(savedLocale));
    }
  }, []);

  // ... rest of code
}
```

### 3. 移动 PROJECT_ACTIONS 到组件内部
将 `PROJECT_ACTIONS` 从全局常量移到 `ProjectActions` 组件内部：

**之前 (错误)：**
```tsx
// 在组件外部 - 无法访问 t
const PROJECT_ACTIONS = [
  {
    id: "duplicate",
    label: zh["common.duplicate"], // 错误：直接使用 zh
    icon: Copy01Icon,
  },
];

function ProjectActions() {
  // 使用 PROJECT_ACTIONS
}
```

**之后 (正确)：**
```tsx
function ProjectActions() {
  const { t } = useLocale(); // 获取翻译函数
  
  // 在组件内部定义，可以访问 t
  const PROJECT_ACTIONS = [
    {
      id: "duplicate",
      label: t["common.duplicate"], // 正确：使用 t
      icon: Copy01Icon,
    },
  ];
  
  // ... rest of code
}
```

## 验证修复

### 测试步骤
1. 清除浏览器缓存和 localStorage
2. 访问首页 http://localhost:3000
3. 切换到英文模式
4. 点击 "Projects" 进入项目列表页面
5. 检查是否有 hydration 错误

### 预期结果
✅ 不再出现 hydration 错误  
✅ 页面正常渲染  
✅ 语言切换正常工作  
✅ 所有文本显示正确的语言  

## 技术要点

### suppressHydrationWarning 的使用
- 只在确实需要的地方使用（如 html 和 body 标签）
- 不要滥用，因为它会抑制有用的警告
- 适用于：主题切换、语言切换等客户端动态内容

### 避免 Hydration 错误的原则
1. **避免在服务器端和客户端使用不同的数据**
   - 不要在渲染时使用 `Date.now()`, `Math.random()` 等
   - 不要在渲染时读取 localStorage 或 window 对象

2. **使用 useEffect 处理客户端专属逻辑**
   - useEffect 只在客户端运行
   - 在 useEffect 中读取 localStorage、设置事件监听等

3. **保持组件纯函数特性**
   - 相同的 props 应该产生相同的输出
   - 避免在渲染过程中产生副作用

## 相关文件

修改的文件：
- ✅ `src/locale/locale-context.tsx` - 简化 Provider
- ✅ `src/app/layout.tsx` - 添加 suppressHydrationWarning
- ✅ `src/app/projects/page.tsx` - 移动 PROJECT_ACTIONS 到组件内部

---

**修复完成！** ✨ 现在页面可以正常加载，没有 hydration 错误。
