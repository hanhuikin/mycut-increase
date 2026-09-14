# 语言切换功能 / Language Switching

## 功能说明

本项目已集成中英文双语切换功能，用户可以在界面右上角点击语言切换按钮在中英文之间切换。

## 实现方式

### 1. 语言文件
- `src/locale/zh.ts` - 中文翻译
- `src/locale/en.ts` - 英文翻译
- `src/locale/index.ts` - 语言管理
- `src/locale/locale-context.tsx` - React Context 提供语言切换

### 2. 使用方法

在组件中使用 `useLocale` Hook：

```tsx
import { useLocale } from "@/locale/locale-context";

function MyComponent() {
  const { t, locale, setLocale } = useLocale();
  
  return (
    <div>
      <h1>{t["landing.title"]}</h1>
      <button onClick={() => setLocale(locale === "zh" ? "en" : "zh")}>
        切换语言 / Switch Language
      </button>
    </div>
  );
}
```

### 3. 添加新的翻译

在 `zh.ts` 和 `en.ts` 中添加相同的 key：

```typescript
// zh.ts
export const zh = {
  "your.new.key": "中文翻译",
} as const;

// en.ts
export const en = {
  "your.new.key": "English Translation",
} as const;
```

### 4. 语言持久化

用户选择的语言会自动保存到 `localStorage`，下次访问时自动恢复。

## 已更新的组件

- ✅ Header（导航栏）- 添加语言切换按钮
- ✅ Hero（首页）- 使用多语言文本
- ✅ Footer（页脚）- 品牌名称改为 MyCut
- ✅ Layout（全局布局）- 添加 LocaleProvider

## 品牌更改

所有 "OpenCut" 已更改为 "MyCut"：
- Logo alt 文本
- 页脚版权信息
- 下载文件名
- 品牌显示名称
