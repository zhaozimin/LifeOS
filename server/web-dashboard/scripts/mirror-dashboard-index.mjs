import { copyFile, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, relative, resolve } from "node:path";

// 深链由 Python 静态层回退根 index；资源保留 dashboard/ 目录以匹配 Vite base。
await copyFile(resolve("../web/dashboard/index.html"), resolve("../web/index.html"));

// ==============================================================================
// 源码指纹：让「产物是否由当前源码构建」成为可检验的事实，而不是施工者的记性
// ==============================================================================
// server/web/ 是随源码提交的发布物：Python 静态层只读它，make_release.sh 直接打包它。
// 源码改了却忘记构建时，服务端照常下发新字段，而用户加载的仍是旧包——
// 两侧各自都「正确」，功能却在最后一跳静默消失，且没有任何测试会红。
// 这里把 src/ 的内容摘要写进产物，由 test_lifeos_deployment.py 重算比对。
// 与 core/build.py 给后端 .py 算 buildId 是同一个范式：身份取自内容，不取自时间戳
// （git 不保留 mtime，任何基于文件时间的判据一次 checkout 就失效）。

const SOURCE_ROOT = resolve("src");
const DIGEST_PATH = resolve("../web/dashboard/source-digest.txt");

// 指纹只能覆盖「进版本库、且会进构建」的源码。src/ 下还散落着工具缓存
// （设计钩子的 .impeccable/、编辑器与 macOS 的产物），它们被 .gitignore 排除，
// 因此本机有、干净 checkout 没有——一旦算进摘要，同一份源码在两台机器上得出两个指纹，
// 这道闸就会在 CI 上恒红且报错文案还指错方向（叫人去 npm run build）。
const IGNORED_ENTRIES = new Set([".impeccable", ".DS_Store", ".git"]);

async function collectSources(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (IGNORED_ENTRIES.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await collectSources(path)));
    else found.push(path);
  }
  return found;
}

const paths = (await collectSources(SOURCE_ROOT)).sort();
if (paths.length === 0) throw new Error("src/ 下没有源文件，指纹无从谈起");

const digest = createHash("sha256");
for (const path of paths) {
  digest.update(relative(SOURCE_ROOT, path).split("\\").join("/"));
  digest.update("\0");
  digest.update(await readFile(path));
  digest.update("\0");
}

await writeFile(DIGEST_PATH, `${digest.digest("hex").slice(0, 16)}\n`, "utf8");
