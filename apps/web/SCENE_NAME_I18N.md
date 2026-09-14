# 场景名称国际化说明 / Scene Name Internationalization

## 概述 / Overview

本项目使用完全分离的中英文国际化系统。场景名称遵循以下约定：

This project uses a fully separated Chinese/English internationalization system. Scene names follow these conventions:

## 主场景命名 / Main Scene Naming

### 内部标识符 / Internal Identifier

主场景在数据库和代码中始终使用内部标识符：
The main scene always uses an internal identifier in database and code:

```typescript
const MAIN_SCENE_IDENTIFIER = "__main_scene__";
```

### 显示名称 / Display Name

显示给用户时，通过国际化系统转换：
When displayed to users, it's translated via the i18n system:

**中文 / Chinese:**
```typescript
t["scene.main_scene"] // "主场景"
```

**英文 / English:**
```typescript
t["scene.main_scene"] // "Main scene"
```

## 实现规则 / Implementation Rules

### ✅ 正确做法 / Correct Approach

```typescript
// 1. 创建场景时使用标识符
const mainScene = buildDefaultScene({ 
  name: "__main_scene__", 
  isMain: true 
});

// 2. 显示场景名称时转换
const getSceneName = (scene: TScene) => {
  if (scene.isMain || scene.name === "__main_scene__") {
    return t["scene.main_scene"];
  }
  return scene.name;
};
```

### ❌ 错误做法 / Wrong Approach

```typescript
// ❌ 不要硬编码中文
const mainScene = { name: "主场景", isMain: true };

// ❌ 不要硬编码英文
const mainScene = { name: "Main scene", isMain: true };

// ❌ 不要在数据库中存储翻译后的文本
scene.name = t["scene.main_scene"]; // Wrong!
```

## 向后兼容 / Backward Compatibility

为了兼容旧数据，UI 层会处理多种格式：
For backward compatibility with old data, the UI layer handles multiple formats:

```typescript
const getSceneName = (scene: TScene) => {
  // 新格式：内部标识符
  if (scene.name === "__main_scene__") {
    return t["scene.main_scene"];
  }
  
  // 旧格式：硬编码的翻译（向后兼容）
  if (scene.name === "Main scene" || scene.name === "主场景") {
    return t["scene.main_scene"];
  }
  
  // 其他场景使用存储的名称
  return scene.name;
};
```

## 数据迁移 / Data Migration

### 自动迁移 / Automatic Migration

项目启动时会自动将旧的硬编码名称迁移到标识符：
On project startup, old hardcoded names are automatically migrated to identifiers:

```typescript
// Before: "Main scene" 或 "主场景"
// After:  "__main_scene__"
```

迁移函数位于：
Migration function located at:
```
src/services/storage/migrations/transformers/normalize-main-scene-name.ts
```

## 添加新语言 / Adding New Languages

添加新语言支持时，只需在语言文件中添加翻译：
To add support for a new language, just add the translation in the language file:

```typescript
// src/locale/ja.ts (日语示例)
export const ja = {
  "scene.main_scene": "メインシーン",
  // ... 其他翻译
};
```

无需修改代码或数据库结构。
No need to modify code or database structure.

## 检查清单 / Checklist

在添加场景相关功能时，确保：
When adding scene-related features, ensure:

- [ ] 创建场景时使用 `__main_scene__` 标识符
- [ ] 显示场景名称时使用 `t["scene.main_scene"]`
- [ ] 不在数据库中存储翻译后的文本
- [ ] 处理向后兼容的旧格式

---

- [ ] Use `__main_scene__` identifier when creating scenes
- [ ] Use `t["scene.main_scene"]` when displaying scene names
- [ ] Don't store translated text in database
- [ ] Handle backward compatibility with old formats

## 相关文件 / Related Files

- 国际化配置 / i18n Config: `src/locale/`
  - `zh.ts` - 中文翻译
  - `en.ts` - 英文翻译
  - `locale-context.tsx` - 语言上下文

- 场景管理 / Scene Management:
  - `src/timeline/scenes.ts` - 场景创建逻辑
  - `src/components/editor/scenes-view.tsx` - 场景显示UI
  - `src/core/managers/project-manager.ts` - 项目管理

- 数据迁移 / Data Migration:
  - `src/services/storage/migrations/transformers/v0-to-v1.ts`
  - `src/services/storage/migrations/transformers/normalize-main-scene-name.ts`

## 常见问题 / FAQ

**Q: 为什么使用 `__main_scene__` 而不是直接使用英文？**  
**Q: Why use `__main_scene__` instead of plain English?**

A: 使用内部标识符可以：
1. 避免显示层和数据层的耦合
2. 轻松添加新语言而无需数据迁移
3. 明确区分「内部标识」和「显示文本」

A: Using an internal identifier allows us to:
1. Decouple display layer from data layer
2. Easily add new languages without data migration
3. Clearly distinguish between "internal ID" and "display text"

**Q: 用户创建的自定义场景如何命名？**  
**Q: How are user-created custom scenes named?**

A: 用户创建的场景直接使用用户输入的名称，不经过国际化系统。只有系统创建的主场景使用标识符。

A: User-created scenes directly use the user-input name without going through the i18n system. Only the system-created main scene uses the identifier.

**Q: 如何检查哪些文本未被国际化？**  
**Q: How to check which text is not internationalized?**

A: 搜索代码中的硬编码字符串：
Search for hardcoded strings in code:

```bash
# 查找中文字符
grep -r "[一-龥]" src/ --include="*.ts" --include="*.tsx"

# 查找可能的英文硬编码（排除变量名、注释）
grep -r '"[A-Z][a-z]' src/ --include="*.ts" --include="*.tsx"
```

建议：所有面向用户的文本都应该通过 `t[key]` 来获取。
Recommendation: All user-facing text should be retrieved via `t[key]`.
