/**
 * 以 version.json 为唯一数据源，生成中英双语内容：
 *   1. versions/<版本号>/README.md         —— 英文版本页
 *   2. versions/<版本号>/README.zh-CN.md   —— 中文版本页
 *   3. README.md / README.zh-CN.md         —— 两个根 README 的表格主体
 *
 * 根 README 的表头及其以上内容（标题、语言切换、说明文字）由人工维护，
 * 本脚本只重写表格主体，因此翻译文案的改动不会被覆盖。
 *
 * 该脚本是幂等的：可重复执行，结果一致；version.json 中已不存在的版本目录会被清理。
 *
 * 用法: node scripts/genVersionPages.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const VERSION_FILE = path.join(ROOT, 'version.json');
const VERSIONS_DIR = path.join(ROOT, 'versions');

const TABLE_SEPARATOR = '|  :----  | :----  | :----  |';
const CHANGELOG_URL = 'https://weixin.qq.com/updates';
const VERSION_PATTERN = /^\d+(\.\d+)*$/;

/**
 * @typedef {{name?: string, version: string, publish_date: string, url: string}} VersionEntry
 */

const LOCALES = {
  en: {
    rootFile: 'README.md',
    pageFile: 'README.md',
    switcher: '**English** · [简体中文](README.zh-CN.md)',
    displayName: (version) => `WeChat ${version} for Android`,
    rootRowLink: (version) => `versions/${version}/`,
    siblingLink: (version) => `../${version}/`,
    backLink: '../../README.md',
    intro: (version) =>
      `Official download links for WeChat for Android **${version}**. All links point to Tencent's official servers.`,
    metaVersion: 'Version',
    metaDate: 'Release date',
    metaCount: 'Packages',
    metaPlatform: 'Platform',
    downloadsHeading: 'Downloads',
    downloadsTableHeader: '| Package | Release date | Download |',
    downloadLabel: 'Download',
    otherHeading: 'Other versions',
    newerLabel: 'Newer',
    olderLabel: 'Older',
    noNewer: 'none — this is the latest release',
    noOlder: 'none — earliest release on record',
    backText: '← Back to all versions',
    footer: `Release notes for this version are available on the official [changelog](${CHANGELOG_URL}). This repository only catalogues official download links and does not host any APK files.`
  },
  'zh-CN': {
    rootFile: 'README.zh-CN.md',
    pageFile: 'README.zh-CN.md',
    switcher: '[English](README.md) · **简体中文**',
    displayName: (version, entry) => entry?.name || `微信 ${version} for Android`,
    rootRowLink: (version) => `versions/${version}/README.zh-CN.md`,
    siblingLink: (version) => `../${version}/README.zh-CN.md`,
    backLink: '../../README.zh-CN.md',
    intro: (version) => `微信安卓版 **${version}** 官方安装包下载地址，所有下载链接均来自微信官网。`,
    metaVersion: '软件版本',
    metaDate: '发布日期',
    metaCount: '安装包数量',
    metaPlatform: '适用平台',
    downloadsHeading: '下载地址',
    downloadsTableHeader: '| 安装包文件名 | 发布日期 | 下载地址 |',
    downloadLabel: '下载',
    otherHeading: '其他版本',
    newerLabel: '更新版本',
    olderLabel: '更早版本',
    noNewer: '无（已是最新版本）',
    noOlder: '无（已是最早收录版本）',
    backText: '← 返回全部历史版本列表',
    footer: `本版本更新日志可参见官网 [changelog](${CHANGELOG_URL})。本仓库仅收录官方下载地址，不托管安装包文件。`
  }
};

/**
 * 语义化比较两个版本号，返回值遵循 Array#sort 约定。
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareVersion(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  const len = Math.max(pa.length, pb.length);

  for (let i = 0; i < len; i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) {
      return diff;
    }
  }

  return 0;
}

/**
 * 解析条目的版本号：优先使用 version 字段，为空时回退到从 name 中提取。
 * 两者都拿不到合法版本号时直接抛错，避免生成出路径为空的版本目录。
 * @param {VersionEntry} entry
 * @returns {string}
 */
function resolveVersion(entry) {
  const declared = String(entry.version ?? '').trim();
  if (VERSION_PATTERN.test(declared)) {
    return declared;
  }

  const matched = /微信\s+([\d.]+)\s+for\s+Android/.exec(entry.name ?? '');
  if (matched && VERSION_PATTERN.test(matched[1])) {
    return matched[1];
  }

  throw new Error(`version.json 条目缺少合法版本号: ${JSON.stringify(entry)}`);
}

/**
 * 读取并规范化 version.json：去掉 URL 首尾空白，保留原始数组顺序（新版本在前）。
 * @returns {VersionEntry[]}
 */
function readEntries() {
  const raw = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8'));

  return raw.map((entry) => ({
    ...entry,
    url: String(entry.url).trim(),
    version: resolveVersion(entry),
    publish_date: String(entry.publish_date).trim()
  }));
}

/**
 * 按版本号聚合条目，组内保留 version.json 的原始顺序。
 * @param {VersionEntry[]} entries
 * @returns {Map<string, VersionEntry[]>}
 */
function groupByVersion(entries) {
  const grouped = new Map();

  for (const entry of entries) {
    if (!grouped.has(entry.version)) {
      grouped.set(entry.version, []);
    }
    grouped.get(entry.version).push(entry);
  }

  return grouped;
}

/**
 * 渲染单个版本在指定语言下的页面内容。
 * @param {typeof LOCALES[keyof typeof LOCALES]} locale
 * @param {string} version
 * @param {VersionEntry[]} items
 * @param {string | null} newer 更新的相邻版本号
 * @param {string | null} older 更早的相邻版本号
 * @returns {string}
 */
function renderVersionPage(locale, version, items, newer, older) {
  const dates = [...new Set(items.map((item) => item.publish_date))].sort();
  const dateText = dates.length === 1 ? dates[0] : `${dates[0]} ~ ${dates[dates.length - 1]}`;

  const rows = items.map((item) => {
    const fileName = item.url.split('/').pop();
    return `| \`${fileName}\` | ${item.publish_date} | [${locale.downloadLabel}](${item.url}) |`;
  });

  const newerText = newer
    ? `[${locale.displayName(newer)}](${locale.siblingLink(newer)})`
    : locale.noNewer;
  const olderText = older
    ? `[${locale.displayName(older)}](${locale.siblingLink(older)})`
    : locale.noOlder;

  return [
    `# ${locale.displayName(version, items[0])}`,
    '',
    locale.switcher,
    '',
    locale.intro(version),
    '',
    `- **${locale.metaVersion}**: ${version}`,
    `- **${locale.metaDate}**: ${dateText}`,
    `- **${locale.metaCount}**: ${items.length}`,
    `- **${locale.metaPlatform}**: Android`,
    '',
    `## ${locale.downloadsHeading}`,
    '',
    locale.downloadsTableHeader,
    TABLE_SEPARATOR,
    ...rows,
    '',
    `## ${locale.otherHeading}`,
    '',
    `- ${locale.newerLabel}: ${newerText}`,
    `- ${locale.olderLabel}: ${olderText}`,
    `- [${locale.backText}](${locale.backLink})`,
    '',
    '---',
    '',
    locale.footer,
    ''
  ].join('\n');
}

/**
 * 写入全部版本目录（每个目录含各语言一份页面），并清理 version.json 中已不存在的条目。
 * @param {Map<string, VersionEntry[]>} grouped
 * @param {string[]} orderedDesc 语义化降序排列的版本号
 * @returns {number} 写入的文件总数
 */
function writeVersionPages(grouped, orderedDesc) {
  fs.mkdirSync(VERSIONS_DIR, { recursive: true });

  const known = new Set(orderedDesc);
  for (const existing of fs.readdirSync(VERSIONS_DIR)) {
    if (!known.has(existing)) {
      fs.rmSync(path.join(VERSIONS_DIR, existing), { recursive: true, force: true });
    }
  }

  let written = 0;

  orderedDesc.forEach((version, index) => {
    const newer = index > 0 ? orderedDesc[index - 1] : null;
    const older = index < orderedDesc.length - 1 ? orderedDesc[index + 1] : null;
    const dir = path.join(VERSIONS_DIR, version);
    fs.mkdirSync(dir, { recursive: true });

    for (const locale of Object.values(LOCALES)) {
      fs.writeFileSync(
        path.join(dir, locale.pageFile),
        renderVersionPage(locale, version, grouped.get(version), newer, older),
        'utf8'
      );
      written += 1;
    }
  });

  return written;
}

/**
 * 重写单个根 README 的表格主体。表头分隔行及其以上内容保持不变。
 * @param {typeof LOCALES[keyof typeof LOCALES]} locale
 * @param {VersionEntry[]} entries
 * @returns {number} 写入的表格行数
 */
function writeRootTable(locale, entries) {
  const file = path.join(ROOT, locale.rootFile);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const separatorIndex = lines.findIndex((line) => line.includes(TABLE_SEPARATOR));

  if (separatorIndex === -1) {
    throw new Error(`未在 ${locale.rootFile} 中找到表格分隔行: ${TABLE_SEPARATOR}`);
  }

  let bodyEnd = separatorIndex + 1;
  while (bodyEnd < lines.length && lines[bodyEnd].startsWith('|')) {
    bodyEnd += 1;
  }

  const rows = entries.map((entry) => {
    const name = locale.displayName(entry.version, entry);
    const link = locale.rootRowLink(entry.version);
    return `| [${name}](${link})  | (${entry.publish_date}) | [${entry.url}](${entry.url}) |`;
  });

  const next = [...lines.slice(0, separatorIndex + 1), ...rows, ...lines.slice(bodyEnd)];
  fs.writeFileSync(file, next.join('\n'), 'utf8');

  return rows.length;
}

function main() {
  const entries = readEntries();
  const grouped = groupByVersion(entries);
  const orderedDesc = [...grouped.keys()].sort((a, b) => compareVersion(b, a));

  const fileCount = writeVersionPages(grouped, orderedDesc);
  const locales = Object.keys(LOCALES);
  for (const locale of Object.values(LOCALES)) {
    writeRootTable(locale, entries);
  }

  process.stdout.write(
    `已生成 ${orderedDesc.length} 个版本目录 / ${fileCount} 个版本页（语言: ${locales.join(', ')}），` +
      `两个根 README 各更新 ${entries.length} 行\n`
  );
}

main();
