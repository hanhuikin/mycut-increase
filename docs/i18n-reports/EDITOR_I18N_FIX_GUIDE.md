# 编辑器页面多语言修复指南

## 需要修复的文件列表

基于搜索结果，以下文件需要将 `zh[...]` 替换为 `t[...]` 并添加 `useLocale()`：

### 1. 已修复的文件
- ✅ `apps/web/src/app/editor/[project_id]/page.tsx` - 编辑器主页面
  - 已添加 `useLocale` import
  - 已更新 `DegradedRendererBanner` 组件

### 2. 需要修复的文件

#### 高优先级（用户直接可见）
1. **export-button.tsx** - 导出按钮
   - 已添加 `useLocale` 
   - 需要替换所有 `zh[` 为 `t[`
   - 涉及组件：`ExportButton`, `ExportPopover`, `ExportError`

2. **scenes-view.tsx** - 场景视图
   - 需要添加 `useLocale`
   - 替换 2 处 `zh[...]`

#### 中优先级（面板和工具）
3. **panels/assets/views/*.tsx** - 资源面板视图
   - `ai-video.tsx` - AI 视频生成
   - `ai-audio.tsx` - AI 音频生成
   - `ai-tools.tsx` - AI 工具
   - `captions.tsx` - 字幕
   - `media.tsx` - 媒体
   - `sounds.tsx` - 声音

4. **panels/properties/*.tsx** - 属性面板
   - 各种属性编辑器

## 修复步骤模板

对于每个文件：

### 1. 添加 import
```tsx
// 替换
import { zh } from "@/locale/zh";

// 为
import { useLocale } from "@/locale/locale-context";
```

### 2. 在组件中添加 hook
```tsx
export function MyComponent() {
  const { t } = useLocale();
  // ... rest of component
}
```

### 3. 替换所有使用
```tsx
// 替换
zh["export.export"]

// 为
t["export.export"]
```

## 批量替换命令

对于每个文件，执行：
```bash
# 1. 替换 import
sed -i 's/import { zh } from "@\/locale\/zh";/import { useLocale } from "@\/locale\/locale-context";/g' FILE

# 2. 替换所有 zh[ 为 t[
sed -i 's/zh\[/t[/g' FILE
```

## 手动检查清单

替换后需要手动检查：
- [ ] 组件是否添加了 `const { t } = useLocale();`
- [ ] 所有 `zh[...]` 已替换为 `t[...]`
- [ ] 没有引入编译错误
- [ ] 组件是否标记为 `"use client"`（因为使用了 hook）

## 快速批量修复脚本

由于有很多文件需要修复，建议创建一个脚本：

```bash
#!/bin/bash

FILES=(
  "apps/web/src/components/editor/export-button.tsx"
  "apps/web/src/components/editor/scenes-view.tsx"
  "apps/web/src/components/editor/panels/assets/views/ai-video.tsx"
  "apps/web/src/components/editor/panels/assets/views/ai-audio.tsx"
  "apps/web/src/components/editor/panels/assets/views/ai-tools.tsx"
  "apps/web/src/components/editor/panels/assets/views/captions.tsx"
  "apps/web/src/components/editor/panels/assets/views/media.tsx"
  "apps/web/src/components/editor/panels/assets/views/sounds.tsx"
)

for file in "${FILES[@]}"; do
  echo "Processing $file..."
  
  # 替换 import
  sed -i 's/import { zh } from "@\/locale\/zh";/import { useLocale } from "@\/locale\/locale-context";/g' "$file"
  
  # 替换所有 zh[ 为 t[
  sed -i 's/zh\[/t[/g' "$file"
  
  echo "Done: $file"
done

echo "All files processed. Please manually add 'const { t } = useLocale();' to each component."
```

## 注意事项

1. **Server vs Client Components**
   - 使用 `useLocale()` 的组件必须是客户端组件
   - 确保文件顶部有 `"use client"`

2. **组件层级**
   - 只在组件函数内部调用 `useLocale()`
   - 不能在组件外部的常量中使用

3. **性能考虑**
   - `useLocale()` 返回的 `t` 对象在每次语言切换时会更新
   - 这会触发使用它的组件重新渲染（预期行为）

## 验证方法

修复后测试：
1. 进入编辑器页面
2. 切换语言（右上角 🌐 按钮）
3. 检查以下区域的文本是否正确切换：
   - [ ] 导出按钮和对话框
   - [ ] 场景选择
   - [ ] AI 工具面板
   - [ ] 媒体面板
   - [ ] 属性面板
   - [ ] 字幕面板

## 当前状态

- ✅ 编辑器主页面横幅已修复
- ⏳ 导出按钮组件部分修复（已添加 useLocale，需替换 zh）
- ⏳ 其他组件待修复

---

**建议**: 由于涉及文件较多，可以分批修复，优先处理用户最常见的功能（导出、场景、媒体）。
