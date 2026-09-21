/**
 * 以 version.json 为唯一数据源，生成：
 *   1. versions/<版本号>/README.md  —— 每个历史版本一个文件夹，配套版本号标题
 *   2. 根 README.md 表格           —— 每行版本名链接到对应版本文件夹
 *
 * 该脚本是幂等的：可重复执行，结果一致；version.json 中已不存在的版本文件夹会被清理。
 *
 * 用法: node scripts/genVersionPages.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const VERSION_FILE = path.join(ROOT, 'version.json');
const README_FILE = path.join(ROOT, 'README.md');
const VERSIONS_DIR = path.join(ROOT, 'versions');

const TABLE_SEPARATOR = '|  :----  | :----  | :----  |';
const CHANGELOG_URL = 'https://weixin.qq.com/updates';

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

const VERSION_PATTERN = /^\d+(\.\d+)*$/;

/**
 * 解析条目的版本号：优先使用 version 字段，为空时回退到从 name 中提取。
 * 两者都拿不到合法版本号时直接抛错，避免生成出路径为空的版本目录。
 * @param {{name?: string, version?: string, url?: string}} entry
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
 * @returns {Array<{name: string, version: string, publish_date: string, url: string}>}
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
 * @param {ReturnType<typeof readEntries>} entries
 * @returns {Map<string, ReturnType<typeof readEntries>>}
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
 * 渲染单个版本的 README.md 内容。
 * @param {string} version
 * @param {ReturnType<typeof readEntries>} items
 * @param {string | null} newer 更新的相邻版本号
 * @param {string | null} older 更早的相邻版本号
 * @returns {string}
 */
function renderVersionPage(version, items, newer, older) {
  const title = items[0].name || `微信 ${version} for Android`;
  const dates = [...new Set(items.map((item) => item.publish_date))].sort();
  const dateText = dates.length === 1 ? dates[0] : `${dates[0]} ~ ${dates[dates.length - 1]}`;

  const rows = items.map((item) => {
    const fileName = item.url.split('/').pop();
    return `| \`${fileName}\` | ${item.publish_date} | [下载](${item.url}) |`;
  });

  const nav = [
    `- 更新版本：${newer ? `[微信 ${newer} for Android](../${newer}/)` : '无（已是最新版本）'}`,
    `- 更早版本：${older ? `[微信 ${older} for Android](../${older}/)` : '无（已是最早收录版本）'}`,
    '- [← 返回全部历史版本列表](../../README.md)'
  ];

  return [
    `# ${title}`,
    '',
    `微信安卓版 **${version}** 官方安装包下载地址，所有下载链接均来自微信官网。`,
    '',
    `- **软件版本**：${version}`,
    `- **发布日期**：${dateText}`,
    `- **安装包数量**：${items.length}`,
    '- **适用平台**：Android',
    '',
    '## 下载地址',
    '',
    '| 安装包文件名 | 发布日期 | 下载地址 |',
    '|  :----  | :----  | :----  |',
    ...rows,
    '',
    '## 其他版本',
    '',
    ...nav,
    '',
    '---',
    '',
    `本版本更新日志可参见官网 [changelog](${CHANGELOG_URL})。本仓库仅收录官方下载地址，不托管安装包文件。`,
    ''
  ].join('\n');
}

/**
 * 写入全部版本文件夹，并清理 version.json 中已不存在的旧文件夹。
 * @param {Map<string, ReturnType<typeof readEntries>>} grouped
 * @param {string[]} orderedDesc 语义化降序排列的版本号
 * @returns {number} 写入的版本文件夹数量
 */
function writeVersionPages(grouped, orderedDesc) {
  fs.mkdirSync(VERSIONS_DIR, { recursive: true });

  const known = new Set(orderedDesc);
  for (const existing of fs.readdirSync(VERSIONS_DIR)) {
    if (!known.has(existing)) {
      fs.rmSync(path.join(VERSIONS_DIR, existing), { recursive: true, force: true });
    }
  }

  orderedDesc.forEach((version, index) => {
    const newer = index > 0 ? orderedDesc[index - 1] : null;
    const older = index < orderedDesc.length - 1 ? orderedDesc[index + 1] : null;
    const dir = path.join(VERSIONS_DIR, version);

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'README.md'),
      renderVersionPage(version, grouped.get(version), newer, older),
      'utf8'
    );
  });

  return orderedDesc.length;
}

/**
 * 重写根 README 的表格主体，版本名指向对应版本文件夹。表头及其以上内容保持不变。
 * @param {ReturnType<typeof readEntries>} entries
 * @returns {number} 写入的表格行数
 */
function writeRootReadme(entries) {
  const lines = fs.readFileSync(README_FILE, 'utf8').split('\n');
  const separatorIndex = lines.findIndex((line) => line.includes(TABLE_SEPARATOR));

  if (separatorIndex === -1) {
    throw new Error(`未在 README.md 中找到表格分隔行: ${TABLE_SEPARATOR}`);
  }

  let bodyEnd = separatorIndex + 1;
  while (bodyEnd < lines.length && lines[bodyEnd].startsWith('|')) {
    bodyEnd += 1;
  }

  const rows = entries.map((entry) => {
    const name = entry.name || `微信 ${entry.version} for Android`;
    return `| [${name}](versions/${entry.version}/)  | (${entry.publish_date}) | [${entry.url}](${entry.url}) |`;
  });

  const next = [...lines.slice(0, separatorIndex + 1), ...rows, ...lines.slice(bodyEnd)];
  fs.writeFileSync(README_FILE, next.join('\n'), 'utf8');

  return rows.length;
}

function main() {
  const entries = readEntries();
  const grouped = groupByVersion(entries);
  const orderedDesc = [...grouped.keys()].sort((a, b) => compareVersion(b, a));

  const pageCount = writeVersionPages(grouped, orderedDesc);
  const rowCount = writeRootReadme(entries);

  process.stdout.write(
    `已生成 ${pageCount} 个版本文件夹，更新根 README 表格 ${rowCount} 行（共 ${entries.length} 个安装包）\n`
  );
}

main();
