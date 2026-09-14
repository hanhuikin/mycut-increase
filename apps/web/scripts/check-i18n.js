#!/usr/bin/env node

/**
 * 检查项目中未国际化的硬编码文本
 * Check for hardcoded non-internationalized text in the project
 *
 * Usage: node check-i18n.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SRC_DIR = path.join(__dirname, '..', 'src');

// 忽略的文件和目录
const IGNORE_PATTERNS = [
  /node_modules/,
  /\.next/,
  /\.git/,
  /\.test\./,
  /\.spec\./,
  /__tests__/,
  /locale\//,  // 语言文件本身
  /migrations\//,  // 迁移文件（包含测试数据）
];

// 常见的需要国际化的模式
const PATTERNS = [
  {
    name: '中文字符',
    regex: /["'`]([^"'`]*[一-龥]+[^"'`]*)["'`]/g,
    severity: 'high',
    description: '发现硬编码的中文文本'
  },
  {
    name: '用户可见英文',
    // 匹配引号中首字母大写的句子（可能是用户可见文本）
    regex: /["']([A-Z][a-z]{2,}[\s\w,\.!?-]*?)["']/g,
    severity: 'medium',
    description: '可能的硬编码英文文本（需人工确认）',
    exclude: [
      /import.*from/,  // 排除 import 语句
      /className/,  // 排除 className
      /type.*=/,  // 排除类型定义
      /interface/,  // 排除接口定义
    ]
  }
];

const issues = [];

function shouldIgnore(filePath) {
  return IGNORE_PATTERNS.some(pattern => pattern.test(filePath));
}

function checkFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  PATTERNS.forEach(pattern => {
    lines.forEach((line, lineIndex) => {
      // 跳过注释行
      if (line.trim().startsWith('//') || line.trim().startsWith('*')) {
        return;
      }

      // 检查是否应该排除
      if (pattern.exclude) {
        const shouldExclude = pattern.exclude.some(ex => ex.test(line));
        if (shouldExclude) return;
      }

      let match;
      while ((match = pattern.regex.exec(line)) !== null) {
        const text = match[1];

        // 跳过一些常见的非用户文本
        if (isLikelyNotUserText(text)) {
          continue;
        }

        issues.push({
          file: path.relative(SRC_DIR, filePath),
          line: lineIndex + 1,
          severity: pattern.severity,
          pattern: pattern.name,
          text: text,
          description: pattern.description,
          lineContent: line.trim()
        });
      }

      // 重置 regex lastIndex
      pattern.regex.lastIndex = 0;
    });
  });
}

function isLikelyNotUserText(text) {
  // 排除常见的非用户文本
  const nonUserTextPatterns = [
    /^[A-Z_]+$/, // 常量名
    /^[a-z][a-zA-Z]*$/, // 单个驼峰单词（可能是变量）
    /^\d+$/, // 纯数字
    /^#[0-9a-f]{3,6}$/i, // 颜色值
    /^https?:\/\//, // URL
    /^@/, // 装饰器或特殊标记
    /^\w+\.\w+$/, // 属性访问如 "foo.bar"
    /^[A-Z][a-z]+[A-Z]/, // PascalCase (组件名)
    /\$\{/, // 模板字符串变量
  ];

  return nonUserTextPatterns.some(pattern => pattern.test(text));
}

function scanDirectory(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  entries.forEach(entry => {
    const fullPath = path.join(dir, entry.name);

    if (shouldIgnore(fullPath)) {
      return;
    }

    if (entry.isDirectory()) {
      scanDirectory(fullPath);
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
      checkFile(fullPath);
    }
  });
}

// 运行检查
console.log('🔍 开始扫描未国际化的文本...\n');
console.log('📁 扫描目录:', SRC_DIR, '\n');

scanDirectory(SRC_DIR);

// 按严重程度分组
const highIssues = issues.filter(i => i.severity === 'high');
const mediumIssues = issues.filter(i => i.severity === 'medium');

console.log('📊 扫描结果:\n');
console.log(`❗ 高优先级 (中文硬编码): ${highIssues.length} 个`);
console.log(`⚠️  中优先级 (可能的英文硬编码): ${mediumIssues.length} 个`);
console.log(`📝 总计: ${issues.length} 个问题\n`);

if (highIssues.length > 0) {
  console.log('\n' + '='.repeat(80));
  console.log('❗ 高优先级问题 (必须修复)');
  console.log('='.repeat(80) + '\n');

  highIssues.forEach((issue, index) => {
    console.log(`${index + 1}. ${issue.file}:${issue.line}`);
    console.log(`   文本: "${issue.text}"`);
    console.log(`   代码: ${issue.lineContent.substring(0, 100)}...`);
    console.log();
  });
}

if (mediumIssues.length > 0 && mediumIssues.length <= 50) {
  console.log('\n' + '='.repeat(80));
  console.log('⚠️  中优先级问题 (需要人工确认)');
  console.log('='.repeat(80) + '\n');

  mediumIssues.slice(0, 20).forEach((issue, index) => {
    console.log(`${index + 1}. ${issue.file}:${issue.line}`);
    console.log(`   文本: "${issue.text}"`);
    console.log(`   代码: ${issue.lineContent.substring(0, 100)}...`);
    console.log();
  });

  if (mediumIssues.length > 20) {
    console.log(`... 还有 ${mediumIssues.length - 20} 个中优先级问题未显示\n`);
  }
}

// 生成报告文件
const report = {
  timestamp: new Date().toISOString(),
  summary: {
    total: issues.length,
    high: highIssues.length,
    medium: mediumIssues.length
  },
  issues: issues
};

const reportPath = path.join(__dirname, '..', 'i18n-check-report.json');
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

console.log(`\n📄 详细报告已保存到: ${path.relative(process.cwd(), reportPath)}`);

// 提供修复建议
console.log('\n' + '='.repeat(80));
console.log('💡 修复建议');
console.log('='.repeat(80));
console.log(`
1. 对于中文硬编码:
   - 在 src/locale/zh.ts 和 src/locale/en.ts 中添加翻译键
   - 将硬编码文本替换为 t["translation.key"]

2. 对于英文硬编码:
   - 先确认是否为用户可见文本
   - 如果是，添加到国际化文件
   - 如果不是（如常量、配置），可以忽略

3. 使用国际化:
   import { useLocale } from "@/locale/locale-context";
   const { t } = useLocale();
   const text = t["your.translation.key"];

4. 主场景命名规范:
   - 创建时使用: "__main_scene__"
   - 显示时使用: t["scene.main_scene"]
   - 详见: apps/web/SCENE_NAME_I18N.md
`);

// 如果有高优先级问题，返回非零退出码
process.exit(highIssues.length > 0 ? 1 : 0);
