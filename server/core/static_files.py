"""
[INPUT]: 依赖预构建 web 根和 HTTP 请求路径。
[OUTPUT]: 对外提供防目录穿越、history fallback、gzip 与缓存头的静态文件解析结果。
[POS]: core 的静态旁路；只服务无密钥的面板壳，绝不读取 runtime 或领域数据。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""

from __future__ import annotations

import gzip
import mimetypes
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import unquote


@dataclass(frozen=True)
class StaticResponse:
    body: bytes
    content_type: str
    content_encoding: str | None
    cache_control: str


class StaticFiles:
    def __init__(self, web_root: Path) -> None:
        self.web_root = web_root.resolve()

    def resolve(self, request_path: str, accepts_gzip: bool) -> StaticResponse | None:
        if not self.web_root.is_dir():
            return None
        decoded = unquote(request_path)
        # 曾经写成 "\\x00"（字面反斜杠 + x00），恒不命中；NUL 会一路穿到
        # Path.resolve 抛 ValueError，被上层泛化 except 吞成 500 而非 404。
        if "\x00" in decoded:
            return None
        relative = decoded.lstrip("/") or "index.html"
        try:
            candidate = (self.web_root / relative).resolve()
            if not candidate.is_relative_to(self.web_root):
                return None
            if candidate.is_dir():
                candidate = candidate / "index.html"
            if not candidate.is_file() and "." not in Path(relative).name:
                candidate = self.web_root / "index.html"
            if not candidate.is_file():
                return None
        except (ValueError, OSError):
            # 畸形路径是「没有这个静态资源」，不是服务器内部错误。
            return None
        body = candidate.read_bytes()
        encoding = None
        if accepts_gzip and len(body) > 512:
            body = gzip.compress(body)
            encoding = "gzip"
        content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        cache_control = "no-cache" if candidate.name == "index.html" else "public, max-age=31536000, immutable"
        return StaticResponse(body, content_type, encoding, cache_control)
