/**
 * 下载与文件名时间戳：两个页面共用的小工具。
 *
 * 为什么从 export.js 里拆出来：export.js 依赖 contract.js 与 experiment.js
 * （17 字段契约、实验记录 schema），那是**步频实验页**才需要的东西。
 * GPS 页只用得到"生成时间戳"和"触发下载"两个函数，却因为一次 import
 * 把 38 KB 的契约模块一起拉进了首屏。拆开之后，GPS 页的资源闭包少 38 KB，
 * 而 export.js 的公开 API 一个都没变（它仍然 re-export 这两个函数）。
 *
 * 这个文件里**不许出现任何网络原语**：下载走的是 Blob + a[download]，
 * 全程在本机完成。tools/audit_release.py 的 RA-05 会盯着这一点。
 */

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** 生成 20261119_231500 形式的时间戳，用于文件名。 */
export function formatStamp(date) {
  const d = date instanceof Date ? date : new Date(date);
  return (
    `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}` +
    `_${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
  );
}

/** 触发浏览器下载。没有 document 时直接抛错，不静默失败。 */
export function downloadText(filename, text, mime) {
  if (typeof document === "undefined") {
    throw new Error("downloadText 只能在浏览器中调用");
  }
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
