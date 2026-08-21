import { extname } from "node:path";
import JSZip from "jszip";
import iconv from "iconv-lite";

const CHAPTER_PATTERN =
  /^(?:\s*)(第[零〇一二三四五六七八九十百千万两\d]+[章节回卷部篇]\s*[^\n]{0,40}|序章|楔子|引子|尾声|后记)\s*$/gmu;
const MAX_EPUB_BYTES = 50 * 1024 * 1024;
const MAX_EPUB_TEXT = 10_000_000;
const MAX_EPUB_CHAPTERS = 5_000;
// TXT 与 EPUB 同档上限：防止超大文本/海量章节把解码与后续烧制撑爆。
const MAX_TXT_BYTES = 100 * 1024 * 1024;
const MAX_TXT_TEXT = 10_000_000;
const MAX_TXT_CHAPTERS = 5_000;

function decodeText(buffer) {
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString("utf8");
  }
  // UTF-16 带 BOM（Windows 记事本常见）：按 BOM 识别字节序。否则 utf8 解码
  // 会把它们读成 NUL 夹杂的乱码，且没有替换字符触发 gb18030 回退。
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString("utf16le");
  }
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.allocUnsafe(buffer.length - 2);
    for (let index = 2; index + 1 < buffer.length; index += 2) {
      swapped[index - 2] = buffer[index + 1];
      swapped[index - 1] = buffer[index];
    }
    return swapped.toString("utf16le");
  }
  const utf8 = buffer.toString("utf8");
  const replacementRatio = (utf8.match(/\uFFFD/g)?.length ?? 0) / Math.max(utf8.length, 1);
  return replacementRatio < 0.005 ? utf8 : iconv.decode(buffer, "gb18030");
}

// 章节标题启发式：正文里以「第X章」开头的整行会被正则误判成章节名，
// 拦腰切章。可靠的判据是句读与长度——真正的标题行几乎不含句读/引号、
// 也不会太长。原先还排除「以 的/了/上/中/下来… 收尾」的行，但「第十章 上」
// 「第十二章 南下」「第十章 城中」都是真实标题写法，末字虚词会把两章静默
// 并成一章、锚点整体偏移——不能当判据。
function looksLikeBodySentence(line) {
  const stripped = String(line ?? "").trim();
  if (!stripped) return true;
  if (/[。！？；，：、…「」『』“”]/.test(stripped)) return true;
  return stripped.length > 30;
}

// —— 盗版 TXT/EPUB 的站外噪声清理 ——
// 只删「几乎不可能出现在正文」的行:纯网址/域名行、站名水印、短广告口号与推广页脚。
// 带引号的对话、含句读的长句一律不动——宁可漏删,也不误删正文。
const SITE_NAMES = "笔趣阁|新笔趣阁|顶点小说|顶点小说网|八一中文|飘天文学|飞卢小说|纵横中文|红袖添香|潇湘书院|书旗小说|追书神器|塔读文学|米读小说|番茄小说|七猫小说|书虫小说|笔趣库|笔趣岛";
const SITE_RE = new RegExp(SITE_NAMES);
const AD_ACTION_RE = /(?:地址|网址|首发|更新|最快|最全|无弹窗|无错|阅读|手机|记住|收藏|书签|订阅|下载|正版|转载|链接|入口|域名|网站|app|APP)/;
const URL_RE = /(?:https?:\/\/|www\.)[^\s，。！？；、「」“”]*|[\w-]+\.(?:com|net|cn|org|cc|xyz|top|info|me|la|co|biz|tv)/g;
const FOOTER_RE = /(?:投(?:推荐票|月票)|订阅(?:本书|正版)|支持(?:正版|作者)|更多(?:精彩|好书)|本书(?:由|来自)|请(?:记住|支持)|(?:求|投)(?:收藏|推荐|月票|订阅|鲜花|打赏)|更新(?:最快|最全)|无弹窗|首发|手机用户请|点击(?:下一页|下一章)|本章未完|未完待续|继续阅读|欢迎(?:光临|阅读)|感谢(?:支持|订阅)|广告|推广位)/;
const SHORT_SLOGAN_RE = /^(?:更多精彩|最新章节|请支持正版|请购买正版|求收藏|求推荐|求月票|求订阅|求打赏|求鲜花|加入书架|加入书签|请记住本站|本书来自|本书由|整理上传|欢迎光临|手机用户请|点击下一页|本章未完|继续阅读|阅读愉快|感谢支持|多多支持)[^\n]{0,20}$/;

function isNoiseLine(line) {
  // 1) 站名水印行:整行恰为站名(允许「小说/小说网」等后缀),无句读无引号。
  if (
    line.length <= 14 &&
    SITE_RE.test(line) &&
    /^[\s（(【\[]*[一-龥]{2,8}(?:小说|小说网|中文网|阅读网|书屋|库|岛)?[\s）)】\]]*$/.test(line) &&
    !/[。！？；，、…「」“”]/.test(line)
  ) {
    return true;
  }
  // 2) 网址/域名行:剔除网址后几乎不剩正文(少量 CJK 与引号作为对话残余保护)。
  const urls = line.match(URL_RE);
  if (urls) {
    const residue = line.replace(URL_RE, "");
    const cjk = (residue.match(/[一-龥]/g) ?? []).length;
    if (cjk <= 4 && !/[「」“”]/.test(residue)) return true;
    if (SITE_RE.test(line) && AD_ACTION_RE.test(line)) return true;
  }
  // 3) 短广告口号行:无句读、无引号、整行就是一句口号。
  if (line.length <= 40 && !/[。！？；，、…「」“”]/.test(line) && SHORT_SLOGAN_RE.test(line)) {
    return true;
  }
  // 4) 推广页脚:带句读的推广整句——必须够短或点名站名/网址;引号行不删。
  if (FOOTER_RE.test(line) && (line.length <= 50 || SITE_RE.test(line) || URL_RE.test(line))) {
    if (!/[「」“”]/.test(line)) return true;
  }
  return false;
}

// 行级清理:空行保留(维持段落结构),只删噪声行。返回剩余文本与被删行数。
export function cleanChapterText(text) {
  const lines = String(text ?? "").split("\n");
  const kept = [];
  let removed = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      kept.push(raw);
      continue;
    }
    if (isNoiseLine(line)) {
      removed += 1;
      continue;
    }
    kept.push(raw);
  }
  return { text: kept.join("\n"), removed };
}

// 章节标题后缀清洗:「第12章 出发（求收藏）」这类括号里的拉票/加更声明剥掉;
// 不带括号的尾部口号一并剥掉。合法标记(上/中/下、一二三)不受影响。
const TITLE_AD_SUFFIX_RE = /[（(【\[]\s*(?:求收藏|求推荐|求月票|求订阅|求打赏|求鲜花|加更|爆更|补更|第一更|第二更|第三更|第四更|今天.{0,4}更|.{0,4}点.{0,2}更|更新|未完|待续)[^）)】\]]{0,12}[）)】\]]/g;
const TITLE_SLOGAN_SUFFIX_RE = /(?:\s*)(?:求收藏|求推荐|求月票|求订阅|求打赏|求鲜花|第一更|第二更|第三更|第四更|加更规则.*)\s*$/;
export function cleanChapterTitle(title) {
  const raw = String(title ?? "");
  const cleaned = raw.replace(TITLE_AD_SUFFIX_RE, "").replace(TITLE_SLOGAN_SUFFIX_RE, "").trim();
  return cleaned || raw.trim();
}

export function splitChapters(text, fallbackTitle = "正文") {
  const normalized = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
  const matches = [...normalized.matchAll(CHAPTER_PATTERN)].filter(
    (match) => !looksLikeBodySentence(match[1]),
  );
  if (!matches.length) return [{ index: 1, title: fallbackTitle, text: normalized }];

  const chapters = [];
  if (matches[0].index > 0) {
    const preface = normalized.slice(0, matches[0].index).trim();
    if (preface) chapters.push({ title: "前言", text: preface });
  }
  for (let index = 0; index < matches.length; index += 1) {
    const start = matches[index].index + matches[index][0].length;
    const end = matches[index + 1]?.index ?? normalized.length;
    chapters.push({
      title: cleanChapterTitle(matches[index][1]),
      text: normalized.slice(start, end).trim(),
    });
  }
  return chapters
    .filter((chapter) => chapter.text)
    .map((chapter, index) => ({ index: index + 1, ...chapter }));
}

// HTML 实体解码：命名实体只覆盖最常用的几个（够小说正文用），数字实体
// （&#34; / &#x22;）通用解码——很多 EPUB 用它们包裹对白引号，漏解码会把
// &quot; 原样喂给模型与玩家。
function decodeHtmlEntities(text) {
  return text
    .replace(/&(?:quot|QUOT);/g, '"')
    .replace(/&(?:apos|APOS);/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(Number(dec)))
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function safeCodePoint(code) {
  // 代理区/越界码点没有对应字符，退回原文而不是产出乱码（U+FFFD）。
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return "";
  if (code >= 0xd800 && code <= 0xdfff) return "";
  return String.fromCodePoint(code);
}

function textFromHtml(html) {
  return decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<(?:br|\/p|\/div|\/h[1-6])\s*>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function parseEpub(buffer, fallbackTitle) {
  if (buffer.length > MAX_EPUB_BYTES) throw new Error("EPUB 文件超过 50MB 上限");
  const zip = await JSZip.loadAsync(buffer);
  // zip 炸弹预检：压缩包可以小体积解出大内容，逐个条目累加解压后大小，
  // 超限直接拒，而不是解完文本才发现内存已经被撑爆。
  let projectedText = 0;
  let projectedTotal = 0;
  for (const entry of Object.values(zip.files ?? {})) {
    if (entry.dir) continue;
    const size = entry?._data?.uncompressedSize;
    // 拿不到解压后大小就不再预判（fail-closed）：宁可拒绝，也不能放炸弹进来。
    if (!Number.isFinite(size)) {
      throw new Error("EPUB 存在无法预估解压体积的条目，已拒绝导入");
    }
    projectedTotal += size;
    if (/\.(?:x?html?|txt)$/i.test(entry.name)) projectedText += size;
  }
  if (projectedTotal > 500 * 1024 * 1024) {
    throw new Error("EPUB 解压后体积异常（疑似压缩炸弹），已拒绝导入");
  }
  if (projectedText > MAX_EPUB_TEXT * 2) {
    throw new Error("EPUB 文本总量超过上限，已拒绝导入");
  }
  const container = await zip.file("META-INF/container.xml")?.async("text");
  const rootPath = container?.match(/full-path=["']([^"']+)["']/i)?.[1];
  if (!rootPath) throw new Error("EPUB 缺少 container.xml 或 OPF 路径");
  const opf = await zip.file(rootPath)?.async("text");
  if (!opf) throw new Error("EPUB 缺少 OPF 文件");

  const title =
    textFromHtml(opf.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i)?.[1] ?? "") ||
    fallbackTitle;
  // 属性顺序无关解析：EPUB 规范不保证 id 在 href 之前，分开抓属性而不是
  // 用一条要求特定顺序的正则（顺序不符会被静默漏掉，章节凭空消失）。
  const manifest = new Map();
  for (const match of opf.matchAll(/<item\b([^>]*)>/gi)) {
    const attributes = match[1];
    const id = attributes.match(/\bid\s*=\s*["']([^"']+)["']/i)?.[1];
    const href = attributes.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
    if (id && href) manifest.set(id, href);
  }
  const spine = [...opf.matchAll(/<itemref\b[^>]*idref=["']([^"']+)["'][^>]*>/gi)]
    .map((match) => match[1]);
  if (spine.length > MAX_EPUB_CHAPTERS) throw new Error("EPUB 章节数量异常");
  const base = rootPath.includes("/") ? rootPath.slice(0, rootPath.lastIndexOf("/") + 1) : "";
  const chapters = [];
  const warnings = [];
  let cleanedLines = 0;
  let totalText = 0;
  const entryPath = (href) => {
    const raw = `${base}${href}`.split("#")[0];
    // 某些 EPUB 的 href 带非法百分号转义（如 "100%2.xhtml"），decodeURI 会抛
    // URIError 直接把导入炸掉；解不动就按原样找，zip 内部按字面路径匹配。
    let path;
    try {
      path = decodeURI(raw);
    } catch {
      path = raw;
    }
    // href 允许 ../ 相对段（OPF 常在 OEBPS/ 子目录，指向 ../Text/…）：
    // 逐段归一化后再进 zip 查找，而不是按字面路径失败丢章。
    const stack = [];
    for (const segment of path.split("/")) {
      if (!segment || segment === ".") continue;
      if (segment === "..") stack.pop();
      else stack.push(segment);
    }
    return stack.join("/");
  };
  for (const id of spine) {
    const href = manifest.get(id);
    if (!href) {
      warnings.push(`spine 引用了 manifest 中不存在的条目：${id}`);
      continue;
    }
    const html = await zip.file(entryPath(href))?.async("text");
    if (!html) {
      warnings.push(`章节文件读取失败：${href}`);
      continue;
    }
    // 单章体量先拦一道：个别条目超大时别等全文处理完才发现内存被撑爆。
    if (html.length > MAX_EPUB_TEXT * 2) throw new Error("EPUB 单章体积异常，已拒绝导入");
    const text = textFromHtml(html);
    if (!text) {
      warnings.push(`章节没有可读文本：${href}`);
      continue;
    }
    totalText += text.length;
    if (totalText > MAX_EPUB_TEXT) throw new Error("EPUB 解压文本超过 1000 万字上限");
    const cleaned = cleanChapterText(text);
    cleanedLines += cleaned.removed;
    if (!cleaned.text.trim()) {
      warnings.push(`章节清理后没有剩余正文：${href}`);
      continue;
    }
    // 标题取清理后的首个非空行:水印行被删时不会把站名当章节名。
    const heading = cleaned.text.split("\n").find((line) => line.trim())?.trim();
    chapters.push({
      index: chapters.length + 1,
      title: cleanChapterTitle(heading?.slice(0, 60)) || `第${chapters.length + 1}章`,
      text: cleaned.text,
    });
  }
  if (!chapters.length) throw new Error("EPUB 未找到可读取章节");
  // spine 与实际读入对不上时明确告诉用户丢了章，而不是静默缺内容。
  if (spine.length !== chapters.length) {
    warnings.push(`目录共 ${spine.length} 章，实际读入 ${chapters.length} 章`);
  }
  return { title, format: "epub", chapters, warnings, cleanedLines };
}

// 全章行级清理 + 清空章节剔除:广告水印清理后可能整章只剩空行。
function cleanChapters(chapters) {
  let cleanedLines = 0;
  const cleaned = [];
  for (const chapter of chapters) {
    const result = cleanChapterText(chapter.text);
    cleanedLines += result.removed;
    if (!result.text.trim()) continue;
    cleaned.push({ ...chapter, text: result.text, index: cleaned.length + 1 });
  }
  return { chapters: cleaned, cleanedLines };
}

export async function parseNovel({ name, buffer }) {
  const extension = extname(name).toLowerCase();
  const fallbackTitle = name.slice(0, -extension.length) || name;
  if (extension === ".txt") {
    if (buffer.length > MAX_TXT_BYTES) throw new Error("TXT 文件超过 100MB 上限");
    const text = decodeText(buffer);
    if (text.length > MAX_TXT_TEXT) throw new Error("TXT 文本超过 1000 万字上限");
    const { chapters, cleanedLines } = cleanChapters(splitChapters(text));
    if (chapters.length > MAX_TXT_CHAPTERS) throw new Error("TXT 章节数量异常");
    return {
      title: fallbackTitle,
      format: "txt",
      chapters,
      cleanedLines,
    };
  }
  if (extension === ".epub") return parseEpub(buffer, fallbackTitle);
  throw new Error("仅支持 TXT 和 EPUB 小说");
}
